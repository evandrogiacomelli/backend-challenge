
import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'inbox_messages' })
@Unique({
  properties: ['consumerName', 'messageId'],
})
export class InboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({
    type: 'string',
    fieldName: 'consumer_name',
    length: 100,
  })
  consumerName!: string;

  @Property({
    type: 'string',
    fieldName: 'message_id',
    length: 255,
  })
  messageId!: string;

  @Property({
    type: 'string',
    fieldName: 'payload_hash',
    length: 128,
  })
  payloadHash!: string;

  @Property({
    type: 'Date',
    fieldName: 'received_at',
    columnType: 'timestamptz',
    defaultRaw: 'now()',
  })
  receivedAt!: Date;

  @Property({
    type: 'Date',
    fieldName: 'processed_at',
    columnType: 'timestamptz',
    nullable: true,
  })
  processedAt?: Date;
}
