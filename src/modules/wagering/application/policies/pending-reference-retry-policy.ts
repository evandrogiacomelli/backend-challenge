export const PENDING_REFERENCE_ALERT_THRESHOLD = 8;

export const PENDING_REFERENCE_MAX_RETRY_SECONDS = 3600;

/**
 * Attempts are incremented when a worker claims
 * a pending transaction.
 *
 * Never permanently reject an unresolved financial
 * reference based only on its retry count.
 */
export function pendingReferenceRetrySeconds(
  attempts: number,
): number {
  if (
    !Number.isSafeInteger(attempts) ||
    attempts < 1
  ) {
    throw new Error(
      'Pending reference attempts must be a positive integer',
    );
  }

  return Math.min(
    PENDING_REFERENCE_MAX_RETRY_SECONDS,
    5 * 2 ** Math.min(attempts, 10),
  );
}

export function pendingReferenceNeedsAttention(
  attempts: number,
): boolean {
  return attempts >= PENDING_REFERENCE_ALERT_THRESHOLD;
}
