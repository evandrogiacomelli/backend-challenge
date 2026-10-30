
import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  EntityManager,
  MikroORM,
} from '@mikro-orm/postgresql';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/modules/wagering/domain/wager-transaction.js';

import mikroOrmConfig from '../../src/config/mikro-orm.config.js';
import { WalletLedgerEntryEntity } from '../../src/modules/ledger/infrastructure/persistence/wallet-ledger-entry.entity.js';
import { WagerTransactionEntity } from '../../src/modules/wagering/infrastructure/persistence/wager-transaction.entity.js';
import { CreateWalletUseCase } from '../../src/modules/wallet/application/use-cases/create-wallet.use-case.js';
import {
  MikroOrmWalletOpeningPersistence,
  WalletAlreadyExistsError,
} from '../../src/modules/wallet/infrastructure/persistence/mikro-orm-wallet-opening.persistence.js';
import { WalletEntity } from '../../src/modules/wallet/infrastructure/persistence/wallet.entity.js';

let orm: MikroORM;

function useCaseWith(em: EntityManager): CreateWalletUseCase {
  return new CreateWalletUseCase(
    new MikroOrmWalletOpeningPersistence(em),
  );
}

async function withRollback(
  callback: (em: EntityManager) => Promise<void>,
): Promise<void> {
  const rollbackMarker = Symbol('rollback-test');

  try {
    await orm.em.fork().transactional(
      async (em) => {
        await callback(em);

        // This forces the outer transaction to roll back.
        throw rollbackMarker;
      },
      { clear: true },
    );
  } catch (error) {
    if (error !== rollbackMarker) {
      throw error;
    }
  }
}

beforeAll(async () => {
  orm = await MikroORM.init(mikroOrmConfig);
});

afterAll(async () => {
  await orm?.close(true);
});

describe('Atomic wallet opening', () => {
  test('should persist wallet, OPENING and CREDIT together', async () => {
    await withRollback(async (em) => {
      const useCase = useCaseWith(em);

      const result = await useCase.execute({
        playerId: randomUUID(),
        initialBalance: {
          amount: '100.00',
          currency: 'BRL',
        },
      });

      const wallet = await em.findOneOrFail(
        WalletEntity,
        result.id,
      );

      const transactions = await em.find(
        WagerTransactionEntity,
        { wallet },
      );

      const entries = await em.find(
        WalletLedgerEntryEntity,
        { wallet },
      );

      expect(wallet.balanceAmount).toBe('100.00');
      expect(wallet.version).toBe(1);

      expect(transactions).toHaveLength(1);
      expect(transactions[0]!.kind).toBe(WagerTransactionKind.Opening);

      expect(transactions[0]!.status).toBe(WagerTransactionStatus.Processed);

      expect(entries).toHaveLength(1);
      expect(entries[0]!.direction).toBe('CREDIT');
      expect(entries[0]!.amount).toBe('100.00');
      expect(entries[0]!.balanceBefore).toBe('0.00');
      expect(entries[0]!.balanceAfter).toBe('100.00');
    });
  });

  test('should persist only the wallet for zero balance', async () => {
    await withRollback(async (em) => {
      const result = await useCaseWith(em).execute({
        playerId: randomUUID(),
        currency: 'BRL',
      });

      const wallet = await em.findOneOrFail(
        WalletEntity,
        result.id,
      );

      const transactions = await em.find(
        WagerTransactionEntity,
        { wallet },
      );

      const entries = await em.find(
        WalletLedgerEntryEntity,
        { wallet },
      );

      expect(wallet.balanceAmount).toBe('0.00');
      expect(wallet.version).toBe(1);
      expect(transactions).toHaveLength(0);
      expect(entries).toHaveLength(0);
    });
  });

  test('should reject duplicate wallets', async () => {
    await withRollback(async (em) => {
      const useCase = useCaseWith(em);
      const playerId = randomUUID();

      await useCase.execute({
        playerId,
        initialBalance: {
          amount: '100.00',
          currency: 'BRL',
        },
      });

      await expect(
        useCase.execute({
          playerId,
          initialBalance: {
            amount: '200.00',
            currency: 'BRL',
          },
        }),
      ).rejects.toBeInstanceOf(WalletAlreadyExistsError);

      const wallets = await em.find(
        WalletEntity,
        { playerId, currency: 'BRL' },
      );

      expect(wallets).toHaveLength(1);
      expect(wallets[0]!.balanceAmount).toBe('100.00');
    });
  });

  test('should preserve the ledger balance invariant', async () => {
    await withRollback(async (em) => {
      const result = await useCaseWith(em).execute({
        playerId: randomUUID(),
        initialBalance: {
          amount: '345.67',
          currency: 'BRL',
        },
      });

      const wallet = await em.findOneOrFail(
        WalletEntity,
        result.id,
      );

      const ledger = await em.find(
        WalletLedgerEntryEntity,
        { wallet },
      );

      const totalCents = ledger.reduce((sum, entry) => {
        const [whole, fraction] = entry.amount.split('.');
        const amount =
          BigInt(whole!) * 100n + BigInt(fraction!);

        return sum +
          (entry.direction === 'CREDIT' ? amount : -amount);
      }, 0n);

      const [whole, fraction] =
        wallet.balanceAmount.split('.');

      const walletCents =
        BigInt(whole!) * 100n + BigInt(fraction!);

      expect(totalCents).toBe(walletCents);
    });
  });
});
