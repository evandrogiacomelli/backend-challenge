import {
  Injectable,
  Logger,
} from '@nestjs/common';

import { Interval } from '@nestjs/schedule';

import {
  RecoverPendingReferencesUseCase,
  type RecoverPendingReferencesResult,
} from '../../application/use-cases/recover-pending-references.use-case.js';

@Injectable()
export class PendingReferenceWorker {
  private readonly logger = new Logger(
    PendingReferenceWorker.name,
  );

  private running = false;

  constructor(
    private readonly recoverPendingReferences:
    RecoverPendingReferencesUseCase,
  ) {}

  @Interval(5_000)
  async tick(): Promise<void> {
    if (
      process.env.PENDING_REFERENCE_WORKER_ENABLED ===
      'false'
    ) {
      return;
    }

    await this.runOnce();
  }

  /**
   * Also exposed for deterministic integration tests.
   *
   * Multiple NestJS instances may run concurrently.
   * Cross-instance coordination is handled by
   * PostgreSQL, not this in-memory flag.
   */
  async runOnce(): Promise<
    RecoverPendingReferencesResult | null
  > {
    if (this.running) {
      return null;
    }

    this.running = true;

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
            `Transaction ${failure.transactionId}: ${failure.message}`,
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

      // The worker does not delete or acknowledge
      // pending operations after a failure.
      // PostgreSQL leases eventually expire.
      return null;
    } finally {
      this.running = false;
    }
  }
}
