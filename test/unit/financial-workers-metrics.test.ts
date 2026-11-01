import {
  afterEach,
  describe,
  expect,
  test,
} from 'bun:test';

import {
  FinancialMetricsService,
} from '../../src/modules/observability/financial-metrics.service.js';

import {
  SqsWagerWorker,
} from '../../src/modules/messaging/inbox/infrastructure/sqs/sqs-wager.worker.js';

import type {
  SqsWagerConsumer,
} from '../../src/modules/messaging/inbox/infrastructure/sqs/sqs-wager.consumer.js';

import {
  PendingReferenceWorker,
} from '../../src/modules/wagering/infrastructure/workers/pending-reference.worker.js';

import type {
  RecoverPendingReferencesUseCase,
} from '../../src/modules/wagering/application/use-cases/recover-pending-references.use-case.js';

describe('Financial workers metrics', () => {
  const originalFlag =
    process.env.SQS_WAGER_WORKER_ENABLED;

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.SQS_WAGER_WORKER_ENABLED;
    } else {
      process.env.SQS_WAGER_WORKER_ENABLED =
        originalFlag;
    }
  });

  test('records successful SQS processing', async () => {
    process.env.SQS_WAGER_WORKER_ENABLED = 'true';

    const metrics = new FinancialMetricsService();

    const consumer = {
      async pollOnce() {
        return {
          received: 3,
          acknowledged: 2,
          duplicates: 1,
          retried: 0,
        };
      },
    } as unknown as SqsWagerConsumer;

    const worker = new SqsWagerWorker(
      consumer,
      metrics,
    );

    await worker.runOnce();

    const snapshot = metrics.getSnapshot();

    expect(snapshot.sqs.polls).toBe(1);
    expect(snapshot.sqs.received).toBe(3);
    expect(snapshot.sqs.acknowledged).toBe(2);
    expect(snapshot.sqs.duplicates).toBe(1);
    expect(snapshot.sqs.pollFailures).toBe(0);
  });

  test('records SQS infrastructure failure', async () => {
    process.env.SQS_WAGER_WORKER_ENABLED = 'true';

    const metrics = new FinancialMetricsService();

    const consumer = {
      async pollOnce(): Promise<never> {
        throw new Error('Simulated failure');
      },
    } as unknown as SqsWagerConsumer;

    const worker = new SqsWagerWorker(
      consumer,
      metrics,
    );

    await worker.runOnce();

    const snapshot = metrics.getSnapshot();

    expect(snapshot.sqs.polls).toBe(1);
    expect(snapshot.sqs.pollFailures).toBe(1);
    expect(snapshot.sqs.acknowledged).toBe(0);
  });

  test('records pending reference recovery', async () => {
    const metrics = new FinancialMetricsService();

    const useCase = {
      async execute() {
        return {
          claimed: 5,
          processed: 2,
          retryScheduled: 2,
          rejected: 1,
          staleClaims: 0,
          failed: 0,
          failures: [],
        };
      },
    } as unknown as RecoverPendingReferencesUseCase;

    const worker = new PendingReferenceWorker(
      useCase,
      metrics,
    );

    await worker.runOnce();

    const snapshot = metrics.getSnapshot();

    expect(snapshot.pending.runs).toBe(1);
    expect(snapshot.pending.claimed).toBe(5);
    expect(snapshot.pending.processed).toBe(2);
    expect(snapshot.pending.retryScheduled).toBe(2);
    expect(snapshot.pending.rejected).toBe(1);
  });

  test('records pending reference infrastructure failure', async () => {
    const metrics = new FinancialMetricsService();

    const useCase = {
      async execute(): Promise<never> {
        throw new Error('Database unavailable');
      },
    } as unknown as RecoverPendingReferencesUseCase;

    const worker = new PendingReferenceWorker(
      useCase,
      metrics,
    );

    const result = await worker.runOnce();

    expect(result).toBeNull();

    const snapshot = metrics.getSnapshot();

    expect(snapshot.pending.runs).toBe(1);
    expect(snapshot.pending.runFailures).toBe(1);
    expect(snapshot.pending.processed).toBe(0);
  });
});
