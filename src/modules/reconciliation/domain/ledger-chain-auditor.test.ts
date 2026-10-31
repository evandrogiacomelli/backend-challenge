import { describe, expect, test } from 'bun:test';

import {
  auditLedgerChain,
  type LedgerChainEntry,
} from './ledger-chain-auditor.js';

function entry(
  id: string,
  direction: string,
  amount: string,
  before: string,
  after: string,
): LedgerChainEntry {
  return {
    id,
    transactionId: `transaction-${id}`,
    currency: 'BRL',
    direction,
    amount,
    balanceBefore: before,
    balanceAfter: after,
  };
}

function audit(
  entries: LedgerChainEntry[],
  actualBalance = '70.00',
) {
  return auditLedgerChain({
    walletId: 'wallet-test',
    currency: 'BRL',
    actualBalance,
    entries,
  });
}

describe('Ledger chain auditor', () => {
  test('accepts a correct OPENING and BET', () => {
    const result = audit([
      entry('opening', 'CREDIT', '100.00', '0.00', '100.00'),
      entry('bet', 'DEBIT', '30.00', '100.00', '70.00'),
    ]);

    expect(result.chainFeasible).toBe(true);
    expect(result.entryCount).toBe(2);
    expect(result.validMovementCount).toBe(2);
    expect(result.issues).toHaveLength(0);
  });

  test('accepts a zero-balance wallet without movements', () => {
    const result = audit([], '0.00');

    expect(result.chainFeasible).toBe(true);
    expect(result.entryCount).toBe(0);
  });

  test('detects an incorrect balance transition', () => {
    const result = audit([
      entry('opening', 'CREDIT', '100.00', '0.00', '100.00'),
      entry('bet', 'DEBIT', '30.00', '100.00', '60.00'),
    ]);

    expect(result.chainFeasible).toBe(false);

    expect(
      result.issues.some(
        (issue) =>
          issue.code === 'INVALID_MOVEMENT' &&
          issue.ledgerIds.includes('bet'),
      ),
    ).toBe(true);
  });

  test('detects disconnected ledger movements', () => {
    const result = audit([
      entry('opening', 'CREDIT', '100.00', '0.00', '100.00'),
      entry('orphan', 'DEBIT', '20.00', '90.00', '70.00'),
    ]);

    expect(result.chainFeasible).toBe(false);

    expect(
      result.issues.some(
        (issue) =>
          issue.code === 'DISCONNECTED_CHAIN',
      ),
    ).toBe(true);
  });

  test('detects incompatible ledger branching', () => {
    const result = audit([
      entry('opening', 'CREDIT', '100.00', '0.00', '100.00'),
      entry('bet-1', 'DEBIT', '30.00', '100.00', '70.00'),
      entry('bet-2', 'DEBIT', '50.00', '100.00', '50.00'),
    ]);

    expect(result.chainFeasible).toBe(false);

    expect(
      result.issues.some(
        (issue) =>
          issue.code === 'INVALID_CHAIN_DEGREES',
      ),
    ).toBe(true);
  });

  test('accepts a legitimate balance cycle', () => {
    const result = audit([
      entry('opening', 'CREDIT', '100.00', '0.00', '100.00'),
      entry('bet-1', 'DEBIT', '30.00', '100.00', '70.00'),
      entry('refund', 'CREDIT', '30.00', '70.00', '100.00'),
      entry('bet-2', 'DEBIT', '30.00', '100.00', '70.00'),
    ]);

    expect(result.chainFeasible).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test('rejects a negative intermediate balance', () => {
    const result = audit([
      entry('invalid', 'DEBIT', '10.00', '0.00', '-10.00'),
    ], '-10.00');

    expect(result.chainFeasible).toBe(false);

    expect(
      result.issues.some(
        (issue) => issue.code === 'INVALID_MOVEMENT',
      ),
    ).toBe(true);
  });
});
