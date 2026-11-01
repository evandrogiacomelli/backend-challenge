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

import { ProcessWinUseCase } from '../../src/modules/wagering/application/use-cases/process-win.use-case.js';
import { MikroOrmWinTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-win-transaction-runner.js';

import { ProcessRefundUseCase } from '../../src/modules/wagering/application/use-cases/process-refund.use-case.js';
import { MikroOrmRefundTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-refund-transaction-runner.js';

import { ProcessRollbackUseCase } from '../../src/modules/wagering/application/use-cases/process-rollback.use-case.js';
import { MikroOrmRollbackTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-rollback-transaction-runner.js';

import { MikroOrmPendingReferenceClaimer } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-pending-reference-claimer.js';
import { MikroOrmPendingReferenceRecovery } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-pending-reference-recovery.js';

import { WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction.js';

let orm: MikroORM;

function provider() {
  return `recovery-${randomUUID()}`;
}

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

  return {
    id: result.id,
    playerId,
  };
}

function betProcessor() {
  return new ProcessBetUseCase(
    new MikroOrmBetTransactionRunner(
      orm.em.fork(),
    ),
  );
}

function winProcessor() {
  return new ProcessWinUseCase(
    new MikroOrmWinTransactionRunner(
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

function rollbackProcessor() {
  return new ProcessRollbackUseCase(
    new MikroOrmRollbackTransactionRunner(
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

async function inspect(walletId: string) {
  const rows = await orm.em.fork().execute<
    Array<{
      balance: string;
      version: number;
      ledger_count: number;
      positions: number;
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

async function transaction(id: string) {
  const rows = await orm.em.fork().execute<
    Array<{
      id: string;
      status: string;
      reference_transaction_id: string | null;
      attempts: number;
      next_attempt_at: Date | null;
      failure_code: string | null;
      response_snapshot: {
        transactionId: string;
        status: string;
        balance: {
          amount: string;
          currency: string;
        };
        walletVersion: number;
      };
    }>
  >(
    `
      SELECT
        id,
        status,
        reference_transaction_id,
        attempts,
        next_attempt_at,
        failure_code,
        response_snapshot
      FROM wager_transactions
      WHERE id = ?
    `,
    [id],
    'all',
  );

  if (!rows[0]) {
    throw new Error('Transaction not found');
  }

  return rows[0];
}

async function claimOne(providerId: string) {
  const claims = await claimer().claimDue({
    providerId,
    limit: 1,
    leaseSeconds: 120,
  });

  expect(claims).toHaveLength(1);

  return claims[0]!;
}

beforeAll(async () => {
  orm = await MikroORM.init(mikroOrmConfig);
});

afterAll(async () => {
  await orm?.close(true);
});

describe('PENDING_REFERENCE PostgreSQL recovery', () => {
  test(
    'processes REFUND after the original BET arrives',
    async () => {
      const wallet = await createWallet();

      const providerId = provider();
      const betExternalId = randomUUID();
      const roundId = randomUUID();
      const gameId = 'recovery-game';

      const refundInput = {
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
      };

      const pending =
        await refundProcessor().execute(refundInput);

      expect(pending.status).toBe(
        WagerTransactionStatus.PendingReference,
      );

      const bet = await betProcessor().execute({
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

      const before = await inspect(wallet.id);

      expect(before.balance).toBe('70.00');
      expect(before.version).toBe(2);
      expect(before.positions).toBe(2);

      const claim = await claimOne(providerId);

      expect(claim.id).toBe(
        pending.transactionId,
      );

      const result = await recovery().recover(claim);

      expect(result.status).toBe('PROCESSED');

      const after = await inspect(wallet.id);

      expect(after.balance).toBe('100.00');
      expect(after.version).toBe(3);
      expect(after.ledger_count).toBe(3);
      expect(after.positions).toBe(3);

      const saved = await transaction(
        pending.transactionId,
      );

      // The SAME transaction is finalized.
      expect(saved.id).toBe(
        pending.transactionId,
      );

      expect(saved.status).toBe('PROCESSED');

      expect(saved.reference_transaction_id)
        .toBe(bet.transactionId);

      expect(saved.response_snapshot.balance.amount)
        .toBe('100.00');

      const replay =
        await refundProcessor().execute(refundInput);

      expect(replay.idempotentReplay).toBe(true);
      expect(replay.transactionId).toBe(
        pending.transactionId,
      );

      expect(replay.status).toBe(
        WagerTransactionStatus.Processed,
      );

      expect(await inspect(wallet.id))
        .toEqual(after);
    },
  );

  test(
    'processes ROLLBACK WIN with compensating DEBIT',
    async () => {
      const wallet = await createWallet();

      const providerId = provider();
      const winExternalId = randomUUID();
      const roundId = randomUUID();
      const gameId = 'recovery-game';

      const pending =
        await rollbackProcessor().execute({
          providerId,
          externalTransactionId: randomUUID(),
          idempotencyKey: randomUUID(),
          referenceExternalTransactionId:
          winExternalId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId,
          gameId,
          amount: '30.00',
          currency: 'BRL',
        });

      expect(pending.status).toBe(
        WagerTransactionStatus.PendingReference,
      );

      const win = await winProcessor().execute({
        providerId,
        externalTransactionId: winExternalId,
        idempotencyKey: randomUUID(),
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId,
        gameId,
        amount: '30.00',
        currency: 'BRL',
      });

      expect(win.status).toBe(
        WagerTransactionStatus.Processed,
      );

      const before = await inspect(wallet.id);
      expect(before.balance).toBe('130.00');

      const claim = await claimOne(providerId);
      const recovered = await recovery().recover(
        claim,
      );

      expect(recovered.status).toBe('PROCESSED');

      const after = await inspect(wallet.id);

      expect(after.balance).toBe('100.00');
      expect(after.version).toBe(3);
      expect(after.ledger_count).toBe(3);
      expect(after.positions).toBe(3);

      const saved = await transaction(
        pending.transactionId,
      );

      expect(saved.status).toBe('PROCESSED');
      expect(saved.reference_transaction_id)
        .toBe(win.transactionId);
    },
  );

  test(
    'schedules a retry while reference is missing',
    async () => {
      const wallet = await createWallet();
      const providerId = provider();

      const pending =
        await refundProcessor().execute({
          providerId,
          externalTransactionId: randomUUID(),
          idempotencyKey: randomUUID(),
          referenceExternalTransactionId:
            randomUUID(),
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: randomUUID(),
          gameId: 'recovery-game',
          amount: '30.00',
          currency: 'BRL',
        });

      const before = await inspect(wallet.id);

      const claim = await claimOne(providerId);

      const result = await recovery().recover(claim);

      expect(result.status).toBe(
        'RETRY_SCHEDULED',
      );

      const saved = await transaction(
        pending.transactionId,
      );

      expect(saved.status).toBe(
        'PENDING_REFERENCE',
      );

      expect(saved.attempts).toBe(1);
      expect(saved.next_attempt_at).not.toBeNull();

      expect(await inspect(wallet.id))
        .toEqual(before);

      const repeated = await claimer().claimDue({
        providerId,
        limit: 1,
        leaseSeconds: 120,
      });

      expect(repeated).toHaveLength(0);
    },
  );

  test(
    'does not process a stale claim',
    async () => {
      const wallet = await createWallet();
      const providerId = provider();

      const pending =
        await refundProcessor().execute({
          providerId,
          externalTransactionId: randomUUID(),
          idempotencyKey: randomUUID(),
          referenceExternalTransactionId:
            randomUUID(),
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: randomUUID(),
          gameId: 'recovery-game',
          amount: '30.00',
          currency: 'BRL',
        });

      const claim = await claimOne(providerId);

      // Simulate an expired worker lease.
      await orm.em.fork().execute(
        `
          UPDATE wager_transactions
          SET next_attempt_at =
            NOW() - INTERVAL '1 second'
          WHERE id = ?
        `,
        [pending.transactionId],
      );

      const before = await inspect(wallet.id);

      const result = await recovery().recover(claim);

      expect(result.status).toBe('STALE_CLAIM');

      expect(await inspect(wallet.id))
        .toEqual(before);

      const saved = await transaction(
        pending.transactionId,
      );

      expect(saved.status).toBe(
        'PENDING_REFERENCE',
      );
    },
  );

  test(
    'rejects a permanently invalid reference without moving money',
    async () => {
      const wallet = await createWallet();

      const providerId = provider();
      const betExternalId = randomUUID();
      const roundId = randomUUID();
      const gameId = 'recovery-game';

      const pending =
        await refundProcessor().execute({
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

      // The reference exists but the amount differs.
      await betProcessor().execute({
        providerId,
        externalTransactionId: betExternalId,
        idempotencyKey: randomUUID(),
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId,
        gameId,
        amount: '20.00',
        currency: 'BRL',
      });

      const before = await inspect(wallet.id);

      const claim = await claimOne(providerId);
      const result = await recovery().recover(claim);

      expect(result.status).toBe('REJECTED');

      const saved = await transaction(
        pending.transactionId,
      );

      expect(saved.status).toBe('REJECTED');
      expect(saved.failure_code).toBe(
        'REFERENCE_AMOUNT_MISMATCH',
      );

      expect(await inspect(wallet.id))
        .toEqual(before);
    },
  );
});
