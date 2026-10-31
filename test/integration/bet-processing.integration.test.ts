
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
import { WalletLedgerEntryEntity } from '../../src/modules/ledger/infrastructure/persistence/wallet-ledger-entry.entity.js';
import {
  ProcessBetUseCase,
  type ProcessBetInput,
} from '../../src/modules/wagering/application/use-cases/process-bet.use-case.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/modules/wagering/domain/wager-transaction.js';
import { MikroOrmBetTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-bet-transaction-runner.js';
import { WagerTransactionEntity } from '../../src/modules/wagering/infrastructure/persistence/wager-transaction.entity.js';
import { CreateWalletUseCase } from '../../src/modules/wallet/application/use-cases/create-wallet.use-case.js';
import { MikroOrmWalletOpeningPersistence } from '../../src/modules/wallet/infrastructure/persistence/mikro-orm-wallet-opening.persistence.js';
import { WalletEntity } from '../../src/modules/wallet/infrastructure/persistence/wallet.entity.js';

let orm: MikroORM;

interface TestWallet {
  id: string;
  playerId: string;
}

function createBetInput(
  wallet: TestWallet,
  amount: string,
): ProcessBetInput {
  return {
    providerId: 'provider-a',
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    amount,
    currency: 'BRL',
  };
}

async function createWallet(
  initialBalance: string,
): Promise<TestWallet> {
  const playerId = randomUUID();

  const useCase = new CreateWalletUseCase(
    new MikroOrmWalletOpeningPersistence(
      orm.em.fork(),
    ),
  );

  const result = await useCase.execute({
    playerId,
    initialBalance: {
      amount: initialBalance,
      currency: 'BRL',
    },
  });

  return {
    id: result.id,
    playerId,
  };
}

function createBetUseCase(): ProcessBetUseCase {
  return new ProcessBetUseCase(
    new MikroOrmBetTransactionRunner(
      orm.em.fork(),
    ),
  );
}

beforeAll(async () => {
  orm = await MikroORM.init(mikroOrmConfig);
});

afterAll(async () => {
  await orm?.close(true);
});

describe('Transactional BET processing', () => {
  test('should persist wallet debit and ledger atomically', async () => {
    const wallet = await createWallet('100.00');

    const result = await createBetUseCase().execute(
      createBetInput(wallet, '25.00'),
    );

    const em = orm.em.fork();

    const persistedWallet = await em.findOneOrFail(
      WalletEntity,
      wallet.id,
    );

    const bet = await em.findOneOrFail(
      WagerTransactionEntity,
      result.transactionId,
    );

    const ledger = await em.findOneOrFail(
      WalletLedgerEntryEntity,
      { transaction: bet },
    );

    expect(result.status).toBe(
      WagerTransactionStatus.Processed,
    );

    expect(persistedWallet.balanceAmount).toBe('75.00');
    expect(persistedWallet.version).toBe(2);

    expect(bet.kind).toBe(WagerTransactionKind.Bet);
    expect(bet.status).toBe(
      WagerTransactionStatus.Processed,
    );

    expect(ledger.direction).toBe('DEBIT');
    expect(ledger.amount).toBe('25.00');
    expect(ledger.balanceBefore).toBe('100.00');
    expect(ledger.balanceAfter).toBe('75.00');
  });

  test('should process only one of two concurrent 80.00 BETs', async () => {
    const wallet = await createWallet('100.00');
    const useCase = createBetUseCase();

    const [first, second] = await Promise.all([
      useCase.execute(createBetInput(wallet, '80.00')),
      useCase.execute(createBetInput(wallet, '80.00')),
    ]);

    const results = [first, second];

    expect(
      results.filter(
        (result) =>
          result.status === WagerTransactionStatus.Processed,
      ),
    ).toHaveLength(1);

    expect(
      results.filter(
        (result) =>
          result.status === WagerTransactionStatus.Rejected,
      ),
    ).toHaveLength(1);

    const em = orm.em.fork();

    const persistedWallet = await em.findOneOrFail(
      WalletEntity,
      wallet.id,
    );

    const transactions = await em.find(
      WagerTransactionEntity,
      { wallet: wallet.id, kind: WagerTransactionKind.Bet },
    );

    const entries = await em.find(
      WalletLedgerEntryEntity,
      { wallet: wallet.id },
    );

    expect(persistedWallet.balanceAmount).toBe('20.00');
    expect(persistedWallet.version).toBe(2);

    expect(transactions).toHaveLength(2);
    expect(entries).toHaveLength(2);

    // One opening CREDIT and one processed BET DEBIT.
    expect(
      entries.filter((entry) => entry.direction === 'DEBIT'),
    ).toHaveLength(1);
  });

  test('should serialize 50 concurrent BETs on one wallet', async () => {
    const wallet = await createWallet('100.00');
    const useCase = createBetUseCase();

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        useCase.execute(createBetInput(wallet, '1.00')),
      ),
    );

    expect(results).toHaveLength(50);

    expect(
      results.every(
        (result) =>
          result.status === WagerTransactionStatus.Processed,
      ),
    ).toBe(true);

    const em = orm.em.fork();

    const persistedWallet = await em.findOneOrFail(
      WalletEntity,
      wallet.id,
    );

    const transactions = await em.find(
      WagerTransactionEntity,
      {
        wallet: wallet.id,
        kind: WagerTransactionKind.Bet,
      },
    );

    const entries = await em.find(
      WalletLedgerEntryEntity,
      {
        wallet: wallet.id,
        direction: 'DEBIT',
      },
    );

    expect(persistedWallet.balanceAmount).toBe('50.00');
    expect(persistedWallet.version).toBe(51);

    expect(transactions).toHaveLength(50);
    expect(entries).toHaveLength(50);

    expect(
      entries.every((entry) => entry.amount === '1.00'),
    ).toBe(true);
  }, 30000);

  test('should roll back wallet debit when transaction insert fails', async () => {
    const wallet = await createWallet('100.00');
    const useCase = createBetUseCase();

    const firstInput = createBetInput(wallet, '10.00');

    await useCase.execute(firstInput);

    const duplicateExternalId: ProcessBetInput = {
      ...createBetInput(wallet, '5.00'),
      externalTransactionId: firstInput.externalTransactionId,
    };

    await expect(
      useCase.execute(duplicateExternalId),
    ).rejects.toThrow();

    const em = orm.em.fork();

    const persistedWallet = await em.findOneOrFail(
      WalletEntity,
      wallet.id,
    );

    const bets = await em.find(
      WagerTransactionEntity,
      {
        wallet: wallet.id,
        kind: WagerTransactionKind.Bet,
      },
    );

    const debits = await em.find(
      WalletLedgerEntryEntity,
      {
        wallet: wallet.id,
        direction: 'DEBIT',
      },
    );

    expect(persistedWallet.balanceAmount).toBe('90.00');
    expect(persistedWallet.version).toBe(2);

    expect(bets).toHaveLength(1);
    expect(debits).toHaveLength(1);
  });
});
