
import { describe, expect, test } from 'bun:test';

import { Money } from '../../../shared/domain/money.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateWagerTransactionProps,
} from './wager-transaction.js';

const money = (amount: string, currency = 'BRL'): Money =>
  Money.from({ amount, currency });

const props = (
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps => ({
  id: 'tx-1',
  providerId: 'provider-a',
  externalTransactionId: 'external-1',
  idempotencyKey: 'provider-a:external-1',
  payloadHash: 'hash-1',
  walletId: 'wallet-1',
  playerId: 'player-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: WagerTransactionKind.Bet,
  money: money('50.00'),
  ...overrides,
});

const create = (
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction => WagerTransaction.create(props(overrides));

const processedBet = (): WagerTransaction => {
  const bet = create();

  bet.markProcessed({
    resultingBalance: money('50.00'),
  });

  return bet;
};

const reversal = (
  kind: WagerTransactionKind,
  reference = 'external-1',
): WagerTransaction =>
  create({
    id: `tx-${kind}`,
    externalTransactionId: `external-${kind}`,
    idempotencyKey: `key-${kind}`,
    kind,
    referenceExternalTransactionId: reference,
  });

describe('WagerTransaction', () => {
  describe('create', () => {
    test('should start in PENDING', () => {
      const transaction = create();

      expect(transaction.status).toBe(WagerTransactionStatus.Pending);
      expect(transaction.id).toBe('tx-1');
      expect(transaction.money.toJSON().amount).toBe('50.00');
      expect(transaction.isTerminal()).toBe(false);
      expect(transaction.attempts).toBe(0);
    });

    test('should reject OPENING through external factory', () => {
      expect(() =>
        create({ kind: WagerTransactionKind.Opening }),
      ).toThrow('Invalid external transaction kind');
    });

    test('should require a reference for REFUND', () => {
      expect(() =>
        create({ kind: WagerTransactionKind.Refund }),
      ).toThrow('Reference is required');
    });

    test('should require a reference for ROLLBACK', () => {
      expect(() =>
        create({ kind: WagerTransactionKind.Rollback }),
      ).toThrow('Reference is required');
    });

    test('should allow WIN without reference', () => {
      const transaction = create({
        kind: WagerTransactionKind.Win,
      });

      expect(transaction.requiresReference()).toBe(false);
      expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    });

    test('should reject zero BET amount', () => {
      expect(() =>
        create({ money: Money.zero('BRL') }),
      ).toThrow('Transaction amount must be positive');
    });

    test('should reject negative amounts', () => {
      expect(() =>
        create({
          money: money('10.00').negate(),
        }),
      ).toThrow();
    });

    test('should reject missing business identifiers', () => {
      expect(() =>
        create({ providerId: '' }),
      ).toThrow('Required transaction field is missing');
    });
  });

  describe('OPENING', () => {
    test('should create an internal opening transaction', () => {
      const transaction = WagerTransaction.createOpening({
        id: 'opening-1',
        walletId: 'wallet-1',
        playerId: 'player-1',
        money: money('100.00'),
      });

      expect(transaction.kind).toBe(WagerTransactionKind.Opening);
      expect(transaction.providerId).toBe('SYSTEM');
      expect(transaction.status).toBe(WagerTransactionStatus.Pending);
      expect(transaction.ledgerDirectionFor()).toBe('CREDIT');
    });

    test('should reject zero opening amount', () => {
      expect(() =>
        WagerTransaction.createOpening({
          id: 'opening-1',
          walletId: 'wallet-1',
          playerId: 'player-1',
          money: Money.zero('BRL'),
        }),
      ).toThrow('Opening amount must be positive');
    });
  });

  describe('domain queries', () => {
    test('should identify operations affecting balance', () => {
      expect(create().affectsBalance()).toBe(true);

      expect(
        create({ kind: WagerTransactionKind.Win }).affectsBalance(),
      ).toBe(true);

      expect(
        create({ kind: WagerTransactionKind.Loss }).affectsBalance(),
      ).toBe(false);
    });

    test('should identify required references', () => {
      expect(create().requiresReference()).toBe(false);
      expect(reversal(WagerTransactionKind.Refund).requiresReference()).toBe(true);
      expect(reversal(WagerTransactionKind.Rollback).requiresReference()).toBe(true);
    });

    test('should match payload hash exactly', () => {
      const transaction = create();

      expect(transaction.matchesPayload('hash-1')).toBe(true);
      expect(transaction.matchesPayload('hash-2')).toBe(false);
    });
  });

  describe('markProcessed', () => {
    test('should persist the original resulting balance', () => {
      const transaction = create();
      const processedAt = new Date('2026-01-01T10:00:00Z');

      transaction.markProcessed({
        resultingBalance: money('50.00'),
        at: processedAt,
      });

      expect(transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(transaction.isTerminal()).toBe(true);
      expect(transaction.resultingBalance?.toJSON().amount).toBe('50.00');
      expect(transaction.processedAt).toEqual(processedAt);
    });

    test('should reject a second processing attempt', () => {
      const transaction = processedBet();

      expect(() =>
        transaction.markProcessed({
          resultingBalance: money('0.00'),
        }),
      ).toThrow('Invalid transaction state');
    });

    test('should reject resulting balance with different currency', () => {
      const transaction = create();

      expect(() =>
        transaction.markProcessed({
          resultingBalance: money('50.00', 'USD'),
        }),
      ).toThrow('Currency mismatch');

      expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    });

    test('should reject negative resulting balance', () => {
      const transaction = create();

      expect(() =>
        transaction.markProcessed({
          resultingBalance: money('10.00').negate(),
        }),
      ).toThrow('Resulting balance cannot be negative');

      expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    });

    test('should process LOSS without reference or financial effect', () => {
      const transaction = create({
        kind: WagerTransactionKind.Loss,
      });

      transaction.markProcessed({
        resultingBalance: money('50.00'),
      });

      expect(transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(transaction.ledgerDirectionFor()).toBeNull();
      expect(transaction.affectsBalance()).toBe(false);
    });
  });

  describe('rejection and failure', () => {
    test('should reject a transaction with failureCode', () => {
      const transaction = create();

      transaction.reject('INSUFFICIENT_BALANCE', money('10.00'));

      expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
      expect(transaction.failureCode).toBe('INSUFFICIENT_BALANCE');
      expect(transaction.resultingBalance?.toJSON().amount).toBe('10.00');
      expect(transaction.isTerminal()).toBe(true);
    });

    test('should reject empty failure code', () => {
      const transaction = create();

      expect(() => transaction.reject('')).toThrow(
        'Failure code is required',
      );

      expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    });

    test('should prevent changes after rejection', () => {
      const transaction = create();
      transaction.reject('INSUFFICIENT_BALANCE');

      expect(() => transaction.fail('INFRASTRUCTURE_ERROR')).toThrow(
        'Invalid transaction state',
      );
    });

    test('should mark permanent failures as FAILED', () => {
      const transaction = create();

      transaction.fail('PERMANENT_PROCESSING_ERROR');

      expect(transaction.status).toBe(WagerTransactionStatus.Failed);
      expect(transaction.failureCode).toBe('PERMANENT_PROCESSING_ERROR');
      expect(transaction.isTerminal()).toBe(true);
    });
  });

  describe('references', () => {
    test('should mark missing references as pending', () => {
      const transaction = reversal(WagerTransactionKind.Refund);

      transaction.markPendingReference();

      expect(transaction.status).toBe(
        WagerTransactionStatus.PendingReference,
      );
    });

    test('should schedule pending reference retries', () => {
      const transaction = reversal(WagerTransactionKind.Refund);
      const nextAttempt = new Date('2026-01-02T10:00:00Z');

      transaction.markPendingReference();
      transaction.scheduleReferenceRetry(nextAttempt);

      expect(transaction.attempts).toBe(1);
      expect(transaction.nextAttemptAt).toEqual(nextAttempt);
    });

    test('should prevent scheduling retries for normal pending transactions', () => {
      expect(() =>
        create().scheduleReferenceRetry(new Date()),
      ).toThrow('Transaction is not pending reference');
    });

    test('should allow processing when the reference arrives', () => {
      const transaction = reversal(WagerTransactionKind.Refund);
      const bet = processedBet();

      transaction.markPendingReference();

      transaction.markProcessed({
        reference: bet,
        resultingBalance: money('100.00'),
      });

      expect(transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(transaction.referenceTransactionId).toBe(bet.id);
      expect(transaction.nextAttemptAt).toBeUndefined();
    });

    test('should reject a reference from another wallet', () => {
      const transaction = reversal(WagerTransactionKind.Refund);
      const bet = processedBet();

      const otherWalletRefund = WagerTransaction.create(
        props({
          id: 'refund-other-wallet',
          externalTransactionId: 'refund-other-wallet',
          idempotencyKey: 'refund-other-wallet',
          kind: WagerTransactionKind.Refund,
          walletId: 'another-wallet',
          referenceExternalTransactionId: 'external-1',
        }),
      );

      expect(() =>
        otherWalletRefund.markProcessed({
          reference: bet,
          resultingBalance: money('100.00'),
        }),
      ).toThrow('Reference context mismatch');

      expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    });

    test('should reject a reference with a different amount', () => {
      const transaction = reversal(WagerTransactionKind.Refund);
      const bet = processedBet();

      const refund = WagerTransaction.create(
        props({
          id: 'refund-20',
          externalTransactionId: 'refund-20',
          idempotencyKey: 'refund-20',
          kind: WagerTransactionKind.Refund,
          money: money('20.00'),
          referenceExternalTransactionId: 'external-1',
        }),
      );

      expect(() =>
        refund.markProcessed({
          reference: bet,
          resultingBalance: money('100.00'),
        }),
      ).toThrow('Reference amount mismatch');

      expect(transaction.isTerminal()).toBe(false);
    });

    test('should reject an unprocessed reference', () => {
      const refund = reversal(WagerTransactionKind.Refund);

      expect(() =>
        refund.markProcessed({
          reference: create(),
          resultingBalance: money('100.00'),
        }),
      ).toThrow('Reference must be processed');
    });

    test('should reject a non-BET reference for REFUND', () => {
      const win = create({
        kind: WagerTransactionKind.Win,
      });

      win.markProcessed({
        resultingBalance: money('100.00'),
      });

      const refund = reversal(WagerTransactionKind.Refund);

      expect(() =>
        refund.markProcessed({
          reference: win,
          resultingBalance: money('150.00'),
        }),
      ).toThrow('REFUND must reference BET');

      expect(refund.status).toBe(WagerTransactionStatus.Pending);
    });

  });

  describe('ledger direction', () => {
    test('should debit BET and credit WIN', () => {
      expect(create().ledgerDirectionFor()).toBe('DEBIT');
      expect(
        create({ kind: WagerTransactionKind.Win }).ledgerDirectionFor(),
      ).toBe('CREDIT');
    });

    test('should not generate ledger direction for LOSS', () => {
      expect(
        create({ kind: WagerTransactionKind.Loss }).ledgerDirectionFor(),
      ).toBeNull();
    });

    test('should credit a REFUND of BET', () => {
      expect(
        reversal(WagerTransactionKind.Refund).ledgerDirectionFor(
          processedBet(),
        ),
      ).toBe('CREDIT');
    });

    test('should credit a ROLLBACK of BET', () => {
      expect(
        reversal(WagerTransactionKind.Rollback).ledgerDirectionFor(
          processedBet(),
        ),
      ).toBe('CREDIT');
    });

    test('should debit a ROLLBACK of WIN', () => {
      const win = create({
        kind: WagerTransactionKind.Win,
      });

      win.markProcessed({
        resultingBalance: money('100.00'),
      });

      const rollback = reversal(
        WagerTransactionKind.Rollback,
        'external-1',
      );

      expect(rollback.ledgerDirectionFor(win)).toBe('DEBIT');
    });
  });

  describe('rehydrate', () => {
    test('should restore persisted state without replaying transitions', () => {
      const createdAt = new Date('2026-01-01T10:00:00Z');

      const transaction = WagerTransaction.rehydrate({
        ...props(),
        createdAt,
        status: WagerTransactionStatus.Processed,
        resultingBalance: money('50.00'),
        processedAt: createdAt,
        attempts: 0,
      });

      expect(transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(transaction.resultingBalance?.toJSON().amount).toBe('50.00');
      expect(transaction.createdAt).toEqual(createdAt);
      expect(transaction.isTerminal()).toBe(true);
    });

    test('should prevent modification of rehydrated terminal state', () => {
      const transaction = WagerTransaction.rehydrate({
        ...props(),
        createdAt: new Date(),
        status: WagerTransactionStatus.Rejected,
        failureCode: 'INSUFFICIENT_BALANCE',
        attempts: 0,
      });

      expect(() =>
        transaction.markProcessed({
          resultingBalance: money('50.00'),
        }),
      ).toThrow('Invalid transaction state');
    });
  });
});
