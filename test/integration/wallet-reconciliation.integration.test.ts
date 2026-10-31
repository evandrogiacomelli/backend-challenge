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

import {
  PostgresWalletReconciliationService,
} from '../../src/modules/reconciliation/infrastructure/postgres-wallet-reconciliation.service.js';

import {
  WalletNotFoundError,
} from '../../src/modules/reconciliation/domain/reconciliation-report.js';

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
  MikroOrmBetTransactionRunner,
} from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-bet-transaction-runner.js';

let orm: MikroORM;

interface TestWallet {
  id: string;
  playerId: string;
}

class RollbackTestTransaction extends Error {}

async function createWallet(
  amount: string,
): Promise<TestWallet> {
  const playerId = randomUUID();

  const useCase = new CreateWalletUseCase(
    new MikroOrmWalletOpeningPersistence(
      orm.em.fork(),
    ),
  );

  const result = await useCase.execute({
    playerId,
    initialBalance: {
      amount,
      currency: 'BRL',
    },
  });

  return {
    id: result.id,
    playerId,
  };
}

async function bet(
  wallet: TestWallet,
  amount: string,
): Promise<void> {
  const useCase = new ProcessBetUseCase(
    new MikroOrmBetTransactionRunner(
      orm.em.fork(),
    ),
  );

  await useCase.execute({
    providerId: 'reconciliation-test',
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: randomUUID(),
    gameId: 'reconciliation-test-game',
    amount,
    currency: 'BRL',
  });
}

function reconciler() {
  return new PostgresWalletReconciliationService(
    orm.em.fork(),
  );
}

async function withRollback(
  operation: (
    service: PostgresWalletReconciliationService,
    execute: (
      sql: string,
      params: unknown[],
    ) => Promise<unknown>,
  ) => Promise<void>,
): Promise<void> {
  try {
    await orm.em.fork().transactional(async (tx) => {
      const service =
        new PostgresWalletReconciliationService(tx);

      await operation(
        service,
        async (sql, params) =>
          tx.execute(sql, params),
      );

      // Deliberately abort every simulated corruption.
      throw new RollbackTestTransaction();
    });
  } catch (error) {
    if (!(error instanceof RollbackTestTransaction)) {
      throw error;
    }
  }
}

beforeAll(async () => {
  orm = await MikroORM.init(mikroOrmConfig);
});

afterAll(async () => {
  await orm?.close(true);
});

describe('PostgreSQL Wallet Reconciliation', () => {
  test('should reconcile an empty wallet', async () => {
    const wallet = await createWallet('0.00');

    const result = await reconciler().reconcile(
      wallet.id,
    );

    expect(result.consistent).toBe(true);
    expect(result.actualBalance).toBe('0.00');
    expect(result.expectedBalance).toBe('0.00');
    expect(result.difference).toBe('0.00');
    expect(result.actualVersion).toBe(1);
    expect(result.expectedVersion).toBe(1);
    expect(result.ledgerEntries).toBe(0);
    expect(result.issues).toHaveLength(0);
  });

  test('should include OPENING credit exactly once', async () => {
    const wallet = await createWallet('100.00');

    const result = await reconciler().reconcile(
      wallet.id,
    );

    expect(result.consistent).toBe(true);
    expect(result.actualBalance).toBe('100.00');
    expect(result.expectedBalance).toBe('100.00');
    expect(result.ledgerEntries).toBe(1);
    expect(result.actualVersion).toBe(1);
    expect(result.expectedVersion).toBe(1);
  });

  test('should reconcile a processed BET', async () => {
    const wallet = await createWallet('100.00');

    await bet(wallet, '30.00');

    const result = await reconciler().reconcile(
      wallet.id,
    );

    expect(result.consistent).toBe(true);
    expect(result.actualBalance).toBe('70.00');
    expect(result.expectedBalance).toBe('70.00');
    expect(result.difference).toBe('0.00');
    expect(result.ledgerEntries).toBe(2);
    expect(result.actualVersion).toBe(2);
    expect(result.expectedVersion).toBe(2);
    expect(result.missingLedgerEntries).toBe(0);
    expect(result.issues).toHaveLength(0);
  });

  test('should detect a materialized balance mismatch', async () => {
    const wallet = await createWallet('100.00');

    await bet(wallet, '30.00');

    await withRollback(async (service, execute) => {
      await execute(
        `
        UPDATE wallets
        SET balance_amount = balance_amount + 1.00
        WHERE id = ?
        `,
        [wallet.id],
      );

      const result = await service.reconcile(
        wallet.id,
      );

      expect(result.consistent).toBe(false);
      expect(result.actualBalance).toBe('71.00');
      expect(result.expectedBalance).toBe('70.00');
      expect(result.difference).toBe('1.00');

      expect(
        result.issues.some(
          (issue) =>
            issue.code === 'BALANCE_MISMATCH',
        ),
      ).toBe(true);
    });

    // Test corruption has been rolled back.
    const afterRollback =
      await reconciler().reconcile(wallet.id);

    expect(afterRollback.consistent).toBe(true);
    expect(afterRollback.actualBalance).toBe(
      '70.00',
    );
  });

  test('should detect a wallet version mismatch', async () => {
    const wallet = await createWallet('100.00');

    await bet(wallet, '30.00');

    await withRollback(async (service, execute) => {
      await execute(
        `
        UPDATE wallets
        SET version = version + 1
        WHERE id = ?
        `,
        [wallet.id],
      );

      const result = await service.reconcile(
        wallet.id,
      );

      expect(result.consistent).toBe(false);
      expect(result.actualVersion).toBe(3);
      expect(result.expectedVersion).toBe(2);

      expect(
        result.issues.some(
          (issue) =>
            issue.code === 'VERSION_MISMATCH',
        ),
      ).toBe(true);
    });
  });

  test('should report a nonexistent wallet', async () => {
    await expect(
      reconciler().reconcile(randomUUID()),
    ).rejects.toBeInstanceOf(
      WalletNotFoundError,
    );
  });
});
