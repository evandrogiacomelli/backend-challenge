import {
  describe,
  expect,
  test,
} from 'bun:test';

import {
  PendingReferenceWorker,
} from './pending-reference.worker.js';

import type {
  RecoverPendingReferencesUseCase,
  RecoverPendingReferencesResult,
} from '../../application/use-cases/recover-pending-references.use-case.js';

function result(
  overrides: Partial<
    RecoverPendingReferencesResult
  > = {},
): RecoverPendingReferencesResult {
  return {
    claimed: 0,
    processed: 0,
    retryScheduled: 0,
    rejected: 0,
    staleClaims: 0,
    failed: 0,
    failures: [],
    ...overrides,
  };
}

function workerWith(
  execute: RecoverPendingReferencesUseCase['execute'],
): PendingReferenceWorker {
  const useCase = {
    execute,
  } as RecoverPendingReferencesUseCase;

  return new PendingReferenceWorker(useCase);
}

describe('PendingReferenceWorker', () => {
  test('runs the recovery coordinator', async () => {
    let calls = 0;

    const worker = workerWith(async (input) => {
      calls++;

      expect(input.limit).toBe(5);
      expect(input.leaseSeconds).toBe(300);

      return result({
        claimed: 1,
        processed: 1,
      });
    });

    const outcome = await worker.runOnce();

    expect(calls).toBe(1);
    expect(outcome?.processed).toBe(1);
    expect(outcome?.claimed).toBe(1);
  });

  test(
    'does not overlap executions in the same instance',
    async () => {
      let calls = 0;
      let release!: () => void;

      const blocked = new Promise<void>(
        (resolve) => {
          release = resolve;
        },
      );

      const worker = workerWith(async () => {
        calls++;
        await blocked;

        return result({
          claimed: 1,
          processed: 1,
        });
      });

      // The first execution remains in progress.
      const first = worker.runOnce();

      // The second must not invoke the coordinator.
      const second = await worker.runOnce();

      expect(second).toBeNull();
      expect(calls).toBe(1);

      release();

      const completed = await first;

      expect(completed?.processed).toBe(1);

      // A subsequent execution must be allowed.
      const third = await worker.runOnce();

      expect(third?.processed).toBe(1);
      expect(calls).toBe(2);
    },
  );

  test('releases the running flag after failure', async () => {
    let calls = 0;

    const worker = workerWith(async () => {
      calls++;

      if (calls === 1) {
        throw new Error('PostgreSQL unavailable');
      }

      return result({
        claimed: 1,
        processed: 1,
      });
    });

    const first = await worker.runOnce();

    expect(first).toBeNull();

    const second = await worker.runOnce();

    expect(second?.processed).toBe(1);
    expect(calls).toBe(2);
  });

  test('preserves the coordinator failure result', async () => {
    const worker = workerWith(async () =>
      result({
        claimed: 2,
        processed: 1,
        failed: 1,
        failures: [
          {
            transactionId: 'pending-1',
            message: 'Transient failure',
          },
        ],
      }),
    );

    const outcome = await worker.runOnce();

    expect(outcome?.processed).toBe(1);
    expect(outcome?.failed).toBe(1);
    expect(outcome?.failures).toHaveLength(1);
  });
});
