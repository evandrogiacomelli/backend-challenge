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
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
  SQSClient as AwsSqsClient,
} from '@aws-sdk/client-sqs';

import mikroOrmConfig from '../../src/config/mikro-orm.config.js';
import { SqsWagerConsumer } from '../../src/modules/messaging/inbox/infrastructure/sqs/sqs-wager.consumer.js';
import { WalletLedgerEntryEntity } from '../../src/modules/ledger/infrastructure/persistence/wallet-ledger-entry.entity.js';
import { ProcessBetUseCase } from '../../src/modules/wagering/application/use-cases/process-bet.use-case.js';
import { MikroOrmBetTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-bet-transaction-runner.js';
import { CreateWalletUseCase } from '../../src/modules/wallet/application/use-cases/create-wallet.use-case.js';
import { MikroOrmWalletOpeningPersistence } from '../../src/modules/wallet/infrastructure/persistence/mikro-orm-wallet-opening.persistence.js';
import { WalletEntity } from '../../src/modules/wallet/infrastructure/persistence/wallet.entity.js';
import { parseWagerMessage, WAGER_CONSUMER_NAME } from '../../src/modules/messaging/inbox/application/wager-message-envelope.js';
import { ProcessWinUseCase } from '../../src/modules/wagering/application/use-cases/process-win.use-case.js';
import { MikroOrmWinTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-win-transaction-runner.js';
import {
  MikroOrmRollbackTransactionRunner
} from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-rollback-transaction-runner.js';
import { ProcessRollbackUseCase } from '../../src/modules/wagering/application/use-cases/process-rollback.use-case.js';
import {
  MikroOrmRefundTransactionRunner
} from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-refund-transaction-runner.js';
import { ProcessRefundUseCase } from '../../src/modules/wagering/application/use-cases/process-refund.use-case.js';

interface QueuePair {
  sourceUrl: string;
  dlqUrl: string;
}

interface TestWallet {
  id: string;
  playerId: string;
}

let orm: MikroORM;
let sqs: SQSClient;

async function createQueuePair(): Promise<QueuePair> {
  const suffix = randomUUID();

  const dlq = await sqs.send(
    new CreateQueueCommand({
      QueueName: `wager-dlq-test-${suffix}.fifo`,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
      },
    }),
  );

  if (!dlq.QueueUrl) {
    throw new Error('DLQ URL missing');
  }

  const attributes = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlq.QueueUrl,
      AttributeNames: ['QueueArn'],
    }),
  );

  const dlqArn = attributes.Attributes?.QueueArn;
  if (!dlqArn) {
    throw new Error('DLQ ARN missing');
  }

  const source = await sqs.send(
    new CreateQueueCommand({
      QueueName: `wager-source-test-${suffix}.fifo`,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: '30',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: 3,
        }),
      },
    }),
  );

  if (!source.QueueUrl) {
    throw new Error('Source queue URL missing');
  }

  return {
    sourceUrl: source.QueueUrl,
    dlqUrl: dlq.QueueUrl,
  };
}

async function deleteQueuePair(pair: QueuePair): Promise<void> {
  // Delete source first, then its DLQ.
  await sqs.send(
    new DeleteQueueCommand({ QueueUrl: pair.sourceUrl }),
  );
  await sqs.send(
    new DeleteQueueCommand({ QueueUrl: pair.dlqUrl }),
  );
}

async function send(
  queueUrl: string,
  groupId: string,
  body: string,
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageGroupId: groupId,
      // Transport-level dedup ID is unique for an intentional replay.
      // The envelope's messageId stays unchanged for persistent Inbox dedup.
      MessageDeduplicationId: randomUUID(),
      MessageBody: body,
    }),
  );
}

async function receiveFromDlq(
  queueUrl: string,
): Promise<Message | undefined> {
  const response = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 1,
      VisibilityTimeout: 30,
    }),
  );
  return response.Messages?.[0];
}

function fastRetryClient(): SQSClient {
  // Test-only seam: exercise real LocalStack redrive without waiting
  // for the production consumer's exponential visibility backoff.
  return {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof ChangeMessageVisibilityCommand) {
        return sqs.send(
          new ChangeMessageVisibilityCommand({
            ...command.input,
            VisibilityTimeout: 0,
          }),
        );
      }
      return sqs.send(command as never);
    },
  } as unknown as SQSClient;
}

function failingProcessor(): ProcessBetUseCase {
  return {
    async execute(): Promise<never> {
      throw new Error('SIMULATED_PERSISTENT_FAILURE');
    },
  } as unknown as ProcessBetUseCase;
}

function realProcessor(): ProcessBetUseCase {
  return new ProcessBetUseCase(
    new MikroOrmBetTransactionRunner(orm.em.fork()),
  );
}

async function createWallet(): Promise<TestWallet> {
  const playerId = randomUUID();
  const useCase = new CreateWalletUseCase(
    new MikroOrmWalletOpeningPersistence(orm.em.fork()),
  );
  const result = await useCase.execute({
    playerId,
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  return { id: result.id, playerId };
}

function validEnvelope(wallet: TestWallet): string {
  return JSON.stringify({
    messageId: randomUUID(),
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'dlq-integration-provider',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: randomUUID(),
      gameId: 'dlq-integration-game',
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
    },
  });
}

async function drainUntilDlq(
  pair: QueuePair,
  processor: ProcessBetUseCase,
): Promise<{ message: Message; failures: number }> {
  const consumer = new SqsWagerConsumer(
    fastRetryClient(),
    pair.sourceUrl,
    processor,
  );
  let failures = 0;

  // AWS may transfer on a receive subsequent to maxReceiveCount.
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await consumer.pollOnce();
    failures += result.retried;

    const message = await receiveFromDlq(pair.dlqUrl);
    if (message) {
      return { message, failures };
    }
  }

  throw new Error('Message was not moved into DLQ');
}

async function walletBalance(walletId: string): Promise<string> {
  const wallet = await orm.em.fork().findOneOrFail(
    WalletEntity,
    walletId,
  );
  return String(wallet.balanceAmount);
}

async function debitCount(walletId: string): Promise<number> {
  return orm.em.fork().count(WalletLedgerEntryEntity, {
    wallet: walletId,
    direction: 'DEBIT',
  });
}


type ReversalKind = 'REFUND' | 'ROLLBACK';

/**
 * Preserve the original wager context (provider, wallet, player, round and game).
 * A reversal with a different round/game may be correctly rejected by the domain.
 */
function reversalEnvelope(
  originalEnvelope: string,
  kind: ReversalKind,
  referenceExternalTransactionId?: string,
): string {
  const original = JSON.parse(originalEnvelope) as {
    messageId: string;
    data: Record<string, unknown>;
    [key: string]: unknown;
  };

  return JSON.stringify({
    ...original,
    messageId: randomUUID(),
    data: {
      ...original.data,
      kind,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      ...(referenceExternalTransactionId === undefined
        ? {}
        : { referenceExternalTransactionId }),
    },
  });
}

function reversalConsumer(
  queueUrl: string,
  client: SQSClient,
  fail: boolean,
): SqsWagerConsumer {
  const failingReversal = {
    async execute(): Promise<never> {
      throw new Error(
        'SIMULATED_REVERSAL_DATABASE_OUTAGE',
      );
    },
  };

  const refund = fail
    ? failingReversal as unknown as ProcessRefundUseCase
    : new ProcessRefundUseCase(
      new MikroOrmRefundTransactionRunner(
        orm.em.fork(),
      ),
    );

  const rollback = fail
    ? failingReversal as unknown as ProcessRollbackUseCase
    : new ProcessRollbackUseCase(
      new MikroOrmRollbackTransactionRunner(
        orm.em.fork(),
      ),
    );

  return new SqsWagerConsumer(
    client,
    queueUrl,
    realProcessor(),
    undefined,
    undefined,
    refund,
    rollback,
  );
}

async function drainReversalUntilDlq(
  pair: QueuePair,
): Promise<{
  message: Message;
  failures: number;
}> {
  const consumer = reversalConsumer(
    pair.sourceUrl,
    fastRetryClient(),
    true,
  );

  let failures = 0;

  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await consumer.pollOnce();

    failures += result.retried;

    const message = await receiveFromDlq(
      pair.dlqUrl,
    );

    if (message) {
      return {
        message,
        failures,
      };
    }
  }

  throw new Error(
    'Reversal message was not moved to DLQ',
  );
}

async function reversalSnapshot(
  walletId: string,
  providerId: string,
  externalTransactionId: string,
  messageId: string,
  kind: ReversalKind,
) {
  const rows = await orm.em.fork().execute<
    Array<{
      balance: string;
      ledger_count: number;
      position_count: number;
      reversal_count: number;
      outbox_count: number;
      inbox_count: number;
    }>
  >(
    `
      SELECT
        w.balance_amount::text AS balance,

        (
          SELECT COUNT(*)::int
          FROM wallet_ledger_entries l
          WHERE l.wallet_id = w.id
        ) AS ledger_count,

        (
          SELECT COUNT(*)::int
          FROM wallet_ledger_positions p
          WHERE p.wallet_id = w.id
        ) AS position_count,

        (
          SELECT COUNT(*)::int
          FROM wager_transactions t
          WHERE t.wallet_id = w.id
            AND t.provider_id = ?
            AND t.external_transaction_id = ?
            AND t.kind = ?
        ) AS reversal_count,

        (
          SELECT COUNT(*)::int
          FROM outbox_messages o
          WHERE o.aggregate_id = w.id
            AND o.event_type = ?
        ) AS outbox_count,

        (
          SELECT COUNT(*)::int
          FROM inbox_messages i
          WHERE i.consumer_name = ?
            AND i.message_id = ?
        ) AS inbox_count

      FROM wallets w
      WHERE w.id = ?
    `,
    [
      providerId,
      externalTransactionId,
      kind,
      kind === 'REFUND'
        ? 'wager.refund.processed.v1'
        : 'wager.rollback.processed.v1',
      WAGER_CONSUMER_NAME,
      messageId,
      walletId,
    ],
    'all',
  );

  if (!rows[0]) {
    throw new Error('Wallet not found');
  }

  return rows[0];
}


beforeAll(async () => {
  orm = await MikroORM.init(mikroOrmConfig);
  sqs = new AwsSqsClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
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

describe('SQS FIFO DLQ and recovery', () => {
  test('should send malformed messages to the real DLQ', async () => {
    const pair = await createQueuePair();
    const malformed = '{"messageId":';

    try {
      await send(pair.sourceUrl, randomUUID(), malformed);

      const { message, failures } = await drainUntilDlq(
        pair,
        failingProcessor(),
      );

      expect(failures).toBeGreaterThanOrEqual(3);
      expect(message.Body).toBe(malformed);
      expect(message.ReceiptHandle).toBeDefined();
    } finally {
      await deleteQueuePair(pair);
    }
  }, 60000);

  test('should ACK a transient failure without going to DLQ', async () => {
    const pair = await createQueuePair();
    let calls = 0;

    const transient = {
      async execute(): Promise<{ status: string }> {
        calls++;
        if (calls === 1) {
          throw new Error('SIMULATED_TRANSIENT_FAILURE');
        }
        return { status: 'PROCESSED' };
      },
    } as unknown as ProcessBetUseCase;

    const wallet = {
      id: randomUUID(),
      playerId: randomUUID(),
    };

    try {
      await send(pair.sourceUrl, wallet.id, validEnvelope(wallet));
      const consumer = new SqsWagerConsumer(
        fastRetryClient(),
        pair.sourceUrl,
        transient,
      );

      const first = await consumer.pollOnce();
      const second = await consumer.pollOnce();

      expect(first.retried).toBe(1);
      expect(first.acknowledged).toBe(0);
      expect(second.acknowledged).toBe(1);
      expect(second.retried).toBe(0);
      expect(calls).toBe(2);
      expect(await receiveFromDlq(pair.dlqUrl)).toBeUndefined();
    } finally {
      await deleteQueuePair(pair);
    }
  }, 60000);

  test('should safely replay unchanged DLQ envelope and avoid a second debit', async () => {
    const pair = await createQueuePair();
    const wallet = await createWallet();
    const envelope = validEnvelope(wallet);

    try {
      await send(pair.sourceUrl, wallet.id, envelope);

      // Infrastructure unavailable throughout normal retries.
      const { message } = await drainUntilDlq(
        pair,
        failingProcessor(),
      );

      expect(message.Body).toBe(envelope);
      expect(await walletBalance(wallet.id)).toBe('100.00');
      expect(await debitCount(wallet.id)).toBe(0);

      // Operator has resolved the outage: send UNMODIFIED body.
      // Use a new SQS dedup ID to bypass its five-minute cache.
      await send(pair.sourceUrl, wallet.id, message.Body!);

      // Delete from DLQ only AFTER successful re-publication.
      await sqs.send(new DeleteMessageCommand({
        QueueUrl: pair.dlqUrl,
        ReceiptHandle: message.ReceiptHandle!,
      }));

      const consumer = new SqsWagerConsumer(
        sqs,
        pair.sourceUrl,
        realProcessor(),
      );

      const recovered = await consumer.pollOnce();
      expect(recovered.acknowledged).toBe(1);
      expect(recovered.duplicates).toBe(0);
      expect(await walletBalance(wallet.id)).toBe('70.00');
      expect(await debitCount(wallet.id)).toBe(1);

      // A later operator replay of the same envelope must be harmless.
      await send(pair.sourceUrl, wallet.id, envelope);
      const duplicate = await consumer.pollOnce();

      expect(duplicate.acknowledged).toBe(1);
      expect(duplicate.duplicates).toBe(1);
      expect(await walletBalance(wallet.id)).toBe('70.00');
      expect(await debitCount(wallet.id)).toBe(1);
    } finally {
      await deleteQueuePair(pair);
    }
  }, 60000);


  for (const kind of ['REFUND', 'ROLLBACK'] as const) {
    test(`${kind} without reference reaches DLQ without moving money`, async () => {
      const pair = await createQueuePair();
      const wallet = await createWallet();
      const original = validEnvelope(wallet);
      const envelope = reversalEnvelope(original, kind);
      const parsed = JSON.parse(envelope) as {
        messageId: string;
        data: { providerId: string; externalTransactionId: string };
      };

      try {
        await send(pair.sourceUrl, wallet.id, envelope);

        const { message, failures } = await drainReversalUntilDlq(pair);

        expect(failures).toBeGreaterThanOrEqual(3);
        expect(message.Body).toBe(envelope);

        const snapshot = await reversalSnapshot(
          wallet.id,
          parsed.data.providerId,
          parsed.data.externalTransactionId,
          parsed.messageId,
          kind,
        );

        expect(snapshot.balance).toBe('100.00');
        expect(snapshot.ledger_count).toBe(1);
        expect(snapshot.position_count).toBe(1);
        expect(snapshot.reversal_count).toBe(0);
        expect(snapshot.outbox_count).toBe(0);
        expect(snapshot.inbox_count).toBe(0);
      } finally {
        await deleteQueuePair(pair);
      }
    }, 60000);

    test(`${kind} recovers from DLQ without duplicate money movement`, async () => {
      const pair = await createQueuePair();
      const wallet = await createWallet();
      const originalEnvelope = validEnvelope(wallet);
      const parsedOriginal = parseWagerMessage(originalEnvelope);

      if (parsedOriginal.kind !== 'BET') {
        throw new Error('Expected BET fixture');
      }

      try {
        // Construct the original transaction in the exact context
        // the reversal must reference (wallet, player, provider, round, game).
        if (kind === 'REFUND') {
          await realProcessor().execute(parsedOriginal.input);
        } else {
          await new ProcessWinUseCase(
            new MikroOrmWinTransactionRunner(orm.em.fork()),
          ).execute(parsedOriginal.input);
        }

        const originalBalance = kind === 'REFUND' ? '70.00' : '130.00';
        expect(await walletBalance(wallet.id)).toBe(originalBalance);

        const envelope = reversalEnvelope(
          originalEnvelope,
          kind,
          parsedOriginal.input.externalTransactionId,
        );
        const parsed = JSON.parse(envelope) as {
          messageId: string;
          data: { providerId: string; externalTransactionId: string };
        };

        await send(pair.sourceUrl, wallet.id, envelope);
        const { message, failures } = await drainReversalUntilDlq(pair);

        expect(failures).toBeGreaterThanOrEqual(3);
        expect(message.Body).toBe(envelope);

        const beforeReplay = await reversalSnapshot(
          wallet.id,
          parsed.data.providerId,
          parsed.data.externalTransactionId,
          parsed.messageId,
          kind,
        );
        expect(beforeReplay.balance).toBe(originalBalance);
        expect(beforeReplay.ledger_count).toBe(2);
        expect(beforeReplay.position_count).toBe(2);
        expect(beforeReplay.reversal_count).toBe(0);
        expect(beforeReplay.outbox_count).toBe(0);
        expect(beforeReplay.inbox_count).toBe(0);

        // Simulate recovery of the infrastructure: publish the SAME
        // envelope with a new SQS transport-level deduplication ID.
        await send(pair.sourceUrl, wallet.id, message.Body!);
        await sqs.send(new DeleteMessageCommand({
          QueueUrl: pair.dlqUrl,
          ReceiptHandle: message.ReceiptHandle!,
        }));

        const consumer = reversalConsumer(pair.sourceUrl, sqs, false);
        const recovered = await consumer.pollOnce();
        expect(recovered.acknowledged).toBe(1);
        expect(recovered.duplicates).toBe(0);

        const afterReplay = await reversalSnapshot(
          wallet.id,
          parsed.data.providerId,
          parsed.data.externalTransactionId,
          parsed.messageId,
          kind,
        );
        expect(afterReplay.balance).toBe('100.00');
        expect(afterReplay.ledger_count).toBe(3);
        expect(afterReplay.position_count).toBe(3);
        expect(afterReplay.reversal_count).toBe(1);
        expect(afterReplay.outbox_count).toBe(1);
        expect(afterReplay.inbox_count).toBe(1);

        // An additional DLQ replay must be recognized by the Inbox.
        await send(pair.sourceUrl, wallet.id, envelope);
        const duplicate = await consumer.pollOnce();
        expect(duplicate.acknowledged).toBe(1);
        expect(duplicate.duplicates).toBe(1);

        const finalState = await reversalSnapshot(
          wallet.id,
          parsed.data.providerId,
          parsed.data.externalTransactionId,
          parsed.messageId,
          kind,
        );
        expect(finalState).toEqual(afterReplay);
      } finally {
        await deleteQueuePair(pair);
      }
    }, 60000);
  }

});
