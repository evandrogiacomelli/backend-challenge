
import type { WalletLedgerEntry } from '../../../ledger/domain/wallet-ledger-entry.js';
import type { Wallet } from '../../../wallet/domain/wallet.js';
import type {
  WagerTransaction,
  WagerTransactionStatus,
} from '../../domain/wager-transaction.js';

export const BET_TRANSACTION_RUNNER = Symbol(
  'BET_TRANSACTION_RUNNER',
);

export class WalletNotFoundError extends Error {
  constructor() {
    super('Wallet not found');
    this.name = 'WalletNotFoundError';
  }
}

export class BetIdentityConflictError extends Error {
  constructor(
    public readonly code:
      | 'IDEMPOTENCY_KEY_CONFLICT'
      | 'EXTERNAL_TRANSACTION_ID_CONFLICT',
  ) {
    super(code);
    this.name = 'BetIdentityConflictError';
  }
}

export class BetWriteConflictError extends Error {
  constructor() {
    super('Concurrent BET identity conflict');
    this.name = 'BetWriteConflictError';
  }
}

export interface BetIdentity {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
}

export interface BetResponseSnapshot {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: string;
  balance: {
    amount: string;
    currency: string;
  };
  walletVersion: number;
}

export interface StoredBet {
  matchedBy: 'idempotencyKey' | 'externalTransactionId';
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  snapshot: BetResponseSnapshot | null;
}

export interface LockedBetContext {
  wallet: Wallet;
  existing: StoredBet | null;

  saveProcessed(
    transaction: WagerTransaction,
    ledger: WalletLedgerEntry,
    snapshot: BetResponseSnapshot,
  ): Promise<void>;

  saveRejected(
    transaction: WagerTransaction,
    snapshot: BetResponseSnapshot,
  ): Promise<void>;
}

export interface BetTransactionRunner {
  findExisting(identity: BetIdentity): Promise<StoredBet | null>;

  withLockedWallet<T>(
    walletId: string,
    identity: BetIdentity,
    callback: (context: LockedBetContext) => Promise<T>,
  ): Promise<T>;
}
