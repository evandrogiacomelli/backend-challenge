import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';

import mikroOrmConfig from '../../src/config/mikro-orm.config.js';

import { CreateWalletUseCase } from '../../src/modules/wallet/application/use-cases/create-wallet.use-case.js';

import { MikroOrmWalletOpeningPersistence } from '../../src/modules/wallet/infrastructure/persistence/mikro-orm-wallet-opening.persistence.js';

import { ProcessBetUseCase } from '../../src/modules/wagering/application/use-cases/process-bet.use-case.js';

import { MikroOrmBetTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-bet-transaction-runner.js';

import { ProcessRefundUseCase } from '../../src/modules/wagering/application/use-cases/process-refund.use-case.js';

import { MikroOrmRefundTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-refund-transaction-runner.js';

import { MikroOrmPendingReferenceClaimer } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-pending-reference-claimer.js';

import { MikroOrmPendingReferenceRecovery } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-pending-reference-recovery.js';

import { WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction.js';

let orm: MikroORM;

function betProcessor() {
  return new ProcessBetUseCase(
    new MikroOrmBetTransactionRunner(
      orm.em.fork(),
    ),
  );
}

function refundProcessor() {
  return new ProcessRefundUseCase(
    new MikroOrmRefundTransactionRunner(
      orm.em.fork(),
    ),
  );
}

function claimer() {
  return new MikroOrmPendingReferenceClaimer(
    orm.em.fork(),
  );
}

function recovery() {
  return new MikroOrmPendingReferenceRecovery(
    orm.em.fork(),
  );
}

async function createWallet() {
  const playerId = randomUUID();

  const created = await new CreateWalletUseCase(
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
    id: created.id,
    playerId,
  };
}

async function createFixture() {
  const wallet = await createWallet();

  const providerId = randomUUID();
  const betExternalId = randomUUID();
  const roundId = randomUUID();
  const gameId = 'recovery-concurrency-game';

  async function pendingRefund() {
    const result = await refundProcessor().execute({
      providerId,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      referenceExternalTransactionId:
      betExternalId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId,
      gameId,
      amount: '30.00',
      currency: 'BRL',
    });

    expect(result.status).toBe(
      WagerTransactionStatus.PendingReference,
    );

    return result.transactionId;
  }

  async function createBet() {
    const result = await betProcessor().execute({
      providerId,
      externalTransactionId: betExternalId,
      idempotencyKey: randomUUID(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId,
      gameId,
      amount: '30.00',
      currency: 'BRL',
    });

    expect(result.status).toBe(
      WagerTransactionStatus.Processed,
    );

    return result.transactionId;
  }

  return {
    wallet,
    providerId,
    pendingRefund,
    createBet,
  };
}

async function inspect(
  walletId: string,
) {
  const rows = await orm.em.fork().execute<
    Array<{
      balance: string;
      version: number;
      ledger_count: number;
      positions: number;
      refunds_processed: number;
      refunds_pending: number;
      refunds_rejected: number;
      refund_events: number;
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
          FROM wager_transactions
          WHERE wallet_id = w.id
            AND kind = 'REFUND'
            AND status = 'PROCESSED'
        ) AS refunds_processed,

        (
          SELECT COUNT(*)::int
          FROM wager_transactions
          WHERE wallet_id = w.id
            AND kind = 'REFUND'
            AND status = 'PENDING_REFERENCE'
        ) AS refunds_pending,

        (
          SELECT COUNT(*)::int
          FROM wager_transactions
          WHERE wallet_id = w.id
            AND kind = 'REFUND'
            AND status = 'REJECTED'
        ) AS refunds_rejected,

        (
          SELECT COUNT(*)::int
          FROM outbox_messages
          WHERE aggregate_id = w.id
            AND event_type =
              'wager.refund.processed.v1'
        ) AS refund_events

      FROM wallets w
      WHERE w.id = ?
    `,
    [walletId],
    'all',
  );

  if (!rows[0]) {
    throw new Error('Wallet not found');
  }

  return rows[0];
}

async function inspectTransaction(
  transactionId: string,
) {
  const rows = await orm.em.fork().execute<
    Array<{
      id: string;
      status: string;
      failure_code: string | null;
      reference_transaction_id: string | null;
    }>
  >(
    `
      SELECT
        id,
        status,
        failure_code,
        reference_transaction_id
      FROM wager_transactions
      WHERE id = ?
    `,
    [transactionId],
    'all',
  );

  if (!rows[0]) {
    throw new Error('Transaction not found');
  }

  return rows[0];
}

beforeAll(async () => {
  orm = await MikroORM.init(mikroOrmConfig);
});

afterAll(async () => {
  await orm?.close(true);
});

describe(
  'PENDING_REFERENCE recovery concurrency and atomicity',
  () => {
    test(
      '50 workers cannot finalize the same claim twice',
      async () => {
        const fixture = await createFixture();

        const pendingId =
          await fixture.pendingRefund();

        const betId =
          await fixture.createBet();

        const claims = await claimer().claimDue({
          providerId: fixture.providerId,
          limit: 1,
          leaseSeconds: 120,
        });

        expect(claims).toHaveLength(1);
        expect(claims[0]!.id).toBe(pendingId);

        // Simulate duplicate delivery of the same
        // claimed work to 50 worker instances.
        const results = await Promise.all(
          Array.from(
            { length: 50 },
            () => recovery().recover(claims[0]!),
          ),
        );

        expect(
          results.filter(
            (result) =>
              result.status === 'PROCESSED',
          ),
        ).toHaveLength(1);

        expect(
          results.filter(
            (result) =>
              result.status === 'STALE_CLAIM',
          ),
        ).toHaveLength(49);

        const saved = await inspect(
          fixture.wallet.id,
        );

        expect(saved.balance).toBe('100.00');
        expect(saved.version).toBe(3);
        expect(saved.ledger_count).toBe(3);
        expect(saved.positions).toBe(3);

        expect(saved.refunds_processed).toBe(1);
        expect(saved.refunds_pending).toBe(0);
        expect(saved.refund_events).toBe(1);

        const transaction =
          await inspectTransaction(pendingId);

        expect(transaction.status)
          .toBe('PROCESSED');

        expect(transaction.id).toBe(pendingId);

        expect(transaction.reference_transaction_id)
          .toBe(betId);
      },
      60000,
    );

    test(
      'two pending REFUNDs for the same BET cannot both credit',
      async () => {
        const fixture = await createFixture();

        // Both are pending before the original BET
        // becomes available.
        const firstId =
          await fixture.pendingRefund();

        const secondId =
          await fixture.pendingRefund();

        const betId =
          await fixture.createBet();

        const claims = await claimer().claimDue({
          providerId: fixture.providerId,
          limit: 2,
          leaseSeconds: 120,
        });

        expect(claims).toHaveLength(2);

        const results = await Promise.all(
          claims.map(
            (claim) => recovery().recover(claim),
          ),
        );

        expect(
          results.filter(
            (result) =>
              result.status === 'PROCESSED',
          ),
        ).toHaveLength(1);

        expect(
          results.filter(
            (result) =>
              result.status === 'REJECTED',
          ),
        ).toHaveLength(1);

        const first =
          await inspectTransaction(firstId);

        const second =
          await inspectTransaction(secondId);

        expect(
          [first.status, second.status].sort(),
        ).toEqual([
          'PROCESSED',
          'REJECTED',
        ]);

        const processed =
          first.status === 'PROCESSED'
            ? first
            : second;

        const rejected =
          first.status === 'REJECTED'
            ? first
            : second;

        expect(
          processed.reference_transaction_id,
        ).toBe(betId);

        expect(rejected.failure_code).toBe(
          'REFERENCE_ALREADY_REVERSED',
        );

        const saved = await inspect(
          fixture.wallet.id,
        );

        // Opening 100, BET -30, one REFUND +30.
        expect(saved.balance).toBe('100.00');
        expect(saved.version).toBe(3);

        expect(saved.refunds_processed).toBe(1);
        expect(saved.refunds_rejected).toBe(1);
        expect(saved.refunds_pending).toBe(0);

        expect(saved.ledger_count).toBe(3);
        expect(saved.positions).toBe(3);
        expect(saved.refund_events).toBe(1);
      },
      30000,
    );

    test(
      'ledger failure rolls back wallet, pending transition and Outbox',
      async () => {
        const fixture = await createFixture();

        const pendingId =
          await fixture.pendingRefund();

        await fixture.createBet();

        const claims = await claimer().claimDue({
          providerId: fixture.providerId,
          limit: 1,
          leaseSeconds: 120,
        });

        expect(claims).toHaveLength(1);

        const before = await inspect(
          fixture.wallet.id,
        );

        const transactionBefore =
          await inspectTransaction(pendingId);

        // Install a test-only PostgreSQL trigger that
        // fails ledger insertion for THIS transaction.
        //
        // Other ledger inserts are unaffected.
        const suffix = randomUUID().replaceAll(
          '-',
          '',
        );

        const functionName =
          `test_fail_pending_ledger_${suffix}`;

        const triggerName =
          `trg_fail_pending_ledger_${suffix}`;

        // Identifiers are generated locally from UUIDs.
        // pendingId also comes from a generated UUID.
        await orm.em.fork().execute(
          `
            CREATE FUNCTION public.${functionName}()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
              IF NEW.wager_transaction_id =
                '${pendingId}'::uuid
              THEN
                RAISE EXCEPTION
                  'Simulated pending recovery ledger failure';
              END IF;

              RETURN NEW;
            END;
            $$;
          `,
        );

        try {
          await orm.em.fork().execute(
            `
              CREATE TRIGGER ${triggerName}
              BEFORE INSERT
              ON wallet_ledger_entries
              FOR EACH ROW
              EXECUTE FUNCTION
                public.${functionName}();
            `,
          );

          await expect(
            recovery().recover(claims[0]!),
          ).rejects.toThrow(
            'Simulated pending recovery ledger failure',
          );

          // All financial SQL writes must roll back.
          const after = await inspect(
            fixture.wallet.id,
          );

          const transactionAfter =
            await inspectTransaction(pendingId);

          expect(after).toEqual(before);

          expect(transactionAfter).toEqual(
            transactionBefore,
          );

          expect(transactionAfter.status)
            .toBe('PENDING_REFERENCE');

          expect(after.balance).toBe('70.00');
          expect(after.version).toBe(2);

          expect(after.refunds_processed).toBe(0);
          expect(after.refunds_pending).toBe(1);

          expect(after.ledger_count).toBe(2);
          expect(after.positions).toBe(2);
          expect(after.refund_events).toBe(0);
        } finally {
          await orm.em.fork().execute(
            `
              DROP TRIGGER IF EXISTS
                ${triggerName}
              ON wallet_ledger_entries;
            `,
          );

          await orm.em.fork().execute(
            `
              DROP FUNCTION IF EXISTS
                public.${functionName}();
            `,
          );
        }

        // Retry after removing the simulated failure.
        // The original lease is still active because
        // the failed recovery transaction rolled back.
        const recovered =
          await recovery().recover(claims[0]!);

        expect(recovered.status).toBe('PROCESSED');

        const final = await inspect(
          fixture.wallet.id,
        );

        expect(final.balance).toBe('100.00');
        expect(final.version).toBe(3);
        expect(final.refunds_processed).toBe(1);
        expect(final.refunds_pending).toBe(0);
        expect(final.ledger_count).toBe(3);
        expect(final.positions).toBe(3);
        expect(final.refund_events).toBe(1);
      },
      30000,
    );
  },
);
