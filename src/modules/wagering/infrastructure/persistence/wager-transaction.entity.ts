
import { DecimalType } from '@mikro-orm/core';
import {
  Check,
  Entity,
  Index,
  ManyToOne,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

import { WalletEntity } from '../../../wallet/infrastructure/persistence/wallet.entity.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction.js';

@Entity({ tableName: 'wager_transactions' })
@Unique({
  properties: ['providerId', 'idempotencyKey'],
})
@Unique({
  properties: ['providerId', 'externalTransactionId'],
})
@Unique({
  properties: ['id', 'wallet', 'currency'],
})
@Unique({
  name: 'uq_wager_processed_reversal',
  properties: ['referenceTransaction'],
  where: "kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED'",
})
@Index({
  name: 'idx_wager_pending_reference',
  properties: ['nextAttemptAt', 'id'],
  where: "status = 'PENDING_REFERENCE'",
})
@Index({
  name: 'idx_wager_reference_lookup',
  properties: ['providerId', 'referenceExternalTransactionId'],
  where: 'reference_external_transaction_id IS NOT NULL',
})
@Index({
  name: 'idx_wager_wallet_created',
  properties: ['wallet', 'createdAt', 'id'],
})
@Check({
  name: 'chk_wager_amount',
  expression: `
    amount >= 0
    AND (
      kind IN ('LOSS', 'OPENING')
      OR amount > 0
    )
  `,
})
@Check({
  name: 'chk_wager_attempts',
  expression: 'attempts >= 0',
})
@Check({
  name: 'chk_wager_currency',
  expression: "currency ~ '^[A-Z]{3}$'",
})
@Check({
  name: 'chk_wager_result_pair',
  expression: `
    (resulting_balance_amount IS NULL)
    =
    (resulting_balance_currency IS NULL)
  `,
})
@Check({
  name: 'chk_wager_result_nonnegative',
  expression: `
    resulting_balance_amount IS NULL
    OR resulting_balance_amount >= 0
  `,
})
@Check({
  name: 'chk_wager_result_currency',
  expression: `
    resulting_balance_currency IS NULL
    OR resulting_balance_currency = currency
  `,
})
@Check({
  name: 'chk_wager_reference_required',
  expression: `
    kind NOT IN ('REFUND', 'ROLLBACK')
    OR NULLIF(TRIM(reference_external_transaction_id), '') IS NOT NULL
  `,
})
@Check({
  name: 'chk_wager_processed_snapshot',
  expression: `
    status <> 'PROCESSED'
    OR resulting_balance_amount IS NOT NULL
  `,
})
@Check({
  name: 'chk_wager_processed_reference',
  expression: `
    status <> 'PROCESSED'
    OR kind NOT IN ('REFUND', 'ROLLBACK')
    OR reference_transaction_id IS NOT NULL
  `,
})
@Check({
  name: 'chk_wager_terminal_failure',
  expression: `
    status NOT IN ('REJECTED', 'FAILED')
    OR NULLIF(TRIM(failure_code), '') IS NOT NULL
  `,
})
@Check({
  name: 'chk_wager_pending_reference',
  expression: `
    status <> 'PENDING_REFERENCE'
    OR NULLIF(TRIM(reference_external_transaction_id), '') IS NOT NULL
  `,
})
@Check({
  name: 'chk_wager_kind',
  expression: `
    kind IN (
      'OPENING',
      'BET',
      'WIN',
      'LOSS',
      'REFUND',
      'ROLLBACK'
    )
  `,
})
@Check({
  name: 'chk_wager_status',
  expression: `
    status IN (
      'PENDING',
      'PENDING_REFERENCE',
      'PROCESSED',
      'REJECTED',
      'FAILED'
    )
  `,
})
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({
    type: 'string',
    fieldName: 'provider_id',
    length: 100,
  })
  providerId!: string;

  @Property({
    type: 'string',
    fieldName: 'external_transaction_id',
    length: 255,
  })
  externalTransactionId!: string;

  @Property({
    type: 'string',
    fieldName: 'idempotency_key',
    length: 255,
  })
  idempotencyKey!: string;

  @Property({
    type: 'string',
    fieldName: 'payload_hash',
    length: 128,
  })
  payloadHash!: string;

  @ManyToOne(() => WalletEntity, {
    joinColumn: 'wallet_id',
    deleteRule: 'restrict',
    cascade: [],
  })
  wallet!: WalletEntity;

  @Property({
    type: 'uuid',
    fieldName: 'player_id',
  })
  playerId!: string;

  @Property({
    type: 'string',
    fieldName: 'round_id',
    length: 255,
  })
  roundId!: string;

  @Property({
    type: 'string',
    fieldName: 'game_id',
    length: 255,
  })
  gameId!: string;

  @Property({
    type: 'string',
    length: 20,
  })
  kind!: WagerTransactionKind;

  @Property({
    type: 'string',
    length: 20,
    default: WagerTransactionStatus.Pending,
  })
  status!: WagerTransactionStatus;

  @Property({
    type: DecimalType,
    precision: 19,
    scale: 2,
  })
  amount!: string;

  @Property({
    type: 'string',
    length: 3,
  })
  currency!: string;

  @Property({
    type: 'string',
    fieldName: 'reference_external_transaction_id',
    length: 255,
    nullable: true,
  })
  referenceExternalTransactionId?: string;

  @ManyToOne(() => WagerTransactionEntity, {
    joinColumn: 'reference_transaction_id',
    nullable: true,
    deleteRule: 'restrict',
    cascade: [],
  })
  referenceTransaction?: WagerTransactionEntity;

  @Property({
    type: DecimalType,
    fieldName: 'resulting_balance_amount',
    precision: 19,
    scale: 2,
    nullable: true,
  })
  resultingBalanceAmount?: string;

  @Property({
    type: 'string',
    fieldName: 'resulting_balance_currency',
    length: 3,
    nullable: true,
  })
  resultingBalanceCurrency?: string;

  @Property({
    type: 'string',
    fieldName: 'failure_code',
    length: 100,
    nullable: true,
  })
  failureCode?: string;

  @Property({
    type: 'integer',
    default: 0,
  })
  attempts!: number;

  @Property({
    type: 'Date',
    fieldName: 'next_attempt_at',
    columnType: 'timestamptz',
    nullable: true,
  })
  nextAttemptAt?: Date;

  @Property({
    type: 'Date',
    fieldName: 'created_at',
    columnType: 'timestamptz',
    defaultRaw: 'now()',
  })
  createdAt!: Date;

  @Property({
    type: 'Date',
    fieldName: 'processed_at',
    columnType: 'timestamptz',
    nullable: true,
  })
  processedAt?: Date;


  @Property({
    type: 'json',
    columnType: 'jsonb',
    fieldName: 'response_snapshot',
    nullable: true,
  })
  responseSnapshot?: Record<string, unknown>;

}
