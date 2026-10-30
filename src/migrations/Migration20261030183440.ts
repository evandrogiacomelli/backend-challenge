import { Migration } from '@mikro-orm/migrations';

export class Migration20261030183440 extends Migration {

  override name = 'Migration20261030183440';


  override up(): void {
    this.addSql(`
    ALTER TABLE "wager_transactions"
    ADD CONSTRAINT "fk_wager_wallet_context"
    FOREIGN KEY ("wallet_id", "player_id", "currency")
    REFERENCES "wallets" ("id", "player_id", "currency")
    ON DELETE RESTRICT;
  `);

    this.addSql(`
    ALTER TABLE "wallet_ledger_entries"
    ADD CONSTRAINT "fk_ledger_wager_context"
    FOREIGN KEY (
      "wager_transaction_id",
      "wallet_id",
      "currency"
    )
    REFERENCES "wager_transactions" (
      "id",
      "wallet_id",
      "currency"
    )
    ON DELETE RESTRICT;
  `);
  }

  override down(): void {
    this.addSql(`
    ALTER TABLE "wallet_ledger_entries"
    DROP CONSTRAINT "fk_ledger_wager_context";
  `);

    this.addSql(`
    ALTER TABLE "wager_transactions"
    DROP CONSTRAINT "fk_wager_wallet_context";
  `);
  }

}
