import { randomUUID } from 'node:crypto';

import {
  describe,
  expect,
  test,
} from 'bun:test';

import { Decimal } from 'decimal.js';

import { Money } from '../../../../shared/domain/money.js';

import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransactionState,
} from '../../domain/wager-transaction.js';

import {
  RollbackAlreadyAppliedError,
  RollbackIdentityConflictError,
  RollbackInsufficientFundsError,
  RollbackInvalidReferenceError,
  RollbackReferenceNotFoundError,
  type RollbackTransactionRunner,
  type StoredRollback,
} from '../ports/rollback-transaction-runner.js';

import {
  ProcessRollbackUseCase,
  type ProcessRollbackInput,
} from './process-rollback.use-case.js';

function input(): ProcessRollbackInput {
  return {
    providerId: 'rollback-unit-tests',
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),
    referenceExternalTransactionId: randomUUID(),
    walletId: randomUUID(),
    playerId: randomUUID(),
    roundId: randomUUID(),
    gameId: 'rollback-game',
    amount: '30.00',
    currency: 'BRL',
  };
}

function reference(
  value: ProcessRollbackInput,
  kind: WagerTransactionKind,
  overrides: Partial<WagerTransactionState> = {},
): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: randomUUID(),
    providerId: value.providerId,
    externalTransactionId:
    value.referenceExternalTransactionId,
    idempotencyKey: randomUUID(),
    payloadHash: randomUUID(),
    walletId: value.walletId,
    playerId: value.playerId,
    roundId: value.roundId,
    gameId: value.gameId,
    kind,
    money: Money.from({
      amount: value.amount,
      currency: value.currency,
    }),
    status: WagerTransactionStatus.Processed,
    createdAt: new Date(),
    processedAt: new Date(),
    attempts: 0,
    ...overrides,
  });
}

function harness(
  value: ProcessRollbackInput,
  referenceKind = WagerTransactionKind.Bet,
  initialBalance = '70.00',
) {
  let currentBalance = Money.from({
    amount: initialBalance,
    currency: 'BRL',
  });

  let currentVersion = 2;

  let original: WagerTransaction | null =
    reference(value, referenceKind);

  let existing: StoredRollback | null = null;
  let alreadyReversed = false;

  let saves = 0;

  const wallet = {
    id: value.walletId,
    playerId: value.playerId,
    currency: 'BRL',

    get balance() {
      return currentBalance;
    },

    get version() {
      return currentVersion;
    },

    credit(amount: Money) {
      const balanceBefore = currentBalance;

      const next = new Decimal(
        balanceBefore.toJSON().amount,
      ).plus(amount.toJSON().amount);

      currentBalance = Money.from({
        amount: next.toFixed(2),
        currency: 'BRL',
      });

      currentVersion++;

      return {
        balanceBefore,
        balanceAfter: currentBalance,
      };
    },

    debit(amount: Money) {
      const balanceBefore = currentBalance;

      const next = new Decimal(
        balanceBefore.toJSON().amount,
      ).minus(amount.toJSON().amount);

      if (next.isNegative()) {
        throw new Error('Insufficient funds');
      }

      currentBalance = Money.from({
        amount: next.toFixed(2),
        currency: 'BRL',
      });

      currentVersion++;

      return {
        balanceBefore,
        balanceAfter: currentBalance,
      };
    },
  };

  const runner: RollbackTransactionRunner = {
    async findExisting() {
      return existing;
    },

    async withLockedWallet(
      _walletId,
      identity,
      _referenceExternalTransactionId,
      callback,
    ) {

      return callback({
        wallet,
        existing,
        referenceTransaction: original,
        alreadyReversed,

        async savePendingReference(
          transaction,
          snapshot,
        ) {
          expect(transaction.status).toBe(
            WagerTransactionStatus.PendingReference,
          );

          expect(snapshot.status).toBe(
            WagerTransactionStatus.PendingReference,
          );

          // Persist the pending identity in the mock.
          // No wallet movement or ledger entry.
          existing = {
            externalTransactionId:
            identity.externalTransactionId,
            idempotencyKey:
            identity.idempotencyKey,
            payloadHash:
            identity.payloadHash,
            snapshot,
          };
        },

        async saveProcessed(
          transaction,
          ledger,
          snapshot,
          details,
        ) {
          if (!original) {
            throw new Error(
              'Missing original transaction',
            );
          }

          expect(transaction.referenceTransactionId)
            .toBe(original.id);

          expect(details.referenceTransactionId)
            .toBe(original.id);

          expect(details.balanceBefore.toJSON().amount)
            .toBe(ledger.balanceBefore.toJSON().amount);

          expect(ledger.direction)
            .toBe(details.direction);

          saves++;
          alreadyReversed = true;

          existing = {
            externalTransactionId:
            identity.externalTransactionId,
            idempotencyKey: identity.idempotencyKey,
            payloadHash: identity.payloadHash,
            snapshot,
          };
        },
      });
    },
  };

  return {
    useCase: new ProcessRollbackUseCase(runner),
    wallet,

    get saves() {
      return saves;
    },

    setReference(transaction: WagerTransaction | null) {
      original = transaction;
    },

    setAlreadyReversed(value: boolean) {
      alreadyReversed = value;
    },
  };
}

describe('ProcessRollbackUseCase', () => {
  test('reverses BET with CREDIT', async () => {
    const value = input();
    const setup = harness(value);

    const result = await setup.useCase.execute(value);

    expect(result.status)
      .toBe(WagerTransactionStatus.Processed);

    expect(result.balance.amount).toBe('100.00');
    expect(result.walletVersion).toBe(3);
    expect(result.idempotentReplay).toBe(false);
    expect(setup.saves).toBe(1);
  });

  test('replays the same ROLLBACK without crediting again', async () => {
    const value = input();
    const setup = harness(value);

    const first = await setup.useCase.execute(value);
    const repeated = await setup.useCase.execute(value);

    expect(repeated.transactionId)
      .toBe(first.transactionId);

    expect(repeated.balance).toEqual(first.balance);
    expect(repeated.idempotentReplay).toBe(true);
    expect(setup.wallet.balance.toJSON().amount)
      .toBe('100.00');
    expect(setup.saves).toBe(1);
  });

  test('reverses WIN with DEBIT', async () => {
    const value = input();
    const setup = harness(
      value,
      WagerTransactionKind.Win,
      '130.00',
    );

    const result = await setup.useCase.execute(value);

    expect(result.balance.amount).toBe('100.00');
    expect(result.walletVersion).toBe(3);
    expect(setup.saves).toBe(1);
  });

  test('reverses REFUND with DEBIT', async () => {
    const value = input();
    const setup = harness(
      value,
      WagerTransactionKind.Refund,
      '100.00',
    );

    const result = await setup.useCase.execute(value);

    expect(result.balance.amount).toBe('70.00');
    expect(setup.saves).toBe(1);
  });

  test('rejects reversing WIN without sufficient balance', async () => {
    const value = input();
    const setup = harness(
      value,
      WagerTransactionKind.Win,
      '20.00',
    );

    await expect(
      setup.useCase.execute(value),
    ).rejects.toBeInstanceOf(
      RollbackInsufficientFundsError,
    );

    expect(setup.wallet.balance.toJSON().amount)
      .toBe('20.00');

    expect(setup.wallet.version).toBe(2);
    expect(setup.saves).toBe(0);
  });

  test('rejects reference to LOSS', async () => {
    const value = input();
    const setup = harness(value);

    setup.setReference(
      reference(value, WagerTransactionKind.Loss),
    );

    await expect(
      setup.useCase.execute(value),
    ).rejects.toBeInstanceOf(
      RollbackInvalidReferenceError,
    );

    expect(setup.saves).toBe(0);
  });

  test('rejects different rollback amount', async () => {
    const value = input();
    const setup = harness(value);

    await expect(
      setup.useCase.execute({
        ...value,
        amount: '40.00',
      }),
    ).rejects.toBeInstanceOf(
      RollbackInvalidReferenceError,
    );

    expect(setup.saves).toBe(0);
  });

  test('rejects already reversed transaction', async () => {
    const value = input();
    const setup = harness(value);

    setup.setAlreadyReversed(true);

    await expect(
      setup.useCase.execute(value),
    ).rejects.toBeInstanceOf(
      RollbackAlreadyAppliedError,
    );

    expect(setup.saves).toBe(0);
  });

  test('rejects reused idempotency key with changed payload', async () => {
    const value = input();
    const setup = harness(value);

    await setup.useCase.execute(value);

    await expect(
      setup.useCase.execute({
        ...value,
        amount: '40.00',
      }),
    ).rejects.toBeInstanceOf(
      RollbackIdentityConflictError,
    );

    expect(setup.saves).toBe(1);
  });

  test('rejects reference from another wallet', async () => {
    const value = input();
    const setup = harness(value);

    setup.setReference(
      reference(value, WagerTransactionKind.Bet, {
        walletId: randomUUID(),
      }),
    );

    await expect(
      setup.useCase.execute(value),
    ).rejects.toBeInstanceOf(
      RollbackInvalidReferenceError,
    );

    expect(setup.saves).toBe(0);
  });

  test('rejects missing reference external ID', async () => {
    const value = input();
    const setup = harness(value);

    await expect(
      setup.useCase.execute({
        ...value,
        referenceExternalTransactionId: '',
      }),
    ).rejects.toBeInstanceOf(
      RollbackInvalidReferenceError,
    );

    expect(setup.saves).toBe(0);
  });



  test('persists ROLLBACK as pending without financial movement', async () => {
    const value = input();
    const setup = harness(value);

    setup.setReference(null);

    const result = await setup.useCase.execute(value);

    expect(result.status).toBe(
      WagerTransactionStatus.PendingReference,
    );

    expect(result.balance.amount).toBe('70.00');
    expect(result.walletVersion).toBe(2);
    expect(result.idempotentReplay).toBe(false);

    expect(setup.saves).toBe(0);
    expect(setup.wallet.version).toBe(2);

    const replay = await setup.useCase.execute(value);

    expect(replay.transactionId).toBe(
      result.transactionId,
    );

    expect(replay.status).toBe(
      WagerTransactionStatus.PendingReference,
    );

    expect(replay.idempotentReplay).toBe(true);
    expect(setup.saves).toBe(0);
  });
});
