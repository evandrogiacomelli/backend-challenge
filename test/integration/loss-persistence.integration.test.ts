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
  CreateWalletUseCase,
} from '../../src/modules/wallet/application/use-cases/create-wallet.use-case.js';

import {
  MikroOrmWalletOpeningPersistence,
} from '../../src/modules/wallet/infrastructure/persistence/mikro-orm-wallet-opening.persistence.js';

import {
  ProcessLossUseCase,
  type ProcessLossInput,
} from '../../src/modules/wagering/application/use-cases/process-loss.use-case.js';

import {
  MikroOrmLossTransactionRunner,
} from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-loss-transaction-runner.js';

import {
  ProcessBetUseCase,
} from '../../src/modules/wagering/application/use-cases/process-bet.use-case.js';

import {
  MikroOrmBetTransactionRunner,
} from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-bet-transaction-runner.js';

import {
  LossIdentityConflictError,
} from '../../src/modules/wagering/application/ports/loss-transaction-runner.js';
import { WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction.js';

let orm: MikroORM;

interface TestWallet {
  id: string;
  playerId: string;
}

interface FinancialState {
  balance_amount: string;
  version: number;
  losses: number;
  ledger_entries: number;
  ledger_positions: number;
  outbox_events: number;
}

async function createWallet(): Promise<TestWallet> {
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

function lossInput(
  wallet: TestWallet,
): ProcessLossInput {
  return {
    providerId: 'loss-integration-tests',
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: randomUUID(),
    gameId: 'loss-integration-game',
    amount: '30.00',
    currency: 'BRL',
  };
}

function processor(): ProcessLossUseCase {
  return new ProcessLossUseCase(
    new MikroOrmLossTransactionRunner(
      orm.em.fork(),
    ),
  );
}

async function inspect(
  walletId: string,
): Promise<FinancialState> {
  const rows = await orm.em.fork().execute<
    FinancialState[]
  >(
    `
    SELECT
      w.balance_amount::text AS balance_amount,
      w.version,

      (
        SELECT COUNT(*)::int
        FROM wager_transactions
        WHERE wallet_id = w.id
          AND kind = 'LOSS'
      ) AS losses,

      (
        SELECT COUNT(*)::int
        FROM wallet_ledger_entries
        WHERE wallet_id = w.id
      ) AS ledger_entries,

      (
        SELECT COUNT(*)::int
        FROM wallet_ledger_positions
        WHERE wallet_id = w.id
      ) AS ledger_positions,

      (
        SELECT COUNT(*)::int
        FROM outbox_messages
        WHERE aggregate_id = w.id
          AND event_type = 'wager.loss.processed.v1'
      ) AS outbox_events

    FROM wallets w
    WHERE w.id = ?
    `,
    [walletId],
    'all',
  );

  const result = rows[0];

  if (!result) {
    throw new Error('Test wallet not found');
  }

  return result;
}

beforeAll(async () => {
  orm = await MikroORM.init(mikroOrmConfig);
});

afterAll(async () => {
  await orm?.close(true);
});

describe('PostgreSQL LOSS persistence', () => {
  test('persists LOSS and Outbox without changing wallet or ledger', async () => {
    const wallet = await createWallet();

    const before = await inspect(wallet.id);

    const result = await processor().execute(
      lossInput(wallet),
    );

    const after = await inspect(wallet.id);

    expect(result.status).toBe(
      WagerTransactionStatus.Processed,
    );
    expect(result.balance.amount).toBe('100.00');
    expect(result.walletVersion).toBe(1);
    expect(result.idempotentReplay).toBe(false);

    expect(after.balance_amount).toBe(
      before.balance_amount,
    );

    expect(after.version).toBe(before.version);

    expect(after.ledger_entries).toBe(
      before.ledger_entries,
    );

    expect(after.ledger_positions).toBe(
      before.ledger_positions,
    );

    expect(after.losses).toBe(1);
    expect(after.outbox_events).toBe(1);
  });

  test('replays LOSS without writing another transaction or event', async () => {
    const wallet = await createWallet();
    const input = lossInput(wallet);

    const first = await processor().execute(input);
    const replay = await processor().execute(input);

    const state = await inspect(wallet.id);

    expect(replay.transactionId).toBe(
      first.transactionId,
    );

    expect(replay.balance).toEqual(
      first.balance,
    );

    expect(replay.idempotentReplay).toBe(true);

    expect(state.losses).toBe(1);
    expect(state.outbox_events).toBe(1);
    expect(state.ledger_entries).toBe(1);
    expect(state.ledger_positions).toBe(1);
  });

  test('rejects an identity already used by BET', async () => {
    const wallet = await createWallet();
    const input = lossInput(wallet);

    await new ProcessBetUseCase(
      new MikroOrmBetTransactionRunner(
        orm.em.fork(),
      ),
    ).execute({
      providerId: input.providerId,
      externalTransactionId:
      input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      amount: '30.00',
      currency: input.currency,
    });

    await expect(
      processor().execute(input),
    ).rejects.toBeInstanceOf(
      LossIdentityConflictError,
    );

    const state = await inspect(wallet.id);

    expect(state.balance_amount).toBe('70.00');
    expect(state.losses).toBe(0);
    expect(state.ledger_entries).toBe(2);
    expect(state.ledger_positions).toBe(2);
  });

  test('processes 50 different concurrent LOSS messages without financial movements', async () => {
    const wallet = await createWallet();

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        processor().execute(lossInput(wallet)),
      ),
    );

    expect(results).toHaveLength(50);

    expect(
      results.every(
        (result) => !result.idempotentReplay,
      ),
    ).toBe(true);

    const state = await inspect(wallet.id);

    expect(state.balance_amount).toBe('100.00');
    expect(state.version).toBe(1);
    expect(state.losses).toBe(50);
    expect(state.outbox_events).toBe(50);
    expect(state.ledger_entries).toBe(1);
    expect(state.ledger_positions).toBe(1);
  }, 30000);

  test('processes 50 identical concurrent LOSS requests only once', async () => {
    const wallet = await createWallet();
    const input = lossInput(wallet);

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        processor().execute(input),
      ),
    );

    const originals = results.filter(
      (result) => !result.idempotentReplay,
    );

    const replays = results.filter(
      (result) => result.idempotentReplay,
    );

    expect(originals).toHaveLength(1);
    expect(replays).toHaveLength(49);

    expect(
      new Set(
        results.map(
          (result) => result.transactionId,
        ),
      ).size,
    ).toBe(1);

    const state = await inspect(wallet.id);

    expect(state.balance_amount).toBe('100.00');
    expect(state.version).toBe(1);
    expect(state.losses).toBe(1);
    expect(state.outbox_events).toBe(1);
    expect(state.ledger_entries).toBe(1);
    expect(state.ledger_positions).toBe(1);
  }, 30000);
});
