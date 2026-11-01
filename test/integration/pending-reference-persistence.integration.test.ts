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

import {
  ProcessRefundUseCase,
  type ProcessRefundInput,
} from '../../src/modules/wagering/application/use-cases/process-refund.use-case.js';

import {
  ProcessRollbackUseCase,
  type ProcessRollbackInput,
} from '../../src/modules/wagering/application/use-cases/process-rollback.use-case.js';

import { MikroOrmRefundTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-refund-transaction-runner.js';

import { MikroOrmRollbackTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-rollback-transaction-runner.js';

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

function refundProcessor() {
  return new ProcessRefundUseCase(
    new MikroOrmRefundTransactionRunner(
      orm.em.fork(),
    ),
  );
}

function rollbackProcessor() {
  return new ProcessRollbackUseCase(
    new MikroOrmRollbackTransactionRunner(
      orm.em.fork(),
    ),
  );
}

function makeInput(wallet: {
  id: string;
  playerId: string;
}): ProcessRefundInput & ProcessRollbackInput {
  return {
    providerId: 'pending-reference-tests',
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),
    referenceExternalTransactionId: randomUUID(),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: randomUUID(),
    gameId: 'pending-reference-game',
    amount: '30.00',
    currency: 'BRL',
  };
}

async function inspect(walletId: string) {
  const rows = await orm.em.fork().execute<
    Array<{
      balance: string;
      version: number;
      pending: number;
      ledger: number;
      outbox: number;
      positions: number;
    }>
  >(
    `
      SELECT
        w.balance_amount::text AS balance,
        w.version,

        (
          SELECT COUNT(*)::int
          FROM wager_transactions
          WHERE wallet_id = w.id
            AND status = 'PENDING_REFERENCE'
        ) AS pending,

        (
          SELECT COUNT(*)::int
          FROM wallet_ledger_entries
          WHERE wallet_id = w.id
        ) AS ledger,

        (
          SELECT COUNT(*)::int
          FROM outbox_messages
          WHERE aggregate_id = w.id
        ) AS outbox,

        (
          SELECT COUNT(*)::int
          FROM wallet_ledger_positions
          WHERE wallet_id = w.id
        ) AS positions

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

async function inspectPending(transactionId: string) {
  const rows = await orm.em.fork().execute<
    Array<{
      kind: string;
      status: string;
      reference_external_transaction_id: string;
      reference_transaction_id: string | null;
      attempts: number;
      next_attempt_at: Date | string | null;
      processed_at: Date | string | null;
      response_snapshot: {
        status: string;
        transactionId: string;
      };
    }>
  >(
    `
      SELECT
        kind,
        status,
        reference_external_transaction_id,
        reference_transaction_id,
        attempts,
        next_attempt_at,
        processed_at,
        response_snapshot
      FROM wager_transactions
      WHERE id = ?
    `,
    [transactionId],
    'all',
  );

  if (!rows[0]) {
    throw new Error('Pending transaction not found');
  }

  return rows[0];
}

beforeAll(async () => {
  orm = await MikroORM.init(mikroOrmConfig);
});

afterAll(async () => {
  await orm?.close(true);
});

describe('PostgreSQL PENDING_REFERENCE persistence', () => {
  test('persists REFUND without modifying wallet or ledger', async () => {
    const wallet = await createWallet();
    const input = makeInput(wallet);

    const before = await inspect(wallet.id);

    const result = await refundProcessor().execute(
      input,
    );

    const after = await inspect(wallet.id);

    expect(result.status).toBe(
      WagerTransactionStatus.PendingReference,
    );

    expect(result.balance.amount).toBe('100.00');
    expect(result.walletVersion).toBe(1);

    expect(after.balance).toBe(before.balance);
    expect(after.version).toBe(before.version);
    expect(after.ledger).toBe(before.ledger);
    expect(after.outbox).toBe(before.outbox);
    expect(after.positions).toBe(before.positions);
    expect(after.pending).toBe(1);

    const pending = await inspectPending(
      result.transactionId,
    );

    expect(pending.kind).toBe('REFUND');
    expect(pending.status).toBe('PENDING_REFERENCE');

    expect(
      pending.reference_external_transaction_id,
    ).toBe(input.referenceExternalTransactionId);

    expect(pending.reference_transaction_id).toBeNull();
    expect(pending.processed_at).toBeNull();
    expect(pending.attempts).toBe(0);
    expect(pending.next_attempt_at).not.toBeNull();

    expect(
      pending.response_snapshot.transactionId,
    ).toBe(result.transactionId);
  });

  test('replays a pending REFUND without duplicating it', async () => {
    const wallet = await createWallet();
    const input = makeInput(wallet);

    const first = await refundProcessor().execute(
      input,
    );

    const replay = await refundProcessor().execute(
      input,
    );

    expect(replay.transactionId).toBe(
      first.transactionId,
    );

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.status).toBe(
      WagerTransactionStatus.PendingReference,
    );

    const saved = await inspect(wallet.id);

    expect(saved.pending).toBe(1);
    expect(saved.balance).toBe('100.00');
    expect(saved.version).toBe(1);
    expect(saved.ledger).toBe(1);
    expect(saved.positions).toBe(1);
  });

  test('persists ROLLBACK without moving money', async () => {
    const wallet = await createWallet();
    const input = makeInput(wallet);

    const result = await rollbackProcessor().execute(
      input,
    );

    const pending = await inspectPending(
      result.transactionId,
    );

    const saved = await inspect(wallet.id);

    expect(result.status).toBe(
      WagerTransactionStatus.PendingReference,
    );

    expect(pending.kind).toBe('ROLLBACK');
    expect(pending.attempts).toBe(0);
    expect(pending.reference_transaction_id).toBeNull();
    expect(pending.processed_at).toBeNull();

    expect(saved.pending).toBe(1);
    expect(saved.balance).toBe('100.00');
    expect(saved.version).toBe(1);
    expect(saved.ledger).toBe(1);
    expect(saved.positions).toBe(1);
    expect(saved.outbox).toBe(0);
  });

  test('50 identical pending REFUND requests create one row', async () => {
    const wallet = await createWallet();
    const input = makeInput(wallet);

    const results = await Promise.all(
      Array.from(
        { length: 50 },
        () => refundProcessor().execute(input),
      ),
    );

    expect(results).toHaveLength(50);

    expect(
      new Set(
        results.map((r) => r.transactionId),
      ).size,
    ).toBe(1);

    const saved = await inspect(wallet.id);

    expect(saved.pending).toBe(1);
    expect(saved.balance).toBe('100.00');
    expect(saved.version).toBe(1);
    expect(saved.ledger).toBe(1);
    expect(saved.positions).toBe(1);
    expect(saved.outbox).toBe(0);
  }, 30000);
});
