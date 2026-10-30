import { Migration } from '@mikro-orm/migrations';

export class Migration20261030183337 extends Migration {

  override name = 'Migration20261030183337';

  override up(): void | Promise<void> {
    this.addSql(`create table "inbox_messages" ("id" uuid not null, "consumer_name" varchar(100) not null, "message_id" varchar(255) not null, "payload_hash" varchar(128) not null, "received_at" timestamptz not null default now(), "processed_at" timestamptz null, primary key ("id"));`);
    this.addSql(`alter table "inbox_messages" add constraint "inbox_messages_consumer_name_message_id_unique" unique ("consumer_name", "message_id");`);

    this.addSql(`create table "outbox_messages" ("id" uuid not null, "aggregate_id" uuid not null, "event_type" varchar(100) not null, "payload" jsonb not null, "status" varchar(20) not null default 'PENDING', "attempts" int not null default 0, "next_attempt_at" timestamptz not null default now(), "claimed_by" varchar(100) null, "claimed_until" timestamptz null, "claim_token" uuid null, "occurred_at" timestamptz not null, "created_at" timestamptz not null default now(), "published_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "idx_outbox_expired_claims" on "outbox_messages" ("claimed_until", "id") where status = 'PROCESSING';`);
    this.addSql(`create index "idx_outbox_pending" on "outbox_messages" ("next_attempt_at", "id") where status = 'PENDING';`);

    this.addSql(`create table "wallets" ("id" uuid not null, "player_id" uuid not null, "currency" varchar(3) not null, "balance_amount" numeric(19,2) not null default '0.00', "version" int not null default 1, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), primary key ("id"));`);
    this.addSql(`alter table "wallets" add constraint "wallets_id_player_id_currency_unique" unique ("id", "player_id", "currency");`);
    this.addSql(`alter table "wallets" add constraint "wallets_player_id_currency_unique" unique ("player_id", "currency");`);

    this.addSql(`create table "wager_transactions" ("id" uuid not null, "provider_id" varchar(100) not null, "external_transaction_id" varchar(255) not null, "idempotency_key" varchar(255) not null, "payload_hash" varchar(128) not null, "wallet_id" uuid not null, "player_id" uuid not null, "round_id" varchar(255) not null, "game_id" varchar(255) not null, "kind" varchar(20) not null, "status" varchar(20) not null default 'PENDING', "amount" numeric(19,2) not null, "currency" varchar(3) not null, "reference_external_transaction_id" varchar(255) null, "reference_transaction_id" uuid null, "resulting_balance_amount" numeric(19,2) null, "resulting_balance_currency" varchar(3) null, "failure_code" varchar(100) null, "attempts" int not null default 0, "next_attempt_at" timestamptz null, "created_at" timestamptz not null default now(), "processed_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "idx_wager_wallet_created" on "wager_transactions" ("wallet_id", "created_at", "id");`);
    this.addSql(`create index "idx_wager_reference_lookup" on "wager_transactions" ("provider_id", "reference_external_transaction_id") where reference_external_transaction_id IS NOT NULL;`);
    this.addSql(`create index "idx_wager_pending_reference" on "wager_transactions" ("next_attempt_at", "id") where status = 'PENDING_REFERENCE';`);
    this.addSql(`create unique index "uq_wager_processed_reversal" on "wager_transactions" ("reference_transaction_id") where kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED';`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_id_wallet_id_currency_unique" unique ("id", "wallet_id", "currency");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_provider_id_external_transaction_id_unique" unique ("provider_id", "external_transaction_id");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_provider_id_idempotency_key_unique" unique ("provider_id", "idempotency_key");`);

    this.addSql(`create table "wallet_ledger_entries" ("id" uuid not null, "wallet_id" uuid not null, "wager_transaction_id" uuid not null, "direction" varchar(6) not null, "amount" numeric(19,2) not null, "currency" varchar(3) not null, "balance_before" numeric(19,2) not null, "balance_after" numeric(19,2) not null, "created_at" timestamptz not null default now(), primary key ("id"));`);
    this.addSql(`create index "idx_ledger_wallet_history" on "wallet_ledger_entries" ("wallet_id", "created_at", "id");`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_wager_transaction_id_wallet_id_unique" unique ("wager_transaction_id", "wallet_id");`);

    this.addSql(`alter table "outbox_messages" add constraint "chk_outbox_published_at" check (
    status <> 'PUBLISHED'
    OR published_at IS NOT NULL
  );`);
    this.addSql(`alter table "outbox_messages" add constraint "chk_outbox_processing_claim" check (
    status <> 'PROCESSING'
    OR (
      claimed_by IS NOT NULL
      AND claimed_until IS NOT NULL
      AND claim_token IS NOT NULL
    )
  );`);
    this.addSql(`alter table "outbox_messages" add constraint "chk_outbox_attempts" check (attempts >= 0);`);
    this.addSql(`alter table "outbox_messages" add constraint "chk_outbox_status" check (
    status IN ('PENDING', 'PROCESSING', 'PUBLISHED')
  );`);

    this.addSql(`alter table "wallets" add constraint "chk_wallet_currency" check (currency ~ '^[A-Z]{3}\$');`);
    this.addSql(`alter table "wallets" add constraint "chk_wallet_version" check (version >= 1);`);
    this.addSql(`alter table "wallets" add constraint "chk_wallet_balance" check (balance_amount >= 0);`);

    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id") on delete restrict;`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_reference_transaction_id_foreign" foreign key ("reference_transaction_id") references "wager_transactions" ("id") on delete restrict;`);
    this.addSql(`alter table "wager_transactions" add constraint "chk_wager_status" check (
    status IN (
      'PENDING',
      'PENDING_REFERENCE',
      'PROCESSED',
      'REJECTED',
      'FAILED'
    )
  );`);
    this.addSql(`alter table "wager_transactions" add constraint "chk_wager_kind" check (
    kind IN (
      'OPENING',
      'BET',
      'WIN',
      'LOSS',
      'REFUND',
      'ROLLBACK'
    )
  );`);
    this.addSql(`alter table "wager_transactions" add constraint "chk_wager_pending_reference" check (
    status <> 'PENDING_REFERENCE'
    OR NULLIF(TRIM(reference_external_transaction_id), '') IS NOT NULL
  );`);
    this.addSql(`alter table "wager_transactions" add constraint "chk_wager_terminal_failure" check (
    status NOT IN ('REJECTED', 'FAILED')
    OR NULLIF(TRIM(failure_code), '') IS NOT NULL
  );`);
    this.addSql(`alter table "wager_transactions" add constraint "chk_wager_processed_reference" check (
    status <> 'PROCESSED'
    OR kind NOT IN ('REFUND', 'ROLLBACK')
    OR reference_transaction_id IS NOT NULL
  );`);
    this.addSql(`alter table "wager_transactions" add constraint "chk_wager_processed_snapshot" check (
    status <> 'PROCESSED'
    OR resulting_balance_amount IS NOT NULL
  );`);
    this.addSql(`alter table "wager_transactions" add constraint "chk_wager_reference_required" check (
    kind NOT IN ('REFUND', 'ROLLBACK')
    OR NULLIF(TRIM(reference_external_transaction_id), '') IS NOT NULL
  );`);
    this.addSql(`alter table "wager_transactions" add constraint "chk_wager_result_currency" check (
    resulting_balance_currency IS NULL
    OR resulting_balance_currency = currency
  );`);
    this.addSql(`alter table "wager_transactions" add constraint "chk_wager_result_nonnegative" check (
    resulting_balance_amount IS NULL
    OR resulting_balance_amount >= 0
  );`);
    this.addSql(`alter table "wager_transactions" add constraint "chk_wager_result_pair" check (
    (resulting_balance_amount IS NULL)
    =
    (resulting_balance_currency IS NULL)
  );`);
    this.addSql(`alter table "wager_transactions" add constraint "chk_wager_currency" check (currency ~ '^[A-Z]{3}\$');`);
    this.addSql(`alter table "wager_transactions" add constraint "chk_wager_attempts" check (attempts >= 0);`);
    this.addSql(`alter table "wager_transactions" add constraint "chk_wager_amount" check (
    amount >= 0
    AND (
      kind IN ('LOSS', 'OPENING')
      OR amount > 0
    )
  );`);

    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id") on delete restrict;`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_wager_transaction_id_foreign" foreign key ("wager_transaction_id") references "wager_transactions" ("id") on delete restrict;`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "chk_ledger_arithmetic" check (
    (
      direction = 'CREDIT'
      AND balance_after = balance_before + amount
    )
    OR
    (
      direction = 'DEBIT'
      AND balance_after = balance_before - amount
    )
  );`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "chk_ledger_currency" check (currency ~ '^[A-Z]{3}\$');`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "chk_ledger_direction" check (direction IN ('CREDIT', 'DEBIT'));`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "chk_ledger_balances" check (
    balance_before >= 0
    AND balance_after >= 0
  );`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "chk_ledger_amount" check (amount > 0);`);
    this.addSql(`create or replace function "wallet_ledger_entries_trg_ledger_immutable_truncate_fn"() returns trigger as \$\$ begin RAISE EXCEPTION 'Ledger entries are immutable'; end; \$\$ language plpgsql;`);
    this.addSql(`create trigger "trg_ledger_immutable_truncate" BEFORE TRUNCATE on "wallet_ledger_entries" for each STATEMENT execute function "wallet_ledger_entries_trg_ledger_immutable_truncate_fn"();`);
    this.addSql(`create or replace function "wallet_ledger_entries_trg_ledger_immutable_rows_fn"() returns trigger as \$\$ begin RAISE EXCEPTION 'Ledger entries are immutable'; end; \$\$ language plpgsql;`);
    this.addSql(`create trigger "trg_ledger_immutable_rows" BEFORE UPDATE OR DELETE on "wallet_ledger_entries" for each ROW execute function "wallet_ledger_entries_trg_ledger_immutable_rows_fn"();`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "wager_transactions" drop constraint "wager_transactions_wallet_id_foreign";`);
    this.addSql(`alter table "wallet_ledger_entries" drop constraint "wallet_ledger_entries_wallet_id_foreign";`);
    this.addSql(`alter table "wager_transactions" drop constraint "wager_transactions_reference_transaction_id_foreign";`);
    this.addSql(`alter table "wallet_ledger_entries" drop constraint "wallet_ledger_entries_wager_transaction_id_foreign";`);

    this.addSql(`drop table if exists "inbox_messages" cascade;`);
    this.addSql(`drop table if exists "outbox_messages" cascade;`);
    this.addSql(`drop table if exists "wallets" cascade;`);
    this.addSql(`drop table if exists "wager_transactions" cascade;`);
    this.addSql(`drop trigger if exists "trg_ledger_immutable_truncate" on "wallet_ledger_entries";`);
    this.addSql(`drop function if exists "wallet_ledger_entries_trg_ledger_immutable_truncate_fn"();`);
    this.addSql(`drop trigger if exists "trg_ledger_immutable_rows" on "wallet_ledger_entries";`);
    this.addSql(`drop function if exists "wallet_ledger_entries_trg_ledger_immutable_rows_fn"();`);
    this.addSql(`drop table if exists "wallet_ledger_entries" cascade;`);
  }

}
