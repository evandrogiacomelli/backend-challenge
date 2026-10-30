
import {
  Check,
  Entity,
  Index,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';

export type OutboxStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'PUBLISHED';

@Entity({ tableName: 'outbox_messages' })
@Index({
  name: 'idx_outbox_pending',
  properties: ['nextAttemptAt', 'id'],
  where: "status = 'PENDING'",
})
@Index({
  name: 'idx_outbox_expired_claims',
  properties: ['claimedUntil', 'id'],
  where: "status = 'PROCESSING'",
})
@Check({
  name: 'chk_outbox_status',
  expression: `
    status IN ('PENDING', 'PROCESSING', 'PUBLISHED')
  `,
})
@Check({
  name: 'chk_outbox_attempts',
  expression: 'attempts >= 0',
})
@Check({
  name: 'chk_outbox_processing_claim',
  expression: `
    status <> 'PROCESSING'
    OR (
      claimed_by IS NOT NULL
      AND claimed_until IS NOT NULL
      AND claim_token IS NOT NULL
    )
  `,
})
@Check({
  name: 'chk_outbox_published_at',
  expression: `
    status <> 'PUBLISHED'
    OR published_at IS NOT NULL
  `,
})
export class OutboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({
    type: 'uuid',
    fieldName: 'aggregate_id',
  })
  aggregateId!: string;

  @Property({
    type: 'string',
    fieldName: 'event_type',
    length: 100,
  })
  eventType!: string;

  @Property({
    type: 'json',
    columnType: 'jsonb',
  })
  payload!: Record<string, unknown>;

  @Property({
    type: 'string',
    length: 20,
    default: 'PENDING',
  })
  status!: OutboxStatus;

  @Property({
    type: 'integer',
    default: 0,
  })
  attempts!: number;

  @Property({
    type: 'Date',
    fieldName: 'next_attempt_at',
    columnType: 'timestamptz',
    defaultRaw: 'now()',
  })
  nextAttemptAt!: Date;

  @Property({
    type: 'string',
    fieldName: 'claimed_by',
    length: 100,
    nullable: true,
  })
  claimedBy?: string;

  @Property({
    type: 'Date',
    fieldName: 'claimed_until',
    columnType: 'timestamptz',
    nullable: true,
  })
  claimedUntil?: Date;

  @Property({
    type: 'uuid',
    fieldName: 'claim_token',
    nullable: true,
  })
  claimToken?: string;

  @Property({
    type: 'Date',
    fieldName: 'occurred_at',
    columnType: 'timestamptz',
  })
  occurredAt!: Date;

  @Property({
    type: 'Date',
    fieldName: 'created_at',
    columnType: 'timestamptz',
    defaultRaw: 'now()',
  })
  createdAt!: Date;

  @Property({
    type: 'Date',
    fieldName: 'published_at',
    columnType: 'timestamptz',
    nullable: true,
  })
  publishedAt?: Date;
}
