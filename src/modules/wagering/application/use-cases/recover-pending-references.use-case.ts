import {
  Inject,
  Injectable,
} from '@nestjs/common';

import {
  PENDING_REFERENCE_CLAIMER,
  type PendingReferenceClaimer,
  type ClaimPendingReferencesInput,
} from '../ports/pending-reference-claimer.js';

import {
  PENDING_REFERENCE_RECOVERY,
  type PendingReferenceRecovery,
  type PendingReferenceRecoveryStatus,
} from '../ports/pending-reference-recovery.js';

export interface RecoveryFailure {
  transactionId: string;
  message: string;
}

export interface RecoverPendingReferencesResult {
  claimed: number;
  processed: number;
  retryScheduled: number;
  rejected: number;
  staleClaims: number;
  failed: number;
  failures: RecoveryFailure[];
}

@Injectable()
export class RecoverPendingReferencesUseCase {
  constructor(
    @Inject(PENDING_REFERENCE_CLAIMER)
    private readonly claimer: PendingReferenceClaimer,

    @Inject(PENDING_REFERENCE_RECOVERY)
    private readonly recovery: PendingReferenceRecovery,
  ) {}

  async execute(
    input: ClaimPendingReferencesInput,
  ): Promise<RecoverPendingReferencesResult> {
    const claims = await this.claimer.claimDue(input);

    const result: RecoverPendingReferencesResult = {
      claimed: claims.length,
      processed: 0,
      retryScheduled: 0,
      rejected: 0,
      staleClaims: 0,
      failed: 0,
      failures: [],
    };

    // Sequential within a batch. Multiple worker
    // instances can still execute concurrently.
    for (const claim of claims) {
      try {
        const outcome = await this.recovery.recover(
          claim,
        );

        this.increment(
          result,
          outcome.status,
        );
      } catch (error: unknown) {
        result.failed += 1;

        result.failures.push({
          transactionId: claim.id,
          message:
            error instanceof Error
              ? error.message
              : String(error),
        });

        // The claim remains leased.
        // PostgreSQL will make it eligible again
        // when next_attempt_at expires.
      }
    }

    return result;
  }

  private increment(
    result: RecoverPendingReferencesResult,
    status: PendingReferenceRecoveryStatus,
  ): void {
    switch (status) {
      case 'PROCESSED':
        result.processed += 1;
        break;

      case 'RETRY_SCHEDULED':
        result.retryScheduled += 1;
        break;

      case 'REJECTED':
        result.rejected += 1;
        break;

      case 'STALE_CLAIM':
        result.staleClaims += 1;
        break;
    }
  }
}
