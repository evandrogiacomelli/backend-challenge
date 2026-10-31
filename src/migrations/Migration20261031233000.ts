import { Migration } from '@mikro-orm/migrations';

/**
 * Prospective, append-only ledger sequencing.
 * All statements MUST run in one migration transaction.
 * Historical ledger records are deliberately left unnumbered.
 */
export class Migration20261031233000 extends Migration {
  override async up(): Promise<void> {
    // Block writes while checkpoints are captured and the trigger is installed.
    // PostgreSQL holds these locks until this transaction commits.
    this.addSql(`
      LOCK TABLE wallets, wallet_ledger_entries
      IN SHARE ROW EXCLUSIVE MODE;
    `);

    this.addSql(`
      CREATE TABLE wallet_ledger_sequence_state (
        wallet_id UUID PRIMARY KEY REFERENCES wallets(id) ON DELETE RESTRICT,
        anchor_balance NUMERIC(19,2) NOT NULL,
        last_balance NUMERIC(19,2) NOT NULL,
        last_sequence BIGINT NOT NULL DEFAULT 0,
        established_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_ledger_state_anchor CHECK (anchor_balance >= 0),
        CONSTRAINT chk_ledger_state_last_balance CHECK (last_balance >= 0),
        CONSTRAINT chk_ledger_state_sequence CHECK (last_sequence >= 0)
      );
    `);

    this.addSql(`
      CREATE UNIQUE INDEX uq_ledger_wallet_and_id
      ON wallet_ledger_entries(wallet_id, id);
    `);

    this.addSql(`
      CREATE TABLE wallet_ledger_positions (
        wallet_id UUID NOT NULL,
        sequence_no BIGINT NOT NULL,
        ledger_entry_id UUID NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(wallet_id, sequence_no),
        CONSTRAINT uq_ledger_positions_entry UNIQUE (ledger_entry_id),
        CONSTRAINT chk_ledger_positions_sequence CHECK (sequence_no > 0),
        CONSTRAINT fk_positions_ledger_wallet FOREIGN KEY (wallet_id, ledger_entry_id)
          REFERENCES wallet_ledger_entries (wallet_id, id) ON DELETE RESTRICT
      );
    `);

    // Snapshot all existing wallets as of activation, while writers are blocked.
    // Existing entries do NOT get arbitrary historical positions.
    this.addSql(`
      INSERT INTO wallet_ledger_sequence_state
        (wallet_id, anchor_balance, last_balance, last_sequence)
      SELECT id, balance_amount, balance_amount, 0
      FROM wallets;
    `);

    this.addSql(`
      CREATE FUNCTION record_wallet_ledger_position()
      RETURNS trigger AS \$\$
      DECLARE assigned BIGINT;
      BEGIN
        -- New wallets created after activation have no checkpoint yet.
        -- The first ledger entry (normally OPENING) begins at balance_before.
        INSERT INTO wallet_ledger_sequence_state
          (wallet_id, anchor_balance, last_balance, last_sequence)
        VALUES (NEW.wallet_id, NEW.balance_before, NEW.balance_before, 0)
        ON CONFLICT (wallet_id) DO NOTHING;

        -- Concurrent insertions for the same wallet serialize on this row.
        -- If there is a chain discontinuity, abort the originating ledger insert.
        UPDATE wallet_ledger_sequence_state
        SET last_sequence = last_sequence + 1,
            last_balance = NEW.balance_after
        WHERE wallet_id = NEW.wallet_id
          AND last_balance = NEW.balance_before
        RETURNING last_sequence INTO assigned;

        IF assigned IS NULL THEN
          RAISE EXCEPTION 'Ledger sequence continuity failure for wallet %', NEW.wallet_id
            USING ERRCODE = '23514';
        END IF;

        INSERT INTO wallet_ledger_positions
          (wallet_id, sequence_no, ledger_entry_id)
        VALUES (NEW.wallet_id, assigned, NEW.id);

        RETURN NEW;
      END;
      \$\$ LANGUAGE plpgsql;
    `);

    this.addSql(`
      CREATE TRIGGER trg_record_wallet_ledger_position
      AFTER INSERT ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION record_wallet_ledger_position();
    `);

    // Protect append-only positions like the underlying financial ledger.
    this.addSql(`
      CREATE FUNCTION reject_wallet_ledger_position_changes()
      RETURNS trigger AS \$\$
      BEGIN
        RAISE EXCEPTION 'Ledger positions are immutable';
      END;
      \$\$ LANGUAGE plpgsql;
    `);

    this.addSql(`
      CREATE TRIGGER trg_positions_immutable_rows
      BEFORE UPDATE OR DELETE ON wallet_ledger_positions
      FOR EACH ROW EXECUTE FUNCTION reject_wallet_ledger_position_changes();
    `);

    this.addSql(`
      CREATE TRIGGER trg_positions_immutable_truncate
      BEFORE TRUNCATE ON wallet_ledger_positions
      FOR EACH STATEMENT EXECUTE FUNCTION reject_wallet_ledger_position_changes();
    `);
  }

  override async down(): Promise<void> {
    // Destroying sequence history is intentionally not supported.
    throw new Error(
      'Irreversible ledger audit migration: create a reviewed forward migration instead.',
    );
  }
}
