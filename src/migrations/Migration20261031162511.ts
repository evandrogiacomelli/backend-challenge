
import { Migration } from '@mikro-orm/migrations';

export class Migration20261031162511 extends Migration {
  override up(): void {
    this.addSql(`
      ALTER TABLE "wager_transactions"
      ADD COLUMN "response_snapshot" JSONB NULL;
    `);
  }

  override down(): void {
    this.addSql(`
      ALTER TABLE "wager_transactions"
      DROP COLUMN "response_snapshot";
    `);
  }
}
