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

import {
  ProcessRefundUseCase,
  type ProcessRefundInput,
} from '../../src/modules/wagering/application/use-cases/process-refund.use-case.js';

import { MikroOrmBetTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-bet-transaction-runner.js';

import { MikroOrmRefundTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-refund-transaction-runner.js';

import {
  RefundAlreadyAppliedError,
  RefundIdentityConflictError,
  RefundInvalidReferenceError,
  RefundReferenceNotFoundError,
  type LockedRefundContext,
  type RefundIdentity,
  type RefundTransactionRunner,
} from '../../src/modules/wagering/application/ports/refund-transaction-runner.js';

import type {
  InboxReceipt,
} from '../../src/modules/wagering/application/ports/bet-transaction-runner.js';
import { WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction.js';

let orm: MikroORM;

type Wallet = {
  id: string;
  playerId: string;
};

interface BetFixture {
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

  const created = await new CreateWalletUseCase(
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
    id: created.id,
    playerId,
  };
}

async function createBet(
  wallet: Wallet,
  amount = '30.00',
): Promise<BetFixture> {
  const providerId = 'refund-persistence-tests';
  const externalTransactionId = randomUUID();
  const roundId = randomUUID();
  const gameId = 'refund-integration';

  const result = await new ProcessBetUseCase(
    new MikroOrmBetTransactionRunner(
      orm.em.fork(),
    ),
  ).execute({
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

  expect(result.status).toBe(WagerTransactionStatus.Processed);

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

function refund(
  bet: BetFixture,
): ProcessRefundInput {
  return {
    providerId: bet.providerId,
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),

    referenceExternalTransactionId:
    bet.externalTransactionId,

    walletId: bet.wallet.id,
    playerId: bet.wallet.playerId,
    roundId: bet.roundId,
    gameId: bet.gameId,

    amount: bet.amount,
    currency: 'BRL',
  };
}

function processor(): ProcessRefundUseCase {
  return new ProcessRefundUseCase(
    new MikroOrmRefundTransactionRunner(
      orm.em.fork(),
    ),
  );
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

  const countRows = await orm.em.fork().execute<
    Array<{
      refunds: number;
      credits: number;
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
            AND kind = 'REFUND'
            AND status = 'PROCESSED'
        ) AS refunds,

        (
          SELECT COUNT(*)::int
          FROM wallet_ledger_entries l
          JOIN wager_transactions t
            ON t.id = l.wager_transaction_id
          WHERE l.wallet_id = ?
            AND l.direction = 'CREDIT'
            AND t.kind = 'REFUND'
        ) AS credits,

        (
          SELECT COUNT(*)::int
          FROM outbox_messages
          WHERE aggregate_id = ?
            AND event_type = 'wager.refund.processed.v1'
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
    ],
    'all',
  );

  const counts = countRows[0];

  if (!counts) {
    throw new Error('Counts unavailable');
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
      'Ledger sequence state not found',
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

describe('PostgreSQL REFUND transactional persistence', () => {

  test(
    'restores BET amount and writes REFUND, CREDIT, Outbox and ledger position atomically',
    async () => {
      const wallet = await createWallet();
      const bet = await createBet(wallet);

      const before = await inspect(wallet.id);

      expect(before.wallet.balance_amount).toBe('70.00');
      expect(before.wallet.version).toBe(2);
      expect(before.positions).toBe(2);

      const result = await processor().execute(
        refund(bet),
      );

      const saved = await inspect(wallet.id);

      expect(result.status).toBe(WagerTransactionStatus.Processed);
      expect(result.balance.amount).toBe('100.00');
      expect(result.walletVersion).toBe(3);
      expect(result.idempotentReplay).toBe(false);

      expect(saved.wallet.balance_amount).toBe('100.00');
      expect(saved.wallet.version).toBe(3);

      expect(saved.refunds).toBe(1);
      expect(saved.credits).toBe(1);
      expect(saved.events).toBe(1);
      expect(saved.positions).toBe(3);

      const rows = await orm.em.fork().execute<
        Array<{
          reference_transaction_id: string;
          reference_external_transaction_id: string;
          balance_before: string;
          balance_after: string;
        }>
      >(
        `
          SELECT
            t.reference_transaction_id::text,
            t.reference_external_transaction_id,
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

      expect(rows).toHaveLength(1);

      expect(
        rows[0]!.reference_transaction_id,
      ).toBe(bet.transactionId);

      expect(
        rows[0]!.reference_external_transaction_id,
      ).toBe(bet.externalTransactionId);

      expect(rows[0]!.balance_before).toBe('70.00');
      expect(rows[0]!.balance_after).toBe('100.00');

      const sequence = await getSequence(wallet.id);

      expect(sequence.last_sequence).toBe('3');
      expect(sequence.last_balance).toBe('100.00');
    },
  );

  test(
    'replays the original REFUND snapshot without another credit',
    async () => {
      const wallet = await createWallet();
      const bet = await createBet(wallet);
      const input = refund(bet);

      const first = await processor().execute(input);
      const second = await processor().execute(input);

      const saved = await inspect(wallet.id);

      expect(second.transactionId).toBe(
        first.transactionId,
      );

      expect(second.balance).toEqual(
        first.balance,
      );

      expect(second.walletVersion).toBe(
        first.walletVersion,
      );

      expect(second.idempotentReplay).toBe(true);

      expect(saved.wallet.balance_amount).toBe('100.00');
      expect(saved.wallet.version).toBe(3);

      expect(saved.refunds).toBe(1);
      expect(saved.credits).toBe(1);
      expect(saved.events).toBe(1);
      expect(saved.positions).toBe(3);
    },
  );

  test(
    'allows only one of 50 different concurrent REFUNDs for the same BET',
    async () => {
      const wallet = await createWallet();
      const bet = await createBet(wallet);

      const requests = Array.from(
        { length: 50 },
        () => refund(bet),
      );

      const results = await Promise.allSettled(
        requests.map((input) =>
          processor().execute(input),
        ),
      );

      const successes = results.filter(
        (result) =>
          result.status === 'fulfilled',
      );

      const failures = results.filter(
        (result) =>
          result.status === 'rejected',
      );

      const saved = await inspect(wallet.id);

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(49);

      for (const result of results) {
        if (result.status === 'rejected') {
          expect(
            result.reason,
          ).toBeInstanceOf(
            RefundAlreadyAppliedError,
          );
        }
      }

      expect(saved.wallet.balance_amount).toBe('100.00');
      expect(saved.wallet.version).toBe(3);

      expect(saved.refunds).toBe(1);
      expect(saved.credits).toBe(1);
      expect(saved.events).toBe(1);
      expect(saved.positions).toBe(3);

      const sequence = await getSequence(wallet.id);

      expect(sequence.last_sequence).toBe('3');
      expect(sequence.last_balance).toBe('100.00');
    },
    30000,
  );

  test(
    '50 concurrent identical REFUNDs produce exactly one credit',
    async () => {
      const wallet = await createWallet();
      const bet = await createBet(wallet);
      const input = refund(bet);

      const results = await Promise.all(
        Array.from(
          { length: 50 },
          () => processor().execute(input),
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

      expect(saved.wallet.balance_amount).toBe('100.00');
      expect(saved.wallet.version).toBe(3);

      expect(saved.refunds).toBe(1);
      expect(saved.credits).toBe(1);
      expect(saved.events).toBe(1);
      expect(saved.positions).toBe(3);
    },
    30000,
  );

  test(
    'does not modify finances when referenced BET does not exist',
    async () => {
      const wallet = await createWallet();

      const input: ProcessRefundInput = {
        providerId: 'refund-persistence-tests',
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),

        referenceExternalTransactionId:
          randomUUID(),

        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: randomUUID(),
        gameId: 'refund-integration',
        amount: '30.00',
        currency: 'BRL',
      };

      const before = await inspect(wallet.id);

      await expect(
        processor().execute(input),
      ).rejects.toBeInstanceOf(
        RefundReferenceNotFoundError,
      );

      const after = await inspect(wallet.id);

      expect(after).toEqual(before);
      expect(after.refunds).toBe(0);
      expect(after.credits).toBe(0);
      expect(after.events).toBe(0);
    },
  );

  test(
    'rejects a REFUND with a different amount',
    async () => {
      const wallet = await createWallet();
      const bet = await createBet(wallet);

      const input = {
        ...refund(bet),
        amount: '40.00',
      };

      await expect(
        processor().execute(input),
      ).rejects.toBeInstanceOf(
        RefundInvalidReferenceError,
      );

      const saved = await inspect(wallet.id);

      expect(saved.wallet.balance_amount).toBe('70.00');
      expect(saved.wallet.version).toBe(2);

      expect(saved.refunds).toBe(0);
      expect(saved.credits).toBe(0);
      expect(saved.events).toBe(0);
      expect(saved.positions).toBe(2);
    },
  );

  test(
    'rejects a REFUND identity already used by BET',
    async () => {
      const wallet = await createWallet();
      const bet = await createBet(wallet);

      const input = {
        ...refund(bet),
        externalTransactionId:
        bet.externalTransactionId,
      };

      // Use the original BET external ID but a
      // different REFUND identity.
      // The application rejects self-reference
      // before reaching persistence.
      await expect(
        processor().execute(input),
      ).rejects.toBeInstanceOf(
        RefundInvalidReferenceError,
      );

      const saved = await inspect(wallet.id);

      expect(saved.wallet.balance_amount).toBe('70.00');
      expect(saved.refunds).toBe(0);
    },
  );

  test(
    'rolls back wallet, REFUND and Outbox when ledger insertion fails',
    async () => {
      const wallet = await createWallet();
      const bet = await createBet(wallet);
      const input = refund(bet);

      const before = await inspect(wallet.id);
      const sequenceBefore =
        await getSequence(wallet.id);

      const realRunner =
        new MikroOrmRefundTransactionRunner(
          orm.em.fork(),
        );

      // Force an invalid balance_before during
      // ledger insertion, without modifying the
      // production schema or using test triggers.
      const sabotagedRunner: RefundTransactionRunner = {
        findExisting(identity: RefundIdentity) {
          return realRunner.findExisting(identity);
        },

        withLockedWallet<T>(
          walletId: string,
          identity: RefundIdentity,
          referenceExternalTransactionId: string,
          operation: (
            context: LockedRefundContext,
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
                  snapshot,
                  details,
                  ledger,
                ) =>
                  context.saveProcessed(
                    transaction,
                    snapshot,
                    {
                      ...details,
                      balanceBefore: Money.from({
                        amount: '999.00',
                        currency:
                        details.amount.currency,
                      }),
                    },
                    ledger,
                  ),
              }),
            inbox,
          );
        },
      };

      const brokenProcessor =
        new ProcessRefundUseCase(
          sabotagedRunner,
        );

      await expect(
        brokenProcessor.execute(input),
      ).rejects.toThrow();

      const after = await inspect(wallet.id);
      const sequenceAfter =
        await getSequence(wallet.id);

      // The SQL UPDATE on wallets occurred
      // before the intentionally broken ledger.
      // PostgreSQL must revert everything.
      expect(after).toEqual(before);
      expect(sequenceAfter).toEqual(
        sequenceBefore,
      );

      expect(after.wallet.balance_amount).toBe('70.00');
      expect(after.wallet.version).toBe(2);

      expect(after.refunds).toBe(0);
      expect(after.credits).toBe(0);
      expect(after.events).toBe(0);
      expect(after.positions).toBe(2);

      // A valid retry must still succeed.
      const recovered = await processor().execute(
        input,
      );

      expect(recovered.status).toBe(WagerTransactionStatus.Processed);
      expect(recovered.balance.amount).toBe('100.00');

      const final = await inspect(wallet.id);

      expect(final.refunds).toBe(1);
      expect(final.credits).toBe(1);
      expect(final.events).toBe(1);
      expect(final.positions).toBe(3);
    },
  );
});
