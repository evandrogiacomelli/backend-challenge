
import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import {
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

import type { OutboxDelivery } from '../../application/ports/outbox-dispatcher.ports.js';
import { SqsFifoOutboxPublisher } from './sqs-fifo-outbox.publisher.js';

const QUEUE_URL =
  'http://localhost:4566/queue/us-east-1/test.fifo';

function createMessage(): OutboxDelivery {
  return {
    id: randomUUID(),
    aggregateId: randomUUID(),
    eventType: 'wager.bet.processed.v1',
    payload: {
      transactionId: randomUUID(),
      amount: '30.00',
      currency: 'BRL',
    },
    attempts: 1,
    claimToken: randomUUID(),
    claimedUntil: new Date(Date.now() + 120_000),
    occurredAt: new Date(),
  };
}

describe('SqsFifoOutboxPublisher', () => {
  test('should publish with group and deduplication IDs', async () => {
    const sent: SendMessageCommand[] = [];

    const client = {
      async send(command: SendMessageCommand) {
        sent.push(command);
        return { MessageId: randomUUID() };
      },
    } as unknown as SQSClient;

    const publisher = new SqsFifoOutboxPublisher(
      client,
      QUEUE_URL,
    );

    const message = createMessage();

    await publisher.publish(message);

    expect(sent).toHaveLength(1);

    const input = sent[0]!.input;

    expect(input.QueueUrl).toBe(QUEUE_URL);
    expect(input.MessageGroupId).toBe(
      message.aggregateId,
    );
    expect(input.MessageDeduplicationId).toBe(
      message.id,
    );

    const body = JSON.parse(input.MessageBody!);

    expect(body.eventId).toBe(message.id);
    expect(body.eventType).toBe(message.eventType);
    expect(body.aggregateId).toBe(message.aggregateId);
    expect(body.payload).toEqual(message.payload);
  });

  test('should reuse the same deduplication ID on retry', async () => {
    const sent: SendMessageCommand[] = [];

    const client = {
      async send(command: SendMessageCommand) {
        sent.push(command);
        return { MessageId: randomUUID() };
      },
    } as unknown as SQSClient;

    const publisher = new SqsFifoOutboxPublisher(
      client,
      QUEUE_URL,
    );

    const message = createMessage();

    await publisher.publish(message);
    await publisher.publish(message);

    expect(sent).toHaveLength(2);

    expect(
      sent[0]!.input.MessageDeduplicationId,
    ).toBe(message.id);

    expect(
      sent[1]!.input.MessageDeduplicationId,
    ).toBe(message.id);

    expect(
      sent[0]!.input.MessageBody,
    ).toBe(sent[1]!.input.MessageBody);
  });

  test('should propagate SQS failures', async () => {
    const client = {
      async send() {
        throw new Error('SQS unavailable');
      },
    } as unknown as SQSClient;

    const publisher = new SqsFifoOutboxPublisher(
      client,
      QUEUE_URL,
    );

    await expect(
      publisher.publish(createMessage()),
    ).rejects.toThrow('SQS unavailable');
  });

  test('should reject an unconfirmed publication', async () => {
    const client = {
      async send() {
        return {};
      },
    } as unknown as SQSClient;

    const publisher = new SqsFifoOutboxPublisher(
      client,
      QUEUE_URL,
    );

    await expect(
      publisher.publish(createMessage()),
    ).rejects.toThrow(
      'SQS did not confirm message publication',
    );
  });

  test('should reject a non-FIFO queue', () => {
    const client = {} as SQSClient;

    expect(
      () =>
        new SqsFifoOutboxPublisher(
          client,
          'http://localhost:4566/standard',
        ),
    ).toThrow('SQS queue must be FIFO');
  });
});
