import 'dotenv/config';

import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';

import { InboxMessageEntity } from '../modules/messaging/inbox/infrastructure/persistence/inbox-message.entity.js';
import { OutboxMessageEntity } from '../modules/messaging/outbox/infrastructure/persistence/outbox-message.entity.js';
import { WalletLedgerEntryEntity } from '../modules/ledger/infrastructure/persistence/wallet-ledger-entry.entity.js';
import { WagerTransactionEntity } from '../modules/wagering/infrastructure/persistence/wager-transaction.entity.js';
import { WalletEntity } from '../modules/wallet/infrastructure/persistence/wallet.entity.js';

export default defineConfig({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  dbName: process.env.DB_NAME ?? 'wagering',
  user: process.env.DB_USER ?? 'wagering',
  password: process.env.DB_PASSWORD,

  entities: [
    WalletEntity,
    WagerTransactionEntity,
    WalletLedgerEntryEntity,
    InboxMessageEntity,
    OutboxMessageEntity,
  ],
  discovery: {
    warnWhenNoEntities: false,
  },

  extensions: [Migrator],

  migrations: {
    path: './dist/migrations',
    pathTs: './src/migrations',
    emit: 'ts',
    transactional: true,
    allOrNothing: true,
  },
});
