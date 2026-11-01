import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';

import {
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';

import {
  InboxAlreadyProcessedError,
} from '../../../../wagering/application/ports/bet-transaction-runner.js';

import {
  ProcessBetUseCase,
} from '../../../../wagering/application/use-cases/process-bet.use-case.js';

import {
  ProcessWinUseCase,
} from '../../../../wagering/application/use-cases/process-win.use-case.js';

import {
  ProcessLossUseCase,
} from '../../../../wagering/application/use-cases/process-loss.use-case.js';

import {
  ProcessRefundUseCase,
} from '../../../../wagering/application/use-cases/process-refund.use-case.js';

import {
  ProcessRollbackUseCase,
} from '../../../../wagering/application/use-cases/process-rollback.use-case.js';

import {
  parseWagerMessage,
} from '../../application/wager-message-envelope.js';

export const SQS_WAGER_CLIENT = Symbol(
  'SQS_WAGER_CLIENT',
);

export const SQS_WAGER_QUEUE_URL = Symbol(
  'SQS_WAGER_QUEUE_URL',
);

export interface ConsumeResult {
  received: number;
  acknowledged: number;
  duplicates: number;
  retried: number;
}

@Injectable()
export class SqsWagerConsumer {
  private readonly logger = new Logger(
    SqsWagerConsumer.name,
  );

  constructor(
    @Inject(SQS_WAGER_CLIENT)
    private readonly client: SQSClient,

    @Inject(SQS_WAGER_QUEUE_URL)
    private readonly queueUrl: string,

    private readonly processBet: ProcessBetUseCase,

    // Keep the original constructor positions
    // for compatibility with existing unit tests.
    @Optional()
    private readonly processWin?: ProcessWinUseCase,

    @Optional()
    private readonly processLoss?: ProcessLossUseCase,

    @Optional()
    private readonly processRefund?: ProcessRefundUseCase,

    @Optional()
    private readonly processRollback?: ProcessRollbackUseCase,
  ) {}

  async pollOnce(): Promise<ConsumeResult> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 5,
        VisibilityTimeout: 120,
        MessageSystemAttributeNames: [
          'ApproximateReceiveCount',
        ],
      }),
    );

    const message = response.Messages?.[0];

    if (!message) {
      return {
        received: 0,
        acknowledged: 0,
        duplicates: 0,
        retried: 0,
      };
    }

    return this.processMessage(message);
  }

  private async processMessage(
    message: Message,
  ): Promise<ConsumeResult> {
    if (!message.ReceiptHandle) {
      throw new Error(
        'SQS receipt handle is missing',
      );
    }

    let duplicate = false;

    try {
      const parsed = parseWagerMessage(
        message.Body ?? '',
      );

      // Each case creates its own input so TypeScript
      // preserves the discriminated union narrowing.
      switch (parsed.kind) {
        case 'BET': {
          await this.processBet.execute({
            ...parsed.input,
            inbox: parsed.inbox,
          });

          break;
        }

        case 'WIN': {
          if (!this.processWin) {
            throw new Error(
              'WIN processor is not registered',
            );
          }

          await this.processWin.execute({
            ...parsed.input,
            inbox: parsed.inbox,
          });

          break;
        }

        case 'LOSS': {
          if (!this.processLoss) {
            throw new Error(
              'LOSS processor is not registered',
            );
          }

          await this.processLoss.execute({
            ...parsed.input,
            inbox: parsed.inbox,
          });

          break;
        }

        case 'REFUND': {
          if (!this.processRefund) {
            throw new Error(
              'REFUND processor is not registered',
            );
          }

          // PROCESSED and PENDING_REFERENCE both
          // represent committed PostgreSQL states.
          await this.processRefund.execute({
            ...parsed.input,
            inbox: parsed.inbox,
          });

          break;
        }

        case 'ROLLBACK': {
          if (!this.processRollback) {
            throw new Error(
              'ROLLBACK processor is not registered',
            );
          }

          await this.processRollback.execute({
            ...parsed.input,
            inbox: parsed.inbox,
          });

          break;
        }

        default: {
          const exhaustive: never = parsed;

          throw new Error(
            `Unsupported wager kind: ${String(exhaustive)}`,
          );
        }
      }
    } catch (error: unknown) {
      if (
        error instanceof InboxAlreadyProcessedError
      ) {
        // The same message was already committed.
        // Acknowledge the SQS redelivery.
        duplicate = true;
      } else {
        const attempts = Math.max(
          1,
          Number(
            message.Attributes
              ?.ApproximateReceiveCount ?? '1',
          ) || 1,
        );

        const delaySeconds = Math.min(
          300,
          2 ** Math.min(attempts, 8),
        );

        this.logger.warn(
          `Wager message failed; retry=${attempts}, ` +
          `error=${
            error instanceof Error
              ? error.name
              : 'UnknownError'
          }`,
        );

        // Never acknowledge unsuccessful
        // financial processing.
        await this.client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: delaySeconds,
          }),
        );

        return {
          received: 1,
          acknowledged: 0,
          duplicates: 0,
          retried: 1,
        };
      }
    }

    // PostgreSQL must commit before ACK.
    // DeleteMessage failure propagates to caller,
    // allowing SQS to redeliver the same message.
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );

    return {
      received: 1,
      acknowledged: 1,
      duplicates: duplicate ? 1 : 0,
      retried: 0,
    };
  }
}
