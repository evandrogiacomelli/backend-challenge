
import type { WalletLedgerEntry } from '../../../ledger/domain/wallet-ledger-entry.js';
import type { WagerTransaction } from '../../../wagering/domain/wager-transaction.js';
import type { Wallet } from '../../domain/wallet.js';

export const WALLET_OPENING_PERSISTENCE =
  Symbol('WALLET_OPENING_PERSISTENCE');

export interface WalletOpeningRecords {
  transaction: WagerTransaction;
  ledger: WalletLedgerEntry;
}

export interface WalletOpeningPersistence {
  save(
    wallet: Wallet,
    opening?: WalletOpeningRecords,
  ): Promise<void>;
}
