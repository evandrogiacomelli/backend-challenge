
import type { Money } from '../../../../shared/domain/money.js';

import type {
  WalletLedgerEntry,
} from '../../../ledger/domain/wallet-ledger-entry.js';

import type {
  LedgerDirection,
  WagerTransaction,
  WagerTransactionStatus,
} from '../../domain/wager-transaction.js';

import type {
  InboxReceipt,
} from './bet-transaction-runner.js';

export const ROLLBACK_TRANSACTION_RUNNER = Symbol(
  'ROLLBACK_TRANSACTION_RUNNER',
);

export interface RollbackIdentity {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
}

export interface RollbackResponseSnapshot {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: ReturnType<Money['toJSON']>;
  walletVersion: number;
  failureCode?: string;
}

export interface StoredRollback {
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  snapshot: RollbackResponseSnapshot | null;
}

export interface RollbackWalletView {
  id: string;
  playerId: string;
  currency: string;

  balance: Money;
  version: number;

  credit(money: Money): {
    balanceBefore: Money;
    balanceAfter: Money;
  };

  debit(money: Money): {
    balanceBefore: Money;
    balanceAfter: Money;
  };
}

export interface RollbackPersistenceDetails {
  referenceTransactionId: string;
  referenceExternalTransactionId: string;

  roundId: string;
  gameId: string;

  direction: LedgerDirection;
  amount: Money;
  balanceBefore: Money;
}

export interface LockedRollbackContext {
  wallet: RollbackWalletView;

  existing: StoredRollback | null;

  referenceTransaction: WagerTransaction | null;

  alreadyReversed: boolean;

  saveProcessed(
    transaction: WagerTransaction,
    ledger: WalletLedgerEntry,
    snapshot: RollbackResponseSnapshot,
    details: RollbackPersistenceDetails,
  ): Promise<void>;

  savePendingReference(
    transaction: WagerTransaction,
    snapshot: RollbackResponseSnapshot,
  ): Promise<void>;

  saveRejected(
    transaction: WagerTransaction,
    snapshot: RollbackResponseSnapshot,
  ): Promise<void>;
}

export interface RollbackTransactionRunner {
  findExisting(
    identity: RollbackIdentity,
  ): Promise<StoredRollback | null>;

  withLockedWallet<T>(
    walletId: string,
    identity: RollbackIdentity,
    referenceExternalTransactionId: string,
    callback: (
      context: LockedRollbackContext,
    ) => Promise<T>,
    inbox?: InboxReceipt,
  ): Promise<T>;
}

export class RollbackIdentityConflictError extends Error {
  constructor(
    public readonly code:
      | 'IDEMPOTENCY_KEY_CONFLICT'
      | 'EXTERNAL_TRANSACTION_ID_CONFLICT',
  ) {
    super(code);
    this.name = 'RollbackIdentityConflictError';
  }
}

export class RollbackReferenceNotFoundError extends Error {
  constructor() {
    super('Referenced transaction was not found');
    this.name = 'RollbackReferenceNotFoundError';
  }
}

export class RollbackInvalidReferenceError extends Error {
  constructor(
    public readonly code: string,
  ) {
    super(code);
    this.name = 'RollbackInvalidReferenceError';
  }
}

export class RollbackAlreadyAppliedError extends Error {
  constructor() {
    super('Transaction has already been reversed');
    this.name = 'RollbackAlreadyAppliedError';
  }
}

export class RollbackInsufficientFundsError extends Error {
  constructor() {
    super('Insufficient funds to reverse credit');
    this.name = 'RollbackInsufficientFundsError';
  }
}

export class RollbackWriteConflictError extends Error {
  constructor() {
    super('Concurrent ROLLBACK write conflict');
    this.name = 'RollbackWriteConflictError';
  }
}
