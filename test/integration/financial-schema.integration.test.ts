
import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'bun:test';
import { Client } from 'pg';

interface WalletFixture {
  id: string;
  playerId: string;
  currency: string;
}

interface WagerFixture {
  id: string;
  externalId: string;
  idempotencyKey: string;
}

interface WagerOptions {
  providerId?: string;
  externalId?: string;
  idempotencyKey?: string;
  playerId?: string;
  currency?: string;
  kind?: string;
  status?: string;
  amount?: string;
  resultingBalance?: string | null;
  referenceId?: string | null;
  referenceExternalId?: string | null;
}

interface LedgerOptions {
  direction?: string;
  amount?: string;
  currency?: string;
  balanceBefore?: string;
  balanceAfter?: string;
}

function createClient(): Client {
  if (process.env.DATABASE_URL) {
    return new Client({
      connectionString: process.env.DATABASE_URL,
    });
  }

  return new Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME ?? 'wagering',
    user: process.env.DB_USER ?? 'wagering',
    password: process.env.DB_PASSWORD,
  });
}

async function withRollback(
  callback: (client: Client) => Promise<void>,
): Promise<void> {
  const client = createClient();

  await client.connect();

  try {
    await client.query('BEGIN');
    await callback(client);
  } finally {
    try {
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  }
}

async function createWallet(
  client: Client,
  options: {
    playerId?: string;
    currency?: string;
    balance?: string;
  } = {},
): Promise<WalletFixture> {
  const wallet: WalletFixture = {
    id: randomUUID(),
    playerId: options.playerId ?? randomUUID(),
    currency: options.currency ?? 'BRL',
  };

  await client.query(
    `
      INSERT INTO wallets (
        id,
        player_id,
        currency,
        balance_amount
      )
      VALUES ($1, $2, $3, $4)
    `,
    [
      wallet.id,
      wallet.playerId,
      wallet.currency,
      options.balance ?? '100.00',
    ],
  );

  return wallet;
}

async function createWager(
  client: Client,
  wallet: WalletFixture,
  options: WagerOptions = {},
): Promise<WagerFixture> {
  const id = randomUUID();
  const externalId = options.externalId ?? `external-${id}`;
  const idempotencyKey = options.idempotencyKey ?? `key-${id}`;
  const currency = options.currency ?? wallet.currency;
  const status = options.status ?? 'PROCESSED';

  await client.query(
    `
      INSERT INTO wager_transactions (
        id,
        provider_id,
        external_transaction_id,
        idempotency_key,
        payload_hash,
        wallet_id,
        player_id,
        round_id,
        game_id,
        kind,
        status,
        amount,
        currency,
        reference_external_transaction_id,
        reference_transaction_id,
        resulting_balance_amount,
        resulting_balance_currency
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16, $17
      )
    `,
    [
      id,
      options.providerId ?? 'provider-a',
      externalId,
      idempotencyKey,
      'payload-hash-test',
      wallet.id,
      options.playerId ?? wallet.playerId,
      'round-1',
      'game-1',
      options.kind ?? 'BET',
      status,
      options.amount ?? '25.00',
      currency,
      options.referenceExternalId ?? null,
      options.referenceId ?? null,
      options.resultingBalance === undefined
        ? status === 'PROCESSED'
          ? '75.00'
          : null
        : options.resultingBalance,
      status === 'PROCESSED' ||
      options.resultingBalance !== undefined &&
      options.resultingBalance !== null
        ? currency
        : null,
    ],
  );

  return {
    id,
    externalId,
    idempotencyKey,
  };
}

async function createLedger(
  client: Client,
  wallet: WalletFixture,
  wagerId: string,
  options: LedgerOptions = {},
): Promise<string> {
  const id = randomUUID();

  await client.query(
    `
      INSERT INTO wallet_ledger_entries (
        id,
        wallet_id,
        wager_transaction_id,
        direction,
        amount,
        currency,
        balance_before,
        balance_after
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      id,
      wallet.id,
      wagerId,
      options.direction ?? 'DEBIT',
      options.amount ?? '25.00',
      options.currency ?? wallet.currency,
      options.balanceBefore ?? '100.00',
      options.balanceAfter ?? '75.00',
    ],
  );

  return id;
}

describe('Financial database schema', () => {
  test('should contain all five financial tables', async () => {
    await withRollback(async (client) => {
      const result = await client.query<{ table_name: string }>(
        `
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN (
              'wallets',
              'wager_transactions',
              'wallet_ledger_entries',
              'inbox_messages',
              'outbox_messages'
            )
        `,
      );

      expect(result.rows).toHaveLength(5);
    });
  });

  test('should reject negative wallet balances', async () => {
    await withRollback(async (client) => {
      await expect(
        createWallet(client, { balance: '-1.00' }),
      ).rejects.toMatchObject({
        code: '23514',
      });
    });
  });

  test('should enforce unique player and currency', async () => {
    await withRollback(async (client) => {
      const wallet = await createWallet(client);

      await expect(
        createWallet(client, {
          playerId: wallet.playerId,
          currency: wallet.currency,
        }),
      ).rejects.toMatchObject({
        code: '23505',
      });
    });
  });

  test('should reject a wager with a different player', async () => {
    await withRollback(async (client) => {
      const wallet = await createWallet(client);

      await expect(
        createWager(client, wallet, {
          playerId: randomUUID(),
        }),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'fk_wager_wallet_context',
      });
    });
  });

  test('should reject a wager with a different currency', async () => {
    await withRollback(async (client) => {
      const wallet = await createWallet(client);

      await expect(
        createWager(client, wallet, {
          currency: 'USD',
        }),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'fk_wager_wallet_context',
      });
    });
  });

  test('should enforce provider idempotency keys', async () => {
    await withRollback(async (client) => {
      const wallet = await createWallet(client);
      const key = randomUUID();

      await createWager(client, wallet, {
        idempotencyKey: key,
      });

      await expect(
        createWager(client, wallet, {
          idempotencyKey: key,
        }),
      ).rejects.toMatchObject({
        code: '23505',
      });
    });
  });

  test('should enforce unique external transaction IDs', async () => {
    await withRollback(async (client) => {
      const wallet = await createWallet(client);
      const externalId = randomUUID();

      await createWager(client, wallet, {
        externalId,
      });

      await expect(
        createWager(client, wallet, {
          externalId,
        }),
      ).rejects.toMatchObject({
        code: '23505',
      });
    });
  });

  test('should reject inconsistent ledger arithmetic', async () => {
    await withRollback(async (client) => {
      const wallet = await createWallet(client);
      const wager = await createWager(client, wallet);

      await expect(
        createLedger(client, wallet, wager.id, {
          direction: 'DEBIT',
          amount: '25.00',
          balanceBefore: '100.00',
          balanceAfter: '90.00',
        }),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'chk_ledger_arithmetic',
      });
    });
  });

  test('should reject ledger currency mismatches', async () => {
    await withRollback(async (client) => {
      const wallet = await createWallet(client);
      const wager = await createWager(client, wallet);

      await expect(
        createLedger(client, wallet, wager.id, {
          currency: 'USD',
        }),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'fk_ledger_wager_context',
      });
    });
  });

  test('should prevent duplicate ledger entries per transaction', async () => {
    await withRollback(async (client) => {
      const wallet = await createWallet(client);
      const wager = await createWager(client, wallet);

      await createLedger(client, wallet, wager.id);

      await expect(
        createLedger(client, wallet, wager.id),
      ).rejects.toMatchObject({
        code: '23505',
      });
    });
  });

  test('should reject ledger UPDATE', async () => {
    await withRollback(async (client) => {
      const wallet = await createWallet(client);
      const wager = await createWager(client, wallet);
      const entryId = await createLedger(
        client,
        wallet,
        wager.id,
      );

      await expect(
        client.query(
          `
            UPDATE wallet_ledger_entries
            SET amount = 50.00
            WHERE id = $1
          `,
          [entryId],
        ),
      ).rejects.toThrow('Ledger entries are immutable');
    });
  });

  test('should reject ledger DELETE', async () => {
    await withRollback(async (client) => {
      const wallet = await createWallet(client);
      const wager = await createWager(client, wallet);
      const entryId = await createLedger(
        client,
        wallet,
        wager.id,
      );

      await expect(
        client.query(
          `
            DELETE FROM wallet_ledger_entries
            WHERE id = $1
          `,
          [entryId],
        ),
      ).rejects.toThrow('Ledger entries are immutable');
    });
  });

  test('should reject ledger TRUNCATE', async () => {
    await withRollback(async (client) => {
      await expect(
        client.query('TRUNCATE TABLE wallet_ledger_entries'),
      ).rejects.toThrow('Ledger entries are immutable');
    });
  });

  test('should prevent duplicate processed reversals', async () => {
    await withRollback(async (client) => {
      const wallet = await createWallet(client);
      const bet = await createWager(client, wallet);

      await createWager(client, wallet, {
        kind: 'REFUND',
        referenceId: bet.id,
        referenceExternalId: bet.externalId,
        resultingBalance: '100.00',
      });

      await expect(
        createWager(client, wallet, {
          kind: 'ROLLBACK',
          referenceId: bet.id,
          referenceExternalId: bet.externalId,
          resultingBalance: '100.00',
        }),
      ).rejects.toMatchObject({
        code: '23505',
      });
    });
  });

  test('should deduplicate messages per inbox consumer', async () => {
    await withRollback(async (client) => {
      const messageId = randomUUID();

      const insert = (consumerName: string) =>
        client.query(
          `
            INSERT INTO inbox_messages (
              id,
              consumer_name,
              message_id,
              payload_hash
            )
            VALUES ($1, $2, $3, $4)
          `,
          [
            randomUUID(),
            consumerName,
            messageId,
            'payload-hash-test',
          ],
        );

      await insert('wager-consumer');

      await expect(
        insert('wager-consumer'),
      ).rejects.toMatchObject({
        code: '23505',
      });
    });
  });

  test('should reject invalid outbox status', async () => {
    await withRollback(async (client) => {
      await expect(
        client.query(
          `
            INSERT INTO outbox_messages (
              id,
              aggregate_id,
              event_type,
              payload,
              status,
              occurred_at
            )
            VALUES (
              $1,
              $2,
              'WagerTransactionProcessed',
              '{}'::jsonb,
              'INVALID',
              NOW()
            )
          `,
          [randomUUID(), randomUUID()],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'chk_outbox_status',
      });
    });
  });
});
