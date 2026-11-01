export const PENDING_REFERENCE_CLAIMER = Symbol(
  'PENDING_REFERENCE_CLAIMER',
);

export type PendingReferenceKind =
  | 'REFUND'
  | 'ROLLBACK';

export interface PendingReferenceClaim {
  id: string;

  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;

  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;

  kind: PendingReferenceKind;

  amount: string;
  currency: string;

  referenceExternalTransactionId: string;

  attempts: number;
  nextAttemptAt: Date;
}

export interface ClaimPendingReferencesInput {
  limit: number;
  leaseSeconds: number;

  // Optional filtering for isolated integrations
  // and provider-specific processing.
  providerId?: string;
}

export interface PendingReferenceClaimer {
  claimDue(
    input: ClaimPendingReferencesInput,
  ): Promise<PendingReferenceClaim[]>;
}
