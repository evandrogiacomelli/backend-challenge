import {
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';

import {
  PostgresWalletReconciliationService,
} from '../../reconciliation/infrastructure/postgres-wallet-reconciliation.service.js';

import {
  WalletNotFoundError,
} from '../../reconciliation/domain/reconciliation-report.js';

@Controller('wallets')
export class WalletReconciliationController {
  constructor(
    private readonly reconciliation:
    PostgresWalletReconciliationService,
  ) {}

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcile(
    @Param('walletId', ParseUUIDPipe)
    walletId: string,
  ) {
    try {
      return await this.reconciliation.reconcile(
        walletId,
      );
    } catch (error) {
      if (error instanceof WalletNotFoundError) {
        throw new NotFoundException(
          'Wallet not found',
        );
      }

      throw error;
    }
  }
}
