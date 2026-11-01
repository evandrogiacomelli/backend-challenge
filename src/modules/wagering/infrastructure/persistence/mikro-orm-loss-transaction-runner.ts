
import { randomUUID } from 'node:crypto';

import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import { Money } from '../../../../shared/domain/money.js';

import {
  InboxAlreadyProcessedError,
  InboxIncompleteError,
  InboxPayloadConflictError,
  type InboxReceipt,
} from '../../application/ports/bet-transaction-runner.js';

import {
  LossIdentityConflictError,
  LossWriteConflictError,
  type LockedLossContext,
  type LossIdentity,
  type LossPersistenceDetails,
  type LossResponseSnapshot,
  type LossTransactionRunner,
  type StoredLoss,
} from '../../application/ports/loss-transaction-runner.js';

import type {
  WagerTransaction,
} from '../../domain/wager-transaction.js';

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance_amount: string;
  version: number;
}

interface WagerRow {
  kind: string;
  idempotency_key: string;
  external_transaction_id: string;
  payload_hash: string;
  response_snapshot: LossResponseSnapshot | null;
}

function pgErrorCode(
  error: unknown,
): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const candidate = error as {
    code?: string;
    driverException?: {
      code?: string;
    };
    cause?: {
      code?: string;
    };
  };

  return (
    candidate.code ??
    candidate.driverException?.code ??
    candidate.cause?.code
  );
}

@Injectable()
export class MikroOrmLossTransactionRunner
  implements LossTransactionRunner {

  constructor(
    private readonly em: EntityManager,
  ) {}

  private async findExistingIn(
    em: EntityManager,
    identity: LossIdentity,
  ): Promise<StoredLoss | null> {
    const rows = await em.execute<WagerRow[]>(
      `
          SELECT
              kind,
              idempotency_key,
              external_transaction_id,
              payload_hash,
              response_snapshot
          FROM wager_transactions
          WHERE provider_id = ?
            AND (
              idempotency_key = ?
                  OR external_transaction_id = ?
              )
              LIMIT 2
      `,
      [
        identity.providerId,
        identity.idempotencyKey,
        identity.externalTransactionId,
      ],
      'all',
    );

    if (rows.length === 0) {
      return null;
    }

    if (
      rows.length > 1 ||
      rows[0]!.kind !== 'LOSS'
    ) {
      throw new LossIdentityConflictError(
        'IDEMPOTENCY_KEY_CONFLICT',
      );
    }

    const row = rows[0]!;

    return {
      externalTransactionId:
      row.external_transaction_id,
      idempotencyKey:
      row.idempotency_key,
      payloadHash:
      row.payload_hash,
      snapshot:
      row.response_snapshot,
    };
  }

  async findExisting(
    identity: LossIdentity,
  ): Promise<StoredLoss | null> {
    return this.findExistingIn(
      this.em.fork(),
      identity,
    );
  }

  private async insertInbox(
    em: EntityManager,
    inbox: InboxReceipt,
  ): Promise<void> {
    const inserted = await em.execute<
      Array<{ id: string }>
    >(
      `
          INSERT INTO inbox_messages (
              id,
              consumer_name,
              message_id,
              payload_hash,
              received_at
          )
          VALUES (?, ?, ?, ?, NOW())
              ON CONFLICT (consumer_name, message_id)
      DO NOTHING
      RETURNING id
      `,
      [
        randomUUID(),
        inbox.consumerName,
        inbox.messageId,
        inbox.payloadHash,
      ],
      'all',
    );

    if (inserted.length > 0) {
      return;
    }

    const rows = await em.execute<
      Array<{
        payload_hash: string;
        processed_at: Date | string | null;
      }>
    >(
      `
          SELECT
              payload_hash,
              processed_at
          FROM inbox_messages
          WHERE consumer_name = ?
            AND message_id = ?
      `,
      [
        inbox.consumerName,
        inbox.messageId,
      ],
      'all',
    );

    const previous = rows[0];

    if (!previous) {
      throw new InboxIncompleteError();
    }

    if (
      previous.payload_hash !==
      inbox.payloadHash
    ) {
      throw new InboxPayloadConflictError();
    }

    if (previous.processed_at !== null) {
      throw new InboxAlreadyProcessedError();
    }

    throw new InboxIncompleteError();
  }

  async withLockedWallet<T>(
    walletId: string,
    identity: LossIdentity,
    operation: (
      context: LockedLossContext,
    ) => Promise<T>,
    inbox?: InboxReceipt,
  ): Promise<T> {
    try {
      return await this.em.fork().transactional(
        async (tx) => {
          // Inbox participates in the same SQL
          // transaction as LOSS and Outbox.
          if (inbox) {
            await this.insertInbox(tx, inbox);
          }

          // Serialize financial operations
          // for the same wallet.
          const rows = await tx.execute<
            WalletRow[]
          >(
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
            [walletId],
            'all',
          );

          const row = rows[0];

          if (!row) {
            throw new Error(
              'Wallet not found',
            );
          }

          const wallet = {
            id: row.id,
            playerId: row.player_id,
            currency: row.currency,
            balance: Money.from({
              amount: String(
                row.balance_amount,
              ),
              currency: row.currency,
            }),
            version: Number(
              row.version,
            ),
          };

          const existing =
            await this.findExistingIn(
              tx,
              identity,
            );

          const context: LockedLossContext = {
            wallet,
            existing,

            saveProcessed: async (
              transaction: WagerTransaction,
              snapshot: LossResponseSnapshot,
              details: LossPersistenceDetails,
            ): Promise<void> => {
              if (existing) {
                throw new Error(
                  'Cannot persist an existing LOSS',
                );
              }

              // LOSS does not change wallet balance.
              // LOSS does not increment version.
              // LOSS does not create ledger entries.

              await tx.execute(
                `
                    INSERT INTO wager_transactions (
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
                        amount,
                        currency,
                        resulting_balance_amount,
                        resulting_balance_currency,
                        response_snapshot,
                        processed_at
                    )
                    VALUES (
                               ?, ?, ?, ?, ?,
                               ?, ?, ?, ?,
                               'LOSS',
                               'PROCESSED',
                               ?, ?, ?, ?,
                               ?::jsonb,
                               NOW()
                           )
                `,
                [
                  transaction.id,
                  identity.providerId,
                  identity.externalTransactionId,
                  identity.idempotencyKey,
                  identity.payloadHash,
                  wallet.id,
                  wallet.playerId,
                  details.roundId,
                  details.gameId,
                  details.amount.toJSON().amount,
                  details.amount.currency,
                  wallet.balance.toJSON().amount,
                  wallet.currency,
                  JSON.stringify(snapshot),
                ],
              );

              const eventId = randomUUID();
              const occurredAt = new Date();

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
                               'PENDING',
                               0,
                               NOW(),
                               NOW(),
                               NOW()
                           )
                `,
                [
                  eventId,
                  wallet.id,
                  'wager.loss.processed.v1',
                  JSON.stringify({
                    eventId,
                    schemaVersion: 1,
                    walletId: wallet.id,
                    transactionId:
                    transaction.id,
                    kind: 'LOSS',
                    amount:
                      details.amount.toJSON(),
                    balance:
                    snapshot.balance,
                    walletVersion:
                    snapshot.walletVersion,
                    occurredAt:
                      occurredAt.toISOString(),
                  }),
                ],
              );
            },
          };

          const result = await operation(
            context,
          );

          if (inbox) {
            await tx.execute(
              `
                  UPDATE inbox_messages
                  SET processed_at = NOW()
                  WHERE consumer_name = ?
                    AND message_id = ?
                    AND processed_at IS NULL
              `,
              [
                inbox.consumerName,
                inbox.messageId,
              ],
            );
          }

          return result;
        },
      );
    } catch (error) {
      if (
        pgErrorCode(error) === '23505'
      ) {
        throw new LossWriteConflictError();
      }

      throw error;
    }
  }
}
