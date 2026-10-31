import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { Money } from '../../../../shared/domain/money.js';
import type { WalletLedgerEntry } from '../../../ledger/domain/wallet-ledger-entry.js';
import { WagerTransaction } from '../../domain/wager-transaction.js';
import {
  WinIdentityConflictError,
  type LockedWinContext,
  type StoredWin,
  type WinIdentity,
  type WinResponseSnapshot,
  type WinTransactionRunner,
  type WinWallet,
} from '../ports/win-transaction-runner.js';
import {
  ProcessWinUseCase,
  type ProcessWinInput,
} from './process-win.use-case.js';

class FakeWinWallet implements WinWallet {
  readonly id = randomUUID();
  readonly playerId = randomUUID();
  readonly currency = 'BRL';
  private _balance = Money.from({ amount: '100.00', currency: 'BRL' });
  private _version = 1;

  get balance(): Money { return this._balance; }
  get version(): number { return this._version; }

  credit(money: Money) {
    const balanceBefore = this._balance;
    this._balance = this._balance.add(money);
    this._version++;
    return { balanceBefore, balanceAfter: this._balance };
  }
}

class FakeWinRunner implements WinTransactionRunner {
  readonly wallet = new FakeWinWallet();
  readonly entries: WalletLedgerEntry[] = [];
  readonly transactions: WagerTransaction[] = [];
  private stored: StoredWin | null = null;

  async findExisting(identity: WinIdentity): Promise<StoredWin | null> {
    if (
      this.stored?.idempotencyKey === identity.idempotencyKey ||
      this.stored?.externalTransactionId === identity.externalTransactionId
    ) {
      return this.stored;
    }
    return null;
  }

  async withLockedWallet<T>(
    _walletId: string,
    identity: WinIdentity,
    operation: (context: LockedWinContext) => Promise<T>,
  ): Promise<T> {
    const existing = await this.findExisting(identity);
    return operation({
      wallet: this.wallet,
      existing,
      saveProcessed: async (
        transaction: WagerTransaction,
        ledger: WalletLedgerEntry,
        snapshot: WinResponseSnapshot,
      ) => {
        this.entries.push(ledger);
        this.transactions.push(transaction);
        this.stored = {
          idempotencyKey: identity.idempotencyKey,
          externalTransactionId: identity.externalTransactionId,
          payloadHash: identity.payloadHash,
          snapshot,
        };
      },
    });
  }
}

function input(wallet: FakeWinWallet): ProcessWinInput {
  return {
    providerId: 'provider-a',
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: randomUUID(),
    gameId: 'game-1',
    amount: '25.00',
    currency: 'BRL',
  };
}

describe('ProcessWinUseCase', () => {
  test('credits wallet exactly once and creates a CREDIT ledger entry', async () => {
    const runner = new FakeWinRunner();
    const output = await new ProcessWinUseCase(runner).execute(input(runner.wallet));
    expect(output.status).toBe('PROCESSED');
    expect(output.balance.amount).toBe('125.00');
    expect(output.walletVersion).toBe(2);
    expect(output.idempotentReplay).toBe(false);
    expect(runner.entries).toHaveLength(1);
    expect(runner.entries[0]!.direction).toBe('CREDIT');
    expect(runner.transactions).toHaveLength(1);
  });

  test('replays the original WIN response without another credit', async () => {
    const runner = new FakeWinRunner();
    const useCase = new ProcessWinUseCase(runner);
    const request = input(runner.wallet);
    const original = await useCase.execute(request);
    const repeated = await useCase.execute(request);
    expect(repeated.transactionId).toBe(original.transactionId);
    expect(repeated.balance).toEqual(original.balance);
    expect(repeated.walletVersion).toBe(original.walletVersion);
    expect(repeated.idempotentReplay).toBe(true);
    expect(runner.wallet.balance.toJSON().amount).toBe('125.00');
    expect(runner.entries).toHaveLength(1);
  });

  test('rejects reuse of idempotency key with different money', async () => {
    const runner = new FakeWinRunner();
    const useCase = new ProcessWinUseCase(runner);
    const request = input(runner.wallet);
    await useCase.execute(request);
    await expect(useCase.execute({ ...request, amount: '30.00' }))
      .rejects.toBeInstanceOf(WinIdentityConflictError);
    expect(runner.entries).toHaveLength(1);
  });

  test('rejects reuse of external transaction ID with a different key', async () => {
    const runner = new FakeWinRunner();
    const useCase = new ProcessWinUseCase(runner);
    const request = input(runner.wallet);
    await useCase.execute(request);
    await expect(useCase.execute({ ...request, idempotencyKey: randomUUID() }))
      .rejects.toBeInstanceOf(WinIdentityConflictError);
    expect(runner.entries).toHaveLength(1);
  });

  test('rejects a wallet/player mismatch without a credit', async () => {
    const runner = new FakeWinRunner();
    await expect(new ProcessWinUseCase(runner).execute({
      ...input(runner.wallet), playerId: randomUUID(),
    })).rejects.toThrow('Wallet player mismatch');
    expect(runner.wallet.balance.toJSON().amount).toBe('100.00');
    expect(runner.entries).toHaveLength(0);
  });

  test('does not silently ignore a supplied BET reference', async () => {
    const runner = new FakeWinRunner();
    await expect(new ProcessWinUseCase(runner).execute({
      ...input(runner.wallet), referenceExternalTransactionId: randomUUID(),
    })).rejects.toThrow('WIN reference validation is not implemented');
    expect(runner.entries).toHaveLength(0);
  });

  test('rejects zero credit', async () => {
    const runner = new FakeWinRunner();
    await expect(new ProcessWinUseCase(runner).execute({
      ...input(runner.wallet), amount: '0.00',
    })).rejects.toThrow('WIN amount must be positive');
    expect(runner.entries).toHaveLength(0);
  });
});
