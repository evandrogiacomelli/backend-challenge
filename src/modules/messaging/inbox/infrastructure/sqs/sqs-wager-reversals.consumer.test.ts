import { randomUUID } from 'node:crypto';

import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

import {
  describe,
  expect,
  test,
} from 'bun:test';

import {
  InboxAlreadyProcessedError,
} from '../../../../wagering/application/ports/bet-transaction-runner.js';

import type {
  ProcessBetUseCase,
} from '../../../../wagering/application/use-cases/process-bet.use-case.js';

import type {
  ProcessRefundUseCase,
} from '../../../../wagering/application/use-cases/process-refund.use-case.js';

import type {
  ProcessRollbackUseCase,
} from '../../../../wagering/application/use-cases/process-rollback.use-case.js';

import {
  SqsWagerConsumer,
} from './sqs-wager.consumer.js';

type Kind = 'REFUND' | 'ROLLBACK';

const QUEUE_URL =
  'http://localhost:4566/000000000000/wagers.fifo';

function body(
  kind: Kind,
  options: {
    messageId?: string;
    referenceExternalTransactionId?: string;
  } = {},
): string {
  return JSON.stringify({
    messageId: options.messageId ?? randomUUID(),
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      kind,
      providerId: 'sqs-reversal-tests',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      referenceExternalTransactionId:
        options.referenceExternalTransactionId ??
        randomUUID(),
      walletId: randomUUID(),
      playerId: randomUUID(),
      roundId: randomUUID(),
      gameId: 'reversal-game',
      money: {
        amount: '30.00',
        currency: 'BRL',
      },
    },
  });
}

function harness(
  kind: Kind,
  onExecute: (
    input: Record<string, unknown>,
  ) => Promise<unknown>,
) {
  const commands: object[] = [];
  const calls: Record<string, unknown>[] = [];

  let messageBody = body(kind);
  let failNextDelete = false;

  const client = {
    async send(command: object) {
      commands.push(command);

      if (command instanceof ReceiveMessageCommand) {
        return {
          Messages: [
            {
              MessageId: 'sqs-message-id',
              ReceiptHandle: 'receipt-handle',
              Body: messageBody,
              Attributes: {
                ApproximateReceiveCount: '1',
              },
            },
          ],
        };
      }

      if (command instanceof DeleteMessageCommand) {
        if (failNextDelete) {
          failNextDelete = false;

          throw new Error(
            'Simulated SQS ACK failure',
          );
        }

        return {};
      }

      if (
        command instanceof ChangeMessageVisibilityCommand
      ) {
        return {};
      }

      throw new Error('Unexpected SQS command');
    },
  } as unknown as SQSClient;

  const processor = {
    async execute(input: Record<string, unknown>) {
      calls.push(input);

      return onExecute(input);
    },
  };

  const bet = {
    async execute() {
      throw new Error(
        'BET must not handle reversal messages',
      );
    },
  } as unknown as ProcessBetUseCase;

  const refund =
    processor as unknown as ProcessRefundUseCase;

  const rollback =
    processor as unknown as ProcessRollbackUseCase;

  const consumer = new SqsWagerConsumer(
    client,
    QUEUE_URL,
    bet,
    undefined,
    undefined,
    kind === 'REFUND' ? refund : undefined,
    kind === 'ROLLBACK' ? rollback : undefined,
  );

  return {
    consumer,
    calls,
    commands,

    setBody(value: string) {
      messageBody = value;
    },

    failNextAck() {
      failNextDelete = true;
    },
  };
}

describe(
  'SQS REFUND and ROLLBACK integration',
  () => {
    test(
      'routes REFUND and acknowledges after processing',
      async () => {
        const setup = harness(
          'REFUND',
          async () => ({
            status: 'PROCESSED',
          }),
        );

        const result =
          await setup.consumer.pollOnce();

        expect(result).toEqual({
          received: 1,
          acknowledged: 1,
          duplicates: 0,
          retried: 0,
        });

        expect(setup.calls).toHaveLength(1);

        expect(
          setup.calls[0]!
            .referenceExternalTransactionId,
        ).toBeDefined();

        expect(
          setup.calls[0]!.inbox,
        ).toBeDefined();

        expect(
          setup.commands.at(-1),
        ).toBeInstanceOf(DeleteMessageCommand);
      },
    );

    test(
      'routes ROLLBACK and acknowledges after processing',
      async () => {
        const setup = harness(
          'ROLLBACK',
          async () => ({
            status: 'PROCESSED',
          }),
        );

        const result =
          await setup.consumer.pollOnce();

        expect(result.acknowledged).toBe(1);
        expect(result.retried).toBe(0);
        expect(setup.calls).toHaveLength(1);

        expect(
          setup.calls[0]!
            .referenceExternalTransactionId,
        ).toBeDefined();

        expect(
          setup.commands.at(-1),
        ).toBeInstanceOf(DeleteMessageCommand);
      },
    );

    test(
      'acknowledges a persisted pending REFUND',
      async () => {
        const setup = harness(
          'REFUND',
          async () => ({
            status: 'PENDING_REFERENCE',
          }),
        );

        const result =
          await setup.consumer.pollOnce();

        expect(result.acknowledged).toBe(1);
        expect(result.retried).toBe(0);

        expect(
          setup.commands.at(-1),
        ).toBeInstanceOf(DeleteMessageCommand);
      },
    );

    test(
      'acknowledges a persisted pending ROLLBACK',
      async () => {
        const setup = harness(
          'ROLLBACK',
          async () => ({
            status: 'PENDING_REFERENCE',
          }),
        );

        const result =
          await setup.consumer.pollOnce();

        expect(result.acknowledged).toBe(1);
        expect(result.retried).toBe(0);
        expect(setup.calls).toHaveLength(1);

        expect(
          setup.commands.at(-1),
        ).toBeInstanceOf(DeleteMessageCommand);
      },
    );

    test(
      'does not ACK when financial persistence fails',
      async () => {
        const setup = harness(
          'REFUND',
          async () => {
            throw new Error(
              'Simulated PostgreSQL failure',
            );
          },
        );

        const result =
          await setup.consumer.pollOnce();

        expect(result.acknowledged).toBe(0);
        expect(result.retried).toBe(1);

        expect(
          setup.commands.some(
            (command) =>
              command instanceof
              DeleteMessageCommand,
          ),
        ).toBe(false);

        expect(
          setup.commands.at(-1),
        ).toBeInstanceOf(
          ChangeMessageVisibilityCommand,
        );
      },
    );

    test(
      'does not ACK when ROLLBACK persistence fails',
      async () => {
        const setup = harness(
          'ROLLBACK',
          async () => {
            throw new Error(
              'Simulated ROLLBACK failure',
            );
          },
        );

        const result =
          await setup.consumer.pollOnce();

        expect(result.acknowledged).toBe(0);
        expect(result.retried).toBe(1);

        expect(
          setup.commands.at(-1),
        ).toBeInstanceOf(
          ChangeMessageVisibilityCommand,
        );

        expect(
          setup.commands.some(
            (command) =>
              command instanceof
              DeleteMessageCommand,
          ),
        ).toBe(false);
      },
    );

    test(
      'acknowledges an already committed Inbox',
      async () => {
        const setup = harness(
          'ROLLBACK',
          async () => {
            throw new InboxAlreadyProcessedError();
          },
        );

        const result =
          await setup.consumer.pollOnce();

        expect(result.acknowledged).toBe(1);
        expect(result.duplicates).toBe(1);
        expect(result.retried).toBe(0);

        expect(
          setup.commands.at(-1),
        ).toBeInstanceOf(DeleteMessageCommand);
      },
    );

    test(
      're-delivery after ACK failure does not process twice',
      async () => {
        let databaseCommitted = false;
        let financialExecutions = 0;

        const setup = harness(
          'REFUND',
          async () => {
            if (databaseCommitted) {
              throw new InboxAlreadyProcessedError();
            }

            databaseCommitted = true;
            financialExecutions += 1;

            return {
              status: 'PROCESSED',
            };
          },
        );

        setup.failNextAck();

        // The financial transaction commits,
        // but the SQS DeleteMessage fails.
        await expect(
          setup.consumer.pollOnce(),
        ).rejects.toThrow(
          'Simulated SQS ACK failure',
        );

        expect(databaseCommitted).toBe(true);
        expect(financialExecutions).toBe(1);

        // SQS redelivers the same message.
        const replay =
          await setup.consumer.pollOnce();

        expect(replay.acknowledged).toBe(1);
        expect(replay.duplicates).toBe(1);
        expect(financialExecutions).toBe(1);
      },
    );

    test(
      'ROLLBACK redelivery after ACK failure does not debit twice',
      async () => {
        let databaseCommitted = false;
        let financialExecutions = 0;

        const setup = harness(
          'ROLLBACK',
          async () => {
            if (databaseCommitted) {
              throw new InboxAlreadyProcessedError();
            }

            databaseCommitted = true;
            financialExecutions += 1;

            return {
              status: 'PROCESSED',
            };
          },
        );

        setup.failNextAck();

        await expect(
          setup.consumer.pollOnce(),
        ).rejects.toThrow(
          'Simulated SQS ACK failure',
        );

        const replay =
          await setup.consumer.pollOnce();

        expect(replay.acknowledged).toBe(1);
        expect(replay.duplicates).toBe(1);
        expect(financialExecutions).toBe(1);
      },
    );

    test(
      'does not ACK ROLLBACK without a registered processor',
      async () => {
        const commands: object[] = [];

        const client = {
          async send(command: object) {
            commands.push(command);

            if (
              command instanceof ReceiveMessageCommand
            ) {
              return {
                Messages: [
                  {
                    ReceiptHandle:
                      'missing-processor',
                    Body: body('ROLLBACK'),
                    Attributes: {
                      ApproximateReceiveCount: '1',
                    },
                  },
                ],
              };
            }

            return {};
          },
        } as unknown as SQSClient;

        const missingProcessor =
          new SqsWagerConsumer(
            client,
            QUEUE_URL,
            {
              async execute() {
                throw new Error(
                  'Unexpected BET',
                );
              },
            } as unknown as ProcessBetUseCase,
          );

        const result =
          await missingProcessor.pollOnce();

        expect(result.acknowledged).toBe(0);
        expect(result.retried).toBe(1);

        expect(
          commands.some(
            (command) =>
              command instanceof
              DeleteMessageCommand,
          ),
        ).toBe(false);

        expect(
          commands.at(-1),
        ).toBeInstanceOf(
          ChangeMessageVisibilityCommand,
        );
      },
    );

    test(
      'does not ACK an invalid reversal message',
      async () => {
        const setup = harness(
          'REFUND',
          async () => ({
            status: 'PROCESSED',
          }),
        );

        const invalid = JSON.parse(
          body('REFUND'),
        ) as {
          data: Record<string, unknown>;
        };

        delete invalid.data
          .referenceExternalTransactionId;

        setup.setBody(
          JSON.stringify(invalid),
        );

        const result =
          await setup.consumer.pollOnce();

        expect(result.acknowledged).toBe(0);
        expect(result.retried).toBe(1);
        expect(setup.calls).toHaveLength(0);

        expect(
          setup.commands.at(-1),
        ).toBeInstanceOf(
          ChangeMessageVisibilityCommand,
        );
      },
    );
  },
);
