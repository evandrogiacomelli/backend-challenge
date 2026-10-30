
import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../wagering/domain/wager-transaction.js';
import type {
  WalletOpeningPersistence,
  WalletOpeningRecords,
} from '../ports/wallet-opening-persistence.js';
import type { Wallet } from '../../domain/wallet.js';
import { CreateWalletUseCase } from './create-wallet.use-case.js';

interface SavedWallet {
  wallet: Wallet;
  opening?: WalletOpeningRecords;
}

function createUseCase() {
  const saved: SavedWallet[] = [];

  const persistence: WalletOpeningPersistence = {
    async save(
      wallet: Wallet,
      opening?: WalletOpeningRecords,
    ) {
      saved.push({ wallet, opening });
    },
  };

  return {
    useCase: new CreateWalletUseCase(persistence),
    saved,
  };
}

describe('CreateWalletUseCase', () => {
  test('should open a wallet with initial balance', async () => {
    const { useCase, saved } = createUseCase();

    const result = await useCase.execute({
      playerId: randomUUID(),
      initialBalance: {
        amount: '100.00',
        currency: 'BRL',
      },
    });

    expect(result.balance).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });

    expect(result.version).toBe(1);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.opening).toBeDefined();
  });

  test('should create a processed OPENING transaction', async () => {
    const { useCase, saved } = createUseCase();

    await useCase.execute({
      playerId: randomUUID(),
      initialBalance: {
        amount: '250.00',
        currency: 'BRL',
      },
    });

    const opening = saved[0]!.opening!;

    expect(opening.transaction.kind).toBe(
      WagerTransactionKind.Opening,
    );

    expect(opening.transaction.status).toBe(
      WagerTransactionStatus.Processed,
    );

    expect(opening.transaction.money.toJSON().amount).toBe(
      '250.00',
    );
  });

  test('should create a matching CREDIT ledger entry', async () => {
    const { useCase, saved } = createUseCase();

    await useCase.execute({
      playerId: randomUUID(),
      initialBalance: {
        amount: '100.00',
        currency: 'BRL',
      },
    });

    const opening = saved[0]!.opening!;

    expect(opening.ledger.direction).toBe('CREDIT');

    expect(
      opening.ledger.balanceBefore.toJSON().amount,
    ).toBe('0.00');

    expect(
      opening.ledger.balanceAfter.toJSON().amount,
    ).toBe('100.00');

    expect(opening.ledger.isBalanced()).toBe(true);

    expect(opening.ledger.transactionId).toBe(
      opening.transaction.id,
    );
  });

  test('should open a zero-balance wallet without ledger', async () => {
    const { useCase, saved } = createUseCase();

    const result = await useCase.execute({
      playerId: randomUUID(),
      currency: 'BRL',
    });

    expect(result.balance.amount).toBe('0.00');
    expect(result.version).toBe(1);

    expect(saved).toHaveLength(1);
    expect(saved[0]!.opening).toBeUndefined();
  });

  test('should reject conflicting currencies', async () => {
    const { useCase, saved } = createUseCase();

    await expect(
      useCase.execute({
        playerId: randomUUID(),
        currency: 'USD',
        initialBalance: {
          amount: '100.00',
          currency: 'BRL',
        },
      }),
    ).rejects.toThrow('Currency mismatch');

    expect(saved).toHaveLength(0);
  });

  test('should reject negative initial balance', async () => {
    const { useCase, saved } = createUseCase();

    await expect(
      useCase.execute({
        playerId: randomUUID(),
        initialBalance: {
          amount: '-10.00',
          currency: 'BRL',
        },
      }),
    ).rejects.toThrow();

    expect(saved).toHaveLength(0);
  });

  test('should propagate persistence failures', async () => {
    const persistence: WalletOpeningPersistence = {
      async save() {
        throw new Error('Database unavailable');
      },
    };

    const useCase = new CreateWalletUseCase(persistence);

    await expect(
      useCase.execute({
        playerId: randomUUID(),
        currency: 'BRL',
      }),
    ).rejects.toThrow('Database unavailable');
  });
});
