import { Injectable } from '@nestjs/common';
import { IsolationLevel } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Decimal } from 'decimal.js';

interface WalletRow {
  id: string;
  balance_amount: string;
  currency: string;
}

interface StateRow {
  anchor_balance: string;
  last_balance: string;
  last_sequence: string;
}

interface PositionRow {
  sequence_no: string;
  ledger_entry_id: string;
  balance_before: string;
  balance_after: string;
  currency: string;
  direction: string;
  amount: string;
}

export type LedgerSequenceIssueCode =
  | 'MISSING_CHECKPOINT'
  | 'SEQUENCE_GAP'
  | 'BALANCE_CHAIN_BREAK'
  | 'INVALID_MOVEMENT'
  | 'STATE_COUNT_MISMATCH'
  | 'STATE_BALANCE_MISMATCH'
  | 'WALLET_BALANCE_MISMATCH';

export interface LedgerSequenceIssue {
  code: LedgerSequenceIssueCode;
  ledgerEntryId?: string;
  sequenceNo?: number;
}

export interface LedgerSequenceReport {
  walletId: string;
  currency: string;
  anchorBalance: string;
  finalBalance: string;
  walletBalance: string;
  lastSequence: number;
  positionCount: number;
  consistent: boolean;
  issues: LedgerSequenceIssue[];
}

@Injectable()
export class PostgresLedgerSequenceService {
  constructor(private readonly em: EntityManager) {}

  async audit(walletId: string): Promise<LedgerSequenceReport> {
    // Two SQL reads need one snapshot; do not compare different commits.
    return this.em.fork().transactional(
      async (tx) => {
        const wallets = await tx.execute<WalletRow[]>(
          `SELECT id, balance_amount::text AS balance_amount, currency
           FROM wallets WHERE id = ?`,
          [walletId],
          'all',
        );
        const wallet = wallets[0];
        if (!wallet) throw new Error(`Wallet not found: ${walletId}`);

        const states = await tx.execute<StateRow[]>(
          `SELECT anchor_balance::text AS anchor_balance,
                  last_balance::text AS last_balance,
                  last_sequence::text AS last_sequence
           FROM wallet_ledger_sequence_state WHERE wallet_id = ?`,
          [walletId],
          'all',
        );

        const positions = await tx.execute<PositionRow[]>(
          `SELECT p.sequence_no::text AS sequence_no,
                  p.ledger_entry_id,
                  l.balance_before::text AS balance_before,
                  l.balance_after::text AS balance_after,
                  l.currency, l.direction, l.amount::text AS amount
           FROM wallet_ledger_positions p
           JOIN wallet_ledger_entries l
             ON l.id = p.ledger_entry_id AND l.wallet_id = p.wallet_id
           WHERE p.wallet_id = ?
           ORDER BY p.sequence_no ASC`,
          [walletId],
          'all',
        );

        const issues: LedgerSequenceIssue[] = [];
        const state = states[0];
        // A newly created zero-balance wallet can legitimately have no ledger
        // and no checkpoint until its first money movement.
        if (!state && positions.length === 0 &&
            new Decimal(wallet.balance_amount).isZero()) {
          return {
            walletId, currency: wallet.currency, anchorBalance: '0.00',
            finalBalance: '0.00', walletBalance: '0.00', lastSequence: 0,
            positionCount: 0, consistent: true, issues: [],
          };
        }
        if (!state) {
          issues.push({ code: 'MISSING_CHECKPOINT' });
        }

        const anchor = state?.anchor_balance ?? '0.00';
        let previousBalance = new Decimal(anchor);
        let previousSequence = 0;

        for (const p of positions) {
          const seq = Number(p.sequence_no);
          if (!Number.isSafeInteger(seq) || seq !== previousSequence + 1) {
            issues.push({ code: 'SEQUENCE_GAP', ledgerEntryId: p.ledger_entry_id, sequenceNo: seq });
          }
          if (!new Decimal(p.balance_before).eq(previousBalance)) {
            issues.push({ code: 'BALANCE_CHAIN_BREAK', ledgerEntryId: p.ledger_entry_id, sequenceNo: seq });
          }
          const before = new Decimal(p.balance_before);
          const after = new Decimal(p.balance_after);
          const amount = new Decimal(p.amount);
          const expected = p.direction === 'CREDIT'
            ? before.plus(amount)
            : before.minus(amount);
          if (
            !['CREDIT', 'DEBIT'].includes(p.direction) ||
            p.currency !== wallet.currency ||
            !amount.isPositive() || before.isNegative() || after.isNegative() ||
            !expected.eq(after)
          ) {
            issues.push({ code: 'INVALID_MOVEMENT', ledgerEntryId: p.ledger_entry_id, sequenceNo: seq });
          }
          previousBalance = after;
          previousSequence = seq;
        }

        if (state && Number(state.last_sequence) !== positions.length) {
          issues.push({ code: 'STATE_COUNT_MISMATCH' });
        }
        if (state && !previousBalance.eq(state.last_balance)) {
          issues.push({ code: 'STATE_BALANCE_MISMATCH' });
        }
        if (state && !new Decimal(wallet.balance_amount).eq(state.last_balance)) {
          issues.push({ code: 'WALLET_BALANCE_MISMATCH' });
        }

        return {
          walletId,
          currency: wallet.currency,
          anchorBalance: new Decimal(anchor).toFixed(2),
          finalBalance: previousBalance.toFixed(2),
          walletBalance: new Decimal(wallet.balance_amount).toFixed(2),
          lastSequence: state ? Number(state.last_sequence) : 0,
          positionCount: positions.length,
          consistent: issues.length === 0,
          issues,
        };
      },
      { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true },
    );
  }
}
