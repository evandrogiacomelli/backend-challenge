import type {
  PendingReferenceClaim,
} from './pending-reference-claimer.js';

export const PENDING_REFERENCE_RECOVERY = Symbol(
  'PENDING_REFERENCE_RECOVERY',
);

export type PendingReferenceRecoveryStatus =
  | 'PROCESSED'
  | 'RETRY_SCHEDULED'
  | 'REJECTED'
  | 'STALE_CLAIM';

export interface PendingReferenceRecoveryResult {
  transactionId: string;
  status: PendingReferenceRecoveryStatus;
}

export interface PendingReferenceRecovery {
  /**
   * Must execute atomically in PostgreSQL.
   *
   * A claim is valid only if:
   * - transaction status is PENDING_REFERENCE;
   * - its attempts value matches claim.attempts.
   *
   * Financial processing must update the existing
   * transaction instead of inserting a new one.
   */
  recover(
    claim: PendingReferenceClaim,
  ): Promise<PendingReferenceRecoveryResult>;
}
