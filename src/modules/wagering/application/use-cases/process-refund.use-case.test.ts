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
  WagerTransactionKind, WagerTransactionState,
  WagerTransactionStatus,
} from '../../domain/wager-transaction.js';

import {
  RefundAlreadyAppliedError,
  RefundIdentityConflictError,
  RefundInvalidReferenceError,
  RefundReferenceNotFoundError,
  type RefundTransactionRunner,
  type StoredRefund,
} from '../ports/refund-transaction-runner.js';

import {
  ProcessRefundUseCase,
  type ProcessRefundInput,
} from './process-refund.use-case.js';

function createInput(): ProcessRefundInput {
  return {
    providerId: 'refund-provider',
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),
    referenceExternalTransactionId: randomUUID(),
    walletId: randomUUID(),
    playerId: randomUUID(),
    roundId: 'round-1',
    gameId: 'game-1',
    amount: '30.00',
    currency: 'BRL',
  };
}


function createReference(
  input: ProcessRefundInput,
  overrides: Partial<WagerTransactionState> = {},
): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: randomUUID(),
    providerId: input.providerId,
    externalTransactionId:
    input.referenceExternalTransactionId,
    idempotencyKey: randomUUID(),
    payloadHash: randomUUID(),
    walletId: input.walletId,
    playerId: input.playerId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: WagerTransactionKind.Bet,
    money: Money.from({
      amount: '30.00',
      currency: 'BRL',
    }),
    status: WagerTransactionStatus.Processed,
    createdAt: new Date(),
    attempts: 0,
    ...overrides,
  });
}

function createHarness(input: ProcessRefundInput) {
  const wallet = {
    id: input.walletId,
    playerId: input.playerId,
    currency: 'BRL',
    balance: Money.from({
      amount: '70.00',
      currency: 'BRL',
    }),
    version: 2,

    credit(amount: Money) {
      const balanceBefore = this.balance;

      const newAmount = new Decimal(
        balanceBefore.toJSON().amount,
      ).plus(amount.toJSON().amount);

      this.balance = Money.from({
        amount: newAmount.toFixed(2),
        currency: 'BRL',
      });

      this.version++;

      return {
        balanceBefore,
        balanceAfter: this.balance,
      };
    },
  };

  let referenceBet: WagerTransaction | null = createReference(input);

  let existing: StoredRefund | null = null;
  let alreadyRefunded = false;
  let saves = 0;
  let ledgerCredits = 0;

  const runner: RefundTransactionRunner = {
    async findExisting() {
      return existing;
    },

    async withLockedWallet(
      _walletId,
      identity,
      _referenceId,
      callback,
    ) {
      return callback({
        wallet,
        existing,
        referenceBet,
        alreadyRefunded,

        async saveProcessed(
          transaction,
          snapshot,
          details,
          ledger,
        ) {
          expect(ledger).toBeDefined();
          saves++;
          ledgerCredits++;

          expect(transaction.id).toBe(
            snapshot.transactionId,
          );


          if (!referenceBet) {
            throw new Error(
              'Expected a valid BET reference',
            );
          }

          expect(
            details.referenceBetTransactionId,
          ).toBe(referenceBet.id);


          existing = {
            externalTransactionId:
            identity.externalTransactionId,
            idempotencyKey:
            identity.idempotencyKey,
            payloadHash:
            identity.payloadHash,
            snapshot,
          };

          alreadyRefunded = true;
        },
      });
    },
  };

  return {
    useCase: new ProcessRefundUseCase(runner),
    wallet,

    get saves() {
      return saves;
    },

    get ledgerCredits() {
      return ledgerCredits;
    },

    setReference(
      reference: WagerTransaction | null,
    ) {
      referenceBet = reference;
    },

    getReference() {
      return referenceBet;
    },

    setAlreadyRefunded(value: boolean) {
      alreadyRefunded = value;
    },
  };
}

describe('ProcessRefundUseCase', () => {
  test('credits the original BET amount exactly once', async () => {
    const input = createInput();
    const setup = createHarness(input);

    const result = await setup.useCase.execute(
      input,
    );

    expect(result.status).toBe(
      WagerTransactionStatus.Processed,
    );

    expect(result.balance.amount).toBe('100.00');
    expect(result.walletVersion).toBe(3);
    expect(result.idempotentReplay).toBe(false);

    expect(
      setup.wallet.balance.toJSON().amount,
    ).toBe('100.00');

    expect(setup.saves).toBe(1);
    expect(setup.ledgerCredits).toBe(1);
  });

  test('replays the original response without another credit', async () => {
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
    expect(setup.wallet.version).toBe(3);
    expect(setup.saves).toBe(1);
    expect(setup.ledgerCredits).toBe(1);
  });

  test('does not credit if the referenced BET is missing', async () => {
    const input = createInput();
    const setup = createHarness(input);

    setup.setReference(null);

    await expect(
      setup.useCase.execute(input),
    ).rejects.toBeInstanceOf(
      RefundReferenceNotFoundError,
    );

    expect(
      setup.wallet.balance.toJSON().amount,
    ).toBe('70.00');

    expect(setup.saves).toBe(0);
  });

  test('rejects a BET that was not processed', async () => {
    const input = createInput();
    const setup = createHarness(input);

    setup.setReference(
      createReference(input, {
        status: WagerTransactionStatus.Rejected,
      }),
    );

    await expect(
      setup.useCase.execute(input),
    ).rejects.toBeInstanceOf(
      RefundInvalidReferenceError,
    );

    expect(setup.saves).toBe(0);
  });

  test('rejects refunding a different amount', async () => {
    const input = createInput();
    const setup = createHarness(input);

    await expect(
      setup.useCase.execute({
        ...input,
        amount: '40.00',
      }),
    ).rejects.toBeInstanceOf(
      RefundInvalidReferenceError,
    );

    expect(setup.saves).toBe(0);
    expect(setup.wallet.version).toBe(2);
  });

  test('rejects a second refund for the same BET', async () => {
    const input = createInput();
    const setup = createHarness(input);

    setup.setAlreadyRefunded(true);

    await expect(
      setup.useCase.execute(input),
    ).rejects.toBeInstanceOf(
      RefundAlreadyAppliedError,
    );

    expect(setup.saves).toBe(0);
    expect(setup.wallet.version).toBe(2);
  });

  test('rejects an idempotency key reused with different payload', async () => {
    const input = createInput();
    const setup = createHarness(input);

    await setup.useCase.execute(input);

    await expect(
      setup.useCase.execute({
        ...input,
        amount: '40.00',
      }),
    ).rejects.toBeInstanceOf(
      RefundIdentityConflictError,
    );

    expect(setup.saves).toBe(1);
  });

  test('rejects a refund for another wallet', async () => {
    const input = createInput();
    const setup = createHarness(input);

    setup.setReference(
      createReference(input, {
        walletId: randomUUID(),
      }),
    );

    await expect(
      setup.useCase.execute(input),
    ).rejects.toBeInstanceOf(
      RefundInvalidReferenceError,
    );

    expect(setup.saves).toBe(0);
  });

  test('rejects a missing reference', async () => {
    const input = createInput();
    const setup = createHarness(input);

    await expect(
      setup.useCase.execute({
        ...input,
        referenceExternalTransactionId: '',
      }),
    ).rejects.toBeInstanceOf(
      RefundInvalidReferenceError,
    );

    expect(setup.saves).toBe(0);
  });

  test('rejects a zero refund', async () => {
    const input = createInput();
    const setup = createHarness(input);

    await expect(
      setup.useCase.execute({
        ...input,
        amount: '0.00',
      }),
    ).rejects.toThrow();

    expect(setup.saves).toBe(0);
  });
});
