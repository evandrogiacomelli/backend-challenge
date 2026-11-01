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

import { Money } from '../../src/shared/domain/money.js';

import { CreateWalletUseCase } from '../../src/modules/wallet/application/use-cases/create-wallet.use-case.js';

import { MikroOrmWalletOpeningPersistence } from '../../src/modules/wallet/infrastructure/persistence/mikro-orm-wallet-opening.persistence.js';

import { ProcessBetUseCase } from '../../src/modules/wagering/application/use-cases/process-bet.use-case.js';

import { ProcessWinUseCase } from '../../src/modules/wagering/application/use-cases/process-win.use-case.js';

import { ProcessRefundUseCase } from '../../src/modules/wagering/application/use-cases/process-refund.use-case.js';

import {
  ProcessRollbackUseCase,
  type ProcessRollbackInput,
} from '../../src/modules/wagering/application/use-cases/process-rollback.use-case.js';

import { MikroOrmBetTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-bet-transaction-runner.js';

import { MikroOrmWinTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-win-transaction-runner.js';

import { MikroOrmRefundTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-refund-transaction-runner.js';

import { MikroOrmRollbackTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-rollback-transaction-runner.js';

import { WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction.js';

import {
  RollbackAlreadyAppliedError,
  RollbackInsufficientFundsError,
  RollbackReferenceNotFoundError,
  type LockedRollbackContext,
  type RollbackIdentity,
  type RollbackTransactionRunner,
} from '../../src/modules/wagering/application/ports/rollback-transaction-runner.js';

import type {
  InboxReceipt,
} from '../../src/modules/wagering/application/ports/bet-transaction-runner.js';
import {
  PostgresWalletReconciliationService
} from '../../src/modules/reconciliation/infrastructure/postgres-wallet-reconciliation.service.js';

let orm: MikroORM;

interface Wallet {
  id: string;
  playerId: string;
}

interface ReferenceFixture {
  wallet: Wallet;
  providerId: string;
  externalTransactionId: string;
  transactionId: string;
  roundId: string;
  gameId: string;
  amount: string;
}

async function createWallet(
  balance = '100.00',
): Promise<Wallet> {
  const playerId = randomUUID();

  const result = await new CreateWalletUseCase(
    new MikroOrmWalletOpeningPersistence(
      orm.em.fork(),
    ),
  ).execute({
    playerId,
    initialBalance: {
      amount: balance,
      currency: 'BRL',
    },
  });

  return {
    id: result.id,
    playerId,
  };
}

function betProcessor(): ProcessBetUseCase {
  return new ProcessBetUseCase(
    new MikroOrmBetTransactionRunner(
      orm.em.fork(),
    ),
  );
}

function winProcessor(): ProcessWinUseCase {
  return new ProcessWinUseCase(
    new MikroOrmWinTransactionRunner(
      orm.em.fork(),
    ),
  );
}

function refundProcessor(): ProcessRefundUseCase {
  return new ProcessRefundUseCase(
    new MikroOrmRefundTransactionRunner(
      orm.em.fork(),
    ),
  );
}

function rollbackProcessor(): ProcessRollbackUseCase {
  return new ProcessRollbackUseCase(
    new MikroOrmRollbackTransactionRunner(
      orm.em.fork(),
    ),
  );
}

async function createBet(
  wallet: Wallet,
  amount = '30.00',
): Promise<ReferenceFixture> {
  const providerId = 'rollback-persistence-tests';
  const externalTransactionId = randomUUID();
  const roundId = randomUUID();
  const gameId = 'rollback-game';

  const result = await betProcessor().execute({
    providerId,
    externalTransactionId,
    idempotencyKey: randomUUID(),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId,
    gameId,
    amount,
    currency: 'BRL',
  });

  expect(result.status).toBe(
    WagerTransactionStatus.Processed,
  );

  return {
    wallet,
    providerId,
    externalTransactionId,
    transactionId: result.transactionId,
    roundId,
    gameId,
    amount,
  };
}

async function createWin(
  wallet: Wallet,
  amount = '30.00',
): Promise<ReferenceFixture> {
  const providerId = 'rollback-persistence-tests';
  const externalTransactionId = randomUUID();
  const roundId = randomUUID();
  const gameId = 'rollback-game';

  const result = await winProcessor().execute({
    providerId,
    externalTransactionId,
    idempotencyKey: randomUUID(),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId,
    gameId,
    amount,
    currency: 'BRL',
  });

  expect(result.status).toBe(
    WagerTransactionStatus.Processed,
  );

  return {
    wallet,
    providerId,
    externalTransactionId,
    transactionId: result.transactionId,
    roundId,
    gameId,
    amount,
  };
}

async function createRefund(
  bet: ReferenceFixture,
): Promise<ReferenceFixture> {
  const externalTransactionId = randomUUID();

  const result = await refundProcessor().execute({
    providerId: bet.providerId,
    externalTransactionId,
    idempotencyKey: randomUUID(),

    referenceExternalTransactionId:
    bet.externalTransactionId,

    walletId: bet.wallet.id,
    playerId: bet.wallet.playerId,
    roundId: bet.roundId,
    gameId: bet.gameId,

    amount: bet.amount,
    currency: 'BRL',
  });

  expect(result.status).toBe(
    WagerTransactionStatus.Processed,
  );

  return {
    ...bet,
    externalTransactionId,
    transactionId: result.transactionId,
  };
}

function rollback(
  original: ReferenceFixture,
): ProcessRollbackInput {
  return {
    providerId: original.providerId,
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),

    referenceExternalTransactionId:
    original.externalTransactionId,

    walletId: original.wallet.id,
    playerId: original.wallet.playerId,

    roundId: original.roundId,
    gameId: original.gameId,

    amount: original.amount,
    currency: 'BRL',
  };
}

async function inspect(walletId: string) {
  const walletRows = await orm.em.fork().execute<
    Array<{
      balance_amount: string;
      version: number;
    }>
  >(
    `
      SELECT
        balance_amount::text AS balance_amount,
        version
      FROM wallets
      WHERE id = ?
    `,
    [walletId],
    'all',
  );

  const wallet = walletRows[0];

  if (!wallet) {
    throw new Error('Wallet not found');
  }

  const rows = await orm.em.fork().execute<
    Array<{
      rollbacks: number;
      credits: number;
      debits: number;
      events: number;
      positions: number;
    }>
  >(
    `
      SELECT
        (
          SELECT COUNT(*)::int
          FROM wager_transactions
          WHERE wallet_id = ?
            AND kind = 'ROLLBACK'
            AND status = 'PROCESSED'
        ) AS rollbacks,

        (
          SELECT COUNT(*)::int
          FROM wallet_ledger_entries l
          JOIN wager_transactions t
            ON t.id = l.wager_transaction_id
          WHERE l.wallet_id = ?
            AND t.kind = 'ROLLBACK'
            AND l.direction = 'CREDIT'
        ) AS credits,

        (
          SELECT COUNT(*)::int
          FROM wallet_ledger_entries l
          JOIN wager_transactions t
            ON t.id = l.wager_transaction_id
          WHERE l.wallet_id = ?
            AND t.kind = 'ROLLBACK'
            AND l.direction = 'DEBIT'
        ) AS debits,

        (
          SELECT COUNT(*)::int
          FROM outbox_messages
          WHERE aggregate_id = ?
            AND event_type =
              'wager.rollback.processed.v1'
        ) AS events,

        (
          SELECT COUNT(*)::int
          FROM wallet_ledger_positions
          WHERE wallet_id = ?
        ) AS positions
    `,
    [
      walletId,
      walletId,
      walletId,
      walletId,
      walletId,
    ],
    'all',
  );

  const counts = rows[0];

  if (!counts) {
    throw new Error(
      'Rollback counts unavailable',
    );
  }

  return {
    wallet,
    ...counts,
  };
}

async function getSequence(walletId: string) {
  const rows = await orm.em.fork().execute<
    Array<{
      last_sequence: string;
      last_balance: string;
    }>
  >(
    `
      SELECT
        last_sequence::text,
        last_balance::text
      FROM wallet_ledger_sequence_state
      WHERE wallet_id = ?
    `,
    [walletId],
    'all',
  );

  if (!rows[0]) {
    throw new Error(
      'Ledger sequence state missing',
    );
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
  'PostgreSQL ROLLBACK transactional persistence',
  () => {
    test(
      'reverses BET with CREDIT, Outbox and contiguous ledger',
      async () => {
        const wallet = await createWallet();
        const bet = await createBet(wallet);

        const before = await inspect(wallet.id);

        expect(before.wallet.balance_amount)
          .toBe('70.00');
        expect(before.positions).toBe(2);

        const result =
          await rollbackProcessor().execute(
            rollback(bet),
          );

        const saved = await inspect(wallet.id);

        expect(result.status).toBe(
          WagerTransactionStatus.Processed,
        );

        expect(result.balance.amount)
          .toBe('100.00');

        expect(result.walletVersion).toBe(3);

        expect(saved.wallet.balance_amount)
          .toBe('100.00');

        expect(saved.wallet.version).toBe(3);
        expect(saved.rollbacks).toBe(1);
        expect(saved.credits).toBe(1);
        expect(saved.debits).toBe(0);
        expect(saved.events).toBe(1);
        expect(saved.positions).toBe(3);

        const sequence =
          await getSequence(wallet.id);

        expect(sequence.last_sequence).toBe('3');
        expect(sequence.last_balance)
          .toBe('100.00');

        const reference = await orm.em.fork().execute<
          Array<{
            reference_transaction_id: string;
            direction: string;
            balance_before: string;
            balance_after: string;
          }>
        >(
          `
            SELECT
              t.reference_transaction_id::text,
              l.direction,
              l.balance_before::text,
              l.balance_after::text
            FROM wager_transactions t
            JOIN wallet_ledger_entries l
              ON l.wager_transaction_id = t.id
            WHERE t.id = ?
          `,
          [result.transactionId],
          'all',
        );

        expect(reference).toHaveLength(1);

        expect(
          reference[0]!.reference_transaction_id,
        ).toBe(bet.transactionId);

        expect(reference[0]!.direction)
          .toBe('CREDIT');

        expect(reference[0]!.balance_before)
          .toBe('70.00');

        expect(reference[0]!.balance_after)
          .toBe('100.00');
      },
    );

    test(
      'reverses WIN with DEBIT',
      async () => {
        const wallet = await createWallet();
        const win = await createWin(wallet);

        const before = await inspect(wallet.id);

        expect(before.wallet.balance_amount)
          .toBe('130.00');

        const result =
          await rollbackProcessor().execute(
            rollback(win),
          );

        const saved = await inspect(wallet.id);

        expect(result.balance.amount)
          .toBe('100.00');

        expect(saved.wallet.balance_amount)
          .toBe('100.00');

        expect(saved.wallet.version).toBe(3);
        expect(saved.rollbacks).toBe(1);
        expect(saved.credits).toBe(0);
        expect(saved.debits).toBe(1);
        expect(saved.events).toBe(1);
        expect(saved.positions).toBe(3);

        const sequence =
          await getSequence(wallet.id);

        expect(sequence.last_sequence).toBe('3');
        expect(sequence.last_balance)
          .toBe('100.00');
      },
    );

    test(
      'reverses REFUND with DEBIT',
      async () => {
        const wallet = await createWallet();
        const bet = await createBet(wallet);
        const refunded = await createRefund(bet);

        const before = await inspect(wallet.id);

        expect(before.wallet.balance_amount)
          .toBe('100.00');

        expect(before.positions).toBe(3);

        const result =
          await rollbackProcessor().execute(
            rollback(refunded),
          );

        const saved = await inspect(wallet.id);

        expect(result.balance.amount).toBe('70.00');

        expect(saved.wallet.balance_amount)
          .toBe('70.00');

        expect(saved.wallet.version).toBe(4);
        expect(saved.rollbacks).toBe(1);
        expect(saved.credits).toBe(0);
        expect(saved.debits).toBe(1);
        expect(saved.events).toBe(1);
        expect(saved.positions).toBe(4);

        const sequence =
          await getSequence(wallet.id);

        expect(sequence.last_sequence).toBe('4');
        expect(sequence.last_balance).toBe('70.00');
      },
    );

    test(
      'replays the same ROLLBACK without another movement',
      async () => {
        const wallet = await createWallet();
        const bet = await createBet(wallet);
        const input = rollback(bet);

        const first =
          await rollbackProcessor().execute(input);

        const repeated =
          await rollbackProcessor().execute(input);

        const saved = await inspect(wallet.id);

        expect(repeated.transactionId)
          .toBe(first.transactionId);

        expect(repeated.balance)
          .toEqual(first.balance);

        expect(repeated.walletVersion)
          .toBe(first.walletVersion);

        expect(repeated.idempotentReplay)
          .toBe(true);

        expect(saved.wallet.balance_amount)
          .toBe('100.00');

        expect(saved.wallet.version).toBe(3);
        expect(saved.rollbacks).toBe(1);
        expect(saved.credits).toBe(1);
        expect(saved.events).toBe(1);
        expect(saved.positions).toBe(3);
      },
    );

    test(
      'allows only one of 50 different concurrent ROLLBACKs',
      async () => {
        const wallet = await createWallet();
        const bet = await createBet(wallet);

        const requests = Array.from(
          { length: 50 },
          () => rollback(bet),
        );

        const results = await Promise.allSettled(
          requests.map((input) =>
            rollbackProcessor().execute(input),
          ),
        );

        const successful = results.filter(
          (result) =>
            result.status === 'fulfilled',
        );

        const failed = results.filter(
          (result) =>
            result.status === 'rejected',
        );

        expect(successful).toHaveLength(1);
        expect(failed).toHaveLength(49);

        for (const result of failed) {
          if (result.status === 'rejected') {
            expect(result.reason).toBeInstanceOf(
              RollbackAlreadyAppliedError,
            );
          }
        }

        const saved = await inspect(wallet.id);

        expect(saved.wallet.balance_amount)
          .toBe('100.00');

        expect(saved.wallet.version).toBe(3);
        expect(saved.rollbacks).toBe(1);
        expect(saved.credits).toBe(1);
        expect(saved.debits).toBe(0);
        expect(saved.events).toBe(1);
        expect(saved.positions).toBe(3);

        const sequence =
          await getSequence(wallet.id);

        expect(sequence.last_sequence).toBe('3');
        expect(sequence.last_balance)
          .toBe('100.00');
      },
      30000,
    );

    test(
      '50 identical concurrent ROLLBACKs create one movement',
      async () => {
        const wallet = await createWallet();
        const bet = await createBet(wallet);
        const input = rollback(bet);

        const results = await Promise.all(
          Array.from(
            { length: 50 },
            () => rollbackProcessor().execute(input),
          ),
        );

        const saved = await inspect(wallet.id);

        expect(results).toHaveLength(50);

        expect(
          new Set(
            results.map(
              (result) => result.transactionId,
            ),
          ).size,
        ).toBe(1);

        expect(
          results.filter(
            (result) =>
              result.idempotentReplay === false,
          ),
        ).toHaveLength(1);

        expect(saved.wallet.balance_amount)
          .toBe('100.00');

        expect(saved.wallet.version).toBe(3);
        expect(saved.rollbacks).toBe(1);
        expect(saved.credits).toBe(1);
        expect(saved.events).toBe(1);
        expect(saved.positions).toBe(3);
      },
      30000,
    );

    test(
      'rejects reversing WIN when the compensating debit exceeds balance',
      async () => {
        const wallet = await createWallet();
        const win = await createWin(wallet);

        // 100 + 30 - 110 = 20.
        // Reversing WIN would require DEBIT 30.
        await betProcessor().execute({
          providerId: win.providerId,
          externalTransactionId: randomUUID(),
          idempotencyKey: randomUUID(),
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: win.roundId,
          gameId: win.gameId,
          amount: '110.00',
          currency: 'BRL',
        });

        const before = await inspect(wallet.id);

        expect(before.wallet.balance_amount)
          .toBe('20.00');

        await expect(
          rollbackProcessor().execute(
            rollback(win),
          ),
        ).rejects.toBeInstanceOf(
          RollbackInsufficientFundsError,
        );

        const after = await inspect(wallet.id);

        expect(after).toEqual(before);
        expect(after.rollbacks).toBe(0);
        expect(after.events).toBe(0);
      },
    );


    test('persists unknown ROLLBACK reference without financial movement',
      async () => {
        const wallet = await createWallet();

        const input: ProcessRollbackInput = {
          providerId: 'rollback-persistence-tests',
          externalTransactionId: randomUUID(),
          idempotencyKey: randomUUID(),
          referenceExternalTransactionId: randomUUID(),
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: randomUUID(),
          gameId: 'rollback-game',
          amount: '30.00',
          currency: 'BRL',
        };

        const before = await inspect(wallet.id);

        const result =
          await rollbackProcessor().execute(input);

        expect(result.status).toBe(
          WagerTransactionStatus.PendingReference,
        );

        expect(result.balance.amount).toBe('100.00');
        expect(result.walletVersion).toBe(1);
        expect(result.idempotentReplay).toBe(false);

        const after = await inspect(wallet.id);

        // No wallet modification.
        expect(after.wallet.balance_amount).toBe(
          before.wallet.balance_amount,
        );

        expect(after.wallet.version).toBe(
          before.wallet.version,
        );

        // No new processed ROLLBACK.
        expect(after.rollbacks).toBe(before.rollbacks);

        // No credit or debit in ledger.
        expect(after.credits).toBe(before.credits);
        expect(after.debits).toBe(before.debits);

        // No processed event or ledger position.
        expect(after.events).toBe(before.events);
        expect(after.positions).toBe(before.positions);

        // Verify actual PostgreSQL persistence.
        const rows = await orm.em.fork().execute<
          Array<{
            status: string;
            reference_transaction_id: string | null;
          }>
        >(
          `
            SELECT
              status,
              reference_transaction_id
            FROM wager_transactions
            WHERE id = ?
          `,
              [result.transactionId],
              'all',
        );

        expect(rows).toHaveLength(1);
        expect(rows[0]!.status).toBe(
          'PENDING_REFERENCE',
        );
        expect(
          rows[0]!.reference_transaction_id,
        ).toBeNull();
      },
    );


    test(
      'does not ROLLBACK a BET that already has a processed REFUND',
      async () => {
        const wallet = await createWallet();
        const bet = await createBet(wallet);

        await createRefund(bet);

        const before = await inspect(wallet.id);

        await expect(
          rollbackProcessor().execute(
            rollback(bet),
          ),
        ).rejects.toBeInstanceOf(
          RollbackAlreadyAppliedError,
        );

        const after = await inspect(wallet.id);

        expect(after).toEqual(before);
        expect(after.rollbacks).toBe(0);
      },
    );

    test(
      'rolls back the entire SQL transaction if ledger insertion fails',
      async () => {
        const wallet = await createWallet();
        const bet = await createBet(wallet);
        const input = rollback(bet);

        const before = await inspect(wallet.id);
        const sequenceBefore =
          await getSequence(wallet.id);

        const realRunner =
          new MikroOrmRollbackTransactionRunner(
            orm.em.fork(),
          );

        const sabotagedRunner: RollbackTransactionRunner = {
          findExisting(identity: RollbackIdentity) {
            return realRunner.findExisting(identity);
          },

          withLockedWallet<T>(
            walletId: string,
            identity: RollbackIdentity,
            referenceExternalTransactionId: string,
            operation: (
              context: LockedRollbackContext,
            ) => Promise<T>,
            inbox?: InboxReceipt,
          ): Promise<T> {
            return realRunner.withLockedWallet(
              walletId,
              identity,
              referenceExternalTransactionId,

              (context) =>
                operation({
                  ...context,

                  saveProcessed: (
                    transaction,
                    ledger,
                    snapshot,
                    details,
                  ) =>
                    context.saveProcessed(
                      transaction,
                      ledger,
                      snapshot,
                      {
                        ...details,

                        // Deliberately violate
                        // chk_ledger_arithmetic.
                        balanceBefore: Money.from({
                          amount: '999.00',
                          currency:
                          details.amount.currency,
                        }),
                      },
                    ),
                }),

              inbox,
            );
          },
        };

        const brokenProcessor =
          new ProcessRollbackUseCase(
            sabotagedRunner,
          );

        await expect(
          brokenProcessor.execute(input),
        ).rejects.toThrow();

        // PostgreSQL must revert the wallet
        // UPDATE and all associated INSERTs.
        const after = await inspect(wallet.id);
        const sequenceAfter =
          await getSequence(wallet.id);

        expect(after).toEqual(before);
        expect(sequenceAfter)
          .toEqual(sequenceBefore);

        expect(after.wallet.balance_amount)
          .toBe('70.00');

        expect(after.wallet.version).toBe(2);
        expect(after.rollbacks).toBe(0);
        expect(after.credits).toBe(0);
        expect(after.debits).toBe(0);
        expect(after.events).toBe(0);
        expect(after.positions).toBe(2);

        // The same identity must remain available
        // after a rolled-back SQL transaction.
        const recovered =
          await rollbackProcessor().execute(input);

        expect(recovered.status).toBe(
          WagerTransactionStatus.Processed,
        );

        expect(recovered.balance.amount)
          .toBe('100.00');

        const final = await inspect(wallet.id);

        expect(final.rollbacks).toBe(1);
        expect(final.credits).toBe(1);
        expect(final.events).toBe(1);
        expect(final.positions).toBe(3);
      },
    );


    test(
      'reconciles BET rollback with CREDIT',
      async () => {
        const wallet = await createWallet('100.00');
        const original = await createBet(wallet, '30.00');

        const rollbackResult =
          await rollbackProcessor().execute(
            rollback(original),
          );

        expect(rollbackResult.status).toBe(
          WagerTransactionStatus.Processed,
        );

        const report =
          await new PostgresWalletReconciliationService(
            orm.em.fork(),
          ).reconcile(wallet.id);

        expect(report.consistent).toBe(true);
        expect(report.actualBalance).toBe('100.00');
        expect(report.expectedBalance).toBe('100.00');
        expect(report.difference).toBe('0.00');

        expect(report.ledgerEntries).toBe(3);
        expect(report.actualVersion).toBe(3);
        expect(report.expectedVersion).toBe(3);

        expect(report.unexpectedLedgerEntries).toBe(0);
        expect(report.missingLedgerEntries).toBe(0);
        expect(report.invalidLedgerLinks).toBe(0);
        expect(report.mismatchedAmounts).toBe(0);
        expect(report.issues).toHaveLength(0);
      },
    );

    test(
      'reconciles WIN rollback with DEBIT',
      async () => {
        const wallet = await createWallet('100.00');
        const original = await createWin(wallet, '30.00');

        const rollbackResult =
          await rollbackProcessor().execute(
            rollback(original),
          );

        expect(rollbackResult.status).toBe(
          WagerTransactionStatus.Processed,
        );

        const report =
          await new PostgresWalletReconciliationService(
            orm.em.fork(),
          ).reconcile(wallet.id);

        expect(report.consistent).toBe(true);
        expect(report.actualBalance).toBe('100.00');
        expect(report.expectedBalance).toBe('100.00');
        expect(report.difference).toBe('0.00');

        expect(report.ledgerEntries).toBe(3);
        expect(report.actualVersion).toBe(3);
        expect(report.expectedVersion).toBe(3);

        expect(report.unexpectedLedgerEntries).toBe(0);
        expect(report.missingLedgerEntries).toBe(0);
        expect(report.invalidLedgerLinks).toBe(0);
        expect(report.mismatchedAmounts).toBe(0);
        expect(report.issues).toHaveLength(0);
      },
    );

    test(
      'reconciles REFUND rollback with DEBIT',
      async () => {
        const wallet = await createWallet('100.00');

        const originalBet =
          await createBet(wallet, '30.00');

        const refund =
          await createRefund(originalBet);

        const rollbackResult =
          await rollbackProcessor().execute(
            rollback(refund),
          );

        expect(rollbackResult.status).toBe(
          WagerTransactionStatus.Processed,
        );

        const report =
          await new PostgresWalletReconciliationService(
            orm.em.fork(),
          ).reconcile(wallet.id);

        expect(report.consistent).toBe(true);
        expect(report.actualBalance).toBe('70.00');
        expect(report.expectedBalance).toBe('70.00');
        expect(report.difference).toBe('0.00');

        expect(report.ledgerEntries).toBe(4);
        expect(report.actualVersion).toBe(4);
        expect(report.expectedVersion).toBe(4);

        expect(report.unexpectedLedgerEntries).toBe(0);
        expect(report.missingLedgerEntries).toBe(0);
        expect(report.invalidLedgerLinks).toBe(0);
        expect(report.mismatchedAmounts).toBe(0);
        expect(report.issues).toHaveLength(0);
      },
    );

  },
);
