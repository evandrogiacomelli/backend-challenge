import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';

import { EntityManager } from '@mikro-orm/postgresql';

interface WalletRow {
  id: string;
  currency: string;
  balance_amount: string;
  version: number;
}

@Controller('wallets')
export class WalletQueryController {
  constructor(
    private readonly em: EntityManager,
  ) {}

  @Get(':walletId')
  async getWallet(
    @Param('walletId', ParseUUIDPipe)
    walletId: string,
  ) {
    const rows = await this.em.execute<WalletRow[]>(
      `
        SELECT
          id::text AS id,
          currency,
          balance_amount::text AS balance_amount,
          version
        FROM wallets
        WHERE id = ?
        LIMIT 1
      `,
      [walletId],
      'all',
    );

    const wallet = rows[0];

    if (!wallet) {
      throw new NotFoundException(
        'Wallet not found',
      );
    }

    return {
      id: wallet.id,
      balance: {
        amount: wallet.balance_amount,
        currency: wallet.currency,
      },
      version: Number(wallet.version),
    };
  }
}
