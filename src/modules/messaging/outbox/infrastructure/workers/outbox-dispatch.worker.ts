import { randomUUID } from 'node:crypto';

import {
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import {
  OutboxDispatcherService,
} from '../../application/services/outbox-dispatcher.service.js';

@Injectable()
export class OutboxDispatchWorker
  implements OnApplicationShutdown
{
  private readonly logger = new Logger(
    OutboxDispatchWorker.name,
  );

  private readonly workerId =
    process.env.OUTBOX_WORKER_ID?.trim() ||
    randomUUID();

  private runningTask: Promise<void> | null = null;
  private stopping = false;

  constructor(
    private readonly dispatcher: OutboxDispatcherService,
  ) {}

  @Interval(2_000)
  async poll(): Promise<void> {
    if (
      process.env.OUTBOX_WORKER_ENABLED !== 'true' ||
      this.stopping ||
      this.runningTask !== null
    ) {
      return;
    }

    const task = this.dispatchBatch();

    this.runningTask = task;

    try {
      await task;
    } finally {
      if (this.runningTask === task) {
        this.runningTask = null;
      }
    }
  }

  private async dispatchBatch(): Promise<void> {
    const startedAt = performance.now();

    try {
      const result = await this.dispatcher.dispatchOnce({
        workerId: this.workerId,
        batchSize: 10,
        leaseSeconds: 60,
      });

      if (
        result.claimed > 0 ||
        result.failed > 0 ||
        result.lostLease > 0
      ) {
        this.logger.log(
          JSON.stringify({
            event: 'outbox.dispatch.completed',
            claimed: result.claimed,
            published: result.published,
            failed: result.failed,
            lostLease: result.lostLease,
            durationMs: Math.round(
              performance.now() - startedAt,
            ),
          }),
        );
      }
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'outbox.dispatch.failed',
          errorType:
            error instanceof Error
              ? error.name
              : 'UnknownError',
          durationMs: Math.round(
            performance.now() - startedAt,
          ),
        }),
      );
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;

    if (this.runningTask !== null) {
      await this.runningTask;
    }
  }
}
