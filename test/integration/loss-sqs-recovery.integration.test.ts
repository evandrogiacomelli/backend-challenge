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
  DeleteMessageCommand,
  DeleteQueueCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

import mikroOrmConfig from '../../src/config/mikro-orm.config.js';

import { CreateWalletUseCase } from '../../src/modules/wallet/application/use-cases/create-wallet.use-case.js';
import { MikroOrmWalletOpeningPersistence } from '../../src/modules/wallet/infrastructure/persistence/mikro-orm-wallet-opening.persistence.js';

import { ProcessBetUseCase } from '../../src/modules/wagering/application/use-cases/process-bet.use-case.js';
import { ProcessWinUseCase } from '../../src/modules/wagering/application/use-cases/process-win.use-case.js';
import { ProcessLossUseCase } from '../../src/modules/wagering/application/use-cases/process-loss.use-case.js';

import { MikroOrmLossTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-loss-transaction-runner.js';
import { SqsWagerConsumer } from '../../src/modules/messaging/inbox/infrastructure/sqs/sqs-wager.consumer.js';

let orm: MikroORM;
let sqs: SQSClient;

interface FinancialState {
  balance: string;
  version: number;
  losses: number;
  ledger: number;
  outbox: number;
  inbox: number;
}

async function createWallet() {
  const playerId = randomUUID();

  const result = await new CreateWalletUseCase(
    new MikroOrmWalletOpeningPersistence(
      orm.em.fork(),
    ),
  ).execute({
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

function lossProcessor() {
  return new ProcessLossUseCase(
    new MikroOrmLossTransactionRunner(
      orm.em.fork(),
    ),
  );
}

async function inspect(
  walletId: string,
  messageId: string,
): Promise<FinancialState> {
  const rows = await orm.em.fork().execute<
    FinancialState[]
  >(
    `
    SELECT
      w.balance_amount::text AS balance,
      w.version,

      (
        SELECT COUNT(*)::int
        FROM wager_transactions
        WHERE wallet_id = w.id AND kind = 'LOSS'
      ) AS losses,

      (
        SELECT COUNT(*)::int
        FROM wallet_ledger_entries
        WHERE wallet_id = w.id
      ) AS ledger,

      (
        SELECT COUNT(*)::int
        FROM outbox_messages
        WHERE aggregate_id = w.id
          AND event_type = 'wager.loss.processed.v1'
      ) AS outbox,

      (
        SELECT COUNT(*)::int
        FROM inbox_messages
        WHERE consumer_name = 'wager-transactions-v1'
          AND message_id = ?
          AND processed_at IS NOT NULL
      ) AS inbox

    FROM wallets w
    WHERE w.id = ?
    `,
    [messageId, walletId],
    'all',
  );

  if (!rows[0]) {
    throw new Error('Wallet not found');
  }

  return rows[0];
}

function consumer(
  client: SQSClient,
  queueUrl: string,
) {
  // BET and WIN must never be invoked for
  // a LOSS envelope in this integration test.
  const forbiddenBet = {
    async execute() {
      throw new Error('Unexpected BET routing');
    },
  } as unknown as ProcessBetUseCase;

  const forbiddenWin = {
    async execute() {
      throw new Error('Unexpected WIN routing');
    },
  } as unknown as ProcessWinUseCase;

  return new SqsWagerConsumer(
    client,
    queueUrl,
    forbiddenBet,
    forbiddenWin,
    lossProcessor(),
  );
}

beforeAll(async () => {
  orm = await MikroORM.init(mikroOrmConfig);

  sqs = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
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

describe('LOSS SQS crash recovery', () => {
  test(
    'replays LOSS after ACK failure without duplicating transaction or outbox',
    async () => {
      const created = await sqs.send(
        new CreateQueueCommand({
          QueueName:
            `loss-recovery-${randomUUID()}.fifo`,
          Attributes: {
            FifoQueue: 'true',
            ContentBasedDeduplication: 'false',
            VisibilityTimeout: '120',
          },
        }),
      );

      if (!created.QueueUrl) {
        throw new Error('Test queue not created');
      }

      const queueUrl = created.QueueUrl;

      try {
        const wallet = await createWallet();
        const messageId = randomUUID();

        const body = JSON.stringify({
          messageId,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: {
            providerId: 'loss-recovery-tests',
            externalTransactionId: randomUUID(),
            idempotencyKey: randomUUID(),
            walletId: wallet.id,
            playerId: wallet.playerId,
            roundId: randomUUID(),
            gameId: 'loss-recovery-game',
            kind: 'LOSS',
            money: {
              amount: '30.00',
              currency: 'BRL',
            },
          },
        });

        await sqs.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: body,
            MessageGroupId: wallet.id,
            MessageDeduplicationId: messageId,
          }),
        );

        let failedAck = false;
        let receiptHandle: string | undefined;

        const forward = sqs.send.bind(sqs) as unknown as (
          command: unknown,
        ) => Promise<unknown>;

        const crashingSqs = {
          async send(command: unknown) {
            if (
              command instanceof DeleteMessageCommand &&
              !failedAck
            ) {
              failedAck = true;
              receiptHandle =
                command.input.ReceiptHandle;

              throw new Error(
                'SIMULATED_LOSS_ACK_FAILURE',
              );
            }

            return forward(command);
          },
        } as unknown as SQSClient;

        await expect(
          consumer(crashingSqs, queueUrl).pollOnce(),
        ).rejects.toThrow(
          'SIMULATED_LOSS_ACK_FAILURE',
        );

        expect(failedAck).toBe(true);

        const afterCommit = await inspect(
          wallet.id,
          messageId,
        );

        expect(afterCommit.balance).toBe('100.00');
        expect(afterCommit.version).toBe(1);
        expect(afterCommit.losses).toBe(1);
        expect(afterCommit.ledger).toBe(1);
        expect(afterCommit.outbox).toBe(1);
        expect(afterCommit.inbox).toBe(1);

        if (!receiptHandle) {
          throw new Error(
            'Missing SQS receipt handle',
          );
        }

        await sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: receiptHandle,
            VisibilityTimeout: 0,
          }),
        );

        const result = await consumer(
          sqs,
          queueUrl,
        ).pollOnce();

        expect(result).toEqual({
          received: 1,
          acknowledged: 1,
          duplicates: 1,
          retried: 0,
        });

        const afterRecovery = await inspect(
          wallet.id,
          messageId,
        );

        expect(afterRecovery).toEqual(
          afterCommit,
        );
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
