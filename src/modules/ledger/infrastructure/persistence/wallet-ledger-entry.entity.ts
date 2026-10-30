
import { DecimalType } from '@mikro-orm/core';
import {
  Check,
  Entity,
  Index,
  ManyToOne,
  PrimaryKey,
  Property,
  Trigger,
  Unique,
} from '@mikro-orm/decorators/legacy';

import { WagerTransactionEntity } from '../../../wagering/infrastructure/persistence/wager-transaction.entity.js';
import { WalletEntity } from '../../../wallet/infrastructure/persistence/wallet.entity.js';

@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({
  properties: ['transaction', 'wallet'],
})
@Index({
  name: 'idx_ledger_wallet_history',
  properties: ['wallet', 'createdAt', 'id'],
})
@Check({
  name: 'chk_ledger_amount',
  expression: 'amount > 0',
})
@Check({
  name: 'chk_ledger_balances',
  expression: `
    balance_before >= 0
    AND balance_after >= 0
  `,
})
@Check({
  name: 'chk_ledger_direction',
  expression: "direction IN ('CREDIT', 'DEBIT')",
})
@Check({
  name: 'chk_ledger_currency',
  expression: "currency ~ '^[A-Z]{3}$'",
})
@Check({
  name: 'chk_ledger_arithmetic',
  expression: `
    (
      direction = 'CREDIT'
      AND balance_after = balance_before + amount
    )
    OR
    (
      direction = 'DEBIT'
      AND balance_after = balance_before - amount
    )
  `,
})
@Trigger({
  name: 'trg_ledger_immutable_rows',
  timing: 'before',
  events: ['update', 'delete'],
  forEach: 'row',
  body: `
    RAISE EXCEPTION 'Ledger entries are immutable';
  `,
})
@Trigger({
  name: 'trg_ledger_immutable_truncate',
  timing: 'before',
  events: ['truncate'],
  forEach: 'statement',
  body: `
    RAISE EXCEPTION 'Ledger entries are immutable';
  `,
})
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @ManyToOne(() => WalletEntity, {
    joinColumn: 'wallet_id',
    deleteRule: 'restrict',
    cascade: [],
  })
  wallet!: WalletEntity;

  @ManyToOne(() => WagerTransactionEntity, {
    joinColumn: 'wager_transaction_id',
    deleteRule: 'restrict',
    cascade: [],
  })
  transaction!: WagerTransactionEntity;

  @Property({
    type: 'string',
    length: 6,
  })
  direction!: 'CREDIT' | 'DEBIT';

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
    type: DecimalType,
    fieldName: 'balance_before',
    precision: 19,
    scale: 2,
  })
  balanceBefore!: string;

  @Property({
    type: DecimalType,
    fieldName: 'balance_after',
    precision: 19,
    scale: 2,
  })
  balanceAfter!: string;

  @Property({
    type: 'Date',
    fieldName: 'created_at',
    columnType: 'timestamptz',
    defaultRaw: 'now()',
  })
  createdAt!: Date;
}
