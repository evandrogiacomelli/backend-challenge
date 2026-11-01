import {
  Injectable,
  Logger,
  Optional,
  type BeforeApplicationShutdown,
} from '@nestjs/common';

import {
  Interval,
} from '@nestjs/schedule';

import {
  RecoverPendingReferencesUseCase,
  type RecoverPendingReferencesResult,
} from '../../application/use-cases/recover-pending-references.use-case.js';
import { FinancialMetricsService } from '../../../observability/financial-metrics.service.js';

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

    @Optional()
    private readonly metrics?: FinancialMetricsService,
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
    const startedAt = Date.now();

    try {
      const result =
        await this.recoverPendingReferences.execute({
          limit: 5,
          leaseSeconds: 300,
        });

      const durationMs = Date.now() - startedAt;

      // Metrics must never affect financial processing.
      try {
        this.metrics?.recordPendingRecovery(
          result,
          durationMs,
        );
      } catch {
        this.logger.warn(
          'Unable to record pending recovery metrics',
        );
      }

      if (result.failed > 0) {
        this.logger.warn(
          JSON.stringify({
            event: 'pending.recovery.partial_failure',
            failed: result.failed,
          }),
        );
      }

      if (
        result.claimed > 0 ||
        result.failed > 0
      ) {
        this.logger.log(
          JSON.stringify({
            event: 'pending.recovery.completed',
            durationMs,
            claimed: result.claimed,
            processed: result.processed,
            retried: result.retryScheduled,
            rejected: result.rejected,
            staleClaims: result.staleClaims,
            failed: result.failed,
          }),
        );
      }

      return result;
    } catch (error: unknown) {
      const durationMs = Date.now() - startedAt;

      try {
        this.metrics?.recordPendingFailure(
          durationMs,
        );
      } catch {
        this.logger.warn(
          'Unable to record pending failure metrics',
        );
      }

      this.logger.error(
        JSON.stringify({
          event: 'pending.recovery.failed',
          durationMs,
          errorType:
            error instanceof Error
              ? error.name
              : 'UnknownError',
        }),
      );

      // Pending references remain persisted.
      // PostgreSQL leases provide crash recovery.
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
