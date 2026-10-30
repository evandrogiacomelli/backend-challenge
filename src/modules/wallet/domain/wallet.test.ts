
import { describe, expect, test } from 'bun:test';

import { Money } from '../../../shared/domain/money.js';
import { Wallet } from './wallet.js';

const money = (amount: string, currency = 'BRL'): Money =>
  Money.from({ amount, currency });

const createWallet = (amount = '100.00'): Wallet =>
  Wallet.open({
    id: 'wallet-123',
    playerId: 'player-123',
    initialBalance: money(amount),
  });

describe('Wallet', () => {
  describe('open', () => {
    test('should open with initial balance and version 1', () => {
      const wallet = createWallet();

      expect(wallet.id).toBe('wallet-123');
      expect(wallet.playerId).toBe('player-123');
      expect(wallet.currency).toBe('BRL');
      expect(wallet.balance.toJSON().amount).toBe('100.00');
      expect(wallet.version).toBe(1);
      expect(wallet.createdAt).toBeInstanceOf(Date);
      expect(wallet.updatedAt).toBeInstanceOf(Date);
    });

    test('should allow zero initial balance', () => {
      const wallet = createWallet('0.00');

      expect(wallet.balance.isZero()).toBe(true);
      expect(wallet.version).toBe(1);
    });

    test('should reject negative initial balance', () => {
      const negative = money('50.00').negate();

      expect(() =>
        Wallet.open({
          id: 'wallet-123',
          playerId: 'player-123',
          initialBalance: negative,
        }),
      ).toThrow('Initial balance cannot be negative');
    });
  });

  describe('credit', () => {
    test('should increase balance and version', () => {
      const wallet = createWallet();

      wallet.credit(money('50.00'));

      expect(wallet.balance.toJSON().amount).toBe('150.00');
      expect(wallet.version).toBe(2);
    });

    test('should return movement data for the ledger', () => {
      const wallet = createWallet();

      const movement = wallet.credit(money('25.00'));

      expect(movement.direction).toBe('CREDIT');
      expect(movement.money.toJSON().amount).toBe('25.00');
      expect(movement.balanceBefore.toJSON().amount).toBe('100.00');
      expect(movement.balanceAfter.toJSON().amount).toBe('125.00');
    });

    test('should reject different currency', () => {
      const wallet = createWallet();

      expect(() => wallet.credit(money('10.00', 'USD'))).toThrow(
        'Currency mismatch',
      );

      expect(wallet.balance.toJSON().amount).toBe('100.00');
      expect(wallet.version).toBe(1);
    });

    test('should reject zero credit', () => {
      const wallet = createWallet();

      expect(() => wallet.credit(Money.zero('BRL'))).toThrow(
        'Amount must be positive',
      );

      expect(wallet.version).toBe(1);
    });

    test('should reject negative credit', () => {
      const wallet = createWallet();

      expect(() => wallet.credit(money('10.00').negate())).toThrow(
        'Amount must be positive',
      );
    });
  });

  describe('debit', () => {
    test('should decrease balance and increase version', () => {
      const wallet = createWallet();

      wallet.debit(money('30.00'));

      expect(wallet.balance.toJSON().amount).toBe('70.00');
      expect(wallet.version).toBe(2);
    });

    test('should return movement data for the ledger', () => {
      const wallet = createWallet();

      const movement = wallet.debit(money('40.00'));

      expect(movement.direction).toBe('DEBIT');
      expect(movement.money.toJSON().amount).toBe('40.00');
      expect(movement.balanceBefore.toJSON().amount).toBe('100.00');
      expect(movement.balanceAfter.toJSON().amount).toBe('60.00');
    });

    test('should allow debiting the exact balance', () => {
      const wallet = createWallet();

      wallet.debit(money('100.00'));

      expect(wallet.balance.isZero()).toBe(true);
      expect(wallet.version).toBe(2);
    });

    test('should reject insufficient balance', () => {
      const wallet = createWallet();

      expect(() => wallet.debit(money('150.00'))).toThrow(
        'Insufficient balance',
      );

      expect(wallet.balance.toJSON().amount).toBe('100.00');
      expect(wallet.version).toBe(1);
    });

    test('should reject different currency', () => {
      const wallet = createWallet();

      expect(() => wallet.debit(money('10.00', 'USD'))).toThrow(
        'Currency mismatch',
      );

      expect(wallet.version).toBe(1);
    });

    test('should reject zero debit', () => {
      const wallet = createWallet();

      expect(() => wallet.debit(Money.zero('BRL'))).toThrow(
        'Amount must be positive',
      );

      expect(wallet.version).toBe(1);
    });

    test('should reject negative debit', () => {
      const wallet = createWallet();

      expect(() => wallet.debit(money('10.00').negate())).toThrow(
        'Amount must be positive',
      );
    });

    test('should never allow negative balance', () => {
      const wallet = createWallet();

      wallet.debit(money('80.00'));

      expect(() => wallet.debit(money('30.00'))).toThrow(
        'Insufficient balance',
      );

      expect(wallet.balance.toJSON().amount).toBe('20.00');
      expect(wallet.version).toBe(2);
    });
  });

  describe('version', () => {
    test('should increment only on successful movements', () => {
      const wallet = createWallet();

      wallet.credit(money('50.00'));
      wallet.debit(money('20.00'));

      expect(wallet.version).toBe(3);

      expect(() => wallet.debit(money('200.00'))).toThrow(
        'Insufficient balance',
      );

      expect(wallet.version).toBe(3);
      expect(wallet.balance.toJSON().amount).toBe('130.00');
    });
  });

  describe('rehydrate', () => {
    test('should restore persisted state without incrementing version', () => {
      const createdAt = new Date('2026-01-01T10:00:00Z');
      const updatedAt = new Date('2026-01-02T10:00:00Z');

      const wallet = Wallet.rehydrate({
        id: 'wallet-123',
        playerId: 'player-123',
        currency: 'BRL',
        balance: money('250.00'),
        version: 7,
        createdAt,
        updatedAt,
      });

      expect(wallet.balance.toJSON().amount).toBe('250.00');
      expect(wallet.version).toBe(7);
      expect(wallet.createdAt).toEqual(createdAt);
      expect(wallet.updatedAt).toEqual(updatedAt);
    });

    test('should allow new movements after rehydration', () => {
      const wallet = Wallet.rehydrate({
        id: 'wallet-123',
        playerId: 'player-123',
        currency: 'BRL',
        balance: money('100.00'),
        version: 5,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      wallet.debit(money('25.00'));

      expect(wallet.balance.toJSON().amount).toBe('75.00');
      expect(wallet.version).toBe(6);
    });
  });
});
