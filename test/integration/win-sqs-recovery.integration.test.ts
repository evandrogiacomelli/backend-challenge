import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { SQSClient as AwsSQSClient } from '@aws-sdk/client-sqs';

import mikroOrmConfig from '../../src/config/mikro-orm.config.js';
import { SqsWagerConsumer } from '../../src/modules/messaging/inbox/infrastructure/sqs/sqs-wager.consumer.js';
import { CreateWalletUseCase } from '../../src/modules/wallet/application/use-cases/create-wallet.use-case.js';
import { MikroOrmWalletOpeningPersistence } from '../../src/modules/wallet/infrastructure/persistence/mikro-orm-wallet-opening.persistence.js';
import { ProcessBetUseCase } from '../../src/modules/wagering/application/use-cases/process-bet.use-case.js';
import { ProcessWinUseCase } from '../../src/modules/wagering/application/use-cases/process-win.use-case.js';
import { MikroOrmBetTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-bet-transaction-runner.js';
import { MikroOrmWinTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-win-transaction-runner.js';

let orm: MikroORM;
let sqs: AwsSQSClient;

type Wallet = { id: string; playerId: string };

async function createWallet(): Promise<Wallet> {
  const playerId = randomUUID();
  const created = await new CreateWalletUseCase(
    new MikroOrmWalletOpeningPersistence(orm.em.fork()),
  ).execute({
    playerId,
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  return { id: created.id, playerId };
}

function makeUseCases() {
  return {
    bet: new ProcessBetUseCase(new MikroOrmBetTransactionRunner(orm.em.fork())),
    win: new ProcessWinUseCase(new MikroOrmWinTransactionRunner(orm.em.fork())),
  };
}

function makeConsumer(queueUrl: string, client: SQSClient = sqs): SqsWagerConsumer {
  const { bet, win } = makeUseCases();
  return new SqsWagerConsumer(client, queueUrl, bet, win);
}

async function createQueue(): Promise<string> {
  const result = await sqs.send(new CreateQueueCommand({
    QueueName: `win-sqs-${randomUUID()}.fifo`,
    Attributes: {
      FifoQueue: 'true',
      ContentBasedDeduplication: 'false',
      VisibilityTimeout: '120',
    },
  }));
  if (!result.QueueUrl) throw new Error('Test SQS FIFO queue was not created');
  return result.QueueUrl;
}

function winBody(wallet: Wallet, messageId: string): string {
  return JSON.stringify({
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'win-sqs-integration',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: randomUUID(),
      gameId: 'win-sqs-test',
      kind: 'WIN',
      money: { amount: '25.00', currency: 'BRL' },
    },
  });
}

async function sendWin(queueUrl: string, wallet: Wallet, messageId: string, body: string) {
  await sqs.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: body,
    MessageGroupId: wallet.id,
    MessageDeduplicationId: messageId,
  }));
}

async function inspect(walletId: string, messageId: string) {
  const rows = await orm.em.fork().execute<Array<{
    balance: string;
    win_count: number;
    credit_count: number;
    outbox_count: number;
    inbox_count: number;
  }>>(
    `SELECT
       w.balance_amount::text AS balance,
       (SELECT COUNT(*)::int FROM wager_transactions t
        WHERE t.wallet_id = w.id AND t.kind = 'WIN') AS win_count,
       (SELECT COUNT(*)::int FROM wallet_ledger_entries l
        JOIN wager_transactions t ON t.id = l.wager_transaction_id
        WHERE l.wallet_id = w.id AND l.direction = 'CREDIT' AND t.kind = 'WIN') AS credit_count,
       (SELECT COUNT(*)::int FROM outbox_messages o
        WHERE o.aggregate_id = w.id AND o.event_type = 'wager.win.processed.v1') AS outbox_count,
       (SELECT COUNT(*)::int FROM inbox_messages i
        WHERE i.consumer_name = 'wager-transactions-v1'
          AND i.message_id = ? AND i.processed_at IS NOT NULL) AS inbox_count
     FROM wallets w WHERE w.id = ?`,
    [messageId, walletId],
    'all',
  );
  return rows[0]!;
}

beforeAll(async () => {
  orm = await MikroORM.init(mikroOrmConfig);
  sqs = new AwsSQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
});

afterAll(async () => {
  sqs?.destroy();
  await orm?.close(true);
});

describe('WIN SQS persistent Inbox and crash recovery', () => {
  test('processes a real FIFO WIN and ACKs after atomic SQL commit', async () => {
    const queueUrl = await createQueue();
    try {
      const wallet = await createWallet();
      const messageId = randomUUID();
      const body = winBody(wallet, messageId);
      await sendWin(queueUrl, wallet, messageId, body);

      const result = await makeConsumer(queueUrl).pollOnce();
      expect(result).toEqual({ received: 1, acknowledged: 1, duplicates: 0, retried: 0 });
      const state = await inspect(wallet.id, messageId);
      expect(state.balance).toBe('125.00');
      expect(state.win_count).toBe(1);
      expect(state.credit_count).toBe(1);
      expect(state.outbox_count).toBe(1);
      expect(state.inbox_count).toBe(1);
    } finally {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    }
  }, 30000);

  test('redelivery after failed WIN ACK cannot credit a second time', async () => {
    const queueUrl = await createQueue();
    try {
      const wallet = await createWallet();
      const messageId = randomUUID();
      const body = winBody(wallet, messageId);
      await sendWin(queueUrl, wallet, messageId, body);

      let crashed = false;
      let receiptHandle: string | undefined;
      const send = sqs.send.bind(sqs) as unknown as (command: unknown) => Promise<unknown>;
      const failingAckClient = {
        async send(command: unknown) {
          if (command instanceof DeleteMessageCommand && !crashed) {
            crashed = true;
            receiptHandle = command.input.ReceiptHandle;
            throw new Error('SIMULATED_CRASH_AFTER_WIN_COMMIT');
          }
          return send(command);
        },
      } as unknown as SQSClient;

      await expect(makeConsumer(queueUrl, failingAckClient).pollOnce())
        .rejects.toThrow('SIMULATED_CRASH_AFTER_WIN_COMMIT');
      expect(crashed).toBe(true);
      const committed = await inspect(wallet.id, messageId);
      expect(committed.balance).toBe('125.00');
      expect(committed.win_count).toBe(1);
      expect(committed.credit_count).toBe(1);
      expect(committed.outbox_count).toBe(1);
      expect(committed.inbox_count).toBe(1);

      if (!receiptHandle) throw new Error('Missing receipt handle');
      await sqs.send(new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: 0,
      }));

      const recovered = await makeConsumer(queueUrl).pollOnce();
      expect(recovered).toEqual({ received: 1, acknowledged: 1, duplicates: 1, retried: 0 });
      const finalState = await inspect(wallet.id, messageId);
      expect(finalState.balance).toBe('125.00');
      expect(finalState.win_count).toBe(1);
      expect(finalState.credit_count).toBe(1);
      expect(finalState.outbox_count).toBe(1);
      expect(finalState.inbox_count).toBe(1);
    } finally {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    }
  }, 30000);
});
