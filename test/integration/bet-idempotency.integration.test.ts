
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
  BetIdentityConflictError,
} from '../../src/modules/wagering/application/ports/bet-transaction-runner.js';
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

async function createWallet(
  amount = '100.00',
): Promise<TestWallet> {
  const playerId = randomUUID();

  const useCase = new CreateWalletUseCase(
    new MikroOrmWalletOpeningPersistence(
      orm.em.fork(),
    ),
  );

  const wallet = await useCase.execute({
    playerId,
    initialBalance: {
      amount,
      currency: 'BRL',
    },
  });

  return {
    id: wallet.id,
    playerId,
  };
}

function betInput(
  wallet: TestWallet,
  amount = '30.00',
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

function useCase(): ProcessBetUseCase {
  return new ProcessBetUseCase(
    new MikroOrmBetTransactionRunner(
      orm.em.fork(),
    ),
  );
}

async function walletState(id: string) {
  return orm.em.fork().findOneOrFail(WalletEntity, id);
}

async function debitCount(id: string) {
  return orm.em.fork().count(
    WalletLedgerEntryEntity,
    {
      wallet: id,
      direction: 'DEBIT',
    },
  );
}

beforeAll(async () => {
  orm = await MikroORM.init(mikroOrmConfig);
});

afterAll(async () => {
  await orm?.close(true);
});

describe('Persistent BET idempotency', () => {
  test('should return original transaction on retry', async () => {
    const wallet = await createWallet();
    const input = betInput(wallet);

    const first = await useCase().execute(input);
    const replay = await useCase().execute(input);

    expect(first.status).toBe(
      WagerTransactionStatus.Processed,
    );
    expect(first.idempotentReplay).toBe(false);

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.balance).toEqual(first.balance);
    expect(replay.walletVersion).toBe(first.walletVersion);

    expect(await debitCount(wallet.id)).toBe(1);

    const persisted = await orm.em.fork().findOneOrFail(
      WagerTransactionEntity,
      first.transactionId,
    );

    expect(persisted.responseSnapshot).toEqual({
      transactionId: first.transactionId,
      status: first.status,
      balance: first.balance,
      walletVersion: first.walletVersion,
    });
  });

  test('should preserve original balance after later BETs', async () => {
    const wallet = await createWallet();
    const original = betInput(wallet, '30.00');

    const first = await useCase().execute(original);

    await useCase().execute(
      betInput(wallet, '20.00'),
    );

    const replay = await useCase().execute(original);
    const current = await walletState(wallet.id);

    expect(current.balanceAmount).toBe('50.00');
    expect(current.version).toBe(3);

    expect(first.balance.amount).toBe('70.00');
    expect(replay.balance.amount).toBe('70.00');
    expect(replay.walletVersion).toBe(2);
    expect(replay.idempotentReplay).toBe(true);

    expect(await debitCount(wallet.id)).toBe(2);
  });

  test('should reject the same key with different payload', async () => {
    const wallet = await createWallet();
    const input = betInput(wallet);

    await useCase().execute(input);

    await expect(
      useCase().execute({
        ...input,
        amount: '40.00',
      }),
    ).rejects.toBeInstanceOf(
      BetIdentityConflictError,
    );

    expect((await walletState(wallet.id)).balanceAmount)
      .toBe('70.00');

    expect(await debitCount(wallet.id)).toBe(1);
  });

  test('should reject external ID reused with another key', async () => {
    const wallet = await createWallet();
    const input = betInput(wallet);

    await useCase().execute(input);

    try {
      await useCase().execute({
        ...input,
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

    expect(await debitCount(wallet.id)).toBe(1);
  });

  test('should process concurrent identical BET only once', async () => {
    const wallet = await createWallet();
    const input = betInput(wallet, '80.00');

    // Independent use case and EntityManager per request.
    const [first, second] = await Promise.all([
      useCase().execute(input),
      useCase().execute(input),
    ]);

    expect(first.transactionId).toBe(second.transactionId);
    expect(first.balance.amount).toBe('20.00');
    expect(second.balance.amount).toBe('20.00');

    expect(
      [first.idempotentReplay, second.idempotentReplay]
        .sort(),
    ).toEqual([false, true]);

    const persisted = await walletState(wallet.id);

    expect(persisted.balanceAmount).toBe('20.00');
    expect(persisted.version).toBe(2);
    expect(await debitCount(wallet.id)).toBe(1);

    const betCount = await orm.em.fork().count(
      WagerTransactionEntity,
      {
        wallet: wallet.id,
        kind: WagerTransactionKind.Bet,
      },
    );

    expect(betCount).toBe(1);
  }, 30000);

  test('should replay a rejected BET', async () => {
    const wallet = await createWallet('10.00');
    const input = betInput(wallet, '80.00');

    const rejected = await useCase().execute(input);
    const replay = await useCase().execute(input);

    expect(rejected.status).toBe(
      WagerTransactionStatus.Rejected,
    );
    expect(rejected.failureCode).toBe(
      'INSUFFICIENT_FUNDS',
    );

    expect(replay.transactionId).toBe(
      rejected.transactionId,
    );
    expect(replay.failureCode).toBe(
      rejected.failureCode,
    );
    expect(replay.idempotentReplay).toBe(true);

    expect(await debitCount(wallet.id)).toBe(0);
    expect((await walletState(wallet.id)).version).toBe(1);
  });

  test('should reject concurrent key reuse across wallets', async () => {
    const firstWallet = await createWallet();
    const secondWallet = await createWallet();

    const firstInput = betInput(firstWallet, '30.00');

    const secondInput: ProcessBetInput = {
      ...betInput(secondWallet, '30.00'),
      providerId: firstInput.providerId,
      idempotencyKey: firstInput.idempotencyKey,
    };

    const results = await Promise.allSettled([
      useCase().execute(firstInput),
      useCase().execute(secondInput),
    ]);

    const successes = results.filter(
      (result) => result.status === 'fulfilled',
    );

    const failures = results.filter(
      (result) => result.status === 'rejected',
    );

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    const totalDebits =
      (await debitCount(firstWallet.id)) +
      (await debitCount(secondWallet.id));

    expect(totalDebits).toBe(1);

    const first = await walletState(firstWallet.id);
    const second = await walletState(secondWallet.id);

    const balances = [
      first.balanceAmount,
      second.balanceAmount,
    ].sort();

    expect(balances).toEqual(['100.00', '70.00'].sort());
  }, 30000);


  test('should process 50 identical concurrent deliveries once', async () => {
    const wallet = await createWallet('100.00');
    const input = betInput(wallet, '30.00');

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        useCase().execute(input),
      ),
    );

    const transactionIds = new Set(
      results.map((result) => result.transactionId),
    );

    expect(transactionIds.size).toBe(1);

    expect(
      results.filter((result) => result.idempotentReplay),
    ).toHaveLength(49);

    expect(
      results.filter((result) => !result.idempotentReplay),
    ).toHaveLength(1);

    const persisted = await walletState(wallet.id);

    expect(persisted.balanceAmount).toBe('70.00');
    expect(persisted.version).toBe(2);
    expect(await debitCount(wallet.id)).toBe(1);
  }, 30000);
});
