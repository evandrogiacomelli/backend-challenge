import { randomUUID } from 'node:crypto';

import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import { Money } from '../../../../shared/domain/money.js';

import type {
  WalletLedgerEntry,
} from '../../../ledger/domain/wallet-ledger-entry.js';

import {
  InboxAlreadyProcessedError,
  InboxIncompleteError,
  InboxPayloadConflictError,
  type InboxReceipt,
} from '../../application/ports/bet-transaction-runner.js';

import {
  RefundIdentityConflictError,
  RefundWriteConflictError,
  type LockedRefundContext,
  type RefundIdentity,
  type RefundPersistenceDetails,
  type RefundResponseSnapshot,
  type RefundTransactionRunner,
  type RefundWalletView,
  type StoredRefund,
} from '../../application/ports/refund-transaction-runner.js';

import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction.js';

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance_amount: string;
  version: number;
}

interface IdentityRow {
  id: string;
  kind: string;
  idempotency_key: string;
  external_transaction_id: string;
  payload_hash: string;
  response_snapshot: RefundResponseSnapshot | null;
}

interface ReferenceRow {
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
  created_at: Date | string;
  processed_at: Date | string | null;
}

class LockedRefundWallet implements RefundWalletView {
  private balanceValue: Money;
  private versionValue: number;

  constructor(private readonly row: WalletRow) {
    this.balanceValue = Money.from({
      amount: String(row.balance_amount),
      currency: row.currency,
    });

    this.versionValue = Number(row.version);
  }

  get id(): string {
    return this.row.id;
  }

  get playerId(): string {
    return this.row.player_id;
  }

  get currency(): string {
    return this.row.currency;
  }

  get balance(): Money {
    return this.balanceValue;
  }

  get version(): number {
    return this.versionValue;
  }

  credit(
    money: Money,
  ): {
    balanceBefore: Money;
    balanceAfter: Money;
  } {
    if (
      money.currency !== this.currency ||
      !money.isPositive()
    ) {
      throw new Error('Invalid REFUND money');
    }

    const balanceBefore = this.balanceValue;

    this.balanceValue = this.balanceValue.add(money);
    this.versionValue += 1;

    return {
      balanceBefore,
      balanceAfter: this.balanceValue,
    };
  }
}

function pgErrorCode(
  error: unknown,
): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const candidate = error as {
    code?: string;
    driverException?: { code?: string };
    cause?: { code?: string };
  };

  return (
    candidate.code ??
    candidate.driverException?.code ??
    candidate.cause?.code
  );
}

@Injectable()
export class MikroOrmRefundTransactionRunner
  implements RefundTransactionRunner
{
  constructor(
    private readonly em: EntityManager,
  ) {}

  private async findExistingIn(
    em: EntityManager,
    identity: RefundIdentity,
  ): Promise<StoredRefund | null> {
    const rows = await em.execute<IdentityRow[]>(
      `
        SELECT
          id,
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
      rows[0]!.kind !== 'REFUND'
    ) {
      throw new RefundIdentityConflictError(
        'IDEMPOTENCY_KEY_CONFLICT',
      );
    }

    const row = rows[0]!;

    return {
      externalTransactionId:
      row.external_transaction_id,
      idempotencyKey: row.idempotency_key,
      payloadHash: row.payload_hash,
      snapshot: row.response_snapshot,
    };
  }

  async findExisting(
    identity: RefundIdentity,
  ): Promise<StoredRefund | null> {
    return this.findExistingIn(
      this.em.fork(),
      identity,
    );
  }

  private async findReferenceBet(
    em: EntityManager,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const rows = await em.execute<ReferenceRow[]>(
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
          amount,
          currency,
          created_at,
          processed_at
        FROM wager_transactions
        WHERE provider_id = ?
          AND external_transaction_id = ?
        LIMIT 1
      `,
      [
        providerId,
        externalTransactionId,
      ],
      'all',
    );

    const row = rows[0];

    if (!row) {
      return null;
    }

    return WagerTransaction.rehydrate({
      id: row.id,
      providerId: row.provider_id,
      externalTransactionId:
      row.external_transaction_id,
      idempotencyKey: row.idempotency_key,
      payloadHash: row.payload_hash,
      walletId: row.wallet_id,
      playerId: row.player_id,
      roundId: row.round_id,
      gameId: row.game_id,

      kind: row.kind as WagerTransactionKind,
      status: row.status as WagerTransactionStatus,

      money: Money.from({
        amount: String(row.amount),
        currency: row.currency,
      }),

      createdAt: new Date(row.created_at),
      processedAt: row.processed_at
        ? new Date(row.processed_at)
        : undefined,

      attempts: 0,
    });
  }

  private async isAlreadyRefunded(
    em: EntityManager,
    referenceBetId: string,
  ): Promise<boolean> {
    const rows = await em.execute<
      Array<{ id: string }>
    >(
      `
        SELECT id
        FROM wager_transactions
        WHERE kind = 'REFUND'
          AND reference_transaction_id = ?
        LIMIT 1
      `,
      [referenceBetId],
      'all',
    );

    return rows.length > 0;
  }

  private async insertInbox(
    em: EntityManager,
    inbox: InboxReceipt,
  ): Promise<void> {
    const inserted = await em.execute<
      Array<{ id: string }>
    >(
      `
        INSERT INTO inbox_messages
          (
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

    const found = await em.execute<
      Array<{
        payload_hash: string;
        processed_at: string | Date | null;
      }>
    >(
      `
        SELECT payload_hash, processed_at
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

    const previous = found[0];

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
    identity: RefundIdentity,
    referenceExternalTransactionId: string,
    operation: (
      context: LockedRefundContext,
    ) => Promise<T>,
    inbox?: InboxReceipt,
  ): Promise<T> {
    try {
      return await this.em.fork().transactional(
        async (tx) => {
          if (inbox) {
            await this.insertInbox(tx, inbox);
          }

          // Serialize all financial operations
          // on the same wallet.
          const rows = await tx.execute<WalletRow[]>(
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

          const initial = rows[0];

          if (!initial) {
            throw new Error('Wallet not found');
          }

          const wallet = new LockedRefundWallet(
            initial,
          );

          const existing =
            await this.findExistingIn(
              tx,
              identity,
            );

          // These reads happen after the wallet
          // lock, inside the same SQL transaction.
          const referenceBet = existing
            ? null
            : await this.findReferenceBet(
              tx,
              identity.providerId,
              referenceExternalTransactionId,
            );

          const alreadyRefunded =
            existing || !referenceBet
              ? false
              : await this.isAlreadyRefunded(
                tx,
                referenceBet.id,
              );

          const context: LockedRefundContext = {
            wallet,
            existing,
            referenceBet,
            alreadyRefunded,

            saveProcessed: async (
              transaction: WagerTransaction,
              snapshot: RefundResponseSnapshot,
              details: RefundPersistenceDetails,
              ledger: WalletLedgerEntry,
            ) => {
              if (existing) {
                throw new Error(
                  'Cannot persist REFUND for existing identity',
                );
              }

              if (
                !referenceBet ||
                referenceBet.id !==
                details.referenceBetTransactionId
              ) {
                throw new Error(
                  'REFUND reference changed',
                );
              }

              if (alreadyRefunded) {
                throw new Error(
                  'BET already refunded',
                );
              }

              if (
                transaction.referenceTransactionId !==
                referenceBet.id
              ) {
                throw new Error(
                  'REFUND domain reference was not validated',
                );
              }

              // Optimistic version check combined
              // with SELECT FOR UPDATE.
              const updated = await tx.execute<
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
                  wallet.balance.toJSON().amount,
                  wallet.version,
                  wallet.id,
                  Number(initial.version),
                ],
                'all',
              );

              if (updated.length !== 1) {
                throw new Error(
                  'Wallet version changed while locked',
                );
              }

              // REFUND references the original BET
              // using both internal and external IDs.
              await tx.execute(
                `
                  INSERT INTO wager_transactions
                    (
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
                      reference_external_transaction_id,
                      reference_transaction_id,
                      resulting_balance_amount,
                      resulting_balance_currency,
                      response_snapshot,
                      processed_at
                    )
                  VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    'REFUND', 'PROCESSED',
                    ?, ?, ?, ?, ?, ?, ?::jsonb, NOW()
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
                  transaction.referenceExternalTransactionId,
                  details.referenceBetTransactionId,
                  wallet.balance.toJSON().amount,
                  wallet.currency,
                  JSON.stringify(snapshot),
                ],
              );

              // Commit 19 trigger assigns the
              // immutable next ledger sequence.
              await tx.execute(
                `
                  INSERT INTO wallet_ledger_entries
                    (
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
                    ?, ?, ?, 'CREDIT',
                    ?, ?, ?, ?, NOW()
                  )
                `,
                [
                  ledger.id,
                  wallet.id,
                  transaction.id,
                  details.amount.toJSON().amount,
                  wallet.currency,
                  details.balanceBefore.toJSON().amount,
                  wallet.balance.toJSON().amount,
                ],
              );

              const eventId = randomUUID();
              const now = new Date();

              await tx.execute(
                `
                  INSERT INTO outbox_messages
                    (
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
                  'wager.refund.processed.v1',
                  JSON.stringify({
                    eventId,
                    schemaVersion: 1,
                    walletId: wallet.id,
                    transactionId: transaction.id,
                    providerId: identity.providerId,
                    externalTransactionId:
                    identity.externalTransactionId,
                    referenceExternalTransactionId,
                    referenceTransactionId:
                    details.referenceBetTransactionId,
                    kind: 'REFUND',
                    amount: details.amount.toJSON(),
                    balance: snapshot.balance,
                    walletVersion:
                    snapshot.walletVersion,
                    occurredAt: now.toISOString(),
                  }),
                ],
              );
            },
          };

          const result = await operation(context);

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
      // Only uniqueness conflicts are
      // replay-eligible. Other SQL failures
      // must propagate without being hidden.
      if (pgErrorCode(error) === '23505') {
        throw new RefundWriteConflictError();
      }

      throw error;
    }
  }
}
