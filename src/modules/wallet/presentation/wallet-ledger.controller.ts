import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';

import { EntityManager } from '@mikro-orm/postgresql';

interface WalletExistsRow {
  id: string;
}

interface LedgerRow {
  id: string;
  sequence: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date | string;
}

interface LedgerEntryResponse {
  id: string;
  sequence: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: string;
}

interface WalletLedgerResponse {
  walletId: string;
  items: LedgerEntryResponse[];
  nextCursor: string | null;
  limit: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_BIGINT = 9223372036854775807n;

@Controller('wallets')
export class WalletLedgerController {
  constructor(
    private readonly em: EntityManager,
  ) {}

  @Get(':walletId/ledger')
  async getLedger(
    @Param('walletId', ParseUUIDPipe)
    walletId: string,

    @Query('cursor')
    cursorRaw?: string,

    @Query('limit')
    limitRaw?: string,
  ): Promise<WalletLedgerResponse> {
    const cursor = this.parseCursor(cursorRaw);
    const limit = this.parseLimit(limitRaw);

    const wallets = await this.em.execute<
      WalletExistsRow[]
    >(
      `
        SELECT id::text AS id
        FROM wallets
        WHERE id = ?
        LIMIT 1
      `,
      [walletId],
      'all',
    );

    if (wallets.length === 0) {
      throw new NotFoundException(
        'Wallet not found',
      );
    }

    // Fetch one extra row to determine whether
    // another page exists.
    const rows = await this.em.execute<
      LedgerRow[]
    >(
      `
        SELECT
          l.id::text AS "id",

          p.sequence_no::text
            AS "sequence",

          l.wager_transaction_id::text
            AS "transactionId",

          l.direction AS "direction",

          l.amount::text AS "amount",

          l.currency AS "currency",

          l.balance_before::text
            AS "balanceBefore",

          l.balance_after::text
            AS "balanceAfter",

          l.created_at AS "createdAt"

        FROM wallet_ledger_positions p

        INNER JOIN wallet_ledger_entries l
          ON l.id = p.ledger_entry_id
          AND l.wallet_id = p.wallet_id

        WHERE p.wallet_id = ?
          AND p.sequence_no > CAST(? AS bigint)

        ORDER BY p.sequence_no ASC

        LIMIT ?
      `,
      [walletId, cursor, limit + 1],
      'all',
    );

    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);

    const items: LedgerEntryResponse[] =
      pageRows.map((row) => ({
        id: row.id,
        sequence: row.sequence,
        transactionId: row.transactionId,
        direction: row.direction,
        amount: row.amount,
        currency: row.currency,
        balanceBefore: row.balanceBefore,
        balanceAfter: row.balanceAfter,
        createdAt: new Date(
          row.createdAt,
        ).toISOString(),
      }));

    const lastItem = items.at(-1);

    return {
      walletId,
      items,
      nextCursor:
        hasMore && lastItem
          ? lastItem.sequence
          : null,
      limit,
    };
  }

  private parseCursor(
    value?: string,
  ): string {
    if (value === undefined) {
      return '0';
    }

    if (
      typeof value !== 'string' ||
      !/^\d+$/.test(value)
    ) {
      throw new BadRequestException(
        'cursor must be a non-negative integer',
      );
    }

    const cursor = BigInt(value);

    if (cursor > MAX_BIGINT) {
      throw new BadRequestException(
        'cursor exceeds BIGINT range',
      );
    }

    return cursor.toString();
  }

  private parseLimit(
    value?: string,
  ): number {
    if (value === undefined) {
      return DEFAULT_LIMIT;
    }

    if (
      typeof value !== 'string' ||
      !/^[1-9]\d*$/.test(value)
    ) {
      throw new BadRequestException(
        'limit must be a positive integer',
      );
    }

    const limit = Number(value);

    if (
      !Number.isSafeInteger(limit) ||
      limit > MAX_LIMIT
    ) {
      throw new BadRequestException(
        `limit must be between 1 and ${MAX_LIMIT}`,
      );
    }

    return limit;
  }
}
