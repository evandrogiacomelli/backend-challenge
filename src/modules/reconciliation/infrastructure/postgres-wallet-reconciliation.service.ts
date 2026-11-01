import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Decimal } from 'decimal.js';

import {
  type ReconciliationIssue,
  type ReconciliationReport,
  WalletNotFoundError,
} from '../domain/reconciliation-report.js';

interface ReconciliationRow {
  wallet_id: string;
  currency: string;
  actual_balance: string;
  expected_balance: string;
  actual_version: number;
  ledger_entries: number;
  version_increments: number;
  missing_ledger: number;
  unexpected_ledger: number;
  invalid_links: number;
  mismatched_amounts: number;
}

@Injectable()
export class PostgresWalletReconciliationService {
  constructor(
    private readonly em: EntityManager,
  ) {}

  async reconcile(
    walletId: string,
  ): Promise<ReconciliationReport> {
    const rows = await this.em.execute<
      ReconciliationRow[]
    >(
      `
          WITH target_wallet AS (
              SELECT
                  id,
                  currency,
                  balance_amount,
                  version
              FROM wallets
              WHERE id = ?
          ),

               ledger_summary AS (
                   SELECT
                       COUNT(l.id)::int AS ledger_entries,

                       COALESCE(
                               SUM(
                                       CASE
                                           WHEN l.direction = 'CREDIT'
                                               THEN l.amount
                                           WHEN l.direction = 'DEBIT'
                                               THEN -l.amount
                                           ELSE 0
                                           END
                               ),
                               0
                       ) AS expected_balance,

                       COUNT(l.id) FILTER (
            WHERE t.kind <> 'OPENING'
          )::int AS version_increments,

                       COUNT(l.id) FILTER (
            WHERE
              t.id IS NULL
              OR t.wallet_id <> l.wallet_id
              OR t.currency <> l.currency
              OR l.currency <> w.currency
          )::int AS invalid_links,

                       COUNT(l.id) FILTER (
            WHERE
              t.id IS NOT NULL
              AND t.amount <> l.amount
          )::int AS mismatched_amounts,

                       COUNT(l.id) FILTER (
            WHERE
              t.status IS DISTINCT FROM 'PROCESSED'

              OR t.kind = 'LOSS'

              OR (
                t.kind = 'OPENING'
                AND t.amount = 0
              )

              OR (
                t.kind = 'BET'
                AND l.direction <> 'DEBIT'
              )

              OR (
                t.kind IN (
                  'OPENING',
                  'WIN',
                  'REFUND'
                )
                AND l.direction <> 'CREDIT'
              )

              OR (
                t.kind = 'ROLLBACK'
                AND (
                  original.id IS NULL

                  OR original.status
                    IS DISTINCT FROM 'PROCESSED'

                  OR original.wallet_id
                    IS DISTINCT FROM t.wallet_id

                  OR original.currency
                    IS DISTINCT FROM t.currency

                  OR original.kind NOT IN (
                    'BET',
                    'WIN',
                    'REFUND'
                  )

                  OR l.direction IS DISTINCT FROM
                    CASE
                      WHEN original.kind = 'BET'
                        THEN 'CREDIT'

                      WHEN original.kind IN (
                        'WIN',
                        'REFUND'
                      )
                        THEN 'DEBIT'

                      ELSE NULL
                    END
                )
              )
          )::int AS unexpected_ledger

                   FROM target_wallet w

                            LEFT JOIN wallet_ledger_entries l
                                      ON l.wallet_id = w.id

                            LEFT JOIN wager_transactions t
                                      ON t.id = l.wager_transaction_id

                            LEFT JOIN wager_transactions original
                                      ON original.id = t.reference_transaction_id
               ),

               transaction_summary AS (
                   SELECT
                       COUNT(t.id) FILTER (
            WHERE
              t.status = 'PROCESSED'
              AND t.kind IN (
                'OPENING',
                'BET',
                'WIN',
                'REFUND',
                'ROLLBACK'
              )
              AND t.amount > 0
              AND l.id IS NULL
          )::int AS missing_ledger

                   FROM target_wallet w

                            LEFT JOIN wager_transactions t
                                      ON t.wallet_id = w.id

                            LEFT JOIN wallet_ledger_entries l
                                      ON l.wager_transaction_id = t.id
                                          AND l.wallet_id = w.id
               )

          SELECT
              w.id AS wallet_id,
              w.currency,

              w.balance_amount::text
          AS actual_balance,

              ls.expected_balance::text
          AS expected_balance,

              w.version AS actual_version,

              ls.ledger_entries,
              ls.version_increments,
              ts.missing_ledger,
              ls.unexpected_ledger,
              ls.invalid_links,
              ls.mismatched_amounts

          FROM target_wallet w
                   CROSS JOIN ledger_summary ls
                   CROSS JOIN transaction_summary ts
      `,
      [walletId],
      'all',
    );

    const row = rows[0];

    if (!row) {
      throw new WalletNotFoundError(walletId);
    }

    const actual = new Decimal(row.actual_balance);
    const expected = new Decimal(row.expected_balance);
    const difference = actual.minus(expected);

    // A wallet starts at version 1.
    // OPENING does not increment its version.
    const expectedVersion =
      1 + Number(row.version_increments);

    const issues: ReconciliationIssue[] = [];

    if (!difference.isZero()) {
      issues.push({
        code: 'BALANCE_MISMATCH',
        description:
          'Materialized balance differs from ledger total',
      });
    }

    if (
      Number(row.actual_version) !== expectedVersion
    ) {
      issues.push({
        code: 'VERSION_MISMATCH',
        description:
          'Wallet version differs from recorded movements',
      });
    }

    if (Number(row.missing_ledger) > 0) {
      issues.push({
        code: 'MISSING_LEDGER',
        description:
          'Processed financial transactions without ledger entries',
      });
    }

    if (Number(row.unexpected_ledger) > 0) {
      issues.push({
        code: 'UNEXPECTED_LEDGER',
        description:
          'Ledger entries violate transaction status, kind or direction',
      });
    }

    if (Number(row.invalid_links) > 0) {
      issues.push({
        code: 'INVALID_LEDGER_LINK',
        description:
          'Ledger entries have invalid transaction or currency links',
      });
    }

    if (Number(row.mismatched_amounts) > 0) {
      issues.push({
        code: 'LEDGER_AMOUNT_MISMATCH',
        description:
          'Ledger amounts differ from their financial transactions',
      });
    }

    return {
      walletId: row.wallet_id,
      currency: row.currency,

      actualBalance: actual.toFixed(2),
      expectedBalance: expected.toFixed(2),
      difference: difference.toFixed(2),

      actualVersion: Number(row.actual_version),
      expectedVersion,

      ledgerEntries: Number(row.ledger_entries),
      missingLedgerEntries: Number(
        row.missing_ledger,
      ),
      unexpectedLedgerEntries: Number(
        row.unexpected_ledger,
      ),
      invalidLedgerLinks: Number(
        row.invalid_links,
      ),
      mismatchedAmounts: Number(
        row.mismatched_amounts,
      ),

      consistent: issues.length === 0,
      issues,
      checkedAt: new Date().toISOString(),
    };
  }
}
