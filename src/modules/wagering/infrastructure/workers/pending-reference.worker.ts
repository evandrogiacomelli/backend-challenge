import {
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
} from '@nestjs/common';

import {
  Interval,
} from '@nestjs/schedule';

import {
  RecoverPendingReferencesUseCase,
  type RecoverPendingReferencesResult,
} from '../../application/use-cases/recover-pending-references.use-case.js';

@Injectable()
export class PendingReferenceWorker
  implements BeforeApplicationShutdown {

  private readonly logger = new Logger(
    PendingReferenceWorker.name,
  );

  private shuttingDown = false;

  private inFlight:
    Promise<RecoverPendingReferencesResult | null>
    | null = null;

  constructor(
    private readonly recoverPendingReferences:
    RecoverPendingReferencesUseCase,
  ) {}

  @Interval(5_000)
  async tick(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    if (
      process.env.PENDING_REFERENCE_WORKER_ENABLED ===
      'false'
    ) {
      return;
    }

    await this.runOnce();
  }

  /**
   * Exposed for deterministic integration tests.
   *
   * Concurrent NestJS instances coordinate using
   * PostgreSQL leases and row locking.
   */
  async runOnce(): Promise<
    RecoverPendingReferencesResult | null
  > {
    if (this.shuttingDown) {
      return null;
    }

    if (this.inFlight !== null) {
      return null;
    }

    const task = this.processBatch();

    this.inFlight = task;

    try {
      return await task;
    } finally {
      if (this.inFlight === task) {
        this.inFlight = null;
      }
    }
  }

  private async processBatch(): Promise<
    RecoverPendingReferencesResult | null
  > {
    try {
      const result =
        await this.recoverPendingReferences.execute({
          limit: 5,
          leaseSeconds: 300,
        });

      if (result.failed > 0) {
        this.logger.warn(
          `Pending recovery failures: ${result.failed}`,
        );

        for (const failure of result.failures) {
          this.logger.error(
            `Transaction ${failure.transactionId}: ` +
            failure.message,
          );
        }
      }

      if (
        result.processed > 0 ||
        result.retryScheduled > 0 ||
        result.rejected > 0
      ) {
        this.logger.log(
          [
            `Claimed=${result.claimed}`,
            `Processed=${result.processed}`,
            `Retried=${result.retryScheduled}`,
            `Rejected=${result.rejected}`,
            `Stale=${result.staleClaims}`,
            `Failed=${result.failed}`,
          ].join(' | '),
        );
      }

      return result;
    } catch (error: unknown) {
      this.logger.error(
        'Pending reference worker execution failed',
        error instanceof Error
          ? error.stack
          : String(error),
      );

      // Never delete pending work on failure.
      // PostgreSQL leases eventually expire.
      return null;
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
        'no active pending recovery',
      );
      return;
    }

    this.logger.log(
      `Shutdown (${signal ?? 'manual'}): ` +
      'waiting for active pending recovery',
    );

    await active;

    this.logger.log(
      'Active pending recovery finished',
    );
  }
}
