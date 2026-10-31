import { Injectable } from '@nestjs/common';
import { IsolationLevel } from '@mikro-orm/core';
import {
  EntityManager,
} from '@mikro-orm/postgresql';

import type {
  ReconciliationReport,
} from '../domain/reconciliation-report.js';

import type {
  LedgerChainReport,
} from '../domain/ledger-chain-auditor.js';

import {
  PostgresWalletReconciliationService,
} from '../infrastructure/postgres-wallet-reconciliation.service.js';

import {
  PostgresLedgerContinuityService,
} from '../infrastructure/postgres-ledger-continuity.service.js';

interface WalletIdRow {
  id: string;
}

export interface WalletAuditResult {
  walletId: string;
  consistent: boolean;
  reconciliation: ReconciliationReport;
  chain: LedgerChainReport;
}

export interface WalletBatchReport {
  checkedAt: string;
  checkedCount: number;
  consistentCount: number;
  inconsistentCount: number;
  results: WalletAuditResult[];
  nextCursor: string | null;
}

@Injectable()
export class WalletBatchReconciliationService {
  constructor(
    private readonly em: EntityManager,
  ) {}

  async scanPage(options: {
    after?: string;
    limit?: number;
  } = {}): Promise<WalletBatchReport> {
    const limit = options.limit ?? 25;

    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new Error(
        'Batch limit must be between 1 and 100',
      );
    }

    if (
      options.after !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        options.after,
      )
    ) {
      throw new Error('Invalid wallet cursor');
    }

    return this.em.fork().transactional(
      async (tx) => {
        const params: unknown[] = [];
        const afterClause = options.after
          ? 'WHERE id > ?::uuid'
          : '';

        if (options.after) {
          params.push(options.after);
        }

        // Fetch one extra wallet to detect
        // whether the next page exists.
        params.push(limit + 1);

        const rows = await tx.execute<WalletIdRow[]>(
          `
          SELECT id
          FROM wallets
          ${afterClause}
          ORDER BY id
          LIMIT ?
          `,
          params,
          'all',
        );

        const hasMore = rows.length > limit;
        const selected = rows.slice(0, limit);

        const reconciler =
          new PostgresWalletReconciliationService(tx);

        const chainAuditor =
          new PostgresLedgerContinuityService(tx);

        const results: WalletAuditResult[] = [];

        for (const row of selected) {
          const reconciliation =
            await reconciler.reconcile(row.id);

          const chain = await chainAuditor.audit(
            row.id,
          );

          results.push({
            walletId: row.id,
            consistent:
              reconciliation.consistent &&
              chain.chainFeasible,
            reconciliation,
            chain,
          });
        }

        const consistentCount = results.filter(
          (result) => result.consistent,
        ).length;

        return {
          checkedAt: new Date().toISOString(),
          checkedCount: results.length,
          consistentCount,
          inconsistentCount:
            results.length - consistentCount,
          results,
          nextCursor: hasMore
            ? selected.at(-1)!.id
            : null,
        };
      },
      {
        isolationLevel: IsolationLevel.REPEATABLE_READ,
        readOnly: true,
      },
    );
  }
}
