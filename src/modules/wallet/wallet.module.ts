import { Module } from '@nestjs/common';

import {
  WALLET_OPENING_PERSISTENCE,
} from './application/ports/wallet-opening-persistence.js';
import {
  CreateWalletUseCase,
} from './application/use-cases/create-wallet.use-case.js';
import {
  MikroOrmWalletOpeningPersistence,
} from './infrastructure/persistence/mikro-orm-wallet-opening.persistence.js';
import { WalletController } from './presentation/wallet.controller.js';
import { WalletQueryController } from './presentation/wallet-query-controller.js';
import { WalletLedgerController } from './presentation/wallet-ledger.controller.js';
import { WalletReconciliationController } from './presentation/wallet-reconciliation.controller.js';
import {
  PostgresWalletReconciliationService
} from '../reconciliation/infrastructure/postgres-wallet-reconciliation.service.js';

@Module({
  controllers: [WalletController, WalletQueryController, WalletLedgerController, WalletReconciliationController],
  providers: [
    CreateWalletUseCase,
    {
      provide: WALLET_OPENING_PERSISTENCE,
      useClass: MikroOrmWalletOpeningPersistence,
    },
    PostgresWalletReconciliationService,
  ],
})
export class WalletModule {}
