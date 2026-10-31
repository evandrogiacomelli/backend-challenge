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
import { SqsWagerConsumer } from './sqs-wager.consumer.js';

const QUEUE_URL = 'http://localhost:4566/000000000000/wager-transactions.fifo';

type Mode = 'success' | 'duplicate' | 'error';

function fixture(kind: 'BET' | 'WIN', mode: Mode, includeWin = true) {
  const commands: unknown[] = [];
  const calls: string[] = [];
  const messageId = randomUUID();
  const body = JSON.stringify({
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-test',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      walletId: randomUUID(),
      playerId: randomUUID(),
      roundId: randomUUID(),
      gameId: 'test-game',
      kind,
      money: { amount: '25.00', currency: 'BRL' },
    },
  });

  const client = {
    async send(command: unknown) {
      commands.push(command);
      if (command instanceof ReceiveMessageCommand) {
        return { Messages: [{
          MessageId: randomUUID(),
          Body: body,
          ReceiptHandle: 'handle-1',
          Attributes: { ApproximateReceiveCount: '1' },
        }] };
      }
      return {};
    },
  } as unknown as SQSClient;

  function execute(which: string, input: { inbox?: { messageId: string } }) {
    calls.push(which);
    expect(input.inbox?.messageId).toBe(messageId);
    if (mode === 'duplicate') throw new InboxAlreadyProcessedError();
    if (mode === 'error') throw new Error('Simulated failure');
    return { status: 'PROCESSED' };
  }

  const bet = {
    execute: (input: { inbox?: { messageId: string } }) =>
      execute('BET', input),
  } as unknown as ProcessBetUseCase;

  const win = {
    execute: (input: { inbox?: { messageId: string } }) =>
      execute('WIN', input),
  } as unknown as ProcessWinUseCase;

  return {
    commands,
    calls,
    consumer: new SqsWagerConsumer(client, QUEUE_URL, bet, includeWin ? win : undefined),
  };
}

describe('SQS wager consumer with WIN routing', () => {
  test('processes WIN, then acknowledges the SQS message', async () => {
    const f = fixture('WIN', 'success');
    const result = await f.consumer.pollOnce();
    expect(result).toEqual({ received: 1, acknowledged: 1, duplicates: 0, retried: 0 });
    expect(f.calls).toEqual(['WIN']);
    expect(f.commands.map((c) => c?.constructor?.name))
      .toEqual(['ReceiveMessageCommand', 'DeleteMessageCommand']);
  });

  test('routes BET to its original use case', async () => {
    const f = fixture('BET', 'success');
    await f.consumer.pollOnce();
    expect(f.calls).toEqual(['BET']);
  });

  test('acknowledges a previously processed WIN without another credit', async () => {
    const f = fixture('WIN', 'duplicate');
    const result = await f.consumer.pollOnce();
    expect(result.duplicates).toBe(1);
    expect(f.commands.some((c) => c instanceof DeleteMessageCommand)).toBe(true);
  });

  test('retries WIN errors and does not delete the message', async () => {
    const f = fixture('WIN', 'error');
    const result = await f.consumer.pollOnce();
    expect(result.retried).toBe(1);
    expect(f.commands.some((c) => c instanceof ChangeMessageVisibilityCommand)).toBe(true);
    expect(f.commands.some((c) => c instanceof DeleteMessageCommand)).toBe(false);
  });

  test('does not ACK WIN when the WIN processor was not injected', async () => {
    const f = fixture('WIN', 'success', false);
    const result = await f.consumer.pollOnce();
    expect(result.retried).toBe(1);
    expect(f.calls).toHaveLength(0);
    expect(f.commands.some((c) => c instanceof DeleteMessageCommand)).toBe(false);
  });
});
