
import { describe, expect, test } from 'bun:test';

import { Money } from '../../../shared/domain/money.js';
import {
  WalletLedgerEntry,
  type CreateLedgerEntryProps,
} from './wallet-ledger-entry.js';

const money = (amount: string, currency = 'BRL'): Money =>
  Money.from({ amount, currency });

const createCreditProps = (): CreateLedgerEntryProps => ({
  id: 'ledger-123',
  walletId: 'wallet-123',
  transactionId: 'transaction-123',
  direction: 'CREDIT',
  money: money('50.00'),
  balanceBefore: money('100.00'),
  balanceAfter: money('150.00'),
});

const createDebitProps = (): CreateLedgerEntryProps => ({
  id: 'ledger-456',
  walletId: 'wallet-123',
  transactionId: 'transaction-456',
  direction: 'DEBIT',
  money: money('30.00'),
  balanceBefore: money('100.00'),
  balanceAfter: money('70.00'),
});

describe('WalletLedgerEntry', () => {
  describe('create', () => {
    test('should create a valid credit entry', () => {
      const entry = WalletLedgerEntry.create(createCreditProps());

      expect(entry.id).toBe('ledger-123');
      expect(entry.walletId).toBe('wallet-123');
      expect(entry.transactionId).toBe('transaction-123');
      expect(entry.direction).toBe('CREDIT');
      expect(entry.money.toJSON().amount).toBe('50.00');
      expect(entry.isBalanced()).toBe(true);
    });

    test('should create a valid debit entry', () => {
      const entry = WalletLedgerEntry.create(createDebitProps());

      expect(entry.direction).toBe('DEBIT');
      expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
      expect(entry.balanceAfter.toJSON().amount).toBe('70.00');
      expect(entry.isBalanced()).toBe(true);
    });

    test('should allow a debit resulting in zero balance', () => {
      const entry = WalletLedgerEntry.create({
        ...createDebitProps(),
        money: money('100.00'),
        balanceAfter: Money.zero('BRL'),
      });

      expect(entry.balanceAfter.isZero()).toBe(true);
      expect(entry.isBalanced()).toBe(true);
    });

    test('should reject an incorrect credit balance', () => {
      expect(() =>
        WalletLedgerEntry.create({
          ...createCreditProps(),
          balanceAfter: money('160.00'),
        }),
      ).toThrow('Unbalanced ledger entry');
    });

    test('should reject an incorrect debit balance', () => {
      expect(() =>
        WalletLedgerEntry.create({
          ...createDebitProps(),
          balanceAfter: money('80.00'),
        }),
      ).toThrow('Unbalanced ledger entry');
    });

    test('should reject a zero amount', () => {
      expect(() =>
        WalletLedgerEntry.create({
          ...createCreditProps(),
          money: Money.zero('BRL'),
        }),
      ).toThrow('Ledger amount must be positive');
    });

    test('should reject a negative amount', () => {
      expect(() =>
        WalletLedgerEntry.create({
          ...createCreditProps(),
          money: money('50.00').negate(),
        }),
      ).toThrow('Ledger amount must be positive');
    });

    test('should reject a different movement currency', () => {
      expect(() =>
        WalletLedgerEntry.create({
          ...createCreditProps(),
          money: money('50.00', 'USD'),
        }),
      ).toThrow('Currency mismatch');
    });

    test('should reject a different balance currency', () => {
      expect(() =>
        WalletLedgerEntry.create({
          ...createCreditProps(),
          balanceAfter: money('150.00', 'USD'),
        }),
      ).toThrow('Currency mismatch');
    });

    test('should reject an entry with an invalid direction', () => {
      expect(() =>
        WalletLedgerEntry.create({
          ...createCreditProps(),
          direction: 'INVALID' as 'CREDIT',
        }),
      ).toThrow('Unbalanced ledger entry');
    });

    test('should preserve exact decimal arithmetic', () => {
      const entry = WalletLedgerEntry.create({
        ...createCreditProps(),
        money: money('0.10'),
        balanceBefore: money('0.20'),
        balanceAfter: money('0.30'),
      });

      expect(entry.isBalanced()).toBe(true);
      expect(entry.balanceAfter.toJSON().amount).toBe('0.30');
    });
  });

  describe('immutability', () => {
    test('should freeze the entry', () => {
      const entry = WalletLedgerEntry.create(createCreditProps());

      expect(Object.isFrozen(entry)).toBe(true);
    });

    test('should not allow createdAt to be modified externally', () => {
      const originalDate = new Date('2026-01-01T10:00:00Z');

      const entry = WalletLedgerEntry.create({
        ...createCreditProps(),
        createdAt: originalDate,
      });

      originalDate.setFullYear(2030);

      const returnedDate = entry.createdAt;
      returnedDate.setFullYear(2040);

      expect(entry.createdAt.toISOString()).toBe(
        '2026-01-01T10:00:00.000Z',
      );
    });

    test('should preserve original Money values', () => {
      const entry = WalletLedgerEntry.create(createCreditProps());

      const changed = entry.balanceBefore.add(money('500.00'));

      expect(changed.toJSON().amount).toBe('600.00');
      expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    });
  });

  describe('rehydrate', () => {
    test('should restore an existing ledger entry', () => {
      const createdAt = new Date('2026-01-01T10:00:00Z');

      const entry = WalletLedgerEntry.rehydrate({
        ...createDebitProps(),
        createdAt,
      });

      expect(entry.id).toBe('ledger-456');
      expect(entry.direction).toBe('DEBIT');
      expect(entry.createdAt).toEqual(createdAt);
      expect(entry.isBalanced()).toBe(true);
    });

    test('should reconstruct persisted state without revalidating it', () => {
      const entry = WalletLedgerEntry.rehydrate({
        ...createCreditProps(),
        balanceAfter: money('999.00'),
        createdAt: new Date(),
      });

      expect(entry.balanceAfter.toJSON().amount).toBe('999.00');
      expect(entry.isBalanced()).toBe(false);
    });

    test('should keep rehydrated entries immutable', () => {
      const entry = WalletLedgerEntry.rehydrate({
        ...createCreditProps(),
        createdAt: new Date(),
      });

      expect(Object.isFrozen(entry)).toBe(true);
    });
  });
});
