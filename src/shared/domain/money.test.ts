
import { describe, expect, test } from 'bun:test';

import { Money } from './money.js';

describe('Money', () => {
  describe('from', () => {
    test('should create money with a valid amount and currency', () => {
      const money = Money.from({
        amount: '100.00',
        currency: 'BRL',
      });

      expect(money.toJSON()).toEqual({
        amount: '100.00',
        currency: 'BRL',
      });
    });

    test('should reject amounts with more than two decimal places', () => {
      expect(() =>
        Money.from({
          amount: '100.999',
          currency: 'BRL',
        }),
      ).toThrow('Invalid money amount');
    });

    test('should reject negative input amounts', () => {
      expect(() =>
        Money.from({
          amount: '-10.00',
          currency: 'BRL',
        }),
      ).toThrow('Invalid money amount');
    });
  });

  describe('add', () => {
    test('should add two monetary values', () => {
      const first = Money.from({
        amount: '100.50',
        currency: 'BRL',
      });

      const second = Money.from({
        amount: '25.25',
        currency: 'BRL',
      });

      const result = first.add(second);

      expect(result.toJSON()).toEqual({
        amount: '125.75',
        currency: 'BRL',
      });
    });

    test('should not mutate the original value', () => {
      const first = Money.from({
        amount: '100.00',
        currency: 'BRL',
      });

      const second = Money.from({
        amount: '50.00',
        currency: 'BRL',
      });

      const result = first.add(second);

      expect(first.toJSON().amount).toBe('100.00');
      expect(result.toJSON().amount).toBe('150.00');
      expect(result).not.toBe(first);
    });

    test('should reject operations between different currencies', () => {
      const brl = Money.from({
        amount: '100.00',
        currency: 'BRL',
      });

      const usd = Money.from({
        amount: '50.00',
        currency: 'USD',
      });

      expect(() => brl.add(usd)).toThrow('Currency mismatch');
    });
  });

  describe('subtract', () => {
    test('should subtract two monetary values', () => {
      const first = Money.from({
        amount: '100.50',
        currency: 'BRL',
      });

      const second = Money.from({
        amount: '25.25',
        currency: 'BRL',
      });

      const result = first.subtract(second);

      expect(result.toJSON()).toEqual({
        amount: '75.25',
        currency: 'BRL',
      });

      expect(first.toJSON().amount).toBe('100.50');
    });

    test('should allow negative results internally', () => {
      const first = Money.from({
        amount: '25.00',
        currency: 'BRL',
      });

      const second = Money.from({
        amount: '50.00',
        currency: 'BRL',
      });

      expect(first.subtract(second).toJSON()).toEqual({
        amount: '-25.00',
        currency: 'BRL',
      });
    });

    test('should reject subtraction between different currencies', () => {
      const brl = Money.from({
        amount: '100.00',
        currency: 'BRL',
      });

      const usd = Money.from({
        amount: '25.00',
        currency: 'USD',
      });

      expect(() => brl.subtract(usd)).toThrow('Currency mismatch');
    });
  });

  describe('negate', () => {
    test('should invert the sign without mutating the original', () => {
      const money = Money.from({
        amount: '50.00',
        currency: 'BRL',
      });

      const result = money.negate();

      expect(result.toJSON().amount).toBe('-50.00');
      expect(money.toJSON().amount).toBe('50.00');
    });

    test('should restore the original value when negated twice', () => {
      const money = Money.from({
        amount: '50.00',
        currency: 'BRL',
      });

      expect(money.negate().negate().equals(money)).toBe(true);
    });
  });

  describe('equals', () => {
    test('should compare monetary values by value', () => {
      const first = Money.from({
        amount: '100.00',
        currency: 'BRL',
      });

      const second = Money.from({
        amount: '100.00',
        currency: 'BRL',
      });

      expect(first.equals(second)).toBe(true);
      expect(first).not.toBe(second);
    });

    test('should return false for different amounts', () => {
      const first = Money.from({
        amount: '100.00',
        currency: 'BRL',
      });

      const second = Money.from({
        amount: '200.00',
        currency: 'BRL',
      });

      expect(first.equals(second)).toBe(false);
    });

    test('should reject comparison between different currencies', () => {
      const brl = Money.from({
        amount: '100.00',
        currency: 'BRL',
      });

      const usd = Money.from({
        amount: '100.00',
        currency: 'USD',
      });

      expect(() => brl.equals(usd)).toThrow('Currency mismatch');
    });
  });

  describe('zero', () => {
    test('should create zero money for a given currency', () => {
      const money = Money.zero('BRL');

      expect(money.toJSON()).toEqual({
        amount: '0.00',
        currency: 'BRL',
      });
    });
  });

  describe('sign checks', () => {
    test('should identify zero', () => {
      const money = Money.zero('BRL');

      expect(money.isZero()).toBe(true);
      expect(money.isPositive()).toBe(false);
      expect(money.isNegative()).toBe(false);
    });

    test('should identify positive money', () => {
      const money = Money.from({
        amount: '25.00',
        currency: 'BRL',
      });

      expect(money.isZero()).toBe(false);
      expect(money.isPositive()).toBe(true);
      expect(money.isNegative()).toBe(false);
    });

    test('should identify negative money', () => {
      const money = Money.from({
        amount: '25.00',
        currency: 'BRL',
      }).negate();

      expect(money.isZero()).toBe(false);
      expect(money.isPositive()).toBe(false);
      expect(money.isNegative()).toBe(true);
    });

    test('should keep zero when negated', () => {
      const money = Money.zero('BRL').negate();

      expect(money.isZero()).toBe(true);
      expect(money.toJSON().amount).toBe('0.00');
    });
  });

  describe('isLessThan', () => {
    test('should return true when the amount is smaller', () => {
      const first = Money.from({
        amount: '50.00',
        currency: 'BRL',
      });

      const second = Money.from({
        amount: '100.00',
        currency: 'BRL',
      });

      expect(first.isLessThan(second)).toBe(true);
    });

    test('should return false when amounts are equal', () => {
      const first = Money.from({
        amount: '100.00',
        currency: 'BRL',
      });

      const second = Money.from({
        amount: '100.00',
        currency: 'BRL',
      });

      expect(first.isLessThan(second)).toBe(false);
    });

    test('should return false when the amount is greater', () => {
      const first = Money.from({
        amount: '150.00',
        currency: 'BRL',
      });

      const second = Money.from({
        amount: '100.00',
        currency: 'BRL',
      });

      expect(first.isLessThan(second)).toBe(false);
    });

    test('should reject comparisons between different currencies', () => {
      const brl = Money.from({
        amount: '50.00',
        currency: 'BRL',
      });

      const usd = Money.from({
        amount: '100.00',
        currency: 'USD',
      });

      expect(() => brl.isLessThan(usd)).toThrow('Currency mismatch');
    });
  });

  describe('toString', () => {
    test('should return a readable monetary representation', () => {
      const money = Money.from({
        amount: '125.50',
        currency: 'BRL',
      });

      expect(money.toString()).toBe('125.50 BRL');
    });

    test('should preserve two decimal places for negative values', () => {
      const money = Money.from({
        amount: '25.00',
        currency: 'BRL',
      }).negate();

      expect(money.toString()).toBe('-25.00 BRL');
    });
  });
});
