import {
  Injectable,
  Logger,
  Optional,
  type BeforeApplicationShutdown,
} from '@nestjs/common';

import { Interval } from '@nestjs/schedule';

import {
  FinancialMetricsService,
} from '../../../../observability/financial-metrics.service.js';

import {
  SqsWagerConsumer,
} from './sqs-wager.consumer.js';

@Injectable()
export class SqsWagerWorker
  implements BeforeApplicationShutdown {

  private readonly logger = new Logger(
    SqsWagerWorker.name,
  );

  private shuttingDown = false;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly consumer: SqsWagerConsumer,

    @Optional()
    private readonly metrics?: FinancialMetricsService,
  ) {}

  @Interval(1_000)
  async runOnce(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    if (
      process.env.SQS_WAGER_WORKER_ENABLED !==
      'true'
    ) {
      return;
    }

    if (this.inFlight !== null) {
      return;
    }

    const task = this.poll();
    this.inFlight = task;

    try {
      await task;
    } finally {
      if (this.inFlight === task) {
        this.inFlight = null;
      }
    }
  }

  private async poll(): Promise<void> {
    const startedAt = Date.now();

    try {
      const result =
        await this.consumer.pollOnce();

      const durationMs =
        Date.now() - startedAt;

      try {
        this.metrics?.recordSqsPoll(
          result,
          durationMs,
        );
      } catch (metricsError: unknown) {
        this.logger.warn(
          'Unable to record SQS metrics',
        );
      }

      if (result.received === 0) {
        return;
      }

      this.logger.log(
        JSON.stringify({
          event: 'sqs.poll.completed',
          durationMs,
          received: result.received,
          acknowledged: result.acknowledged,
          duplicates: result.duplicates,
          retried: result.retried,
        }),
      );
    } catch (error: unknown) {
      const durationMs =
        Date.now() - startedAt;

      try {
        this.metrics?.recordSqsFailure(
          durationMs,
        );
      } catch (metricsError: unknown) {
        this.logger.warn(
          'Unable to record SQS failure metrics',
        );
      }

      this.logger.error(
        JSON.stringify({
          event: 'sqs.poll.failed',
          durationMs,
          errorType:
            error instanceof Error
              ? error.name
              : 'UnknownError',
        }),
      );
    }
  }

  async beforeApplicationShutdown(
    signal?: string,
  ): Promise<void> {
    this.shuttingDown = true;

    const active = this.inFlight;

    if (active === null) {
      this.logger.log(
        `Shutdown (${signal ?? 'manual'}): ` +
        'no active SQS polling',
      );
      return;
    }

    this.logger.log(
      `Shutdown (${signal ?? 'manual'}): ` +
      'waiting for active SQS processing',
    );

    await active;

    this.logger.log(
      'Active SQS processing finished',
    );
  }
}
