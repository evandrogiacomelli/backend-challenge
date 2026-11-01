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

import { ProcessWinUseCase } from '../../src/modules/wagering/application/use-cases/process-win.use-case.js';
import { MikroOrmWinTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-win-transaction-runner.js';

import { ProcessRollbackUseCase } from '../../src/modules/wagering/application/use-cases/process-rollback.use-case.js';
import { MikroOrmRollbackTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-rollback-transaction-runner.js';

import { MikroOrmPendingReferenceClaimer } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-pending-reference-claimer.js';
import { MikroOrmPendingReferenceRecovery } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-pending-reference-recovery.js';

import { WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction.js';

let orm: MikroORM;

async function fixture() {
  const playerId = randomUUID();
  const providerId = randomUUID();
  const roundId = randomUUID();
  const gameId = 'rollback-concurrency';
  const winExternalId = randomUUID();

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

  async function pendingRollback() {
    const result = await new ProcessRollbackUseCase(
      new MikroOrmRollbackTransactionRunner(
        orm.em.fork(),
      ),
    ).execute({
      providerId,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      referenceExternalTransactionId:
      winExternalId,
      walletId: wallet.id,
      playerId,
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

  async function createWin() {
    const result = await new ProcessWinUseCase(
      new MikroOrmWinTransactionRunner(
        orm.em.fork(),
      ),
    ).execute({
      providerId,
      externalTransactionId: winExternalId,
      idempotencyKey: randomUUID(),
      walletId: wallet.id,
      playerId,
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
    walletId: wallet.id,
    providerId,
    pendingRollback,
    createWin,
  };
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

async function inspect(walletId: string) {
  const rows = await orm.em.fork().execute<
    Array<{
      balance: string;
      version: number;
      ledger_count: number;
      positions: number;
      processed: number;
      rejected: number;
      events: number;
      rollback_debits: number;
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
            AND kind = 'ROLLBACK'
            AND status = 'PROCESSED'
        ) AS processed,

        (
          SELECT COUNT(*)::int
          FROM wager_transactions
          WHERE wallet_id = w.id
            AND kind = 'ROLLBACK'
            AND status = 'REJECTED'
        ) AS rejected,

        (
          SELECT COUNT(*)::int
          FROM outbox_messages
          WHERE aggregate_id = w.id
            AND event_type =
              'wager.rollback.processed.v1'
        ) AS events,

        (
          SELECT COUNT(*)::int
          FROM wallet_ledger_entries l
          JOIN wager_transactions t
            ON t.id = l.wager_transaction_id
          WHERE l.wallet_id = w.id
            AND t.kind = 'ROLLBACK'
            AND l.direction = 'DEBIT'
        ) AS rollback_debits

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

beforeAll(async () => {
  orm = await MikroORM.init(mikroOrmConfig);
});

afterAll(async () => {
  await orm?.close(true);
});

describe(
  'PostgreSQL concurrent ROLLBACK recovery',
  () => {
    test(
      '50 workers cannot debit the same WIN twice',
      async () => {
        const setup = await fixture();

        const pendingId =
          await setup.pendingRollback();

        await setup.createWin();

        const claims = await claimer().claimDue({
          providerId: setup.providerId,
          limit: 1,
          leaseSeconds: 120,
        });

        expect(claims).toHaveLength(1);
        expect(claims[0]!.id).toBe(pendingId);

        const results = await Promise.all(
          Array.from(
            { length: 50 },
            () => recovery().recover(claims[0]!),
          ),
        );

        expect(
          results.filter(
            (item) => item.status === 'PROCESSED',
          ),
        ).toHaveLength(1);

        expect(
          results.filter(
            (item) => item.status === 'STALE_CLAIM',
          ),
        ).toHaveLength(49);

        const saved = await inspect(
          setup.walletId,
        );

        expect(saved.balance).toBe('100.00');
        expect(saved.version).toBe(3);
        expect(saved.ledger_count).toBe(3);
        expect(saved.positions).toBe(3);
        expect(saved.processed).toBe(1);
        expect(saved.rollback_debits).toBe(1);
        expect(saved.events).toBe(1);
      },
      60000,
    );

    test(
      'two pending ROLLBACKs for the same WIN produce only one debit',
      async () => {
        const setup = await fixture();

        const firstId =
          await setup.pendingRollback();

        const secondId =
          await setup.pendingRollback();

        const winId = await setup.createWin();

        const claims = await claimer().claimDue({
          providerId: setup.providerId,
          limit: 2,
          leaseSeconds: 120,
        });

        expect(claims).toHaveLength(2);

        const results = await Promise.all(
          claims.map((claim) =>
            recovery().recover(claim),
          ),
        );

        expect(
          results.filter(
            (item) => item.status === 'PROCESSED',
          ),
        ).toHaveLength(1);

        expect(
          results.filter(
            (item) => item.status === 'REJECTED',
          ),
        ).toHaveLength(1);

        const transactions =
          await orm.em.fork().execute<
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
              WHERE id IN (?, ?)
            `,
            [firstId, secondId],
            'all',
          );

        expect(transactions).toHaveLength(2);

        const processed = transactions.find(
          (item) => item.status === 'PROCESSED',
        );

        const rejected = transactions.find(
          (item) => item.status === 'REJECTED',
        );

        expect(processed).toBeDefined();
        expect(rejected).toBeDefined();

        expect(
          processed!.reference_transaction_id,
        ).toBe(winId);

        expect(rejected!.failure_code).toBe(
          'REFERENCE_ALREADY_REVERSED',
        );

        const saved = await inspect(
          setup.walletId,
        );

        expect(saved.balance).toBe('100.00');
        expect(saved.version).toBe(3);

        expect(saved.processed).toBe(1);
        expect(saved.rejected).toBe(1);
        expect(saved.rollback_debits).toBe(1);
        expect(saved.events).toBe(1);

        expect(saved.ledger_count).toBe(3);
        expect(saved.positions).toBe(3);
      },
      30000,
    );
  },
);
