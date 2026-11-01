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

@Module({
  controllers: [WalletController, WalletQueryController, WalletLedgerController],
  providers: [
    CreateWalletUseCase,
    {
      provide: WALLET_OPENING_PERSISTENCE,
      useClass: MikroOrmWalletOpeningPersistence,
    },
  ],
})
export class WalletModule {}
