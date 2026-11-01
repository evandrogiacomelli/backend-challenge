import { randomUUID } from 'node:crypto';

import {
  beforeAll,
  afterAll,
  describe,
  expect,
  test,
} from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';

import mikroOrmConfig from '../../src/config/mikro-orm.config.js';

import { CreateWalletUseCase } from '../../src/modules/wallet/application/use-cases/create-wallet.use-case.js';

import { MikroOrmWalletOpeningPersistence } from '../../src/modules/wallet/infrastructure/persistence/mikro-orm-wallet-opening.persistence.js';

import { ProcessRefundUseCase } from '../../src/modules/wagering/application/use-cases/process-refund.use-case.js';

import { MikroOrmRefundTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-refund-transaction-runner.js';

import { MikroOrmPendingReferenceClaimer } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-pending-reference-claimer.js';

import { WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction.js';

let orm: MikroORM;

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

async function createPendingRefund(
  providerId: string,
) {
  const wallet = await createWallet();

  const result = await new ProcessRefundUseCase(
    new MikroOrmRefundTransactionRunner(
      orm.em.fork(),
    ),
  ).execute({
    providerId,
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),

    referenceExternalTransactionId:
      randomUUID(),

    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: randomUUID(),
    gameId: 'pending-worker-game',

    amount: '30.00',
    currency: 'BRL',
  });

  expect(result.status).toBe(
    WagerTransactionStatus.PendingReference,
  );

  return {
    wallet,
    transactionId: result.transactionId,
  };
}

function claimer() {
  return new MikroOrmPendingReferenceClaimer(
    orm.em.fork(),
  );
}

async function inspectPending(id: string) {
  const rows = await orm.em.fork().execute<
    Array<{
      status: string;
      attempts: number;
      next_attempt_at: Date | null;
    }>
  >(
    `
      SELECT
        status,
        attempts,
        next_attempt_at
      FROM wager_transactions
      WHERE id = ?
    `,
    [id],
    'all',
  );

  if (!rows[0]) {
    throw new Error(
      'Pending transaction not found',
    );
  }

  return rows[0];
}

async function inspectWallet(id: string) {
  const rows = await orm.em.fork().execute<
    Array<{
      balance: string;
      version: number;
      ledger_count: number;
    }>
  >(
    `
      SELECT
        w.balance_amount::text AS balance,
        w.version,

        (
          SELECT COUNT(*)::int
          FROM wallet_ledger_entries l
          WHERE l.wallet_id = w.id
        ) AS ledger_count

      FROM wallets w
      WHERE w.id = ?
    `,
    [id],
    'all',
  );

  if (!rows[0]) {
    throw new Error('Wallet not found');
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
  'PostgreSQL pending reference claiming',
  () => {
    test(
      'claims a pending operation exactly once during its lease',
      async () => {
        const providerId = randomUUID();

        const fixture =
          await createPendingRefund(providerId);

        const beforeWallet =
          await inspectWallet(fixture.wallet.id);

        const first = await claimer().claimDue({
          providerId,
          limit: 10,
          leaseSeconds: 120,
        });

        expect(first).toHaveLength(1);

        expect(first[0]!.id).toBe(
          fixture.transactionId,
        );

        expect(first[0]!.kind).toBe('REFUND');
        expect(first[0]!.attempts).toBe(1);

        const second = await claimer().claimDue({
          providerId,
          limit: 10,
          leaseSeconds: 120,
        });

        expect(second).toHaveLength(0);

        const pending = await inspectPending(
          fixture.transactionId,
        );

        expect(pending.status).toBe(
          'PENDING_REFERENCE',
        );

        expect(pending.attempts).toBe(1);
        expect(pending.next_attempt_at).not.toBeNull();

        // Claiming is not financial processing.
        expect(
          await inspectWallet(fixture.wallet.id),
        ).toEqual(beforeWallet);
      },
    );

    test(
      '50 concurrent workers claim one pending operation only once',
      async () => {
        const providerId = randomUUID();

        const fixture =
          await createPendingRefund(providerId);

        const results = await Promise.all(
          Array.from(
            { length: 50 },
            () =>
              claimer().claimDue({
                providerId,
                limit: 1,
                leaseSeconds: 120,
              }),
          ),
        );

        const claimed = results.flat();

        expect(claimed).toHaveLength(1);

        expect(claimed[0]!.id).toBe(
          fixture.transactionId,
        );

        const pending = await inspectPending(
          fixture.transactionId,
        );

        expect(pending.attempts).toBe(1);
        expect(pending.status).toBe(
          'PENDING_REFERENCE',
        );
      },
      30000,
    );

    test(
      'expired lease becomes eligible for recovery',
      async () => {
        const providerId = randomUUID();

        const fixture =
          await createPendingRefund(providerId);

        const first = await claimer().claimDue({
          providerId,
          limit: 1,
          leaseSeconds: 120,
        });

        expect(first).toHaveLength(1);

        // Simulate worker crash and lease expiration.
        await orm.em.fork().execute(
          `
            UPDATE wager_transactions
            SET
              next_attempt_at =
                NOW() - INTERVAL '1 second'
            WHERE id = ?
          `,
          [fixture.transactionId],
        );

        const second = await claimer().claimDue({
          providerId,
          limit: 1,
          leaseSeconds: 120,
        });

        expect(second).toHaveLength(1);

        expect(second[0]!.id).toBe(
          fixture.transactionId,
        );

        expect(second[0]!.attempts).toBe(2);

        const saved = await inspectPending(
          fixture.transactionId,
        );

        expect(saved.attempts).toBe(2);
        expect(saved.status).toBe(
          'PENDING_REFERENCE',
        );
      },
    );

    test(
      'multiple pending operations are distributed without duplicate claims',
      async () => {
        const providerId = randomUUID();

        const fixtures = await Promise.all(
          Array.from(
            { length: 8 },
            () => createPendingRefund(providerId),
          ),
        );

        const results = await Promise.all(
          Array.from(
            { length: 8 },
            () =>
              claimer().claimDue({
                providerId,
                limit: 1,
                leaseSeconds: 120,
              }),
          ),
        );

        const claimed = results.flat();

        expect(claimed).toHaveLength(8);

        const ids = claimed.map(
          (item) => item.id,
        );

        expect(new Set(ids).size).toBe(8);

        const expected = new Set(
          fixtures.map(
            (fixture) => fixture.transactionId,
          ),
        );

        for (const id of ids) {
          expect(expected.has(id)).toBe(true);
        }
      },
      30000,
    );
  },
);
