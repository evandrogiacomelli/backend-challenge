import { Module } from '@nestjs/common';

import {
  BET_TRANSACTION_RUNNER,
} from './application/ports/bet-transaction-runner.js';

import {
  WIN_TRANSACTION_RUNNER,
} from './application/ports/win-transaction-runner.js';

import {
  LOSS_TRANSACTION_RUNNER,
} from './application/ports/loss-transaction-runner.js';

import {
  REFUND_TRANSACTION_RUNNER,
} from './application/ports/refund-transaction-runner.js';

import {
  ROLLBACK_TRANSACTION_RUNNER,
} from './application/ports/rollback-transaction-runner.js';

import {
  ProcessBetUseCase,
} from './application/use-cases/process-bet.use-case.js';

import {
  ProcessWinUseCase,
} from './application/use-cases/process-win.use-case.js';

import {
  ProcessLossUseCase,
} from './application/use-cases/process-loss.use-case.js';

import {
  ProcessRefundUseCase,
} from './application/use-cases/process-refund.use-case.js';

import {
  ProcessRollbackUseCase,
} from './application/use-cases/process-rollback.use-case.js';

import {
  MikroOrmBetTransactionRunner,
} from './infrastructure/persistence/mikro-orm-bet-transaction-runner.js';

import {
  MikroOrmWinTransactionRunner,
} from './infrastructure/persistence/mikro-orm-win-transaction-runner.js';

import {
  MikroOrmLossTransactionRunner,
} from './infrastructure/persistence/mikro-orm-loss-transaction-runner.js';

import {
  MikroOrmRefundTransactionRunner,
} from './infrastructure/persistence/mikro-orm-refund-transaction-runner.js';

import {
  MikroOrmRollbackTransactionRunner,
} from './infrastructure/persistence/mikro-orm-rollback-transaction-runner.js';

@Module({
  providers: [
    ProcessBetUseCase,
    {
      provide: BET_TRANSACTION_RUNNER,
      useClass: MikroOrmBetTransactionRunner,
    },

    ProcessWinUseCase,
    {
      provide: WIN_TRANSACTION_RUNNER,
      useClass: MikroOrmWinTransactionRunner,
    },

    ProcessLossUseCase,
    {
      provide: LOSS_TRANSACTION_RUNNER,
      useClass: MikroOrmLossTransactionRunner,
    },

    ProcessRefundUseCase,
    {
      provide: REFUND_TRANSACTION_RUNNER,
      useClass: MikroOrmRefundTransactionRunner,
    },

    ProcessRollbackUseCase,
    {
      provide: ROLLBACK_TRANSACTION_RUNNER,
      useClass: MikroOrmRollbackTransactionRunner,
    },
  ],

  exports: [
    ProcessBetUseCase,
    ProcessWinUseCase,
    ProcessLossUseCase,
    ProcessRefundUseCase,
    ProcessRollbackUseCase,
  ],
})
export class WageringModule {}
