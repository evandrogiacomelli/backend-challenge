import { randomUUID } from 'node:crypto';

import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import { Money } from '../../../../shared/domain/money.js';

import type {
  PendingReferenceClaim,
} from '../../application/ports/pending-reference-claimer.js';

import type {
  PendingReferenceRecovery,
  PendingReferenceRecoveryResult,
} from '../../application/ports/pending-reference-recovery.js';

import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction.js';
import { pendingReferenceRetrySeconds } from '../../application/policies/pending-reference-retry-policy.js';

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance_amount: string;
  version: number;
}

interface TransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;

  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;

  kind: string;
  status: string;

  amount: string;
  currency: string;

  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;

  attempts: number;
  next_attempt_at: Date | string | null;

  created_at: Date | string;
  processed_at: Date | string | null;
}

type RecoveryStatus =
  PendingReferenceRecoveryResult['status'];

const MAX_REFERENCE_ATTEMPTS = 10;

@Injectable()
export class MikroOrmPendingReferenceRecovery
  implements PendingReferenceRecovery
{
  constructor(
    private readonly em: EntityManager,
  ) {}

  async recover(
    claim: PendingReferenceClaim,
  ): Promise<PendingReferenceRecoveryResult> {
    return this.em.fork().transactional(
      async (tx) => {
        const outcome = (
          status: RecoveryStatus,
        ): PendingReferenceRecoveryResult => ({
          transactionId: claim.id,
          status,
        });

        // Lock order:
        // 1. Wallet
        // 2. Pending transaction
        //
        // Matches the existing financial runners.
        const wallets = await tx.execute<WalletRow[]>(
          `
              SELECT
                  id,
                  player_id,
                  currency,
                  balance_amount,
                  version
              FROM wallets
              WHERE id = ?
                  FOR UPDATE
          `,
          [claim.walletId],
          'all',
        );

        const wallet = wallets[0];

        if (!wallet) {
          throw new Error(
            'Pending reference wallet not found',
          );
        }

        const pendingRows =
          await tx.execute<TransactionRow[]>(
            `
                SELECT
                    id,
                    provider_id,
                    external_transaction_id,
                    idempotency_key,
                    payload_hash,
                    wallet_id,
                    player_id,
                    round_id,
                    game_id,
                    kind,
                    status,
                    amount::text AS amount,
                    currency,
                    reference_external_transaction_id,
                    reference_transaction_id,
                    attempts,
                    next_attempt_at,
                    created_at,
                    processed_at
                FROM wager_transactions
                WHERE id = ?
                    FOR UPDATE
            `,
            [claim.id],
            'all',
          );

        const pending = pendingRows[0];

        if (
          !pending ||
          pending.status !== 'PENDING_REFERENCE' ||
          Number(pending.attempts) !== claim.attempts
        ) {
          return outcome('STALE_CLAIM');
        }

        // Protect against incorrect/stale claim data.
        if (
          pending.wallet_id !== claim.walletId ||
          pending.provider_id !== claim.providerId ||
          pending.external_transaction_id !==
          claim.externalTransactionId ||
          pending.idempotency_key !==
          claim.idempotencyKey ||
          pending.payload_hash !== claim.payloadHash ||
          pending.reference_external_transaction_id !==
          claim.referenceExternalTransactionId ||
          pending.kind !== claim.kind ||
          pending.player_id !== claim.playerId
        ) {
          return outcome('STALE_CLAIM');
        }

        if (
          pending.kind !== 'REFUND' &&
          pending.kind !== 'ROLLBACK'
        ) {
          return outcome('STALE_CLAIM');
        }

        // A lease must still be active.
        const activeLease = await tx.execute<
          Array<{ active: boolean }>
        >(
          `
              SELECT (
                         next_attempt_at IS NOT NULL
                             AND next_attempt_at > NOW()
                         ) AS active
              FROM wager_transactions
              WHERE id = ?
          `,
          [claim.id],
          'all',
        );

        if (!activeLease[0]?.active) {
          return outcome('STALE_CLAIM');
        }

        const balanceBefore = Money.from({
          amount: String(wallet.balance_amount),
          currency: wallet.currency,
        });

        const money = Money.from({
          amount: String(pending.amount),
          currency: pending.currency,
        });

        const snapshot = (
          status: WagerTransactionStatus,
          balance: Money = balanceBefore,
          version = Number(wallet.version),
        ) => ({
          transactionId: pending.id,
          status,
          balance: balance.toJSON(),
          walletVersion: version,
        });


        const reject = async (
          failureCode: string,
        ): Promise<PendingReferenceRecoveryResult> => {
          const rejectedSnapshot = {
            ...snapshot(WagerTransactionStatus.Rejected),
            failureCode,
          };

          const updated = await tx.execute<
            Array<{ id: string }>
          >(
            `
                UPDATE wager_transactions
                SET
                    status = 'REJECTED',
                    failure_code = ?,
                    resulting_balance_amount = ?,
                    resulting_balance_currency = ?,
                    response_snapshot = ?::jsonb,
                next_attempt_at = NULL
                WHERE id = ?
                  AND status = 'PENDING_REFERENCE'
                  AND attempts = ?
                  AND next_attempt_at > NOW()
                    RETURNING id
            `,
            [
              failureCode,
              balanceBefore.toJSON().amount,
              wallet.currency,
              JSON.stringify(rejectedSnapshot),
              pending.id,
              claim.attempts,
            ],
            'all',
          );

          if (updated.length !== 1) {
            return outcome('STALE_CLAIM');
          }

          // The rejection and its event commit atomically.
          const eventId = randomUUID();
          const occurredAt = new Date().toISOString();

          await tx.execute(
            `
                INSERT INTO outbox_messages (
                    id,
                    aggregate_id,
                    event_type,
                    payload,
                    status,
                    attempts,
                    next_attempt_at,
                    occurred_at,
                    created_at
                )
                VALUES (
                           ?, ?, 'WagerTransactionRejected', ?::jsonb,
                           'PENDING', 0, NOW(), NOW(), NOW()
                       )
            `,
            [
              eventId,
              wallet.id,
              JSON.stringify({
                eventId,
                eventType: 'WagerTransactionRejected',
                version: 1,
                aggregateId: wallet.id,
                correlationId: pending.id,
                occurredAt,
                data: {
                  transactionId: pending.id,
                  walletId: wallet.id,
                  providerId: pending.provider_id,
                  externalTransactionId:
                  pending.external_transaction_id,
                  referenceExternalTransactionId:
                  pending.reference_external_transaction_id,
                  kind: pending.kind,
                  status: 'REJECTED',
                  failureCode,
                  attempts: Number(pending.attempts),
                  money: money.toJSON(),
                  balance: rejectedSnapshot.balance,
                  walletVersion: rejectedSnapshot.walletVersion,
                },
              }),
            ],
          );

          return outcome('REJECTED');
        };

        const retry = async (
          failureCodeOnExhaustion: string,
        ): Promise<PendingReferenceRecoveryResult> => {
          // The claimer increments attempts when acquiring the lease.
          if (
            Number(pending.attempts) >=
            MAX_REFERENCE_ATTEMPTS
          ) {
            return reject(failureCodeOnExhaustion);
          }

          const seconds = pendingReferenceRetrySeconds(
            Number(pending.attempts),
          );

          const updated = await tx.execute<
            Array<{ id: string }>
          >(
            `
                UPDATE wager_transactions
                SET
                    next_attempt_at =
                        NOW() + (? * INTERVAL '1 second')
                WHERE id = ?
                  AND status = 'PENDING_REFERENCE'
                  AND attempts = ?
                  AND next_attempt_at > NOW()
                    RETURNING id
            `,
            [
              seconds,
              pending.id,
              claim.attempts,
            ],
            'all',
          );

          return outcome(
            updated.length === 1
              ? 'RETRY_SCHEDULED'
              : 'STALE_CLAIM',
          );
        };

        if (
          wallet.player_id !== pending.player_id ||
          wallet.currency !== pending.currency
        ) {
          return reject('WALLET_CONTEXT_MISMATCH');
        }

        const referenceRows =
          await tx.execute<TransactionRow[]>(
            `
                SELECT
                    id,
                    provider_id,
                    external_transaction_id,
                    idempotency_key,
                    payload_hash,
                    wallet_id,
                    player_id,
                    round_id,
                    game_id,
                    kind,
                    status,
                    amount::text AS amount,
                    currency,
                    reference_external_transaction_id,
                    reference_transaction_id,
                    attempts,
                    next_attempt_at,
                    created_at,
                    processed_at
                FROM wager_transactions
                WHERE provider_id = ?
                  AND external_transaction_id = ?
                    LIMIT 1
            `,
            [
              pending.provider_id,
              pending.reference_external_transaction_id,
            ],
            'all',
          );

        const original = referenceRows[0];

        // Reference may arrive after the REFUND/ROLLBACK.
        if (!original) {
          return retry('REFERENCE_NOT_FOUND');
        }

        if (
          original.status === 'PENDING' ||
          original.status === 'PENDING_REFERENCE'
        ) {
          return retry('REFERENCE_NOT_PROCESSED');
        }

        if (
          original.status !== 'PROCESSED'
        ) {
          return reject(
            'REFERENCE_NOT_PROCESSED',
          );
        }

        if (
          original.id === pending.id ||
          original.wallet_id !== pending.wallet_id ||
          original.player_id !== pending.player_id ||
          original.round_id !== pending.round_id ||
          original.game_id !== pending.game_id ||
          original.currency !== pending.currency
        ) {
          return reject(
            'REFERENCE_CONTEXT_MISMATCH',
          );
        }

        const originalMoney = Money.from({
          amount: String(original.amount),
          currency: original.currency,
        });

        if (!money.equals(originalMoney)) {
          return reject(
            'REFERENCE_AMOUNT_MISMATCH',
          );
        }

        if (
          pending.kind === 'REFUND' &&
          original.kind !== 'BET'
        ) {
          return reject(
            'REFERENCE_IS_NOT_BET',
          );
        }

        if (
          pending.kind === 'ROLLBACK' &&
          ![
            'BET',
            'WIN',
            'REFUND',
          ].includes(original.kind)
        ) {
          return reject(
            'INVALID_ROLLBACK_REFERENCE',
          );
        }

        // A processed REFUND or ROLLBACK already
        // compensating this transaction is terminal.
        //
        // This also agrees with
        // uq_wager_processed_reversal.
        const reversals = await tx.execute<
          Array<{ id: string }>
        >(
          `
              SELECT id
              FROM wager_transactions
              WHERE reference_transaction_id = ?
                AND kind IN ('REFUND', 'ROLLBACK')
                AND status = 'PROCESSED'
                  LIMIT 1
          `,
          [original.id],
          'all',
        );

        if (reversals.length > 0) {
          return reject(
            'REFERENCE_ALREADY_REVERSED',
          );
        }

        const reference = WagerTransaction.rehydrate({
          id: original.id,
          providerId: original.provider_id,
          externalTransactionId:
          original.external_transaction_id,
          idempotencyKey: original.idempotency_key,
          payloadHash: original.payload_hash,
          walletId: original.wallet_id,
          playerId: original.player_id,
          roundId: original.round_id,
          gameId: original.game_id,
          kind: original.kind as WagerTransactionKind,
          status:
          WagerTransactionStatus.Processed,
          money: originalMoney,
          referenceExternalTransactionId:
            original.reference_external_transaction_id ??
            undefined,
          referenceTransactionId:
            original.reference_transaction_id ??
            undefined,
          createdAt: new Date(original.created_at),
          processedAt: original.processed_at
            ? new Date(original.processed_at)
            : undefined,
          attempts: Number(original.attempts),
        });

        const transaction =
          WagerTransaction.rehydrate({
            id: pending.id,
            providerId: pending.provider_id,
            externalTransactionId:
            pending.external_transaction_id,
            idempotencyKey: pending.idempotency_key,
            payloadHash: pending.payload_hash,
            walletId: pending.wallet_id,
            playerId: pending.player_id,
            roundId: pending.round_id,
            gameId: pending.game_id,
            kind:
              pending.kind as WagerTransactionKind,
            status:
            WagerTransactionStatus.PendingReference,
            money,
            referenceExternalTransactionId:
              pending.reference_external_transaction_id ??
              undefined,
            createdAt: new Date(pending.created_at),
            attempts: Number(pending.attempts),
            nextAttemptAt: pending.next_attempt_at
              ? new Date(pending.next_attempt_at)
              : undefined,
          });

        // Domain decides the compensating direction.
        const direction =
          transaction.ledgerDirectionFor(reference);

        if (!direction) {
          return reject(
            'INVALID_LEDGER_DIRECTION',
          );
        }

        // Insufficient balance may be temporary.
        // Retry rather than create a negative wallet.
        if (
          direction === 'DEBIT' &&
          balanceBefore.isLessThan(money)
        ) {
          return retry('ROLLBACK_INSUFFICIENT_FUNDS');
        }

        const balanceAfter =
          direction === 'CREDIT'
            ? balanceBefore.add(money)
            : balanceBefore.subtract(money);

        const nextVersion =
          Number(wallet.version) + 1;

        transaction.markProcessed({
          resultingBalance: balanceAfter,
          reference,
        });

        const response = snapshot(
          WagerTransactionStatus.Processed,
          balanceAfter,
          nextVersion,
        );

        // Update the EXISTING transaction.
        //
        // Recheck the lease here, immediately
        // before the financial writes.
        const finalized = await tx.execute<
          Array<{ id: string }>
        >(
          `
              UPDATE wager_transactions
              SET
                  status = 'PROCESSED',
                  reference_transaction_id = ?,
                  resulting_balance_amount = ?,
                  resulting_balance_currency = ?,
                  response_snapshot = ?::jsonb,
              failure_code = NULL,
              next_attempt_at = NULL,
              processed_at = NOW()
              WHERE id = ?
                AND status = 'PENDING_REFERENCE'
                AND attempts = ?
                AND next_attempt_at > NOW()
                  RETURNING id
          `,
          [
            original.id,
            balanceAfter.toJSON().amount,
            wallet.currency,
            JSON.stringify(response),
            pending.id,
            claim.attempts,
          ],
          'all',
        );

        if (finalized.length !== 1) {
          return outcome('STALE_CLAIM');
        }

        const updatedWallet = await tx.execute<
          Array<{ id: string }>
        >(
          `
              UPDATE wallets
              SET
                  balance_amount = ?,
                  version = ?,
                  updated_at = NOW()
              WHERE id = ?
                AND version = ?
                  RETURNING id
          `,
          [
            balanceAfter.toJSON().amount,
            nextVersion,
            wallet.id,
            Number(wallet.version),
          ],
          'all',
        );

        if (updatedWallet.length !== 1) {
          // Throwing rolls back the pending transition.
          throw new Error(
            'Wallet version changed during recovery',
          );
        }

        // Existing ledger trigger allocates
        // the next sequence number.
        await tx.execute(
          `
              INSERT INTO wallet_ledger_entries (
                  id,
                  wallet_id,
                  wager_transaction_id,
                  direction,
                  amount,
                  currency,
                  balance_before,
                  balance_after,
                  created_at
              )
              VALUES (
                         ?, ?, ?, ?, ?, ?, ?, ?, NOW()
                     )
          `,
          [
            randomUUID(),
            wallet.id,
            pending.id,
            direction,
            money.toJSON().amount,
            wallet.currency,
            balanceBefore.toJSON().amount,
            balanceAfter.toJSON().amount,
          ],
        );

        const eventId = randomUUID();
        const occurredAt = new Date();

        const eventType =
          pending.kind === 'REFUND'
            ? 'wager.refund.processed.v1'
            : 'wager.rollback.processed.v1';

        const payload = {
          eventId,
          schemaVersion: 1,
          walletId: wallet.id,
          transactionId: pending.id,
          providerId: pending.provider_id,
          externalTransactionId:
          pending.external_transaction_id,
          referenceExternalTransactionId:
          pending.reference_external_transaction_id,
          referenceTransactionId: original.id,
          kind: pending.kind,
          ...(pending.kind === 'ROLLBACK'
            ? { direction }
            : {}),
          amount: money.toJSON(),
          balance: response.balance,
          walletVersion: response.walletVersion,
          occurredAt: occurredAt.toISOString(),
        };

        await tx.execute(
          `
              INSERT INTO outbox_messages (
                  id,
                  aggregate_id,
                  event_type,
                  payload,
                  status,
                  attempts,
                  next_attempt_at,
                  occurred_at,
                  created_at
              )
              VALUES (
                         ?, ?, ?, ?::jsonb,
                         'PENDING', 0,
                         NOW(), NOW(), NOW()
                     )
          `,
          [
            eventId,
            wallet.id,
            eventType,
            JSON.stringify(payload),
          ],
        );

        return outcome('PROCESSED');
      },
    );
  }
}
