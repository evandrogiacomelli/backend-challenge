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
  WalletBatchReconciliationService,
} from '../../src/modules/reconciliation/application/wallet-batch-reconciliation.service.js';

import {
  PostgresLedgerContinuityService,
} from '../../src/modules/reconciliation/infrastructure/postgres-ledger-continuity.service.js';

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

  return { id: result.id, playerId };
}

beforeAll(async () => {
  orm = await MikroORM.init(mikroOrmConfig);
});

afterAll(async () => {
  await orm?.close(true);
});

describe('Wallet batch reconciliation', () => {
  test('audits real OPENING and BET movements', async () => {
    const wallet = await createWallet();

    await new ProcessBetUseCase(
      new MikroOrmBetTransactionRunner(
        orm.em.fork(),
      ),
    ).execute({
      providerId: 'chain-test',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: randomUUID(),
      gameId: 'chain-test-game',
      amount: '30.00',
      currency: 'BRL',
    });

    const report =
      await new PostgresLedgerContinuityService(
        orm.em.fork(),
      ).audit(wallet.id);

    expect(report.chainFeasible).toBe(true);
    expect(report.entryCount).toBe(2);
    expect(report.validMovementCount).toBe(2);
    expect(report.issues).toHaveLength(0);
  });

  test('returns paginated wallet reconciliation results', async () => {
    await createWallet();
    await createWallet();

    const service =
      new WalletBatchReconciliationService(
        orm.em.fork(),
      );

    const first = await service.scanPage({
      limit: 1,
    });

    expect(first.checkedCount).toBe(1);
    expect(first.results).toHaveLength(1);

    expect(first.consistentCount +
      first.inconsistentCount,
    ).toBe(1);

    if (first.nextCursor) {
      const second = await service.scanPage({
        after: first.nextCursor,
        limit: 1,
      });

      expect(second.checkedCount).toBeLessThanOrEqual(1);

      if (second.results.length > 0) {
        expect(second.results[0]!.walletId)
          .not.toBe(first.results[0]!.walletId);
      }
    }
  });

  test('rejects an invalid batch size', async () => {
    const service =
      new WalletBatchReconciliationService(
        orm.em.fork(),
      );

    await expect(
      service.scanPage({ limit: 101 }),
    ).rejects.toThrow(
      'Batch limit must be between 1 and 100',
    );
  });
});
