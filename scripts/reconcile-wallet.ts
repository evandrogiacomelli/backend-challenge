import { MikroORM } from '@mikro-orm/postgresql';

import mikroOrmConfig from '../src/config/mikro-orm.config.js';

import { PostgresWalletReconciliationService } from '../src/modules/reconciliation/infrastructure/postgres-wallet-reconciliation.service.js';

const walletId = process.argv[2];

if (
  !walletId ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    walletId,
  )
) {
  console.error(
    'Usage: bun scripts/reconcile-wallet.ts <wallet-uuid>',
  );

  process.exit(1);
}

const orm = await MikroORM.init(mikroOrmConfig);

try {
  const service =
    new PostgresWalletReconciliationService(
      orm.em.fork(),
    );

  const report = await service.reconcile(walletId);

  console.log(
    JSON.stringify(report, null, 2),
  );

  if (!report.consistent) {
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await orm.close(true);
}
