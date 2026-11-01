import {
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
} from '@nestjs/common';

import {
  Interval,
} from '@nestjs/schedule';

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

    // Never overlap polling inside one instance.
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
    try {
      const result =
        await this.consumer.pollOnce();

      if (result.received === 0) {
        return;
      }

      this.logger.log(
        `SQS poll: received=${result.received}, ` +
        `acknowledged=${result.acknowledged}, ` +
        `duplicates=${result.duplicates}, ` +
        `retried=${result.retried}`,
      );
    } catch (error: unknown) {
      this.logger.error(
        'SQS wager polling failed',
        error instanceof Error
          ? error.stack
          : String(error),
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

    // The existing consumer decides whether an ACK is
    // safe. The worker must not acknowledge anything.
    await active;

    this.logger.log(
      'Active SQS processing finished',
    );
  }
}
