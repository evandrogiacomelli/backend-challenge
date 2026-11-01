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

interface LedgerCursorPayload {
  v: number;
  walletId: string;
  sequence: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_BIGINT = 9223372036854775807n;

const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 1024;

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
    const cursor = this.parseCursor(
      cursorRaw,
      walletId,
    );

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

    // Request one extra row to determine
    // whether a subsequent page exists.
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

    const pageRows = rows.slice(
      0,
      limit,
    );

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

    const nextCursor =
      hasMore && lastItem
        ? this.encodeCursor(
          walletId,
          lastItem.sequence,
        )
        : null;

    return {
      walletId,
      items,
      nextCursor,
      limit,
    };
  }

  private encodeCursor(
    walletId: string,
    sequence: string,
  ): string {
    const payload: LedgerCursorPayload = {
      v: CURSOR_VERSION,
      walletId,
      sequence,
    };

    return Buffer.from(
      JSON.stringify(payload),
      'utf8',
    ).toString('base64url');
  }

  private parseCursor(
    value: unknown,
    walletId: string,
  ): string {
    if (value === undefined) {
      return '0';
    }

    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > MAX_CURSOR_LENGTH ||
      !/^[A-Za-z0-9_-]+$/.test(value)
    ) {
      throw new BadRequestException(
        'Invalid ledger cursor',
      );
    }

    let decoded: unknown;

    try {
      const buffer = Buffer.from(
        value,
        'base64url',
      );

      // Reject malformed and noncanonical
      // Base64URL encodings.
      if (
        buffer.toString('base64url') !==
        value
      ) {
        throw new Error(
          'Invalid Base64URL encoding',
        );
      }

      decoded = JSON.parse(
        new TextDecoder('utf-8', {
          fatal: true,
        }).decode(buffer),
      );
    } catch {
      throw new BadRequestException(
        'Invalid ledger cursor',
      );
    }

    if (
      decoded === null ||
      typeof decoded !== 'object' ||
      Array.isArray(decoded)
    ) {
      throw new BadRequestException(
        'Invalid ledger cursor payload',
      );
    }

    const payload = decoded as Record<
      string,
      unknown
    >;

    if (
      Object.keys(payload).length !== 3 ||
      !Object.hasOwn(payload, 'v') ||
      !Object.hasOwn(payload, 'walletId') ||
      !Object.hasOwn(payload, 'sequence')
    ) {
      throw new BadRequestException(
        'Invalid ledger cursor payload',
      );
    }

    if (
      payload.v !== CURSOR_VERSION
    ) {
      throw new BadRequestException(
        'Unsupported ledger cursor version',
      );
    }

    if (
      typeof payload.walletId !== 'string' ||
      payload.walletId.toLowerCase() !==
      walletId.toLowerCase()
    ) {
      throw new BadRequestException(
        'Ledger cursor does not belong to this wallet',
      );
    }

    if (
      typeof payload.sequence !== 'string' ||
      !/^[1-9]\d*$/.test(payload.sequence)
    ) {
      throw new BadRequestException(
        'Invalid ledger cursor sequence',
      );
    }

    let sequence: bigint;

    try {
      sequence = BigInt(
        payload.sequence,
      );
    } catch {
      throw new BadRequestException(
        'Invalid ledger cursor sequence',
      );
    }

    if (
      sequence > MAX_BIGINT
    ) {
      throw new BadRequestException(
        'Ledger cursor sequence exceeds BIGINT range',
      );
    }

    return sequence.toString();
  }

  private parseLimit(
    value: unknown,
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
