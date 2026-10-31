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
import { SqsWagerConsumer } from './sqs-wager.consumer.js';

function messageBody(): string {
  return JSON.stringify({
    messageId: randomUUID(),
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      playerId: randomUUID(),
      walletId: randomUUID(),
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: {
        amount: '25.00',
        currency: 'BRL',
      },
    },
  });
}

function fixture(
  behavior: 'success' | 'duplicate' | 'failure',
) {
  const commands: unknown[] = [];
  const body = messageBody();

  const sqs = {
    async send(command: unknown): Promise<unknown> {
      commands.push(command);

      if (command instanceof ReceiveMessageCommand) {
        return {
          Messages: [
            {
              MessageId: randomUUID(),
              Body: body,
              ReceiptHandle: 'receipt-123',
              Attributes: {
                ApproximateReceiveCount: '1',
              },
            },
          ],
        };
      }

      return {};
    },
  } as unknown as SQSClient;

  let executions = 0;

  const useCase = {
    async execute() {
      executions++;

      if (behavior === 'duplicate') {
        throw new InboxAlreadyProcessedError();
      }

      if (behavior === 'failure') {
        throw new Error('Database unavailable');
      }

      return {
        status: 'PROCESSED',
      };
    },
  } as unknown as ProcessBetUseCase;

  return {
    commands,
    consumer: new SqsWagerConsumer(
      sqs,
      'http://localhost:4566/wager-transactions.fifo',
      useCase,
    ),
    get executions() {
      return executions;
    },
  };
}

describe('SqsWagerConsumer', () => {
  test('should ACK only after processing succeeds', async () => {
    const setup = fixture('success');

    const result = await setup.consumer.pollOnce();

    expect(result).toEqual({
      received: 1,
      acknowledged: 1,
      duplicates: 0,
      retried: 0,
    });

    expect(setup.executions).toBe(1);

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

  test('should ACK an already processed Inbox message', async () => {
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
  });

  test('should retry infrastructure failure without ACK', async () => {
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

  test('should use a persistent envelope message ID', async () => {
    const setup = fixture('success');

    const result = await setup.consumer.pollOnce();

    expect(result.received).toBe(1);
    expect(setup.executions).toBe(1);
  });
});
