import {
  describe,
  expect,
  test,
} from 'bun:test';

import type {
  EntityManager,
} from '@mikro-orm/postgresql';

import {
  PostgresLedgerSequenceService,
} from '../../src/modules/reconciliation/infrastructure/postgres-ledger-sequence.service.js';

interface MockPosition {
  sequence_no: string;
  ledger_entry_id: string;
  balance_before: string;
  balance_after: string;
  currency: string;
  direction: string;
  amount: string;
}

function createMockManager(options: {
  positions: MockPosition[];
  lastSequence: number;
  ledgerCount: number;
  walletBalance?: string;
}): EntityManager {
  const execute = async (sql: string): Promise<unknown[]> => {
    if (sql.includes('FROM wallets')) {
      return [{
        id: 'wallet-1',
        balance_amount:
          options.walletBalance ?? '70.00',
        currency: 'BRL',
      }];
    }

    if (
      sql.includes(
        'FROM wallet_ledger_sequence_state',
      )
    ) {
      return [{
        anchor_balance: '0.00',
        last_balance: '70.00',
        last_sequence: String(
          options.lastSequence,
        ),
      }];
    }

    if (
      sql.includes(
        'FROM wallet_ledger_positions p',
      )
    ) {
      return options.positions;
    }

    if (sql.includes('AS ledger_count')) {
      return [{
        ledger_count: options.ledgerCount,
        position_count: options.positions.length,
      }];
    }

    throw new Error(
      `Unexpected SQL in test: ${sql}`,
    );
  };

  return {
    execute,
  } as unknown as EntityManager;
}

const opening: MockPosition = {
  sequence_no: '1',
  ledger_entry_id: 'opening-ledger',
  balance_before: '0.00',
  balance_after: '100.00',
  currency: 'BRL',
  direction: 'CREDIT',
  amount: '100.00',
};

const bet: MockPosition = {
  sequence_no: '2',
  ledger_entry_id: 'bet-ledger',
  balance_before: '100.00',
  balance_after: '70.00',
  currency: 'BRL',
  direction: 'DEBIT',
  amount: '30.00',
};

describe('PostgreSQL ledger sequence audit', () => {
  test(
    'accepts contiguous positions and correct balance',
    async () => {
      const em = createMockManager({
        positions: [opening, bet],
        lastSequence: 2,
        ledgerCount: 2,
      });

      const service =
        new PostgresLedgerSequenceService(em);

      const report = await service.audit(
        'wallet-1',
        em,
      );

      expect(report.consistent).toBe(true);
      expect(report.positionCount).toBe(2);
      expect(report.lastSequence).toBe(2);
      expect(report.walletBalance).toBe('70.00');
      expect(report.issues).toEqual([]);
    },
  );

  test(
    'detects a sequence gap despite correct balance',
    async () => {
      const em = createMockManager({
        positions: [
          opening,
          {
            ...bet,
            sequence_no: '3',
          },
        ],
        lastSequence: 3,
        ledgerCount: 2,
      });

      const service =
        new PostgresLedgerSequenceService(em);

      const report = await service.audit(
        'wallet-1',
        em,
      );

      expect(report.walletBalance).toBe('70.00');
      expect(report.finalBalance).toBe('70.00');
      expect(report.consistent).toBe(false);

      expect(
        report.issues.some(
          (issue) =>
            issue.code === 'SEQUENCE_GAP',
        ),
      ).toBe(true);
    },
  );

  test(
    'detects missing positions despite correct balance',
    async () => {
      const em = createMockManager({
        positions: [opening, bet],
        lastSequence: 2,
        ledgerCount: 3,
      });

      const service =
        new PostgresLedgerSequenceService(em);

      const report = await service.audit(
        'wallet-1',
        em,
      );

      expect(report.walletBalance).toBe('70.00');
      expect(report.consistent).toBe(false);

      expect(
        report.issues.some(
          (issue) =>
            issue.code ===
            'POSITION_COUNT_MISMATCH',
        ),
      ).toBe(true);
    },
  );
});
