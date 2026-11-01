import type { Money } from '../../../../shared/domain/money.js';
import type { WagerTransaction } from '../../domain/wager-transaction.js';
import { WagerTransactionStatus } from '../../domain/wager-transaction.js';
import type { InboxReceipt } from './bet-transaction-runner.js';

export const LOSS_TRANSACTION_RUNNER = Symbol(
  'LOSS_TRANSACTION_RUNNER',
);

export interface LossIdentity {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
}

export interface LossResponseSnapshot {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: ReturnType<Money['toJSON']>;
  walletVersion: number;
}

export interface StoredLoss {
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  snapshot: LossResponseSnapshot | null;
}

export interface LossWalletView {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
}

export interface LockedLossContext {
  wallet: LossWalletView;
  existing: StoredLoss | null;

  saveProcessed(
    transaction: WagerTransaction,
    snapshot: LossResponseSnapshot,
    details: LossPersistenceDetails,
  ): Promise<void>;
}

export interface LossTransactionRunner {
  findExisting(
    identity: LossIdentity,
  ): Promise<StoredLoss | null>;

  withLockedWallet<T>(
    walletId: string,
    identity: LossIdentity,
    callback: (
      context: LockedLossContext,
    ) => Promise<T>,
    inbox?: InboxReceipt,
  ): Promise<T>;
}

export interface LossPersistenceDetails {
  roundId: string;
  gameId: string;
  amount: Money;
}

export class LossIdentityConflictError extends Error {
  constructor(
    public readonly code:
      | 'IDEMPOTENCY_KEY_CONFLICT'
      | 'EXTERNAL_TRANSACTION_ID_CONFLICT',
  ) {
    super(code);
    this.name = 'LossIdentityConflictError';
  }
}

export class LossWriteConflictError extends Error {
  constructor() {
    super('Concurrent LOSS write conflict');
    this.name = 'LossWriteConflictError';
  }
}
