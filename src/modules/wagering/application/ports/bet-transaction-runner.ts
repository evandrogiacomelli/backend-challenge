
import type { WalletLedgerEntry } from '../../../ledger/domain/wallet-ledger-entry.js';
import type { Wallet } from '../../../wallet/domain/wallet.js';
import type { WagerTransaction } from '../../domain/wager-transaction.js';

export const BET_TRANSACTION_RUNNER = Symbol(
  'BET_TRANSACTION_RUNNER',
);

export class WalletNotFoundError extends Error {
  constructor() {
    super('Wallet not found');
    this.name = 'WalletNotFoundError';
  }
}

export interface LockedBetContext {
  wallet: Wallet;

  saveProcessed(
    transaction: WagerTransaction,
    ledger: WalletLedgerEntry,
  ): Promise<void>;

  saveRejected(
    transaction: WagerTransaction,
  ): Promise<void>;
}

export interface BetTransactionRunner {
  withLockedWallet<T>(
    walletId: string,
    callback: (context: LockedBetContext) => Promise<T>,
  ): Promise<T>;
}
