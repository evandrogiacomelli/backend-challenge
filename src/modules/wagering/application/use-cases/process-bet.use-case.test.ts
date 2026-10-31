
import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import { Money } from '../../../../shared/domain/money.js';
import type { WalletLedgerEntry } from '../../../ledger/domain/wallet-ledger-entry.js';
import { Wallet } from '../../../wallet/domain/wallet.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransaction,
} from '../../domain/wager-transaction.js';
import {
  BetIdentityConflictError,
  WalletNotFoundError,
  type BetIdentity,
  type BetResponseSnapshot,
  type BetTransactionRunner,
  type LockedBetContext,
  type StoredBet,
} from '../ports/bet-transaction-runner.js';
import {
  ProcessBetUseCase,
  type ProcessBetInput,
} from './process-bet.use-case.js';

function createInput(
  overrides: Partial<ProcessBetInput> = {},
): ProcessBetInput {
  return {
    providerId: 'provider-a',
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),
    walletId: randomUUID(),
    playerId: randomUUID(),
    roundId: 'round-1',
    gameId: 'game-1',
    amount: '25.00',
    currency: 'BRL',
    ...overrides,
  };
}

function createFixture(balance = '100.00') {
  const input = createInput();

  const wallet = Wallet.open({
    id: input.walletId,
    playerId: input.playerId,
    initialBalance: Money.from({
      amount: balance,
      currency: 'BRL',
    }),
  });

  const processed: Array<{
    transaction: WagerTransaction;
    ledger: WalletLedgerEntry;
  }> = [];

  const rejected: WagerTransaction[] = [];

  const stored: StoredBet[] = [];

  function findStored(identity: BetIdentity): StoredBet | null {
    const byKey = stored.find(
      (record) =>
        record.providerId === identity.providerId &&
        record.idempotencyKey === identity.idempotencyKey,
    );

    if (byKey) {
      return {
        ...byKey,
        matchedBy: 'idempotencyKey',
      };
    }

    const byExternal = stored.find(
      (record) =>
        record.providerId === identity.providerId &&
        record.externalTransactionId ===
        identity.externalTransactionId,
    );

    if (byExternal) {
      return {
        ...byExternal,
        matchedBy: 'externalTransactionId',
      };
    }

    return null;
  }

  function store(
    transaction: WagerTransaction,
    snapshot: BetResponseSnapshot,
  ) {
    stored.push({
      matchedBy: 'idempotencyKey',
      providerId: transaction.providerId,
      externalTransactionId:
      transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      payloadHash: transaction.payloadHash,
      snapshot,
    });
  }

  const runner: BetTransactionRunner = {
    async findExisting(identity) {
      return findStored(identity);
    },

    async withLockedWallet<T>(
      walletId: string,
      identity: BetIdentity,
      callback: (context: LockedBetContext) => Promise<T>,
    ): Promise<T> {
      if (walletId !== wallet.id) {
        throw new WalletNotFoundError();
      }

      return callback({
        wallet,
        existing: findStored(identity),

        async saveProcessed(transaction, ledger, snapshot) {
          processed.push({ transaction, ledger });
          store(transaction, snapshot);
        },

        async saveRejected(transaction, snapshot) {
          rejected.push(transaction);
          store(transaction, snapshot);
        },
      });
    },
  };

  return {
    input,
    wallet,
    processed,
    rejected,
    stored,
    useCase: new ProcessBetUseCase(runner),
  };
}

describe('ProcessBetUseCase', () => {
  test('should debit a valid BET', async () => {
    const fixture = createFixture();

    const result = await fixture.useCase.execute(
      fixture.input,
    );

    expect(result.status).toBe(
      WagerTransactionStatus.Processed,
    );
    expect(result.balance.amount).toBe('75.00');
    expect(result.walletVersion).toBe(2);
    expect(result.idempotentReplay).toBe(false);

    expect(fixture.wallet.balance.toJSON().amount).toBe(
      '75.00',
    );
    expect(fixture.processed).toHaveLength(1);
    expect(fixture.rejected).toHaveLength(0);
  });

  test('should create a matching DEBIT ledger', async () => {
    const fixture = createFixture();

    await fixture.useCase.execute(fixture.input);

    const { transaction, ledger } =
      fixture.processed[0]!;

    expect(transaction.kind).toBe(
      WagerTransactionKind.Bet,
    );
    expect(transaction.status).toBe(
      WagerTransactionStatus.Processed,
    );
    expect(ledger.direction).toBe('DEBIT');
    expect(ledger.money.toJSON().amount).toBe('25.00');
    expect(ledger.balanceBefore.toJSON().amount).toBe(
      '100.00',
    );
    expect(ledger.balanceAfter.toJSON().amount).toBe(
      '75.00',
    );
    expect(ledger.transactionId).toBe(transaction.id);
  });

  test('should reject insufficient funds without ledger', async () => {
    const fixture = createFixture('20.00');

    const result = await fixture.useCase.execute(
      fixture.input,
    );

    expect(result.status).toBe(
      WagerTransactionStatus.Rejected,
    );
    expect(result.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(result.balance.amount).toBe('20.00');
    expect(result.walletVersion).toBe(1);
    expect(result.idempotentReplay).toBe(false);
    expect(fixture.processed).toHaveLength(0);
    expect(fixture.rejected).toHaveLength(1);
  });

  test('should allow betting the exact balance', async () => {
    const fixture = createFixture('25.00');

    const result = await fixture.useCase.execute(
      fixture.input,
    );

    expect(result.status).toBe(
      WagerTransactionStatus.Processed,
    );
    expect(result.balance.amount).toBe('0.00');
    expect(result.walletVersion).toBe(2);
  });

  test('should reject a zero BET amount', async () => {
    const fixture = createFixture();

    await expect(
      fixture.useCase.execute({
        ...fixture.input,
        amount: '0.00',
      }),
    ).rejects.toThrow();

    expect(fixture.processed).toHaveLength(0);
  });

  test('should reject player mismatch', async () => {
    const fixture = createFixture();

    await expect(
      fixture.useCase.execute({
        ...fixture.input,
        playerId: randomUUID(),
      }),
    ).rejects.toThrow('Wallet player mismatch');

    expect(fixture.processed).toHaveLength(0);
  });

  test('should reject currency mismatch', async () => {
    const fixture = createFixture();

    await expect(
      fixture.useCase.execute({
        ...fixture.input,
        currency: 'USD',
      }),
    ).rejects.toThrow('Wallet currency mismatch');

    expect(fixture.processed).toHaveLength(0);
  });

  test('should reject a missing wallet', async () => {
    const runner: BetTransactionRunner = {
      async findExisting() {
        return null;
      },
      async withLockedWallet() {
        throw new WalletNotFoundError();
      },
    };

    const useCase = new ProcessBetUseCase(runner);

    await expect(
      useCase.execute(createInput()),
    ).rejects.toBeInstanceOf(WalletNotFoundError);
  });

  test('should replay the same BET without debiting again', async () => {
    const fixture = createFixture();

    const first = await fixture.useCase.execute(
      fixture.input,
    );

    const replay = await fixture.useCase.execute(
      fixture.input,
    );

    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);

    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.balance).toEqual(first.balance);
    expect(replay.walletVersion).toBe(first.walletVersion);

    expect(fixture.processed).toHaveLength(1);
    expect(fixture.wallet.balance.toJSON().amount).toBe(
      '75.00',
    );
  });

  test('should reject same key with different amount', async () => {
    const fixture = createFixture();

    await fixture.useCase.execute(fixture.input);

    await expect(
      fixture.useCase.execute({
        ...fixture.input,
        amount: '30.00',
      }),
    ).rejects.toBeInstanceOf(
      BetIdentityConflictError,
    );

    expect(fixture.processed).toHaveLength(1);
    expect(fixture.wallet.balance.toJSON().amount).toBe(
      '75.00',
    );
  });

  test('should reject same external ID with different key', async () => {
    const fixture = createFixture();

    await fixture.useCase.execute(fixture.input);

    try {
      await fixture.useCase.execute({
        ...fixture.input,
        idempotencyKey: randomUUID(),
      });

      throw new Error('Expected identity conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(
        BetIdentityConflictError,
      );

      if (error instanceof BetIdentityConflictError) {
        expect(error.code).toBe(
          'EXTERNAL_TRANSACTION_ID_CONFLICT',
        );
      }
    }

    expect(fixture.processed).toHaveLength(1);
  });

  test('should replay a rejected BET without retrying it', async () => {
    const fixture = createFixture('10.00');

    const first = await fixture.useCase.execute(
      fixture.input,
    );

    const replay = await fixture.useCase.execute(
      fixture.input,
    );

    expect(first.status).toBe(
      WagerTransactionStatus.Rejected,
    );
    expect(replay.status).toBe(first.status);
    expect(replay.failureCode).toBe(first.failureCode);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.idempotentReplay).toBe(true);

    expect(fixture.rejected).toHaveLength(1);
    expect(fixture.processed).toHaveLength(0);
  });

  test('should retain the original response snapshot', async () => {
    const fixture = createFixture('100.00');

    const first = await fixture.useCase.execute(
      fixture.input,
    );

    // Different BET with a new identity changes the wallet.
    await fixture.useCase.execute({
      ...fixture.input,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      amount: '10.00',
    });

    const replay = await fixture.useCase.execute(
      fixture.input,
    );

    expect(fixture.wallet.balance.toJSON().amount).toBe(
      '65.00',
    );

    expect(first.balance.amount).toBe('75.00');
    expect(replay.balance.amount).toBe('75.00');
    expect(replay.walletVersion).toBe(2);
    expect(replay.idempotentReplay).toBe(true);
  });
});
