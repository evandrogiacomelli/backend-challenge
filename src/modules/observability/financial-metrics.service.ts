import { Injectable } from '@nestjs/common';

export interface SqsPollResult {
  received: number;
  acknowledged: number;
  duplicates: number;
  retried: number;
}

export interface PendingRecoveryResult {
  claimed: number;
  processed: number;
  retryScheduled: number;
  rejected: number;
  staleClaims: number;
  failed: number;
}

export interface FinancialMetricsSnapshot {
  uptimeSeconds: number;
  sqs: {
    polls: number;
    pollFailures: number;
    received: number;
    acknowledged: number;
    duplicates: number;
    retried: number;
    durationSecondsSum: number;
    lastSuccessTimestamp: number;
    lastFailureTimestamp: number;
  };
  pending: {
    runs: number;
    runFailures: number;
    claimed: number;
    processed: number;
    retryScheduled: number;
    rejected: number;
    staleClaims: number;
    failed: number;
    durationSecondsSum: number;
    lastSuccessTimestamp: number;
    lastFailureTimestamp: number;
  };
}

@Injectable()
export class FinancialMetricsService {
  private readonly startedAt = Date.now();

  private readonly sqs = {
    polls: 0,
    pollFailures: 0,
    received: 0,
    acknowledged: 0,
    duplicates: 0,
    retried: 0,
    durationSecondsSum: 0,
    lastSuccessTimestamp: 0,
    lastFailureTimestamp: 0,
  };

  private readonly pending = {
    runs: 0,
    runFailures: 0,
    claimed: 0,
    processed: 0,
    retryScheduled: 0,
    rejected: 0,
    staleClaims: 0,
    failed: 0,
    durationSecondsSum: 0,
    lastSuccessTimestamp: 0,
    lastFailureTimestamp: 0,
  };

  recordSqsPoll(
    result: SqsPollResult,
    durationMs: number,
  ): void {
    this.sqs.polls++;
    this.sqs.received += result.received;
    this.sqs.acknowledged += result.acknowledged;
    this.sqs.duplicates += result.duplicates;
    this.sqs.retried += result.retried;
    this.sqs.durationSecondsSum +=
      Math.max(0, durationMs) / 1000;
    this.sqs.lastSuccessTimestamp =
      Date.now() / 1000;
  }

  recordSqsFailure(
    durationMs: number,
  ): void {
    this.sqs.polls++;
    this.sqs.pollFailures++;
    this.sqs.durationSecondsSum +=
      Math.max(0, durationMs) / 1000;
    this.sqs.lastFailureTimestamp =
      Date.now() / 1000;
  }

  recordPendingRecovery(
    result: PendingRecoveryResult,
    durationMs: number,
  ): void {
    this.pending.runs++;
    this.pending.claimed += result.claimed;
    this.pending.processed += result.processed;
    this.pending.retryScheduled +=
      result.retryScheduled;
    this.pending.rejected += result.rejected;
    this.pending.staleClaims +=
      result.staleClaims;
    this.pending.failed += result.failed;
    this.pending.durationSecondsSum +=
      Math.max(0, durationMs) / 1000;
    this.pending.lastSuccessTimestamp =
      Date.now() / 1000;
  }

  recordPendingFailure(
    durationMs: number,
  ): void {
    this.pending.runs++;
    this.pending.runFailures++;
    this.pending.durationSecondsSum +=
      Math.max(0, durationMs) / 1000;
    this.pending.lastFailureTimestamp =
      Date.now() / 1000;
  }

  getSnapshot(): FinancialMetricsSnapshot {
    return {
      uptimeSeconds:
        (Date.now() - this.startedAt) / 1000,
      sqs: { ...this.sqs },
      pending: { ...this.pending },
    };
  }

  renderPrometheus(): string {
    const snapshot = this.getSnapshot();

    const lines: string[] = [];

    const metric = (
      name: string,
      help: string,
      type: 'counter' | 'gauge',
      value: number,
    ): void => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
      lines.push(`${name} ${value}`);
    };

    metric(
      'financial_process_uptime_seconds',
      'Time since process startup',
      'gauge',
      snapshot.uptimeSeconds,
    );

    const sqsMetrics = [
      ['polls_total', snapshot.sqs.polls],
      ['poll_failures_total', snapshot.sqs.pollFailures],
      ['received_total', snapshot.sqs.received],
      ['acknowledged_total', snapshot.sqs.acknowledged],
      ['duplicates_total', snapshot.sqs.duplicates],
      ['retried_total', snapshot.sqs.retried],
      [
        'poll_duration_seconds_sum',
        snapshot.sqs.durationSecondsSum,
      ],
    ] as const;

    for (const [name, value] of sqsMetrics) {
      metric(
        `financial_sqs_${name}`,
        `SQS worker metric: ${name}`,
        'counter',
        value,
      );
    }

    metric(
      'financial_sqs_last_success_timestamp_seconds',
      'Last successful SQS poll',
      'gauge',
      snapshot.sqs.lastSuccessTimestamp,
    );

    metric(
      'financial_sqs_last_failure_timestamp_seconds',
      'Last failed SQS poll',
      'gauge',
      snapshot.sqs.lastFailureTimestamp,
    );

    const pendingMetrics = [
      ['runs_total', snapshot.pending.runs],
      ['run_failures_total', snapshot.pending.runFailures],
      ['claimed_total', snapshot.pending.claimed],
      ['processed_total', snapshot.pending.processed],
      [
        'retry_scheduled_total',
        snapshot.pending.retryScheduled,
      ],
      ['rejected_total', snapshot.pending.rejected],
      ['stale_claims_total', snapshot.pending.staleClaims],
      ['failed_total', snapshot.pending.failed],
      [
        'duration_seconds_sum',
        snapshot.pending.durationSecondsSum,
      ],
    ] as const;

    for (const [name, value] of pendingMetrics) {
      metric(
        `financial_pending_${name}`,
        `Pending reference worker metric: ${name}`,
        'counter',
        value,
      );
    }

    metric(
      'financial_pending_last_success_timestamp_seconds',
      'Last successful pending recovery run',
      'gauge',
      snapshot.pending.lastSuccessTimestamp,
    );

    metric(
      'financial_pending_last_failure_timestamp_seconds',
      'Last failed pending recovery run',
      'gauge',
      snapshot.pending.lastFailureTimestamp,
    );

    lines.push('# EOF');

    return lines.join('\n') + '\n';
  }
}
