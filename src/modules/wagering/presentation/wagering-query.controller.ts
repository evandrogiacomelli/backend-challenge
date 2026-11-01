import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';

import { EntityManager } from '@mikro-orm/postgresql';

interface TransactionRow {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  status: string;
  amount: string;
  currency: string;
  referenceTransactionId: string | null;
  failureCode: string | null;
}

const TRANSACTION_COLUMNS = `
    SELECT
        id::text AS "transactionId",
        provider_id AS "providerId",
        external_transaction_id AS "externalTransactionId",
        wallet_id::text AS "walletId",
        kind,
        status,
        amount::text AS amount,
        currency,
        reference_transaction_id::text AS "referenceTransactionId",
        failure_code AS "failureCode"
    FROM wager_transactions
`;

@Controller()
export class WageringQueryController {
  constructor(
    private readonly em: EntityManager,
  ) {}

  @Get('wagering/transactions/:transactionId')
  async getByTransactionId(
    @Param('transactionId', ParseUUIDPipe)
    transactionId: string,
  ): Promise<TransactionRow> {
    const rows = await this.em.execute<
      TransactionRow[]
    >(
      `
        ${TRANSACTION_COLUMNS}
        WHERE id = ?
        LIMIT 1
      `,
      [transactionId],
      'all',
    );

    const transaction = rows[0];

    if (!transaction) {
      throw new NotFoundException(
        'Transaction not found',
      );
    }

    return transaction;
  }

  @Get(
    'providers/:providerId/wagering/transactions/:externalTransactionId',
  )
  async getByProviderTransactionId(
    @Param('providerId')
    providerId: string,

    @Param('externalTransactionId')
    externalTransactionId: string,
  ): Promise<TransactionRow> {
    const rows = await this.em.execute<
      TransactionRow[]
    >(
      `
        ${TRANSACTION_COLUMNS}
        WHERE provider_id = ?
          AND external_transaction_id = ?
        LIMIT 1
      `,
      [providerId, externalTransactionId],
      'all',
    );

    const transaction = rows[0];

    if (!transaction) {
      throw new NotFoundException(
        'Transaction not found',
      );
    }

    return transaction;
  }
}
