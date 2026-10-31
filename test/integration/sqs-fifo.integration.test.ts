
import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';

import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

import type { OutboxDelivery } from '../../src/modules/messaging/outbox/application/ports/outbox-dispatcher.ports.js';
import { SqsFifoOutboxPublisher } from '../../src/modules/messaging/outbox/infrastructure/sqs/sqs-fifo-outbox.publisher.js';

let client: SQSClient;
let queueUrl: string;

function createMessage(
  aggregateId: string,
  sequence: number,
): OutboxDelivery {
  return {
    id: randomUUID(),
    aggregateId,
    eventType: 'wager.bet.processed.v1',
    payload: {
      transactionId: randomUUID(),
      sequence,
    },
    attempts: 1,
    claimToken: randomUUID(),
    claimedUntil: new Date(Date.now() + 120_000),
    occurredAt: new Date(),
  };
}

async function receiveOne() {
  const response = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 2,
      VisibilityTimeout: 10,
      MessageSystemAttributeNames: [
        'MessageGroupId',
        'MessageDeduplicationId',
      ],
    }),
  );

  return response.Messages?.[0];
}

async function deleteMessage(
  receiptHandle: string,
): Promise<void> {
  await client.send(
    new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: receiptHandle,
    }),
  );
}

beforeAll(async () => {
  client = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint:
      process.env.SQS_ENDPOINT ??
      'http://localhost:4566',
    credentials: {
      accessKeyId: 'test',
      secretAccessKey: 'test',
    },
  });

  const result = await client.send(
    new CreateQueueCommand({
      QueueName:
        `wager-test-${randomUUID()}.fifo`,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
      },
    }),
  );

  if (!result.QueueUrl) {
    throw new Error('Test queue was not created');
  }

  queueUrl = result.QueueUrl;
});

afterAll(async () => {
  try {
    if (queueUrl) {
      await client.send(
        new DeleteQueueCommand({
          QueueUrl: queueUrl,
        }),
      );
    }
  } finally {
    client?.destroy();
  }
});

describe('SQS FIFO integration', () => {
  test(
    'should preserve wallet order and deduplicate repeated sends',
    async () => {
      const walletId = randomUUID();

      const publisher = new SqsFifoOutboxPublisher(
        client,
        queueUrl,
      );

      const first = createMessage(walletId, 1);
      const second = createMessage(walletId, 2);

      await publisher.publish(first);

      // Simulate a retry after the SQS accepted
      // the original message.
      await publisher.publish(first);

      await publisher.publish(second);

      const receivedFirst = await receiveOne();

      expect(receivedFirst).toBeDefined();

      const firstBody = JSON.parse(
        receivedFirst!.Body!,
      );

      expect(firstBody.eventId).toBe(first.id);
      expect(firstBody.payload.sequence).toBe(1);

      expect(
        receivedFirst!.Attributes?.MessageGroupId,
      ).toBe(walletId);

      expect(
        receivedFirst!.Attributes
          ?.MessageDeduplicationId,
      ).toBe(first.id);

      await deleteMessage(
        receivedFirst!.ReceiptHandle!,
      );

      const receivedSecond = await receiveOne();

      expect(receivedSecond).toBeDefined();

      const secondBody = JSON.parse(
        receivedSecond!.Body!,
      );

      expect(secondBody.eventId).toBe(second.id);
      expect(secondBody.payload.sequence).toBe(2);

      await deleteMessage(
        receivedSecond!.ReceiptHandle!,
      );

      const remaining = await receiveOne();

      expect(remaining).toBeUndefined();
    },
    30000,
  );
});
