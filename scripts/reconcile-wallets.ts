import { MikroORM } from '@mikro-orm/postgresql';

import mikroOrmConfig from '../src/config/mikro-orm.config.js';

import {
  WalletBatchReconciliationService,
} from '../src/modules/reconciliation/application/wallet-batch-reconciliation.service.js';

const orm = await MikroORM.init(mikroOrmConfig);

try {
  const service =
    new WalletBatchReconciliationService(
      orm.em.fork(),
    );

  let cursor: string | undefined;
  let checked = 0;
  let inconsistent = 0;
  let pages = 0;

  do {
    const result = await service.scanPage({
      after: cursor,
      limit: 25,
    });

    pages++;
    checked += result.checkedCount;
    inconsistent += result.inconsistentCount;

    for (const wallet of result.results) {
      if (wallet.consistent) {
        continue;
      }

      console.error(
        JSON.stringify(
          {
            walletId: wallet.walletId,
            reconciliationIssues:
            wallet.reconciliation.issues,
            chainIssues: wallet.chain.issues,
          },
          null,
          2,
        ),
      );
    }

    cursor = result.nextCursor ?? undefined;

    if (!result.nextCursor) {
      break;
    }
  } while (true);

  console.log(
    JSON.stringify(
      {
        pages,
        walletsChecked: checked,
        consistent: checked - inconsistent,
        inconsistent,
      },
      null,
      2,
    ),
  );

  if (inconsistent > 0) {
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await orm.close(true);
}
