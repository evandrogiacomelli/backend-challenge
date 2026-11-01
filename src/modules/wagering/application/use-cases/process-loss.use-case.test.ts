import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'bun:test';

import { Money } from '../../../../shared/domain/money.js';
import { WagerTransactionStatus } from '../../domain/wager-transaction.js';

import {
  LossIdentityConflictError,
  type LossIdentity,
  type LossResponseSnapshot,
  type LossTransactionRunner,
  type StoredLoss,
} from '../ports/loss-transaction-runner.js';

import {
  ProcessLossUseCase,
  type ProcessLossInput,
} from './process-loss.use-case.js';

function createInput(): ProcessLossInput {
  return {
    providerId: 'provider-a',
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),
    walletId: randomUUID(),
    playerId: randomUUID(),
    roundId: 'round-1',
    gameId: 'game-1',
    amount: '30.00',
    currency: 'BRL',
  };
}

function createHarness(input: ProcessLossInput) {
  const wallet = {
    id: input.walletId,
    playerId: input.playerId,
    currency: 'BRL',
    balance: Money.from({
      amount: '70.00',
      currency: 'BRL',
    }),
    version: 2,
  };

  let existing: StoredLoss | null = null;
  let saves = 0;

  const runner: LossTransactionRunner = {
    async findExisting() {
      return existing;
    },

    async withLockedWallet(
      _walletId,
      identity,
      callback,
    ) {
      return callback({
        wallet,
        existing,

        async saveProcessed(
          transaction,
          snapshot,
        ) {
          saves++;

          existing = {
            externalTransactionId:
            identity.externalTransactionId,
            idempotencyKey:
            identity.idempotencyKey,
            payloadHash:
            identity.payloadHash,
            snapshot,
          };

          expect(transaction.id).toBe(
            snapshot.transactionId,
          );
        },
      });
    },
  };

  return {
    useCase: new ProcessLossUseCase(runner),
    wallet,
    get saves() {
      return saves;
    },
  };
}

describe('ProcessLossUseCase', () => {
  test('records LOSS without changing the balance', async () => {
    const input = createInput();
    const setup = createHarness(input);

    const before = setup.wallet.balance.toJSON();

    const result = await setup.useCase.execute(
      input,
    );

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance).toEqual(before);
    expect(result.walletVersion).toBe(2);
    expect(result.idempotentReplay).toBe(false);

    expect(
      setup.wallet.balance.toJSON(),
    ).toEqual(before);

    expect(setup.wallet.version).toBe(2);
    expect(setup.saves).toBe(1);
  });

  test('replays LOSS without processing it twice', async () => {
    const input = createInput();
    const setup = createHarness(input);

    const first = await setup.useCase.execute(
      input,
    );

    const second = await setup.useCase.execute(
      input,
    );

    expect(second.transactionId).toBe(
      first.transactionId,
    );

    expect(second.balance).toEqual(
      first.balance,
    );

    expect(second.idempotentReplay).toBe(true);
    expect(setup.saves).toBe(1);
  });

  test('rejects changed payload with the same key', async () => {
    const input = createInput();
    const setup = createHarness(input);

    await setup.useCase.execute(input);

    await expect(
      setup.useCase.execute({
        ...input,
        amount: '40.00',
      }),
    ).rejects.toBeInstanceOf(
      LossIdentityConflictError,
    );

    expect(setup.saves).toBe(1);
  });

  test('rejects different key for the same external ID', async () => {
    const input = createInput();
    const setup = createHarness(input);

    await setup.useCase.execute(input);

    await expect(
      setup.useCase.execute({
        ...input,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(
      LossIdentityConflictError,
    );

    expect(setup.saves).toBe(1);
  });

  test('rejects player mismatch without persisting', async () => {
    const input = createInput();
    const setup = createHarness(input);

    await expect(
      setup.useCase.execute({
        ...input,
        playerId: randomUUID(),
      }),
    ).rejects.toThrow('Wallet player mismatch');

    expect(setup.saves).toBe(0);
    expect(setup.wallet.version).toBe(2);
  });
});
