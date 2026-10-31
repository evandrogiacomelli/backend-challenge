export type ReconciliationIssueCode =
  | 'BALANCE_MISMATCH'
  | 'VERSION_MISMATCH'
  | 'MISSING_LEDGER'
  | 'UNEXPECTED_LEDGER'
  | 'INVALID_LEDGER_LINK'
  | 'LEDGER_AMOUNT_MISMATCH';

export interface ReconciliationIssue {
  code: ReconciliationIssueCode;
  description: string;
}

export interface ReconciliationReport {
  walletId: string;
  currency: string;

  actualBalance: string;
  expectedBalance: string;
  difference: string;

  actualVersion: number;
  expectedVersion: number;

  ledgerEntries: number;
  missingLedgerEntries: number;
  unexpectedLedgerEntries: number;
  invalidLedgerLinks: number;
  mismatchedAmounts: number;

  consistent: boolean;
  issues: ReconciliationIssue[];
  checkedAt: string;
}

export class WalletNotFoundError extends Error {
  constructor(walletId: string) {
    super(`Wallet not found: ${walletId}`);
    this.name = 'WalletNotFoundError';
  }
}
