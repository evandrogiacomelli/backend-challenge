import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { InvalidWagerMessageError, parseWagerMessage } from './wager-message-envelope.js';


function envelope(kind: string, overrides: Record<string, unknown> = {}) {
  return {
    messageId: randomUUID(),
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-test',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      walletId: randomUUID(),
      playerId: randomUUID(),
      roundId: 'round-1',
      gameId: 'game-1',
      kind,
      money: { amount: '25.00', currency: 'BRL' },
      ...overrides,
    },
  };
}

function reversalMessage(
  kind: 'REFUND' | 'ROLLBACK',
  referenceExternalTransactionId?: string,
) {
  const externalTransactionId = randomUUID();

  return JSON.stringify({
    messageId: randomUUID(),
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      kind,
      providerId: 'parser-tests',
      externalTransactionId,
      idempotencyKey: randomUUID(),
      referenceExternalTransactionId,
      walletId: randomUUID(),
      playerId: randomUUID(),
      roundId: randomUUID(),
      gameId: 'parser-game',
      money: {
        amount: '30.00',
        currency: 'BRL',
      },
    },
  });
}

describe('Wager message envelope BET / WIN', () => {
  test('routes a BET without changing its financial data', () => {
    const body = envelope('BET');
    const parsed = parseWagerMessage(JSON.stringify(body));
    expect(parsed.kind).toBe('BET');
    expect(parsed.input.walletId).toBe(body.data.walletId);
    expect(parsed.input.amount).toBe('25.00');
    expect(parsed.inbox.messageId).toBe(body.messageId);
  });

  test('routes a WIN and preserves its Inbox identity', () => {
    const body = envelope('WIN');
    const parsed = parseWagerMessage(JSON.stringify(body));
    expect(parsed.kind).toBe('WIN');
    expect(parsed.input.amount).toBe('25.00');
    expect(parsed.inbox.messageId).toBe(body.messageId);
  });

  test('does not silently discard a WIN reference', () => {
    const parsed = parseWagerMessage(JSON.stringify(envelope('WIN', {
      referenceExternalTransactionId: 'bet-42',
    })));
    expect(parsed.kind).toBe('WIN');
    if (parsed.kind !== 'WIN') throw new Error('Invalid test setup');
    expect(parsed.input.referenceExternalTransactionId).toBe('bet-42');
  });

  test('preserves a stable hash even when JSON object keys are reordered', () => {
    const source = envelope('WIN');
    const reordered = {
      data: { ...source.data },
      occurredAt: source.occurredAt,
      type: source.type,
      messageId: source.messageId,
    };
    expect(parseWagerMessage(JSON.stringify(source)).inbox.payloadHash)
      .toBe(parseWagerMessage(JSON.stringify(reordered)).inbox.payloadHash);
  });

  test('rejects unimplemented kinds without acknowledging them', () => {
    expect(() => parseWagerMessage(JSON.stringify(envelope('REFUND'))))
      .toThrow(InvalidWagerMessageError);
  });

  test('parses REFUND with required reference', () => {
    const reference = randomUUID();

    const result = parseWagerMessage(
      reversalMessage('REFUND', reference),
    );

    expect(result.kind).toBe('REFUND');

    if (result.kind !== 'REFUND') {
      throw new Error('Unexpected kind');
    }

    expect(
      result.input.referenceExternalTransactionId,
    ).toBe(reference);

    expect(result.inbox.payloadHash).toHaveLength(64);
  });

  test('parses ROLLBACK with required reference', () => {
    const reference = randomUUID();

    const result = parseWagerMessage(
      reversalMessage('ROLLBACK', reference),
    );

    expect(result.kind).toBe('ROLLBACK');

    if (result.kind !== 'ROLLBACK') {
      throw new Error('Unexpected kind');
    }

    expect(
      result.input.referenceExternalTransactionId,
    ).toBe(reference);
  });

  test('rejects REFUND without reference', () => {
    expect(() =>
      parseWagerMessage(
        reversalMessage('REFUND'),
      ),
    ).toThrow(InvalidWagerMessageError);
  });

  test('rejects ROLLBACK without reference', () => {
    expect(() =>
      parseWagerMessage(
        reversalMessage('ROLLBACK'),
      ),
    ).toThrow(InvalidWagerMessageError);
  });

  test('rejects reversal referencing itself', () => {
    const parsed = JSON.parse(
      reversalMessage('ROLLBACK', randomUUID()),
    ) as {
      data: {
        externalTransactionId: string;
        referenceExternalTransactionId: string;
      };
    };

    parsed.data.referenceExternalTransactionId =
      parsed.data.externalTransactionId;

    expect(() =>
      parseWagerMessage(JSON.stringify(parsed)),
    ).toThrow(InvalidWagerMessageError);
  });

});
