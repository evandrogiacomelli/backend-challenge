
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
import { OutboxMessageEntity } from '../../src/modules/messaging/outbox/infrastructure/persistence/outbox-message.entity.js';
import {
  ProcessBetUseCase,
  type ProcessBetInput,
} from '../../src/modules/wagering/application/use-cases/process-bet.use-case.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransaction,
} from '../../src/modules/wagering/domain/wager-transaction.js';
import type {
  BetResponseSnapshot,
} from '../../src/modules/wagering/application/ports/bet-transaction-runner.js';
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

  const creator = new CreateWalletUseCase(
    new MikroOrmWalletOpeningPersistence(
      orm.em.fork(),
    ),
  );

  const wallet = await creator.execute({
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

function createInput(
  wallet: TestWallet,
  amount = '30.00',
): ProcessBetInput {
  return {
    providerId: 'provider-a',
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-outbox',
    gameId: 'game-outbox',
    amount,
    currency: 'BRL',
  };
}

function createUseCase() {
  return new ProcessBetUseCase(
    new MikroOrmBetTransactionRunner(
      orm.em.fork(),
    ),
  );
}

async function findBetEvents(walletId: string) {
  return orm.em.fork().find(
    OutboxMessageEntity,
    {
      aggregateId: walletId,
    },
    {
      orderBy: { createdAt: 'ASC' },
    },
  );
}

async function countDebits(walletId: string) {
  return orm.em.fork().count(
    WalletLedgerEntryEntity,
    {
      wallet: walletId,
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

describe('Transactional BET Outbox', () => {
  test('should persist BET, debit and outbox together', async () => {
    const wallet = await createWallet();

    const result = await createUseCase().execute(
      createInput(wallet, '30.00'),
    );

    const em = orm.em.fork();

    const persistedWallet = await em.findOneOrFail(
      WalletEntity,
      wallet.id,
    );

    const transaction = await em.findOneOrFail(
      WagerTransactionEntity,
      result.transactionId,
    );

    const events = await findBetEvents(wallet.id);

    expect(result.status).toBe(
      WagerTransactionStatus.Processed,
    );

    expect(persistedWallet.balanceAmount).toBe('70.00');
    expect(persistedWallet.version).toBe(2);

    expect(transaction.status).toBe(
      WagerTransactionStatus.Processed,
    );

    expect(await countDebits(wallet.id)).toBe(1);

    expect(events).toHaveLength(1);

    const event = events[0]!;

    expect(event.eventType).toBe(
      'wager.bet.processed.v1',
    );

    expect(event.status).toBe('PENDING');
    expect(event.attempts).toBe(0);
    expect(event.aggregateId).toBe(wallet.id);

    expect(event.payload.transactionId).toBe(
      transaction.id,
    );

    expect(event.payload.eventId).toBe(event.id);
    expect(event.payload.walletId).toBe(wallet.id);
    expect(event.payload.schemaVersion).toBe(1);

    expect(event.payload.resultingBalance).toEqual({
      amount: '70.00',
      currency: 'BRL',
    });

    expect(event.payload.walletVersion).toBe(2);
  });

  test('should persist rejected BET and outbox without debit', async () => {
    const wallet = await createWallet('10.00');

    const result = await createUseCase().execute(
      createInput(wallet, '50.00'),
    );

    expect(result.status).toBe(
      WagerTransactionStatus.Rejected,
    );

    expect(result.failureCode).toBe(
      'INSUFFICIENT_FUNDS',
    );

    const events = await findBetEvents(wallet.id);

    expect(events).toHaveLength(1);

    expect(events[0]!.eventType).toBe(
      'wager.bet.rejected.v1',
    );

    expect(events[0]!.status).toBe('PENDING');

    expect(events[0]!.payload.failureCode).toBe(
      'INSUFFICIENT_FUNDS',
    );

    expect(await countDebits(wallet.id)).toBe(0);

    const persistedWallet = await orm.em.fork()
      .findOneOrFail(WalletEntity, wallet.id);

    expect(persistedWallet.balanceAmount).toBe('10.00');
    expect(persistedWallet.version).toBe(1);
  });

  test('should not create a second event on idempotent replay', async () => {
    const wallet = await createWallet();
    const input = createInput(wallet);

    const first = await createUseCase().execute(input);
    const replay = await createUseCase().execute(input);

    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);

    expect(first.transactionId).toBe(
      replay.transactionId,
    );

    expect(await countDebits(wallet.id)).toBe(1);
    expect(await findBetEvents(wallet.id)).toHaveLength(1);
  });

  test('should create one event per distinct concurrent BET', async () => {
    const wallet = await createWallet('100.00');

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        createUseCase().execute(
          createInput(wallet, '1.00'),
        ),
      ),
    );

    expect(results).toHaveLength(20);

    expect(
      results.every(
        (result) =>
          result.status ===
          WagerTransactionStatus.Processed,
      ),
    ).toBe(true);

    const persistedWallet = await orm.em.fork()
      .findOneOrFail(WalletEntity, wallet.id);

    expect(persistedWallet.balanceAmount).toBe('80.00');
    expect(persistedWallet.version).toBe(21);

    expect(await countDebits(wallet.id)).toBe(20);

    const events = await findBetEvents(wallet.id);

    expect(events).toHaveLength(20);

    const eventIds = new Set(
      events.map((event) => event.id),
    );

    expect(eventIds.size).toBe(20);

    expect(
      events.every(
        (event) =>
          event.status === 'PENDING' &&
          event.eventType === 'wager.bet.processed.v1',
      ),
    ).toBe(true);
  }, 30000);

  test('should roll back BET and wallet if outbox insert fails', async () => {
    const wallet = await createWallet('100.00');

    class FailingOutboxRunner
      extends MikroOrmBetTransactionRunner {
      protected override createOutboxMessage(
        transaction: WagerTransaction,
        snapshot: BetResponseSnapshot,
      ): OutboxMessageEntity {
        const event = super.createOutboxMessage(
          transaction,
          snapshot,
        );

        // Simulate a database constraint violation
        // during the outbox INSERT.
        event.status = 'INVALID' as 'PENDING';

        return event;
      }
    }

    const useCase = new ProcessBetUseCase(
      new FailingOutboxRunner(orm.em.fork()),
    );

    await expect(
      useCase.execute(createInput(wallet, '40.00')),
    ).rejects.toThrow();

    const persistedWallet = await orm.em.fork()
      .findOneOrFail(WalletEntity, wallet.id);

    expect(persistedWallet.balanceAmount).toBe('100.00');
    expect(persistedWallet.version).toBe(1);

    expect(await countDebits(wallet.id)).toBe(0);
    expect(await findBetEvents(wallet.id)).toHaveLength(0);

    const transactionCount = await orm.em.fork().count(
      WagerTransactionEntity,
      {
        wallet: wallet.id,
        kind: WagerTransactionKind.Bet,
      },
    );

    expect(transactionCount).toBe(0);
  });
});
