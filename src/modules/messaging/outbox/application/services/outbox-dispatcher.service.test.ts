
import { describe, expect, test } from 'bun:test';

import type {
  OutboxDelivery,
  OutboxDispatchStore,
  OutboxPublisher,
} from '../ports/outbox-dispatcher.ports.js';
import { OutboxDispatcherService } from './outbox-dispatcher.service.js';

function createMessage(
  overrides: Partial<OutboxDelivery> = {},
): OutboxDelivery {
  return {
    id: crypto.randomUUID(),
    aggregateId: crypto.randomUUID(),
    eventType: 'wager.bet.processed.v1',
    payload: { transactionId: crypto.randomUUID() },
    attempts: 1,
    claimToken: crypto.randomUUID(),
    claimedUntil: new Date(Date.now() + 60_000),
    occurredAt: new Date(),
    ...overrides,
  };
}

function createFixture(
  messages: OutboxDelivery[] = [createMessage()],
) {
  const published: string[] = [];
  const acknowledged: string[] = [];
  const retried: string[] = [];

  const store: OutboxDispatchStore = {
    async claim() {
      return messages;
    },

    async markPublished(message) {
      acknowledged.push(message.id);
      return true;
    },

    async releaseForRetry(message) {
      retried.push(message.id);
      return true;
    },
  };

  const publisher: OutboxPublisher = {
    async publish(message) {
      published.push(message.id);
    },
  };

  return {
    messages,
    published,
    acknowledged,
    retried,
    store,
    publisher,
  };
}

describe('OutboxDispatcherService', () => {
  test('should publish and acknowledge a message', async () => {
    const fixture = createFixture();

    const dispatcher = new OutboxDispatcherService(
      fixture.store,
      fixture.publisher,
    );

    const result = await dispatcher.dispatchOnce();

    expect(result).toEqual({
      claimed: 1,
      published: 1,
      failed: 0,
      lostLease: 0,
    });

    expect(fixture.published).toEqual([
      fixture.messages[0]!.id,
    ]);

    expect(fixture.acknowledged).toEqual([
      fixture.messages[0]!.id,
    ]);

    expect(fixture.retried).toHaveLength(0);
  });

  test('should release message when publication fails', async () => {
    const fixture = createFixture();

    const publisher: OutboxPublisher = {
      async publish() {
        throw new Error('SQS unavailable');
      },
    };

    const dispatcher = new OutboxDispatcherService(
      fixture.store,
      publisher,
    );

    const result = await dispatcher.dispatchOnce();

    expect(result.failed).toBe(1);
    expect(result.published).toBe(0);
    expect(fixture.acknowledged).toHaveLength(0);
    expect(fixture.retried).toEqual([
      fixture.messages[0]!.id,
    ]);
  });

  test('should not acknowledge when publisher fails', async () => {
    const fixture = createFixture([
      createMessage(),
      createMessage(),
    ]);

    let attempts = 0;

    const publisher: OutboxPublisher = {
      async publish() {
        attempts++;

        if (attempts === 1) {
          throw new Error('Temporary failure');
        }
      },
    };

    const dispatcher = new OutboxDispatcherService(
      fixture.store,
      publisher,
    );

    const result = await dispatcher.dispatchOnce();

    expect(result.claimed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.published).toBe(1);

    expect(fixture.retried).toHaveLength(1);
    expect(fixture.acknowledged).toHaveLength(1);
  });

  test('should detect a stale lease on acknowledgement', async () => {
    const fixture = createFixture();

    fixture.store.markPublished = async () => false;

    const dispatcher = new OutboxDispatcherService(
      fixture.store,
      fixture.publisher,
    );

    const result = await dispatcher.dispatchOnce();

    expect(result.published).toBe(0);
    expect(result.lostLease).toBe(1);
  });

  test('should handle an empty claim', async () => {
    const fixture = createFixture([]);

    const dispatcher = new OutboxDispatcherService(
      fixture.store,
      fixture.publisher,
    );

    const result = await dispatcher.dispatchOnce();

    expect(result).toEqual({
      claimed: 0,
      published: 0,
      failed: 0,
      lostLease: 0,
    });
  });
});
