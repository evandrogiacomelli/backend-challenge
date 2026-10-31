
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
import type {
  BetTransactionRunner,
  LockedBetContext,
} from '../ports/bet-transaction-runner.js';
import {
  WalletNotFoundError,
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

function createFixture(
  balance = '100.00',
) {
  const input = createInput();

  const wallet = Wallet.open({
    id: input.walletId,
    playerId: input.playerId,
    initialBalance: Money.from({
      amount: balance,
      currency: input.currency,
    }),
  });

  const processed: Array<{
    transaction: WagerTransaction;
    ledger: WalletLedgerEntry;
  }> = [];

  const rejected: WagerTransaction[] = [];

  const runner: BetTransactionRunner = {
    async withLockedWallet<T>(
      walletId: string,
      callback: (context: LockedBetContext) => Promise<T>,
    ): Promise<T> {
      if (walletId !== wallet.id) {
        throw new WalletNotFoundError();
      }

      return callback({
        wallet,
        async saveProcessed(transaction, ledger) {
          processed.push({ transaction, ledger });
        },
        async saveRejected(transaction) {
          rejected.push(transaction);
        },
      });
    },
  };

  return {
    input,
    wallet,
    processed,
    rejected,
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

    expect(
      ledger.balanceBefore.toJSON().amount,
    ).toBe('100.00');

    expect(
      ledger.balanceAfter.toJSON().amount,
    ).toBe('75.00');

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

    expect(result.failureCode).toBe(
      'INSUFFICIENT_FUNDS',
    );

    expect(result.balance.amount).toBe('20.00');
    expect(result.walletVersion).toBe(1);

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
    expect(fixture.rejected).toHaveLength(0);
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
    expect(fixture.rejected).toHaveLength(0);
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
    expect(fixture.rejected).toHaveLength(0);
  });

  test('should reject a missing wallet', async () => {
    const runner: BetTransactionRunner = {
      async withLockedWallet() {
        throw new WalletNotFoundError();
      },
    };

    const useCase = new ProcessBetUseCase(runner);

    await expect(
      useCase.execute(createInput()),
    ).rejects.toBeInstanceOf(WalletNotFoundError);
  });
});
