import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';

import type {
  ConsumeResult,
  SqsWagerConsumer,
} from './sqs-wager.consumer.js';

import {
  SqsWagerWorker,
} from './sqs-wager.worker.js';

function result(
  overrides: Partial<ConsumeResult> = {},
): ConsumeResult {
  return {
    received: 1,
    acknowledged: 1,
    duplicates: 0,
    retried: 0,
    ...overrides,
  };
}

function createWorker(
  pollOnce: () => Promise<ConsumeResult>,
): SqsWagerWorker {
  return new SqsWagerWorker(
    {
      pollOnce,
    } as SqsWagerConsumer,
  );
}

describe('SqsWagerWorker', () => {
  const previousEnabled =
    process.env.SQS_WAGER_WORKER_ENABLED;

  beforeEach(() => {
    process.env.SQS_WAGER_WORKER_ENABLED =
      'true';
  });

  afterEach(() => {
    if (previousEnabled === undefined) {
      delete process.env
        .SQS_WAGER_WORKER_ENABLED;
    } else {
      process.env.SQS_WAGER_WORKER_ENABLED =
        previousEnabled;
    }
  });

  test(
    'does not poll when the worker is disabled',
    async () => {
      process.env.SQS_WAGER_WORKER_ENABLED =
        'false';

      let calls = 0;

      const worker = createWorker(async () => {
        calls++;

        return result();
      });

      await worker.runOnce();

      expect(calls).toBe(0);
    },
  );

  test(
    'polls the consumer when enabled',
    async () => {
      let calls = 0;

      const worker = createWorker(async () => {
        calls++;

        return result();
      });

      await worker.runOnce();

      expect(calls).toBe(1);
    },
  );

  test(
    'does not overlap concurrent polling',
    async () => {
      let calls = 0;

      let finishPoll!: (
        value: ConsumeResult,
      ) => void;

      const firstPoll = new Promise<ConsumeResult>(
        (resolve) => {
          finishPoll = resolve;
        },
      );

      const worker = createWorker(async () => {
        calls++;

        if (calls === 1) {
          return firstPoll;
        }

        return result();
      });

      // Start the first poll without finishing it.
      const firstRun = worker.runOnce();

      expect(calls).toBe(1);

      // A second scheduler tick must not overlap.
      await worker.runOnce();

      expect(calls).toBe(1);

      finishPoll(result());

      await firstRun;

      // Polling can resume after the first run.
      await worker.runOnce();

      expect(calls).toBe(2);
    },
  );

  test(
    'continues polling after an infrastructure failure',
    async () => {
      let calls = 0;

      const worker = createWorker(async () => {
        calls++;

        if (calls === 1) {
          throw new Error(
            'Simulated SQS outage',
          );
        }

        return result();
      });

      // Error is logged, but does not terminate
      // the scheduled worker.
      await worker.runOnce();

      expect(calls).toBe(1);

      await worker.runOnce();

      expect(calls).toBe(2);
    },
  );

  test(
    'handles an empty SQS response',
    async () => {
      let calls = 0;

      const worker = createWorker(async () => {
        calls++;

        return result({
          received: 0,
          acknowledged: 0,
        });
      });

      await worker.runOnce();

      expect(calls).toBe(1);
    },
  );
});
