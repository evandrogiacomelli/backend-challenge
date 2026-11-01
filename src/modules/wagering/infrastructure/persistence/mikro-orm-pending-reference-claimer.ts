import { Injectable } from '@nestjs/common';

import {
  EntityManager,
} from '@mikro-orm/postgresql';

import {
  type ClaimPendingReferencesInput,
  type PendingReferenceClaim,
  type PendingReferenceClaimer,
  type PendingReferenceKind,
} from '../../application/ports/pending-reference-claimer.js';

interface PendingReferenceRow {
  id: string;

  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;

  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;

  kind: PendingReferenceKind;

  amount: string;
  currency: string;

  reference_external_transaction_id: string;

  attempts: number;
  next_attempt_at: Date;
}

@Injectable()
export class MikroOrmPendingReferenceClaimer
  implements PendingReferenceClaimer
{
  constructor(
    private readonly em: EntityManager,
  ) {}

  async claimDue(
    input: ClaimPendingReferencesInput,
  ): Promise<PendingReferenceClaim[]> {
    this.validate(input);

    return this.em.transactional(
      async (tx) => {
        const rows = await tx.execute<
          PendingReferenceRow[]
        >(
          `
            WITH candidates AS (
              SELECT t.id
              FROM wager_transactions t
              WHERE t.status = 'PENDING_REFERENCE'

                AND t.kind IN (
                  'REFUND',
                  'ROLLBACK'
                )

                AND (
                  t.next_attempt_at IS NULL
                  OR t.next_attempt_at <= NOW()
                )

                AND (
                  ?::text IS NULL
                  OR t.provider_id = ?
                )

              ORDER BY
                t.next_attempt_at ASC NULLS FIRST,
                t.created_at ASC,
                t.id ASC

              FOR UPDATE OF t SKIP LOCKED

              LIMIT ?
            )

            UPDATE wager_transactions AS t
            SET
              attempts = t.attempts + 1,

              next_attempt_at =
                NOW() + (? * INTERVAL '1 second')

            FROM candidates
            WHERE t.id = candidates.id

            RETURNING
              t.id::text AS id,

              t.provider_id,
              t.external_transaction_id,
              t.idempotency_key,
              t.payload_hash,

              t.wallet_id::text AS wallet_id,
              t.player_id::text AS player_id,
              t.round_id,
              t.game_id,

              t.kind,

              t.amount::text AS amount,
              t.currency,

              t.reference_external_transaction_id,

              t.attempts,
              t.next_attempt_at
          `,
          [
            input.providerId ?? null,
            input.providerId ?? null,
            input.limit,
            input.leaseSeconds,
          ],
          'all',
        );

        return rows.map((row) => ({
          id: row.id,

          providerId: row.provider_id,

          externalTransactionId:
          row.external_transaction_id,

          idempotencyKey:
          row.idempotency_key,

          payloadHash:
          row.payload_hash,

          walletId: row.wallet_id,
          playerId: row.player_id,
          roundId: row.round_id,
          gameId: row.game_id,

          kind: row.kind,

          amount: row.amount,
          currency: row.currency,

          referenceExternalTransactionId:
          row.reference_external_transaction_id,

          attempts: Number(row.attempts),

          nextAttemptAt: row.next_attempt_at,
        }));
      },
    );
  }

  private validate(
    input: ClaimPendingReferencesInput,
  ): void {
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) {
      throw new Error(
        'Pending reference batch limit must be between 1 and 100',
      );
    }

    if (
      !Number.isInteger(input.leaseSeconds) ||
      input.leaseSeconds < 1 ||
      input.leaseSeconds > 3600
    ) {
      throw new Error(
        'Pending reference lease must be between 1 and 3600 seconds',
      );
    }

    if (
      input.providerId !== undefined &&
      input.providerId.trim().length === 0
    ) {
      throw new Error(
        'Invalid pending reference provider',
      );
    }
  }
}
