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
import { InboxAlreadyProcessedError, InboxPayloadConflictError, type InboxReceipt } from '../../src/modules/wagering/application/ports/bet-transaction-runner.js';
import { ProcessBetUseCase, type ProcessBetInput } from '../../src/modules/wagering/application/use-cases/process-bet.use-case.js';
import { MikroOrmBetTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-bet-transaction-runner.js';
import { CreateWalletUseCase } from '../../src/modules/wallet/application/use-cases/create-wallet.use-case.js';
import { MikroOrmWalletOpeningPersistence } from '../../src/modules/wallet/infrastructure/persistence/mikro-orm-wallet-opening.persistence.js';
import { WalletEntity } from '../../src/modules/wallet/infrastructure/persistence/wallet.entity.js';
import { WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction.js';

let orm: MikroORM;

interface TestWallet {
  id: string;
  playerId: string;
}

interface InboxRow {
  payload_hash: string;
  processed_at: Date | string | null;
}

async function createWallet(): Promise<TestWallet> {
  const playerId = randomUUID();

  const useCase = new CreateWalletUseCase(
    new MikroOrmWalletOpeningPersistence(
      orm.em.fork(),
    ),
  );

  const result = await useCase.execute({
    playerId,
    initialBalance: {
      amount: '100.00',
      currency: 'BRL',
    },
  });

  return { id: result.id, playerId };
}

function createBet(wallet: TestWallet): ProcessBetInput {
  return {
    providerId: 'provider-a',
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-inbox',
    gameId: 'game-inbox',
    amount: '30.00',
    currency: 'BRL',
  };
}

function receipt(): InboxReceipt {
  return {
    consumerName: 'wager-transactions-v1',
    messageId: randomUUID(),
    payloadHash: randomUUID().replaceAll('-', ''),
  };
}

function processor(): ProcessBetUseCase {
  return new ProcessBetUseCase(
    new MikroOrmBetTransactionRunner(
      orm.em.fork(),
    ),
  );
}

async function inboxRows(
  messageId: string,
): Promise<InboxRow[]> {
  return orm.em.fork().execute<InboxRow[]>(
    `
    SELECT payload_hash, processed_at
    FROM inbox_messages
    WHERE consumer_name = ?
      AND message_id = ?
    `,
    ['wager-transactions-v1', messageId],
    'all',
  );
}

async function debitCount(walletId: string) {
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

describe('Atomic SQS Inbox and BET', () => {
  test('should persist Inbox and BET together', async () => {
    const wallet = await createWallet();
    const inbox = receipt();

    const result = await processor().execute({
      ...createBet(wallet),
      inbox,
    });

    expect(result.status).toBe(
      WagerTransactionStatus.Processed,
    );

    const rows = await inboxRows(inbox.messageId);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload_hash).toBe(
      inbox.payloadHash,
    );
    expect(rows[0]!.processed_at).not.toBeNull();

    const savedWallet = await orm.em.fork()
      .findOneOrFail(WalletEntity, wallet.id);

    expect(savedWallet.balanceAmount).toBe('70.00');
    expect(savedWallet.version).toBe(2);
    expect(await debitCount(wallet.id)).toBe(1);
  });

  test('should not debit when Inbox is delivered again', async () => {
    const wallet = await createWallet();
    const input = createBet(wallet);
    const inbox = receipt();

    await processor().execute({ ...input, inbox });

    await expect(
      processor().execute({ ...input, inbox }),
    ).rejects.toBeInstanceOf(
      InboxAlreadyProcessedError,
    );

    expect(await debitCount(wallet.id)).toBe(1);

    const savedWallet = await orm.em.fork()
      .findOneOrFail(WalletEntity, wallet.id);

    expect(savedWallet.balanceAmount).toBe('70.00');
    expect(await inboxRows(inbox.messageId))
      .toHaveLength(1);
  });

  test('should reject same message ID with changed payload', async () => {
    const wallet = await createWallet();
    const input = createBet(wallet);
    const inbox = receipt();

    await processor().execute({ ...input, inbox });

    await expect(
      processor().execute({
        ...input,
        amount: '40.00',
        inbox: {
          ...inbox,
          payloadHash: randomUUID(),
        },
      }),
    ).rejects.toBeInstanceOf(
      InboxPayloadConflictError,
    );

    expect(await debitCount(wallet.id)).toBe(1);
  });

  test('should roll back Inbox on business identity conflict', async () => {
    const wallet = await createWallet();
    const first = createBet(wallet);

    await processor().execute(first);

    const inbox = receipt();

    await expect(
      processor().execute({
        ...createBet(wallet),
        externalTransactionId:
        first.externalTransactionId,
        inbox,
      }),
    ).rejects.toThrow();

    expect(
      await inboxRows(inbox.messageId),
    ).toHaveLength(0);

    expect(await debitCount(wallet.id)).toBe(1);
  });


  test('should process 50 concurrent deliveries once', async () => {
    const wallet = await createWallet();
    const input = createBet(wallet);
    const inbox = receipt();

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        processor().execute({
          ...input,
          inbox,
        }),
      ),
    );

    const successful = results.filter(
      (result) => result.status === 'fulfilled',
    );

    const duplicated = results.filter(
      (result) =>
        result.status === 'rejected' &&
        result.reason instanceof InboxAlreadyProcessedError,
    );

    expect(successful).toHaveLength(1);
    expect(duplicated).toHaveLength(49);

    expect(
      await inboxRows(inbox.messageId),
    ).toHaveLength(1);

    expect(await debitCount(wallet.id)).toBe(1);

    const persistedWallet = await orm.em.fork()
      .findOneOrFail(WalletEntity, wallet.id);

    expect(persistedWallet.balanceAmount).toBe('70.00');
    expect(persistedWallet.version).toBe(2);
  }, 30000);

});
