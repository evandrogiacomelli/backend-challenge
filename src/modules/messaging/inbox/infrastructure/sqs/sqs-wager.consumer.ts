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
} from '@nestjs/common';

import { InboxAlreadyProcessedError } from '../../../../wagering/application/ports/bet-transaction-runner.js';
import { ProcessBetUseCase } from '../../../../wagering/application/use-cases/process-bet.use-case.js';
import { parseWagerMessage } from '../../application/wager-message-envelope.js';

export const SQS_WAGER_CLIENT =
  Symbol('SQS_WAGER_CLIENT');

export const SQS_WAGER_QUEUE_URL =
  Symbol('SQS_WAGER_QUEUE_URL');

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
      throw new Error('SQS receipt handle is missing');
    }

    let duplicate = false;

    try {
      const parsed = parseWagerMessage(
        message.Body ?? '',
      );

      await this.processBet.execute({
        ...parsed.input,
        inbox: parsed.inbox,
      });
    } catch (error) {
      if (error instanceof InboxAlreadyProcessedError) {
        duplicate = true;
      } else {
        const attempts = Math.max(
          1,
          Number(
            message.Attributes?.ApproximateReceiveCount ??
            '1',
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

    // Executed only after a successful SQL commit
    // or confirmation of a previously completed Inbox.
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
