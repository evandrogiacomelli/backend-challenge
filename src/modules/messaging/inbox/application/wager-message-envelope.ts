import { createHash } from 'node:crypto';

import type { ProcessBetInput } from '../../../wagering/application/use-cases/process-bet.use-case.js';
import type { ProcessWinInput } from '../../../wagering/application/use-cases/process-win.use-case.js';
import type { InboxReceipt } from '../../../wagering/application/ports/bet-transaction-runner.js';
import { ProcessLossInput } from '../../../wagering/application/use-cases/process-loss.use-case.js';

export const WAGER_CONSUMER_NAME = 'wager-transactions-v1';

export class InvalidWagerMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWagerMessageError';
  }
}


export type ParsedWagerMessage =
  | {
  kind: 'BET';
  input: ProcessBetInput;
  inbox: InboxReceipt;
}
  | {
  kind: 'WIN';
  input: ProcessWinInput;
  inbox: InboxReceipt;
}
  | {
  kind: 'LOSS';
  input: ProcessLossInput;
  inbox: InboxReceipt;
};


function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidWagerMessageError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, maxLength = 255): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new InvalidWagerMessageError(`Invalid ${field}`);
  }
  return value;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const record = object(value, 'payload');
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

export function parseWagerMessage(body: string): ParsedWagerMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new InvalidWagerMessageError('Message body is not valid JSON');
  }

  const envelope = object(parsed, 'message');
  const messageId = requiredString(envelope.messageId, 'messageId');
  if (envelope.type !== 'WagerTransactionRequested') {
    throw new InvalidWagerMessageError('Unsupported message type');
  }
  const occurredAt = requiredString(envelope.occurredAt, 'occurredAt');
  if (!Number.isFinite(Date.parse(occurredAt))) {
    throw new InvalidWagerMessageError('Invalid occurredAt');
  }

  const data = object(envelope.data, 'data');
  const kind = data.kind;
  if (
    data.kind !== 'BET' &&
    data.kind !== 'WIN' &&
    data.kind !== 'LOSS'
  ) {
    throw new InvalidWagerMessageError(
      'Unsupported wager kind',
    );
  }
  const money = object(data.money, 'data.money');
  const common = {
    providerId: requiredString(data.providerId, 'providerId', 100),
    externalTransactionId: requiredString(data.externalTransactionId, 'externalTransactionId'),
    idempotencyKey: requiredString(data.idempotencyKey, 'idempotencyKey'),
    walletId: requiredString(data.walletId, 'walletId'),
    playerId: requiredString(data.playerId, 'playerId'),
    roundId: requiredString(data.roundId, 'roundId'),
    gameId: requiredString(data.gameId, 'gameId'),
    amount: requiredString(money.amount, 'money.amount'),
    currency: requiredString(money.currency, 'money.currency', 3),
  };

  const inbox: InboxReceipt = {
    consumerName: WAGER_CONSUMER_NAME,
    messageId,
    payloadHash: createHash('sha256')
      .update(canonicalize(envelope))
      .digest('hex'),
  };

  if (kind === 'WIN') {
    const referenceExternalTransactionId =
      data.referenceExternalTransactionId === undefined
        ? undefined
        : requiredString(
          data.referenceExternalTransactionId,
          'referenceExternalTransactionId',
        );

    return {
      kind: 'WIN',
      inbox,
      input: {
        ...common,
        ...(referenceExternalTransactionId === undefined
          ? {}
          : { referenceExternalTransactionId }),
      },
    };
  }

  if (kind === 'LOSS') {
    return {
      kind: 'LOSS',
      inbox,
      input: {
        ...common,
      },
    };
  }

  return {
    kind: 'BET',
    inbox,
    input: {
      ...common,
    },
  };


  if (data.referenceExternalTransactionId !== undefined) {
    throw new InvalidWagerMessageError('BET does not support referenceExternalTransactionId');
  }
  return { kind: 'BET', input: common, inbox };
}
