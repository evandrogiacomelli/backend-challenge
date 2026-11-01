import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  OUTBOX_DISPATCH_STORE,
  OUTBOX_PUBLISHER,
  type OutboxDispatchStore,
  type OutboxPublisher,
} from '../ports/outbox-dispatcher.ports.js';

export interface DispatchOptions {
  workerId?: string;
  batchSize?: number;
  leaseSeconds?: number;
}

export interface DispatchResult {
  claimed: number;
  published: number;
  failed: number;
  lostLease: number;
}

@Injectable()
export class OutboxDispatcherService {
  private readonly logger = new Logger(
    OutboxDispatcherService.name,
  );

  constructor(
    @Inject(OUTBOX_DISPATCH_STORE)
    private readonly store: OutboxDispatchStore,

    @Inject(OUTBOX_PUBLISHER)
    private readonly publisher: OutboxPublisher,
  ) {}

  async dispatchOnce(
    options: DispatchOptions = {},
  ): Promise<DispatchResult> {
    const workerId = options.workerId ?? randomUUID();
    const batchSize = options.batchSize ?? 10;
    const leaseSeconds = options.leaseSeconds ?? 60;

    const messages = await this.store.claim({
      workerId,
      limit: batchSize,
      leaseSeconds,
    });

    const result: DispatchResult = {
      claimed: messages.length,
      published: 0,
      failed: 0,
      lostLease: 0,
    };

    for (const message of messages) {
      try {
        await this.publisher.publish(message);
      } catch (error: unknown) {
        const failure = error as {
          name?: string;
          code?: string;
          $metadata?: {
            httpStatusCode?: number;
          };
        } | null;

        this.logger.error(
          JSON.stringify({
            event: 'outbox.publish.failed',
            errorType:
              failure?.name ?? 'UnknownError',
            errorCode:
              failure?.code ?? null,
            httpStatusCode:
              failure?.$metadata?.httpStatusCode ?? null,
          }),
        );

        const released =
          await this.store.releaseForRetry(
            message,
            workerId,
          );

        if (released) {
          result.failed++;
        } else {
          result.lostLease++;
        }

        continue;
      }

      const acknowledged =
        await this.store.markPublished(
          message,
          workerId,
        );

      if (acknowledged) {
        result.published++;
      } else {
        result.lostLease++;
      }
    }

    return result;
  }
}
