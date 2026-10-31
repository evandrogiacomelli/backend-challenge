import type { Money } from '../../../../shared/domain/money.js';
import type { WalletLedgerEntry } from '../../../ledger/domain/wallet-ledger-entry.js';
import type { WagerTransaction } from '../../domain/wager-transaction.js';
import type { InboxReceipt } from './bet-transaction-runner.js';

export const WIN_TRANSACTION_RUNNER = Symbol('WIN_TRANSACTION_RUNNER');

export interface WinIdentity {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
}

export interface WinResponseSnapshot {
  transactionId: string;
  status: 'PROCESSED';
  balance: { amount: string; currency: string };
  walletVersion: number;
}

export interface StoredWin {
  idempotencyKey: string;
  externalTransactionId: string;
  payloadHash: string;
  snapshot: WinResponseSnapshot | null;
}

export interface WinWallet {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  credit(money: Money): {
    balanceBefore: Money;
    balanceAfter: Money;
  };
}

export interface WinPersistenceDetails {
  roundId: string;
  gameId: string;
  amount: Money;
  balanceBefore: Money;
}

export interface LockedWinContext {
  wallet: WinWallet;
  existing: StoredWin | null;
  saveProcessed(
    transaction: WagerTransaction,
    ledger: WalletLedgerEntry,
    snapshot: WinResponseSnapshot,
    details: WinPersistenceDetails,
  ): Promise<void>;
}

/** The adapter must use one SQL transaction for wallet, WIN, ledger, outbox and optional inbox. */
export interface WinTransactionRunner {
  findExisting(identity: WinIdentity): Promise<StoredWin | null>;
  withLockedWallet<T>(
    walletId: string,
    identity: WinIdentity,
    operation: (context: LockedWinContext) => Promise<T>,
    inbox?: InboxReceipt,
  ): Promise<T>;
}

export class WinIdentityConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WinIdentityConflictError';
  }
}

/** Throw only when a conflicting INSERT loses a persistent uniqueness race (SQLSTATE 23505). */
export class WinWriteConflictError extends Error {
  constructor() {
    super('Concurrent WIN identity insert conflict');
    this.name = 'WinWriteConflictError';
  }
}
