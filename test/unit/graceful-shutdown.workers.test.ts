import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';

import { SqsWagerWorker } from '../../src/modules/messaging/inbox/infrastructure/sqs/sqs-wager.worker.js';
import { SqsWagerConsumer } from '../../src/modules/messaging/inbox/infrastructure/sqs/sqs-wager.consumer.js';

import { PendingReferenceWorker } from '../../src/modules/wagering/infrastructure/workers/pending-reference.worker.js';
import { RecoverPendingReferencesUseCase } from '../../src/modules/wagering/application/use-cases/recover-pending-references.use-case.js';

function deferred() {
  let resolve!: () => void;

  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

describe('Graceful shutdown of financial workers', () => {
  const previousFlag =
    process.env.SQS_WAGER_WORKER_ENABLED;

  beforeEach(() => {
    process.env.SQS_WAGER_WORKER_ENABLED = 'true';
  });

  afterEach(() => {
    if (previousFlag === undefined) {
      delete process.env.SQS_WAGER_WORKER_ENABLED;
    } else {
      process.env.SQS_WAGER_WORKER_ENABLED =
        previousFlag;
    }
  });

  test(
    'SQS waits for active processing during shutdown',
    async () => {
      const gate = deferred();

      let calls = 0;
      let shutdownFinished = false;

      const consumer = {
        async pollOnce() {
          calls++;

          await gate.promise;

          return {
            received: 1,
            acknowledged: 1,
            duplicates: 0,
            retried: 0,
          };
        },
      } as unknown as SqsWagerConsumer;

      const worker = new SqsWagerWorker(
        consumer,
      );

      const processing = worker.runOnce();

      expect(calls).toBe(1);

      const shutdown = worker
        .beforeApplicationShutdown('SIGTERM')
        .then(() => {
          shutdownFinished = true;
        });

      await Promise.resolve();

      expect(shutdownFinished).toBe(false);

      // A second polling cycle cannot start.
      await worker.runOnce();

      expect(calls).toBe(1);

      gate.resolve();

      await Promise.all([
        processing,
        shutdown,
      ]);

      expect(shutdownFinished).toBe(true);
      expect(calls).toBe(1);
    },
  );

  test(
    'SQS does not poll after shutdown starts',
    async () => {
      let calls = 0;

      const consumer = {
        async pollOnce() {
          calls++;

          return {
            received: 0,
            acknowledged: 0,
            duplicates: 0,
            retried: 0,
          };
        },
      } as unknown as SqsWagerConsumer;

      const worker = new SqsWagerWorker(
        consumer,
      );

      await worker.beforeApplicationShutdown(
        'SIGTERM',
      );

      await worker.runOnce();

      expect(calls).toBe(0);
    },
  );

  test(
    'PendingReference waits for active recovery',
    async () => {
      const gate = deferred();

      let calls = 0;
      let shutdownFinished = false;

      const useCase = {
        async execute() {
          calls++;

          await gate.promise;

          return {
            claimed: 1,
            processed: 1,
            retryScheduled: 0,
            rejected: 0,
            staleClaims: 0,
            failed: 0,
            failures: [],
          };
        },
      } as unknown as RecoverPendingReferencesUseCase;

      const worker = new PendingReferenceWorker(
        useCase,
      );

      const processing = worker.runOnce();

      expect(calls).toBe(1);

      const shutdown = worker
        .beforeApplicationShutdown('SIGTERM')
        .then(() => {
          shutdownFinished = true;
        });

      await Promise.resolve();

      expect(shutdownFinished).toBe(false);

      // No new batch can be claimed.
      const second = await worker.runOnce();

      expect(second).toBeNull();
      expect(calls).toBe(1);

      gate.resolve();

      await Promise.all([
        processing,
        shutdown,
      ]);

      expect(shutdownFinished).toBe(true);
      expect(calls).toBe(1);
    },
  );

  test(
    'PendingReference does not start after shutdown',
    async () => {
      let calls = 0;

      const useCase = {
        async execute() {
          calls++;

          return {
            claimed: 0,
            processed: 0,
            retryScheduled: 0,
            rejected: 0,
            staleClaims: 0,
            failed: 0,
            failures: [],
          };
        },
      } as unknown as RecoverPendingReferencesUseCase;

      const worker = new PendingReferenceWorker(
        useCase,
      );

      await worker.beforeApplicationShutdown(
        'SIGINT',
      );

      const result = await worker.runOnce();

      expect(result).toBeNull();
      expect(calls).toBe(0);
    },
  );
});
