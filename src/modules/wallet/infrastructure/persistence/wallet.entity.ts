
import { DecimalType } from '@mikro-orm/core';
import {
  Check,
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wallets' })
@Unique({
  properties: ['playerId', 'currency'],
})
@Unique({
  properties: ['id', 'playerId', 'currency'],
})
@Check({
  name: 'chk_wallet_balance',
  expression: 'balance_amount >= 0',
})
@Check({
  name: 'chk_wallet_version',
  expression: 'version >= 1',
})
@Check({
  name: 'chk_wallet_currency',
  expression: "currency ~ '^[A-Z]{3}$'",
})
export class WalletEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({
    type: 'uuid',
    fieldName: 'player_id',
  })
  playerId!: string;

  @Property({
    type: 'string',
    length: 3,
  })
  currency!: string;

  @Property({
    type: DecimalType,
    fieldName: 'balance_amount',
    precision: 19,
    scale: 2,
    default: '0.00',
  })
  balanceAmount!: string;

  @Property({
    type: 'integer',
    default: 1,
  })
  version!: number;

  @Property({
    type: 'Date',
    fieldName: 'created_at',
    columnType: 'timestamptz',
    defaultRaw: 'now()',
  })
  createdAt!: Date;

  @Property({
    type: 'Date',
    fieldName: 'updated_at',
    columnType: 'timestamptz',
    defaultRaw: 'now()',
  })
  updatedAt!: Date;
}
