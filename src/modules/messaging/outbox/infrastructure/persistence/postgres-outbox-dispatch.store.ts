
import { randomUUID } from 'node:crypto';

import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import type {
  ClaimOutboxOptions,
  OutboxDelivery,
  OutboxDispatchStore,
} from '../../application/ports/outbox-dispatcher.ports.js';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown> | string;
  attempts: number;
  claim_token: string;
  claimed_until: Date | string;
  occurred_at: Date | string;
}

@Injectable()
export class PostgresOutboxDispatchStore
  implements OutboxDispatchStore {
  constructor(private readonly em: EntityManager) {}

  async claim(
    options: ClaimOutboxOptions,
  ): Promise<OutboxDelivery[]> {
    if (
      !Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 100
    ) {
      throw new Error('Claim limit must be between 1 and 100');
    }

    if (
      !Number.isInteger(options.leaseSeconds) ||
      options.leaseSeconds < 1
    ) {
      throw new Error('Invalid lease duration');
    }

    if (!options.workerId.trim()) {
      throw new Error('Worker ID is required');
    }

    const token = randomUUID();

    const rows = await this.em.fork().transactional(
      async (tx) =>
        tx.execute<OutboxRow[]>(
          `
          WITH candidates AS (
            SELECT o.id
            FROM outbox_messages AS o
            WHERE o.status = 'PENDING'
              AND o.next_attempt_at <= NOW()
              AND (
                o.claimed_until IS NULL
                OR o.claimed_until <= NOW()
              )
              AND NOT EXISTS (
                SELECT 1
                FROM outbox_messages AS earlier
                WHERE earlier.aggregate_id = o.aggregate_id
                  AND earlier.status = 'PENDING'
                  AND (
                    earlier.occurred_at,
                    earlier.created_at,
                    earlier.id
                  ) < (
                    o.occurred_at,
                    o.created_at,
                    o.id
                  )
              )
            ORDER BY
              o.occurred_at,
              o.created_at,
              o.id
            LIMIT ?
            FOR UPDATE OF o SKIP LOCKED
          )
          UPDATE outbox_messages AS o
          SET
            claimed_by = ?,
            claim_token = ?,
            claimed_until =
              NOW() + (? * INTERVAL '1 second'),
            attempts = o.attempts + 1
          FROM candidates AS c
          WHERE o.id = c.id
          RETURNING
            o.id,
            o.aggregate_id,
            o.event_type,
            o.payload,
            o.attempts,
            o.claim_token,
            o.claimed_until,
            o.occurred_at
          `,
          [
            options.limit,
            options.workerId,
            token,
            options.leaseSeconds,
          ],
          'all',
        ),
    );

    return rows.map((row) => ({
      id: row.id,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      payload:
        typeof row.payload === 'string'
          ? JSON.parse(row.payload) as Record<string, unknown>
          : row.payload,
      attempts: Number(row.attempts),
      claimToken: row.claim_token,
      claimedUntil: new Date(row.claimed_until),
      occurredAt: new Date(row.occurred_at),
    }));
  }

  async markPublished(
    message: OutboxDelivery,
    workerId: string,
  ): Promise<boolean> {
    const rows = await this.em.fork().execute<
      Array<{ id: string }>
    >(
      `
      UPDATE outbox_messages
      SET
        status = 'PUBLISHED',
        published_at = NOW(),
        claimed_by = NULL,
        claim_token = NULL,
        claimed_until = NULL
      WHERE id = ?
        AND status = 'PENDING'
        AND claimed_by = ?
        AND claim_token = ?
        AND claimed_until > NOW()
      RETURNING id
      `,
      [
        message.id,
        workerId,
        message.claimToken,
      ],
      'all',
    );

    return rows.length === 1;
  }

  async releaseForRetry(
    message: OutboxDelivery,
    workerId: string,
  ): Promise<boolean> {
    // attempts was incremented by the claim operation.
    // Delay: 2, 4, 8 ... 256 seconds (capped).
    const delaySeconds = Math.min(
      300,
      2 ** Math.min(message.attempts, 8),
    );

    const rows = await this.em.fork().execute<
      Array<{ id: string }>
    >(
      `
      UPDATE outbox_messages
      SET
        next_attempt_at =
          NOW() + (? * INTERVAL '1 second'),
        claimed_by = NULL,
        claim_token = NULL,
        claimed_until = NULL
      WHERE id = ?
        AND status = 'PENDING'
        AND claimed_by = ?
        AND claim_token = ?
        AND claimed_until > NOW()
      RETURNING id
      `,
      [
        delaySeconds,
        message.id,
        workerId,
        message.claimToken,
      ],
      'all',
    );

    return rows.length === 1;
  }
}
