import 'dotenv/config';

import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';

export default defineConfig({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  dbName: process.env.DB_NAME ?? 'wagering',
  user: process.env.DB_USER ?? 'wagering',
  password: process.env.DB_PASSWORD,

  entities: [],
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