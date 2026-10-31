import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';

import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteQueueCommand,
  DeleteMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

import mikroOrmConfig from '../../src/config/mikro-orm.config.js';

import { SqsWagerConsumer } from '../../src/modules/messaging/inbox/infrastructure/sqs/sqs-wager.consumer.js';

import { WalletLedgerEntryEntity } from '../../src/modules/ledger/infrastructure/persistence/wallet-ledger-entry.entity.js';

import { ProcessBetUseCase } from '../../src/modules/wagering/application/use-cases/process-bet.use-case.js';

import { MikroOrmBetTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-bet-transaction-runner.js';

import { CreateWalletUseCase } from '../../src/modules/wallet/application/use-cases/create-wallet.use-case.js';

import { MikroOrmWalletOpeningPersistence } from '../../src/modules/wallet/infrastructure/persistence/mikro-orm-wallet-opening.persistence.js';

import { WalletEntity } from '../../src/modules/wallet/infrastructure/persistence/wallet.entity.js';

let orm: MikroORM;
let sqs: SQSClient;

interface TestWallet {
  id: string;
  playerId: string;
}

function processor(): ProcessBetUseCase {
  return new ProcessBetUseCase(
    new MikroOrmBetTransactionRunner(
      orm.em.fork(),
    ),
  );
}

async function createWallet(): Promise<TestWallet> {
  const playerId = randomUUID();

  const useCase = new CreateWalletUseCase(
    new MikroOrmWalletOpeningPersistence(
      orm.em.fork(),
    ),
  );

  const result = await useCase.execute({
    playerId,
    initialBalance: {
      amount: '100.00',
      currency: 'BRL',
    },
  });

  return {
    id: result.id,
    playerId,
  };
}

function wagerBody(
  wallet: TestWallet,
  messageId: string,
  overrides: { playerId?: string } = {},
): string {
  return JSON.stringify({
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'crash-test-provider',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      playerId:
        overrides.playerId ?? wallet.playerId,
      walletId: wallet.id,
      roundId: randomUUID(),
      gameId: 'crash-recovery-game',
      kind: 'BET',
      money: {
        amount: '30.00',
        currency: 'BRL',
      },
    },
  });
}

async function createTestQueue(): Promise<string> {
  const response = await sqs.send(
    new CreateQueueCommand({
      QueueName:
        `crash-recovery-${randomUUID()}.fifo`,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: '120',
      },
    }),
  );

  if (!response.QueueUrl) {
    throw new Error('Test FIFO queue not created');
  }

  return response.QueueUrl;
}

async function sendWager(
  queueUrl: string,
  walletId: string,
  messageId: string,
  body: string,
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: walletId,
      MessageDeduplicationId: messageId,
    }),
  );
}

async function debitCount(
  walletId: string,
): Promise<number> {
  return orm.em.fork().count(
    WalletLedgerEntryEntity,
    {
      wallet: walletId,
      direction: 'DEBIT',
    },
  );
}

async function readInbox(
  messageId: string,
): Promise<
  Array<{
    message_id: string;
    processed_at: Date | string | null;
  }>
> {
  return orm.em.fork().execute(
    `
    SELECT message_id, processed_at
    FROM inbox_messages
    WHERE consumer_name = ?
      AND message_id = ?
    `,
    ['wager-transactions-v1', messageId],
    'all',
  );
}

async function readBalance(
  walletId: string,
): Promise<string> {
  const wallet = await orm.em.fork().findOneOrFail(
    WalletEntity,
    walletId,
  );

  return String(wallet.balanceAmount);
}

beforeAll(async () => {
  orm = await MikroORM.init(mikroOrmConfig);

  sqs = new SQSClient({
    region:
      process.env.AWS_REGION ?? 'us-east-1',
    endpoint:
      process.env.SQS_ENDPOINT ??
      'http://127.0.0.1:4566',
    credentials: {
      accessKeyId: 'test',
      secretAccessKey: 'test',
    },
  });
});

afterAll(async () => {
  sqs?.destroy();
  await orm?.close(true);
});

describe('SQS crash recovery', () => {
  test(
    'should not debit twice when ACK fails after SQL commit',
    async () => {
      const queueUrl = await createTestQueue();

      try {
        const wallet = await createWallet();
        const messageId = randomUUID();

        const body = wagerBody(
          wallet,
          messageId,
        );

        await sendWager(
          queueUrl,
          wallet.id,
          messageId,
          body,
        );

        let simulatedCrash = false;
        let originalReceiptHandle:
          | string
          | undefined;

        // Real SQS client, except the first
        // DeleteMessage deliberately fails.
        const forward = sqs.send.bind(sqs) as unknown as (
          command: unknown,
        ) => Promise<unknown>;

        const crashingClient = {
          async send(command: unknown) {
            if (
              command instanceof DeleteMessageCommand &&
              !simulatedCrash
            ) {
              simulatedCrash = true;

              originalReceiptHandle =
                command.input.ReceiptHandle;

              throw new Error(
                'SIMULATED_CRASH_AFTER_SQL_COMMIT',
              );
            }

            return forward(command);
          },
        } as unknown as SQSClient;

        const firstConsumer = new SqsWagerConsumer(
          crashingClient,
          queueUrl,
          processor(),
        );

        // Financial transaction commits, but
        // the SQS acknowledgement fails.
        await expect(
          firstConsumer.pollOnce(),
        ).rejects.toThrow(
          'SIMULATED_CRASH_AFTER_SQL_COMMIT',
        );

        expect(simulatedCrash).toBe(true);

        // Check persisted financial state.
        expect(await readBalance(wallet.id))
          .toBe('70.00');

        expect(await debitCount(wallet.id))
          .toBe(1);

        const inboxBeforeRetry =
          await readInbox(messageId);

        expect(inboxBeforeRetry).toHaveLength(1);
        expect(
          inboxBeforeRetry[0]!.processed_at,
        ).not.toBeNull();

        if (!originalReceiptHandle) {
          throw new Error(
            'Original SQS receipt handle unavailable',
          );
        }

        // Instead of waiting 120 seconds,
        // make the unacknowledged message visible.
        await sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: originalReceiptHandle,
            VisibilityTimeout: 0,
          }),
        );

        // A new consumer receives the same message.
        const recoveredConsumer =
          new SqsWagerConsumer(
            sqs,
            queueUrl,
            processor(),
          );

        const recovery =
          await recoveredConsumer.pollOnce();

        expect(recovery).toEqual({
          received: 1,
          acknowledged: 1,
          duplicates: 1,
          retried: 0,
        });

        // The Inbox caused the second delivery
        // to be acknowledged without a new debit.
        expect(await readBalance(wallet.id))
          .toBe('70.00');

        expect(await debitCount(wallet.id))
          .toBe(1);

        expect(
          await readInbox(messageId),
        ).toHaveLength(1);
      } finally {
        await sqs.send(
          new DeleteQueueCommand({
            QueueUrl: queueUrl,
          }),
        );
      }
    },
    30000,
  );

  test(
    'should roll back Inbox when financial validation fails',
    async () => {
      const queueUrl = await createTestQueue();

      try {
        const wallet = await createWallet();
        const messageId = randomUUID();

        // Valid wallet, wrong player identity.
        // The use case must reject the operation.
        const body = wagerBody(
          wallet,
          messageId,
          {
            playerId: randomUUID(),
          },
        );

        await sendWager(
          queueUrl,
          wallet.id,
          messageId,
          body,
        );

        const consumer = new SqsWagerConsumer(
          sqs,
          queueUrl,
          processor(),
        );

        const result = await consumer.pollOnce();

        expect(result).toEqual({
          received: 1,
          acknowledged: 0,
          duplicates: 0,
          retried: 1,
        });

        // No financial operation was committed.
        expect(await readBalance(wallet.id))
          .toBe('100.00');

        expect(await debitCount(wallet.id))
          .toBe(0);

        // The Inbox INSERT must also roll back.
        expect(
          await readInbox(messageId),
        ).toHaveLength(0);
      } finally {
        await sqs.send(
          new DeleteQueueCommand({
            QueueUrl: queueUrl,
          }),
        );
      }
    },
    30000,
  );
});
