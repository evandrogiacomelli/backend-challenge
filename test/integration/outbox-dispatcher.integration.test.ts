import { randomUUID } from 'node:crypto';

import { OutboxMessageEntity } from '../../src/modules/messaging/outbox/infrastructure/persistence/outbox-message.entity.js';
import { PostgresOutboxDispatchStore } from '../../src/modules/messaging/outbox/infrastructure/persistence/postgres-outbox-dispatch.store.js';
import mikroOrmConfig from '../../src/config/mikro-orm.config.js';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';


let orm: MikroORM;


let eventSequence = 0;

function createStore(): PostgresOutboxDispatchStore {
  return new PostgresOutboxDispatchStore(
    orm.em.fork(),
  );
}

async function createEvent(
  aggregateId = randomUUID(),
): Promise<string> {
  const now = new Date();

  const occurredAt = new Date(
    Date.UTC(2026, 0, 1) + eventSequence++ * 1000,
  );

  const entity = new OutboxMessageEntity();

  entity.id = randomUUID();
  entity.aggregateId = aggregateId;
  entity.eventType = 'wager.bet.processed.v1';

  entity.payload = {
    eventId: entity.id,
    schemaVersion: 1,
    walletId: aggregateId,
    transactionId: randomUUID(),
  };

  entity.status = 'PENDING';
  entity.attempts = 0;
  entity.nextAttemptAt = now;
  entity.occurredAt = occurredAt;
  entity.createdAt = occurredAt;

  const em = orm.em.fork();

  em.persist(entity);
  await em.flush();

  return entity.id;
}

function claimOptions(workerId = randomUUID()) {
  return {
    workerId,
    limit: 10,
    leaseSeconds: 60,
  };
}

beforeAll(async () => {
  // Create the isolated test schema using the existing DB.
  const setupOrm = await MikroORM.init(mikroOrmConfig);

  try {
    await setupOrm.em.fork().execute(`
      CREATE SCHEMA IF NOT EXISTS outbox_test;
    `);

    await setupOrm.em.fork().execute(`
        CREATE TABLE IF NOT EXISTS outbox_test.outbox_messages
        (
            LIKE public.outbox_messages INCLUDING ALL
        );
    `);
  } finally {
    await setupOrm.close(true);
  }

  // All connections from this ORM use the test schema.
  orm = await MikroORM.init({
    ...mikroOrmConfig,
    schema: 'outbox_test',
    driverOptions: {
      ...mikroOrmConfig.driverOptions,
      options: '-c search_path=outbox_test',
    },
  });
});

beforeEach(async () => {
  eventSequence = 0;

  await orm.em.fork().execute(`
    TRUNCATE TABLE outbox_test.outbox_messages;
  `);
});

afterAll(async () => {
  await orm?.close(true);
});

describe('PostgreSQL Outbox Dispatcher', () => {
  test('should claim only the first event of each wallet', async () => {
    const store = createStore();
    const walletId = randomUUID();

    const firstId = await createEvent(walletId);
    const secondId = await createEvent(walletId);

    const workerId = randomUUID();

    const firstBatch = await store.claim(
      claimOptions(workerId),
    );

    expect(firstBatch).toHaveLength(1);
    expect(firstBatch[0]!.id).toBe(firstId);

    const anotherWorker = createStore();

    const blockedBatch = await anotherWorker.claim(
      claimOptions(),
    );

    expect(blockedBatch).toHaveLength(0);

    expect(
      await store.markPublished(
        firstBatch[0]!,
        workerId,
      ),
    ).toBe(true);

    const nextWorkerId = randomUUID();

    const secondBatch = await anotherWorker.claim(
      claimOptions(nextWorkerId),
    );

    expect(secondBatch).toHaveLength(1);
    expect(secondBatch[0]!.id).toBe(secondId);

    await anotherWorker.markPublished(
      secondBatch[0]!,
      nextWorkerId,
    );
  });

  test('should distribute 12 events across three workers', async () => {
    const eventIds = await Promise.all(
      Array.from({ length: 12 }, () =>
        createEvent(),
      ),
    );

    const workers = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];

    const stores = [
      createStore(),
      createStore(),
      createStore(),
    ];

    const batches = await Promise.all(
      stores.map((store, index) =>
        store.claim({
          workerId: workers[index]!,
          limit: 5,
          leaseSeconds: 60,
        }),
      ),
    );

    const messages = batches.flat();

    expect(messages).toHaveLength(12);

    const claimedIds = messages.map(
      (message) => message.id,
    );

    expect(new Set(claimedIds).size).toBe(12);

    expect(
      [...claimedIds].sort(),
    ).toEqual([...eventIds].sort());

    for (let index = 0; index < batches.length; index++) {
      const store = stores[index]!;
      const workerId = workers[index]!;

      for (const message of batches[index]!) {
        expect(
          await store.markPublished(
            message,
            workerId,
          ),
        ).toBe(true);
      }
    }
  });

  test('should reclaim expired leases and reject stale acknowledgements', async () => {
    const eventId = await createEvent();

    const firstStore = createStore();
    const secondStore = createStore();

    const firstWorker = randomUUID();
    const secondWorker = randomUUID();

    const [original] = await firstStore.claim(
      claimOptions(firstWorker),
    );

    expect(original!.id).toBe(eventId);

    // Simulate lease expiration without waiting.
    await orm.em.fork().execute(
      `
          UPDATE outbox_messages
          SET claimed_until = NOW() - INTERVAL '1 second'
          WHERE id = ?
      `,
      [eventId],
    );

    const [reclaimed] = await secondStore.claim(
      claimOptions(secondWorker),
    );

    expect(reclaimed!.id).toBe(eventId);
    expect(reclaimed!.claimToken).not.toBe(
      original!.claimToken,
    );

    expect(
      await firstStore.markPublished(
        original!,
        firstWorker,
      ),
    ).toBe(false);

    expect(
      await secondStore.markPublished(
        reclaimed!,
        secondWorker,
      ),
    ).toBe(true);

    const persisted = await orm.em.fork()
      .findOneOrFail(
        OutboxMessageEntity,
        eventId,
      );

    expect(persisted.status).toBe('PUBLISHED');
    expect(persisted.attempts).toBe(2);
  });

  test('should reschedule failed deliveries with backoff', async () => {
    const eventId = await createEvent();

    const store = createStore();
    const worker = randomUUID();

    const [message] = await store.claim(
      claimOptions(worker),
    );

    expect(message!.id).toBe(eventId);
    expect(message!.attempts).toBe(1);

    expect(
      await store.releaseForRetry(
        message!,
        worker,
      ),
    ).toBe(true);

    const pending = await orm.em.fork()
      .findOneOrFail(
        OutboxMessageEntity,
        eventId,
      );

    expect(pending.status).toBe('PENDING');
    expect(pending.attempts).toBe(1);

    expect(
      pending.nextAttemptAt.getTime(),
    ).toBeGreaterThan(Date.now());

    expect(
      await store.claim(claimOptions()),
    ).toHaveLength(0);

    // Simulate passing the retry deadline.
    await orm.em.fork().execute(
      `
          UPDATE outbox_messages
          SET next_attempt_at = NOW() - INTERVAL '1 second'
          WHERE id = ?
      `,
      [eventId],
    );

    const nextWorker = randomUUID();

    const [retried] = await store.claim(
      claimOptions(nextWorker),
    );

    expect(retried!.id).toBe(eventId);
    expect(retried!.attempts).toBe(2);

    expect(
      await store.markPublished(
        retried!,
        nextWorker,
      ),
    ).toBe(true);
  });
});
