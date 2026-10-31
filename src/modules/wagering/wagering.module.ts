
import { Module } from '@nestjs/common';

import { BET_TRANSACTION_RUNNER } from './application/ports/bet-transaction-runner.js';
import { ProcessBetUseCase } from './application/use-cases/process-bet.use-case.js';
import { MikroOrmBetTransactionRunner } from './infrastructure/persistence/mikro-orm-bet-transaction-runner.js';

@Module({
  providers: [
    ProcessBetUseCase,
    {
      provide: BET_TRANSACTION_RUNNER,
      useClass: MikroOrmBetTransactionRunner,
    },
  ],
  exports: [ProcessBetUseCase],
})
export class WageringModule {}
