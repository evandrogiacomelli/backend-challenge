import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';

import mikroOrmConfig from '../../src/config/mikro-orm.config.js';
import { PostgresLedgerSequenceService } from '../../src/modules/reconciliation/infrastructure/postgres-ledger-sequence.service.js';
import { CreateWalletUseCase } from '../../src/modules/wallet/application/use-cases/create-wallet.use-case.js';
import { MikroOrmWalletOpeningPersistence } from '../../src/modules/wallet/infrastructure/persistence/mikro-orm-wallet-opening.persistence.js';
import { ProcessBetUseCase } from '../../src/modules/wagering/application/use-cases/process-bet.use-case.js';
import { MikroOrmBetTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-bet-transaction-runner.js';

let orm: MikroORM;

interface TestWallet {
  id: string;
  playerId: string;
}

function processor(): ProcessBetUseCase {
  return new ProcessBetUseCase(new MikroOrmBetTransactionRunner(orm.em.fork()));
}

async function createWallet(amount = '100.00'): Promise<TestWallet> {
  const playerId = randomUUID();
  const result = await new CreateWalletUseCase(
    new MikroOrmWalletOpeningPersistence(orm.em.fork()),
  ).execute({
    playerId,
    initialBalance: { amount, currency: 'BRL' },
  });
  return { id: result.id, playerId };
}

function betInput(wallet: TestWallet, amount = '30.00') {
  return {
    providerId: 'sequence-tests',
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: randomUUID(),
    gameId: 'sequence-game',
    amount,
    currency: 'BRL',
  };
}

function audit(walletId: string) {
  return new PostgresLedgerSequenceService(orm.em.fork()).audit(walletId);
}

beforeAll(async () => {
  orm = await MikroORM.init(mikroOrmConfig);
});

afterAll(async () => {
  await orm?.close(true);
});

describe('PostgreSQL immutable ledger sequencing', () => {
  test('sequences OPENING as #1 and BET as #2 for new wallets', async () => {
    const wallet = await createWallet();
    const initial = await audit(wallet.id);

    expect(initial.consistent).toBe(true);
    expect(initial.anchorBalance).toBe('0.00');
    expect(initial.walletBalance).toBe('100.00');
    expect(initial.lastSequence).toBe(1);
    expect(initial.positionCount).toBe(1);

    await processor().execute(betInput(wallet));
    const after = await audit(wallet.id);

    expect(after.consistent).toBe(true);
    expect(after.lastSequence).toBe(2);
    expect(after.positionCount).toBe(2);
    expect(after.walletBalance).toBe('70.00');
    expect(after.issues).toHaveLength(0);
  });

  test('does not create positions for rejected or replayed BETs', async () => {
    const wallet = await createWallet();
    const input = betInput(wallet, '30.00');

    await processor().execute(input);
    await processor().execute(input);
    await processor().execute(betInput(wallet, '200.00'));

    const result = await audit(wallet.id);
    expect(result.consistent).toBe(true);
    expect(result.lastSequence).toBe(2);
    expect(result.positionCount).toBe(2);
    expect(result.walletBalance).toBe('70.00');
  });

  test('allocates 50 distinct contiguous positions under concurrent BETs', async () => {
    const wallet = await createWallet();
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        processor().execute(betInput(wallet, '1.00')),
      ),
    );
    expect(results).toHaveLength(50);

    const report = await audit(wallet.id);
    expect(report.consistent).toBe(true);
    expect(report.positionCount).toBe(51); // OPENING + 50 BETs
    expect(report.lastSequence).toBe(51);
    expect(report.walletBalance).toBe('50.00');
    expect(report.issues).toHaveLength(0);
  }, 30000);

  test('rolls back an INSERT that breaks ledger continuity', async () => {
    const wallet = await createWallet();
    const rejected = await processor().execute(betInput(wallet, '200.00'));

    await expect(
      orm.em.fork().execute(
        `INSERT INTO wallet_ledger_entries
          (id, wallet_id, wager_transaction_id, direction, amount,
           currency, balance_before, balance_after)
         VALUES (?, ?, ?, 'DEBIT', 1.00, 'BRL', 999.00, 998.00)`,
        [randomUUID(), wallet.id, rejected.transactionId],
      ),
    ).rejects.toThrow();

    const report = await audit(wallet.id);
    expect(report.consistent).toBe(true);
    expect(report.positionCount).toBe(1);
    expect(report.walletBalance).toBe('100.00');
  });

  test('rejects updates to immutable ledger positions', async () => {
    const wallet = await createWallet();
    await expect(
      orm.em.fork().execute(
        `UPDATE wallet_ledger_positions
         SET sequence_no = sequence_no
         WHERE wallet_id = ?`,
        [wallet.id],
      ),
    ).rejects.toThrow();

    const result = await audit(wallet.id);
    expect(result.consistent).toBe(true);
    expect(result.positionCount).toBe(1);
  });

  test('accepts a new zero-balance wallet without positions', async () => {
    const wallet = await createWallet('0.00');
    const report = await audit(wallet.id);

    expect(report.consistent).toBe(true);
    expect(report.anchorBalance).toBe('0.00');
    expect(report.walletBalance).toBe('0.00');
    expect(report.lastSequence).toBe(0);
    expect(report.positionCount).toBe(0);
  });
});
