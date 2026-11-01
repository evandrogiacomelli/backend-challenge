import { randomUUID } from 'node:crypto';

import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';

import mikroOrmConfig from '../../src/config/mikro-orm.config.js';

import {
  WAGER_CONSUMER_NAME,
} from '../../src/modules/messaging/inbox/application/wager-message-envelope.js';

import {
  SqsWagerConsumer,
} from '../../src/modules/messaging/inbox/infrastructure/sqs/sqs-wager.consumer.js';

import {
  CreateWalletUseCase,
} from '../../src/modules/wallet/application/use-cases/create-wallet.use-case.js';

import {
  MikroOrmWalletOpeningPersistence,
} from '../../src/modules/wallet/infrastructure/persistence/mikro-orm-wallet-opening.persistence.js';

import {
  ProcessBetUseCase,
} from '../../src/modules/wagering/application/use-cases/process-bet.use-case.js';

import {
  ProcessWinUseCase,
} from '../../src/modules/wagering/application/use-cases/process-win.use-case.js';

import {
  ProcessRefundUseCase,
} from '../../src/modules/wagering/application/use-cases/process-refund.use-case.js';

import {
  ProcessRollbackUseCase,
} from '../../src/modules/wagering/application/use-cases/process-rollback.use-case.js';

import {
  MikroOrmBetTransactionRunner,
} from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-bet-transaction-runner.js';

import {
  MikroOrmWinTransactionRunner,
} from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-win-transaction-runner.js';

import {
  MikroOrmRefundTransactionRunner,
} from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-refund-transaction-runner.js';

import {
  MikroOrmRollbackTransactionRunner,
} from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-rollback-transaction-runner.js';

import {
  MikroOrmPendingReferenceClaimer,
} from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-pending-reference-claimer.js';

import {
  MikroOrmPendingReferenceRecovery,
} from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-pending-reference-recovery.js';

import {
  WagerTransactionStatus,
} from '../../src/modules/wagering/domain/wager-transaction.js';

type ReversalKind = 'REFUND' | 'ROLLBACK';

interface Fixture {
  walletId: string;
  playerId: string;
  providerId: string;
  roundId: string;
  gameId: string;
}

interface ReversalInput {
  kind: ReversalKind;
  fixture: Fixture;
  externalTransactionId: string;
  referenceExternalTransactionId: string;
  messageId: string;
}

let orm: MikroORM;
let sqs: SQSClient;
let queueUrl: string;

function consumer(
  client: SQSClient = sqs,
): SqsWagerConsumer {
  return new SqsWagerConsumer(
    client,
    queueUrl,
    new ProcessBetUseCase(
      new MikroOrmBetTransactionRunner(
        orm.em.fork(),
      ),
    ),
    new ProcessWinUseCase(
      new MikroOrmWinTransactionRunner(
        orm.em.fork(),
      ),
    ),
    undefined,
    new ProcessRefundUseCase(
      new MikroOrmRefundTransactionRunner(
        orm.em.fork(),
      ),
    ),
    new ProcessRollbackUseCase(
      new MikroOrmRollbackTransactionRunner(
        orm.em.fork(),
      ),
    ),
  );
}

async function createFixture(): Promise<Fixture> {
  const playerId = randomUUID();

  const wallet = await new CreateWalletUseCase(
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
    walletId: wallet.id,
    playerId,
    providerId: `sqs-reversal-${randomUUID()}`,
    roundId: randomUUID(),
    gameId: 'sqs-reversal-integration',
  };
}

async function createBet(
  fixture: Fixture,
  externalTransactionId: string,
) {
  return new ProcessBetUseCase(
    new MikroOrmBetTransactionRunner(
      orm.em.fork(),
    ),
  ).execute({
    providerId: fixture.providerId,
    externalTransactionId,
    idempotencyKey: randomUUID(),
    walletId: fixture.walletId,
    playerId: fixture.playerId,
    roundId: fixture.roundId,
    gameId: fixture.gameId,
    amount: '30.00',
    currency: 'BRL',
  });
}

async function createWin(
  fixture: Fixture,
  externalTransactionId: string,
) {
  return new ProcessWinUseCase(
    new MikroOrmWinTransactionRunner(
      orm.em.fork(),
    ),
  ).execute({
    providerId: fixture.providerId,
    externalTransactionId,
    idempotencyKey: randomUUID(),
    walletId: fixture.walletId,
    playerId: fixture.playerId,
    roundId: fixture.roundId,
    gameId: fixture.gameId,
    amount: '30.00',
    currency: 'BRL',
  });
}

function message(input: ReversalInput): string {
  return JSON.stringify({
    messageId: input.messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      kind: input.kind,
      providerId: input.fixture.providerId,
      externalTransactionId:
      input.externalTransactionId,
      idempotencyKey: randomUUID(),
      referenceExternalTransactionId:
      input.referenceExternalTransactionId,
      walletId: input.fixture.walletId,
      playerId: input.fixture.playerId,
      roundId: input.fixture.roundId,
      gameId: input.fixture.gameId,
      money: {
        amount: '30.00',
        currency: 'BRL',
      },
    },
  });
}

async function publish(
  body: string,
  groupId: string,
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: randomUUID(),
    }),
  );
}

async function pollUntilReceived(
  target: SqsWagerConsumer,
) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await target.pollOnce();

    if (result.received === 1) {
      return result;
    }
  }

  throw new Error(
    'LocalStack did not deliver the SQS message',
  );
}

async function inspect(
  fixture: Fixture,
  kind: ReversalKind,
  externalTransactionId: string,
  messageId: string,
) {
  const rows = await orm.em.fork().execute<
    Array<{
      balance: string;
      version: number;
      ledger_count: number;
      positions: number;
      reversals: number;
      reversal_events: number;
      inbox_count: number;
      inbox_processed: number;
    }>
  >(
    `
      SELECT
        w.balance_amount::text AS balance,
        w.version,

        (
          SELECT COUNT(*)::int
          FROM wallet_ledger_entries
          WHERE wallet_id = w.id
        ) AS ledger_count,

        (
          SELECT COUNT(*)::int
          FROM wallet_ledger_positions
          WHERE wallet_id = w.id
        ) AS positions,

        (
          SELECT COUNT(*)::int
          FROM wager_transactions t
          WHERE t.wallet_id = w.id
            AND t.provider_id = ?
            AND t.external_transaction_id = ?
            AND t.kind = ?
        ) AS reversals,

        (
          SELECT COUNT(*)::int
          FROM outbox_messages o
          WHERE o.aggregate_id = w.id
            AND o.event_type = ?
        ) AS reversal_events,

        (
          SELECT COUNT(*)::int
          FROM inbox_messages i
          WHERE i.consumer_name = ?
            AND i.message_id = ?
        ) AS inbox_count,

        (
          SELECT COUNT(*)::int
          FROM inbox_messages i
          WHERE i.consumer_name = ?
            AND i.message_id = ?
            AND i.processed_at IS NOT NULL
        ) AS inbox_processed

      FROM wallets w
      WHERE w.id = ?
    `,
    [
      fixture.providerId,
      externalTransactionId,
      kind,
      kind === 'REFUND'
        ? 'wager.refund.processed.v1'
        : 'wager.rollback.processed.v1',
      WAGER_CONSUMER_NAME,
      messageId,
      WAGER_CONSUMER_NAME,
      messageId,
      fixture.walletId,
    ],
    'all',
  );

  if (!rows[0]) {
    throw new Error('Wallet not found');
  }

  return rows[0];
}

async function findReversal(
  providerId: string,
  externalTransactionId: string,
) {
  const rows = await orm.em.fork().execute<
    Array<{
      id: string;
      kind: string;
      status: string;
      reference_transaction_id: string | null;
    }>
  >(
    `
      SELECT
        id,
        kind,
        status,
        reference_transaction_id
      FROM wager_transactions
      WHERE provider_id = ?
        AND external_transaction_id = ?
    `,
    [providerId, externalTransactionId],
    'all',
  );

  return rows[0] ?? null;
}

beforeAll(async () => {
  orm = await MikroORM.init(mikroOrmConfig);

  sqs = new SQSClient({
    endpoint:
      process.env.SQS_ENDPOINT ??
      'http://localhost:4566',
    region:
      process.env.AWS_REGION ??
      'us-east-1',
    credentials: {
      accessKeyId: 'test',
      secretAccessKey: 'test',
    },
    maxAttempts: 2,
  });

  const result = await sqs.send(
    new CreateQueueCommand({
      QueueName:
        `wager-reversals-${randomUUID()}.fifo`,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
      },
    }),
  );

  if (!result.QueueUrl) {
    throw new Error(
      'LocalStack did not return a queue URL',
    );
  }

  queueUrl = result.QueueUrl;
});

afterAll(async () => {
  try {
    if (sqs && queueUrl) {
      await sqs.send(
        new DeleteQueueCommand({
          QueueUrl: queueUrl,
        }),
      );
    }
  } finally {
    sqs?.destroy();
    await orm?.close(true);
  }
});

describe(
  'Real SQS FIFO + PostgreSQL reversal integration',
  () => {
    test(
      'processes REFUND exactly once with Inbox, ledger and Outbox',
      async () => {
        const fixture = await createFixture();

        const betExternalId = randomUUID();
        const refundExternalId = randomUUID();
        const messageId = randomUUID();

        const bet = await createBet(
          fixture,
          betExternalId,
        );

        expect(bet.status).toBe(
          WagerTransactionStatus.Processed,
        );

        const payload = message({
          kind: 'REFUND',
          fixture,
          externalTransactionId:
          refundExternalId,
          referenceExternalTransactionId:
          betExternalId,
          messageId,
        });

        await publish(payload, fixture.walletId);

        const result = await pollUntilReceived(
          consumer(),
        );

        expect(result.acknowledged).toBe(1);
        expect(result.retried).toBe(0);

        const saved = await inspect(
          fixture,
          'REFUND',
          refundExternalId,
          messageId,
        );

        expect(saved.balance).toBe('100.00');
        expect(saved.version).toBe(3);
        expect(saved.ledger_count).toBe(3);
        expect(saved.positions).toBe(3);
        expect(saved.reversals).toBe(1);
        expect(saved.reversal_events).toBe(1);
        expect(saved.inbox_count).toBe(1);
        expect(saved.inbox_processed).toBe(1);

        const reversal = await findReversal(
          fixture.providerId,
          refundExternalId,
        );

        expect(reversal?.status).toBe('PROCESSED');
        expect(reversal?.reference_transaction_id)
          .toBe(bet.transactionId);
      },
      30000,
    );

    test(
      'processes ROLLBACK WIN with a single DEBIT',
      async () => {
        const fixture = await createFixture();

        const winExternalId = randomUUID();
        const rollbackExternalId = randomUUID();
        const messageId = randomUUID();

        const win = await createWin(
          fixture,
          winExternalId,
        );

        expect(win.status).toBe(
          WagerTransactionStatus.Processed,
        );

        await publish(
          message({
            kind: 'ROLLBACK',
            fixture,
            externalTransactionId:
            rollbackExternalId,
            referenceExternalTransactionId:
            winExternalId,
            messageId,
          }),
          fixture.walletId,
        );

        const result = await pollUntilReceived(
          consumer(),
        );

        expect(result.acknowledged).toBe(1);

        const saved = await inspect(
          fixture,
          'ROLLBACK',
          rollbackExternalId,
          messageId,
        );

        expect(saved.balance).toBe('100.00');
        expect(saved.version).toBe(3);
        expect(saved.ledger_count).toBe(3);
        expect(saved.positions).toBe(3);
        expect(saved.reversals).toBe(1);
        expect(saved.reversal_events).toBe(1);
        expect(saved.inbox_count).toBe(1);
        expect(saved.inbox_processed).toBe(1);

        const reversal = await findReversal(
          fixture.providerId,
          rollbackExternalId,
        );

        expect(reversal?.status).toBe('PROCESSED');
        expect(reversal?.reference_transaction_id)
          .toBe(win.transactionId);
      },
      30000,
    );

    test(
      'ACKs an out-of-order REFUND and recovers the same transaction',
      async () => {
        const fixture = await createFixture();

        const betExternalId = randomUUID();
        const refundExternalId = randomUUID();
        const messageId = randomUUID();

        await publish(
          message({
            kind: 'REFUND',
            fixture,
            externalTransactionId:
            refundExternalId,
            referenceExternalTransactionId:
            betExternalId,
            messageId,
          }),
          fixture.walletId,
        );

        const consumed = await pollUntilReceived(
          consumer(),
        );

        expect(consumed.acknowledged).toBe(1);

        const pending = await findReversal(
          fixture.providerId,
          refundExternalId,
        );

        expect(pending?.status).toBe(
          'PENDING_REFERENCE',
        );

        const pendingState = await inspect(
          fixture,
          'REFUND',
          refundExternalId,
          messageId,
        );

        expect(pendingState.balance).toBe('100.00');
        expect(pendingState.version).toBe(1);
        expect(pendingState.ledger_count).toBe(1);
        expect(pendingState.reversal_events).toBe(0);
        expect(pendingState.inbox_processed).toBe(1);

        const bet = await createBet(
          fixture,
          betExternalId,
        );

        const claimer =
          new MikroOrmPendingReferenceClaimer(
            orm.em.fork(),
          );

        const claims = await claimer.claimDue({
          providerId: fixture.providerId,
          limit: 1,
          leaseSeconds: 120,
        });

        expect(claims).toHaveLength(1);

        const recovered =
          await new MikroOrmPendingReferenceRecovery(
            orm.em.fork(),
          ).recover(claims[0]!);

        expect(recovered.status).toBe('PROCESSED');

        const final = await findReversal(
          fixture.providerId,
          refundExternalId,
        );

        expect(final?.id).toBe(pending?.id);
        expect(final?.status).toBe('PROCESSED');
        expect(final?.reference_transaction_id)
          .toBe(bet.transactionId);

        const finalState = await inspect(
          fixture,
          'REFUND',
          refundExternalId,
          messageId,
        );

        expect(finalState.balance).toBe('100.00');
        expect(finalState.version).toBe(3);
        expect(finalState.ledger_count).toBe(3);
        expect(finalState.positions).toBe(3);
        expect(finalState.reversals).toBe(1);
        expect(finalState.reversal_events).toBe(1);
        expect(finalState.inbox_count).toBe(1);
      },
      30000,
    );

    test(
      'redelivery after failed SQS ACK does not duplicate REFUND',
      async () => {
        const fixture = await createFixture();

        const betExternalId = randomUUID();
        const refundExternalId = randomUUID();
        const messageId = randomUUID();

        await createBet(
          fixture,
          betExternalId,
        );

        await publish(
          message({
            kind: 'REFUND',
            fixture,
            externalTransactionId:
            refundExternalId,
            referenceExternalTransactionId:
            betExternalId,
            messageId,
          }),
          fixture.walletId,
        );

        let failDelete = true;
        let failedReceiptHandle: string | undefined;

        // Forward actual SQS calls to LocalStack,
        // but fail the first ACK after SQL commits.
        const failingClient = {
          async send(command: object) {
            if (
              command instanceof ReceiveMessageCommand
            ) {
              return sqs.send(command);
            }

            if (
              command instanceof DeleteMessageCommand
            ) {
              if (failDelete) {
                failDelete = false;
                failedReceiptHandle =
                  command.input.ReceiptHandle;

                throw new Error(
                  'Simulated ACK failure',
                );
              }

              return sqs.send(command);
            }

            if (
              command instanceof
              ChangeMessageVisibilityCommand
            ) {
              return sqs.send(command);
            }

            throw new Error(
              'Unexpected SQS command',
            );
          },
        } as unknown as SQSClient;

        await expect(
          pollUntilReceived(
            consumer(failingClient),
          ),
        ).rejects.toThrow(
          'Simulated ACK failure',
        );

        const committed = await inspect(
          fixture,
          'REFUND',
          refundExternalId,
          messageId,
        );

        expect(committed.balance).toBe('100.00');
        expect(committed.version).toBe(3);
        expect(committed.ledger_count).toBe(3);
        expect(committed.reversals).toBe(1);
        expect(committed.inbox_processed).toBe(1);

        if (!failedReceiptHandle) {
          throw new Error(
            'Expected the first ACK to fail',
          );
        }

        // Simulate SQS visibility timeout expiration.
        await sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: failedReceiptHandle,
            VisibilityTimeout: 0,
          }),
        );

        // The real consumer reads the redelivery.
        const replay = await pollUntilReceived(
          consumer(),
        );

        expect(replay.acknowledged).toBe(1);
        expect(replay.duplicates).toBe(1);
        expect(replay.retried).toBe(0);

        const final = await inspect(
          fixture,
          'REFUND',
          refundExternalId,
          messageId,
        );

        // Financial state must be identical.
        expect(final).toEqual(committed);
      },
      30000,
    );


    test(
      'ROLLBACK redelivery after failed SQS ACK does not debit twice',
      async () => {
        const fixture = await createFixture();

        const winExternalId = randomUUID();
        const rollbackExternalId = randomUUID();
        const messageId = randomUUID();

        await createWin(
          fixture,
          winExternalId,
        );

        await publish(
          message({
            kind: 'ROLLBACK',
            fixture,
            externalTransactionId: rollbackExternalId,
            referenceExternalTransactionId: winExternalId,
            messageId,
          }),
          fixture.walletId,
        );

        let failNextDelete = true;
        let receiptHandle: string | undefined;

        const failingClient = {
          async send(command: object) {
            if (command instanceof DeleteMessageCommand) {
              if (failNextDelete) {
                failNextDelete = false;
                receiptHandle =
                  command.input.ReceiptHandle;

                throw new Error(
                  'Simulated ROLLBACK ACK failure',
                );
              }
            }

            return sqs.send(
              command as Parameters<
                typeof sqs.send
              >[0],
            );
          },
        } as unknown as SQSClient;

        // PostgreSQL commits the ROLLBACK,
        // but the SQS ACK fails.
        await expect(
          pollUntilReceived(
            consumer(failingClient),
          ),
        ).rejects.toThrow(
          'Simulated ROLLBACK ACK failure',
        );

        const committed = await inspect(
          fixture,
          'ROLLBACK',
          rollbackExternalId,
          messageId,
        );

        expect(committed.balance).toBe('100.00');
        expect(committed.version).toBe(3);
        expect(committed.ledger_count).toBe(3);
        expect(committed.positions).toBe(3);
        expect(committed.reversals).toBe(1);
        expect(committed.reversal_events).toBe(1);
        expect(committed.inbox_count).toBe(1);
        expect(committed.inbox_processed).toBe(1);

        if (!receiptHandle) {
          throw new Error(
            'Missing SQS receipt handle',
          );
        }

        // Make the same message visible again.
        await sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: receiptHandle,
            VisibilityTimeout: 0,
          }),
        );

        // The real SQS FIFO queue redelivers it.
        const replay = await pollUntilReceived(
          consumer(),
        );

        expect(replay).toEqual({
          received: 1,
          acknowledged: 1,
          duplicates: 1,
          retried: 0,
        });

        const afterReplay = await inspect(
          fixture,
          'ROLLBACK',
          rollbackExternalId,
          messageId,
        );

        // No second debit, ledger entry,
        // transaction or Outbox event.
        expect(afterReplay).toEqual(committed);

        const saved = await findReversal(
          fixture.providerId,
          rollbackExternalId,
        );

        expect(saved?.status).toBe('PROCESSED');
      },
      30000,
    );

  },
);
