import {
  describe,
  expect,
  test,
} from 'bun:test';

import {
  FinancialMetricsService,
} from './financial-metrics.service.js';

describe('FinancialMetricsService', () => {
  test('starts with zero counters', () => {
    const metrics = new FinancialMetricsService();
    const snapshot = metrics.getSnapshot();

    expect(snapshot.sqs.polls).toBe(0);
    expect(snapshot.sqs.received).toBe(0);
    expect(snapshot.pending.runs).toBe(0);
    expect(snapshot.pending.processed).toBe(0);
  });

  test('aggregates SQS polling results', () => {
    const metrics = new FinancialMetricsService();

    metrics.recordSqsPoll({
      received: 5,
      acknowledged: 3,
      duplicates: 1,
      retried: 1,
    }, 250);

    metrics.recordSqsPoll({
      received: 2,
      acknowledged: 2,
      duplicates: 0,
      retried: 0,
    }, 150);

    const { sqs } = metrics.getSnapshot();

    expect(sqs.polls).toBe(2);
    expect(sqs.received).toBe(7);
    expect(sqs.acknowledged).toBe(5);
    expect(sqs.duplicates).toBe(1);
    expect(sqs.retried).toBe(1);
    expect(sqs.durationSecondsSum).toBeCloseTo(0.4);
    expect(sqs.lastSuccessTimestamp).toBeGreaterThan(0);
  });

  test('tracks SQS infrastructure failures', () => {
    const metrics = new FinancialMetricsService();

    metrics.recordSqsFailure(100);

    const { sqs } = metrics.getSnapshot();

    expect(sqs.polls).toBe(1);
    expect(sqs.pollFailures).toBe(1);
    expect(sqs.durationSecondsSum).toBeCloseTo(0.1);
    expect(sqs.lastFailureTimestamp).toBeGreaterThan(0);
  });

  test('aggregates pending reference recovery', () => {
    const metrics = new FinancialMetricsService();

    metrics.recordPendingRecovery({
      claimed: 5,
      processed: 2,
      retryScheduled: 1,
      rejected: 1,
      staleClaims: 1,
      failed: 0,
    }, 500);

    const { pending } = metrics.getSnapshot();

    expect(pending.runs).toBe(1);
    expect(pending.claimed).toBe(5);
    expect(pending.processed).toBe(2);
    expect(pending.retryScheduled).toBe(1);
    expect(pending.rejected).toBe(1);
    expect(pending.staleClaims).toBe(1);
    expect(pending.durationSecondsSum).toBeCloseTo(0.5);
  });

  test('tracks pending worker failures', () => {
    const metrics = new FinancialMetricsService();

    metrics.recordPendingFailure(200);

    const { pending } = metrics.getSnapshot();

    expect(pending.runs).toBe(1);
    expect(pending.runFailures).toBe(1);
    expect(pending.durationSecondsSum).toBeCloseTo(0.2);
  });

  test('exports Prometheus-compatible metrics', () => {
    const metrics = new FinancialMetricsService();

    metrics.recordSqsPoll({
      received: 3,
      acknowledged: 2,
      duplicates: 1,
      retried: 0,
    }, 100);

    const output = metrics.renderPrometheus();

    expect(output).toContain(
      '# TYPE financial_sqs_received_total counter',
    );

    expect(output).toContain(
      'financial_sqs_received_total 3',
    );

    expect(output).toContain(
      'financial_sqs_duplicates_total 1',
    );

    expect(output).toContain(
      'financial_pending_runs_total 0',
    );

    expect(output).toContain('# EOF');
  });

  test('does not expose wallet or player identifiers', () => {
    const metrics = new FinancialMetricsService();
    const output = metrics.renderPrometheus();

    expect(output).not.toContain('walletId');
    expect(output).not.toContain('playerId');
    expect(output).not.toContain('externalTransactionId');
  });
});
