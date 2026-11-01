import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

import { InboxAlreadyProcessedError } from '../../../../wagering/application/ports/bet-transaction-runner.js';

import type { ProcessBetUseCase } from '../../../../wagering/application/use-cases/process-bet.use-case.js';
import type { ProcessWinUseCase } from '../../../../wagering/application/use-cases/process-win.use-case.js';
import type { ProcessLossUseCase } from '../../../../wagering/application/use-cases/process-loss.use-case.js';

import { SqsWagerConsumer } from './sqs-wager.consumer.js';

const QUEUE_URL =
  'http://127.0.0.1:4566/queue/us-east-1/wager-test.fifo';

function lossEnvelope(messageId: string): string {
  return JSON.stringify({
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-loss-test',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      walletId: randomUUID(),
      playerId: randomUUID(),
      roundId: randomUUID(),
      gameId: 'loss-game',
      kind: 'LOSS',
      money: {
        amount: '30.00',
        currency: 'BRL',
      },
    },
  });
}

type Behavior = 'success' | 'duplicate' | 'failure';

function fixture(behavior: Behavior) {
  const messageId = randomUUID();

  const commands: unknown[] = [];

  const calls = {
    bet: 0,
    win: 0,
    loss: 0,
    inboxMessageId: '',
  };

  const client = {
    async send(command: unknown): Promise<unknown> {
      commands.push(command);

      if (command instanceof ReceiveMessageCommand) {
        return {
          Messages: [{
            MessageId: randomUUID(),
            Body: lossEnvelope(messageId),
            ReceiptHandle: 'loss-receipt-1',
            Attributes: {
              ApproximateReceiveCount: '1',
            },
          }],
        };
      }

      return {};
    },
  } as unknown as SQSClient;

  const bet = {
    async execute() {
      calls.bet++;
    },
  } as unknown as ProcessBetUseCase;

  const win = {
    async execute() {
      calls.win++;
    },
  } as unknown as ProcessWinUseCase;

  const loss = {
    async execute(input: {
      inbox?: { messageId: string };
    }) {
      calls.loss++;
      calls.inboxMessageId =
        input.inbox?.messageId ?? '';

      if (behavior === 'duplicate') {
        throw new InboxAlreadyProcessedError();
      }

      if (behavior === 'failure') {
        throw new Error('PostgreSQL unavailable');
      }
    },
  } as unknown as ProcessLossUseCase;

  return {
    consumer: new SqsWagerConsumer(
      client,
      QUEUE_URL,
      bet,
      win,
      loss,
    ),
    commands,
    calls,
    messageId,
  };
}

describe('SQS LOSS routing', () => {
  test('routes LOSS only to ProcessLossUseCase', async () => {
    const setup = fixture('success');

    const result = await setup.consumer.pollOnce();

    expect(result).toEqual({
      received: 1,
      acknowledged: 1,
      duplicates: 0,
      retried: 0,
    });

    expect(setup.calls.loss).toBe(1);
    expect(setup.calls.bet).toBe(0);
    expect(setup.calls.win).toBe(0);

    expect(setup.calls.inboxMessageId).toBe(
      setup.messageId,
    );

    expect(
      setup.commands.some(
        (command) =>
          command instanceof DeleteMessageCommand,
      ),
    ).toBe(true);
  });

  test('ACKs a previously processed LOSS', async () => {
    const setup = fixture('duplicate');

    const result = await setup.consumer.pollOnce();

    expect(result.acknowledged).toBe(1);
    expect(result.duplicates).toBe(1);

    expect(
      setup.commands.some(
        (command) =>
          command instanceof DeleteMessageCommand,
      ),
    ).toBe(true);

    expect(
      setup.commands.some(
        (command) =>
          command instanceof ChangeMessageVisibilityCommand,
      ),
    ).toBe(false);
  });

  test('retries LOSS when the database fails', async () => {
    const setup = fixture('failure');

    const result = await setup.consumer.pollOnce();

    expect(result.retried).toBe(1);
    expect(result.acknowledged).toBe(0);

    expect(
      setup.commands.some(
        (command) =>
          command instanceof ChangeMessageVisibilityCommand,
      ),
    ).toBe(true);

    expect(
      setup.commands.some(
        (command) =>
          command instanceof DeleteMessageCommand,
      ),
    ).toBe(false);
  });
});
