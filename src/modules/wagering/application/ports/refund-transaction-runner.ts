import type { Money } from '../../../../shared/domain/money.js';

import {
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransaction,
} from '../../domain/wager-transaction.js';

import type {
  InboxReceipt,
} from './bet-transaction-runner.js';
import { WalletLedgerEntry } from '../../../ledger/domain/wallet-ledger-entry.js';

export const REFUND_TRANSACTION_RUNNER = Symbol(
  'REFUND_TRANSACTION_RUNNER',
);

export interface RefundIdentity {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
}

export interface RefundResponseSnapshot {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: ReturnType<Money['toJSON']>;
  walletVersion: number;
}

export interface StoredRefund {
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  snapshot: RefundResponseSnapshot | null;
}

export interface RefundBetReference {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  amount: string;
  currency: string;
}

export interface RefundWalletView {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;

  credit(money: Money): {
    balanceBefore: Money;
    balanceAfter: Money;
  };
}

export interface RefundPersistenceDetails {
  referenceBetTransactionId: string;
  roundId: string;
  gameId: string;
  amount: Money;
  balanceBefore: Money;
}

export interface LockedRefundContext {
  wallet: RefundWalletView;
  existing: StoredRefund | null;

  // Loaded inside the wallet's SQL transaction.
  referenceBet: WagerTransaction | null;

  // Must check committed REFUND records for this BET.
  alreadyRefunded: boolean;

  saveProcessed(
    transaction: WagerTransaction,
    snapshot: RefundResponseSnapshot,
    details: RefundPersistenceDetails,
    ledger: WalletLedgerEntry,
  ): Promise<void>;
}

export interface RefundTransactionRunner {
  findExisting(
    identity: RefundIdentity,
  ): Promise<StoredRefund | null>;

  withLockedWallet<T>(
    walletId: string,
    identity: RefundIdentity,
    referenceExternalTransactionId: string,
    callback: (
      context: LockedRefundContext,
    ) => Promise<T>,
    inbox?: InboxReceipt,
  ): Promise<T>;
}

export class RefundIdentityConflictError extends Error {
  constructor(
    public readonly code:
      | 'IDEMPOTENCY_KEY_CONFLICT'
      | 'EXTERNAL_TRANSACTION_ID_CONFLICT',
  ) {
    super(code);
    this.name = 'RefundIdentityConflictError';
  }
}

export class RefundReferenceNotFoundError extends Error {
  constructor() {
    super('Referenced BET was not found');
    this.name = 'RefundReferenceNotFoundError';
  }
}

export class RefundInvalidReferenceError extends Error {
  constructor(
    public readonly code: string,
  ) {
    super(code);
    this.name = 'RefundInvalidReferenceError';
  }
}

export class RefundAlreadyAppliedError extends Error {
  constructor() {
    super('BET has already been refunded');
    this.name = 'RefundAlreadyAppliedError';
  }
}

export class RefundWriteConflictError extends Error {
  constructor() {
    super('Concurrent REFUND write conflict');
    this.name = 'RefundWriteConflictError';
  }
}
