
export interface OutboxDelivery {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
  claimToken: string;
  claimedUntil: Date;
  occurredAt: Date;
}

export interface ClaimOutboxOptions {
  workerId: string;
  limit: number;
  leaseSeconds: number;
}

export interface OutboxDispatchStore {
  claim(options: ClaimOutboxOptions): Promise<OutboxDelivery[]>;

  markPublished(
    message: OutboxDelivery,
    workerId: string,
  ): Promise<boolean>;

  releaseForRetry(
    message: OutboxDelivery,
    workerId: string,
  ): Promise<boolean>;
}

export interface OutboxPublisher {
  publish(message: OutboxDelivery): Promise<void>;
}

export const OUTBOX_DISPATCH_STORE = Symbol(
  'OUTBOX_DISPATCH_STORE',
);

export const OUTBOX_PUBLISHER = Symbol(
  'OUTBOX_PUBLISHER',
);
