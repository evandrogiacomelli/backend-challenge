import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';

import mikroOrmConfig from '../../src/config/mikro-orm.config.js';
import { CreateWalletUseCase } from '../../src/modules/wallet/application/use-cases/create-wallet.use-case.js';
import { MikroOrmWalletOpeningPersistence } from '../../src/modules/wallet/infrastructure/persistence/mikro-orm-wallet-opening.persistence.js';
import { ProcessBetUseCase } from '../../src/modules/wagering/application/use-cases/process-bet.use-case.js';
import { ProcessWinUseCase, type ProcessWinInput } from '../../src/modules/wagering/application/use-cases/process-win.use-case.js';
import { MikroOrmBetTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-bet-transaction-runner.js';
import { MikroOrmWinTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-win-transaction-runner.js';
import { WinIdentityConflictError } from '../../src/modules/wagering/application/ports/win-transaction-runner.js';

let orm: MikroORM;

type Wallet = { id: string; playerId: string };

async function createWallet(balance = '100.00'): Promise<Wallet> {
  const playerId = randomUUID();
  const created = await new CreateWalletUseCase(
    new MikroOrmWalletOpeningPersistence(orm.em.fork()),
  ).execute({
    playerId,
    initialBalance: { amount: balance, currency: 'BRL' },
  });
  return { id: created.id, playerId };
}

function win(input: Wallet, amount = '25.00'): ProcessWinInput {
  return {
    providerId: 'win-persistence-tests',
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),
    walletId: input.id,
    playerId: input.playerId,
    roundId: randomUUID(),
    gameId: 'win-integration',
    amount,
    currency: 'BRL',
  };
}

function processor(): ProcessWinUseCase {
  return new ProcessWinUseCase(
    new MikroOrmWinTransactionRunner(orm.em.fork()),
  );
}

async function inspect(walletId: string) {
  const wallet = (await orm.em.fork().execute<Array<{
    balance_amount: string;
    version: number;
  }>>(
    `SELECT balance_amount::text AS balance_amount, version
     FROM wallets WHERE id = ?`,
    [walletId], 'all',
  ))[0]!;

  const counts = (await orm.em.fork().execute<Array<{
    wins: number;
    credits: number;
    events: number;
    positions: number;
  }>>(
    `SELECT
      (SELECT COUNT(*)::int FROM wager_transactions
       WHERE wallet_id = ? AND kind = 'WIN') AS wins,
      (SELECT COUNT(*)::int FROM wallet_ledger_entries l
       JOIN wager_transactions t ON t.id = l.wager_transaction_id
       WHERE l.wallet_id = ? AND l.direction = 'CREDIT' AND t.kind = 'WIN') AS credits,
      (SELECT COUNT(*)::int FROM outbox_messages
       WHERE aggregate_id = ? AND event_type = 'wager.win.processed.v1') AS events,
      (SELECT COUNT(*)::int FROM wallet_ledger_positions
       WHERE wallet_id = ?) AS positions`,
    [walletId, walletId, walletId, walletId], 'all',
  ))[0]!;

  return { wallet, ...counts };
}

beforeAll(async () => {
  orm = await MikroORM.init(mikroOrmConfig);
});

afterAll(async () => {
  await orm?.close(true);
});

describe('PostgreSQL WIN transactional persistence', () => {
  test('credits wallet, writes WIN + CREDIT + Outbox + sequence atomically', async () => {
    const wallet = await createWallet();
    const result = await processor().execute(win(wallet));
    const saved = await inspect(wallet.id);

    expect(result.status).toBe('PROCESSED');
    expect(result.balance.amount).toBe('125.00');
    expect(result.walletVersion).toBe(2);
    expect(result.idempotentReplay).toBe(false);
    expect(saved.wallet.balance_amount).toBe('125.00');
    expect(saved.wallet.version).toBe(2);
    expect(saved.wins).toBe(1);
    expect(saved.credits).toBe(1);
    expect(saved.events).toBe(1);
    expect(saved.positions).toBe(2); // OPENING + WIN
  });

  test('replays the exact snapshot without another credit or outbox event', async () => {
    const wallet = await createWallet();
    const input = win(wallet);
    const first = await processor().execute(input);
    const repeated = await processor().execute(input);
    const saved = await inspect(wallet.id);

    expect(repeated.transactionId).toBe(first.transactionId);
    expect(repeated.balance).toEqual(first.balance);
    expect(repeated.walletVersion).toBe(first.walletVersion);
    expect(repeated.idempotentReplay).toBe(true);
    expect(saved.wallet.balance_amount).toBe('125.00');
    expect(saved.wins).toBe(1);
    expect(saved.credits).toBe(1);
    expect(saved.events).toBe(1);
    expect(saved.positions).toBe(2);
  });

  test('rejects a collision between BET and WIN identities', async () => {
    const wallet = await createWallet();
    const input = win(wallet);
    await new ProcessBetUseCase(
      new MikroOrmBetTransactionRunner(orm.em.fork()),
    ).execute({
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      amount: '10.00',
      currency: input.currency,
    });

    await expect(processor().execute(input))
      .rejects.toBeInstanceOf(WinIdentityConflictError);

    const saved = await inspect(wallet.id);
    expect(saved.wallet.balance_amount).toBe('90.00');
    expect(saved.wins).toBe(0);
    expect(saved.credits).toBe(0);
  });

  test('processes 50 different concurrent WINs with contiguous positions', async () => {
    const wallet = await createWallet();
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        processor().execute(win(wallet, '1.00')),
      ),
    );
    const saved = await inspect(wallet.id);

    expect(results).toHaveLength(50);
    expect(saved.wallet.balance_amount).toBe('150.00');
    expect(saved.wallet.version).toBe(51);
    expect(saved.wins).toBe(50);
    expect(saved.credits).toBe(50);
    expect(saved.events).toBe(50);
    expect(saved.positions).toBe(51);

    const state = (await orm.em.fork().execute<Array<{
      last_sequence: string;
      last_balance: string;
    }>>(
      `SELECT last_sequence::text, last_balance::text
       FROM wallet_ledger_sequence_state WHERE wallet_id = ?`,
      [wallet.id], 'all',
    ))[0]!;
    expect(state.last_sequence).toBe('51');
    expect(state.last_balance).toBe('150.00');
  }, 30000);

  test('50 concurrent replays produce only one credit', async () => {
    const wallet = await createWallet();
    const input = win(wallet);
    const results = await Promise.all(
      Array.from({ length: 50 }, () => processor().execute(input)),
    );
    const saved = await inspect(wallet.id);

    expect(results).toHaveLength(50);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => r.idempotentReplay === false)).toHaveLength(1);
    expect(saved.wallet.balance_amount).toBe('125.00');
    expect(saved.wins).toBe(1);
    expect(saved.credits).toBe(1);
    expect(saved.events).toBe(1);
    expect(saved.positions).toBe(2);
  }, 30000);
});
