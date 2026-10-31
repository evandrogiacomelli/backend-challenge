import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

import {
  auditLedgerChain,
  type LedgerChainEntry,
  type LedgerChainReport,
} from '../domain/ledger-chain-auditor.js';

import {
  WalletNotFoundError,
} from '../domain/reconciliation-report.js';

interface WalletRow {
  id: string;
  currency: string;
  balance_amount: string;
}

interface LedgerRow {
  id: string;
  transaction_id: string | null;
  currency: string;
  direction: string;
  amount: string;
  balance_before: string;
  balance_after: string;
}

@Injectable()
export class PostgresLedgerContinuityService {
  constructor(
    private readonly em: EntityManager,
  ) {}

  async audit(
    walletId: string,
  ): Promise<LedgerChainReport> {
    const wallets = await this.em.execute<WalletRow[]>(
      `
      SELECT
        id,
        currency,
        balance_amount::text AS balance_amount
      FROM wallets
      WHERE id = ?
      `,
      [walletId],
      'all',
    );

    const wallet = wallets[0];

    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }

    const rows = await this.em.execute<LedgerRow[]>(
      `
      SELECT
        id,
        wager_transaction_id AS transaction_id,
        currency,
        direction,
        amount::text AS amount,
        balance_before::text AS balance_before,
        balance_after::text AS balance_after
      FROM wallet_ledger_entries
      WHERE wallet_id = ?
      `,
      [walletId],
      'all',
    );

    const entries: LedgerChainEntry[] = rows.map(
      (row) => ({
        id: row.id,
        transactionId: row.transaction_id,
        currency: row.currency,
        direction: row.direction,
        amount: row.amount,
        balanceBefore: row.balance_before,
        balanceAfter: row.balance_after,
      }),
    );

    return auditLedgerChain({
      walletId: wallet.id,
      currency: wallet.currency,
      actualBalance: wallet.balance_amount,
      entries,
    });
  }
}
