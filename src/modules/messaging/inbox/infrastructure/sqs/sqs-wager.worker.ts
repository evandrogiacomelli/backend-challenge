import {
  Injectable,
  Logger,
} from '@nestjs/common';

import {
  Interval,
} from '@nestjs/schedule';

import {
  SqsWagerConsumer,
} from './sqs-wager.consumer.js';

@Injectable()
export class SqsWagerWorker {
  private readonly logger = new Logger(
    SqsWagerWorker.name,
  );

  private running = false;

  constructor(
    private readonly consumer: SqsWagerConsumer,
  ) {}

  @Interval(1_000)
  async runOnce(): Promise<void> {
    if (
      process.env.SQS_WAGER_WORKER_ENABLED !==
      'true'
    ) {
      return;
    }

    // An SQS long poll can take up to 5 seconds.
    // Do not start another poll while one is active
    // in this NestJS instance.
    if (this.running) {
      return;
    }

    this.running = true;

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
    } finally {
      this.running = false;
    }
  }
}
