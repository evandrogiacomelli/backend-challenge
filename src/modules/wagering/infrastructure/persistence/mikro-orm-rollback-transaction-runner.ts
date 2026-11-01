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
  RollbackIdentityConflictError,
  RollbackWriteConflictError,
  type LockedRollbackContext,
  type RollbackIdentity,
  type RollbackPersistenceDetails,
  type RollbackResponseSnapshot,
  type RollbackTransactionRunner,
  type RollbackWalletView,
  type StoredRollback,
} from '../../application/ports/rollback-transaction-runner.js';

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
  kind: string;
  idempotency_key: string;
  external_transaction_id: string;
  payload_hash: string;
  response_snapshot: RollbackResponseSnapshot | null;
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
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
}

class LockedRollbackWallet
  implements RollbackWalletView
{
  private balanceValue: Money;
  private versionValue: number;

  constructor(
    private readonly row: WalletRow,
  ) {
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
      throw new Error('Invalid ROLLBACK credit');
    }

    const balanceBefore = this.balanceValue;

    this.balanceValue = this.balanceValue.add(money);
    this.versionValue++;

    return {
      balanceBefore,
      balanceAfter: this.balanceValue,
    };
  }


  debit(
    money: Money,
  ): {
    balanceBefore: Money;
    balanceAfter: Money;
  } {
    if (
      money.currency !== this.currency ||
      !money.isPositive()
    ) {
      throw new Error('Invalid ROLLBACK debit');
    }

    // Never allow a compensating debit to
    // produce a negative wallet balance.
    if (this.balanceValue.isLessThan(money)) {
      throw new Error('Insufficient wallet balance');
    }

    const balanceBefore = this.balanceValue;

    this.balanceValue = this.balanceValue.subtract(money);
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
  if (
    !error ||
    typeof error !== 'object'
  ) {
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
export class MikroOrmRollbackTransactionRunner
  implements RollbackTransactionRunner
{
  constructor(
    private readonly em: EntityManager,
  ) {}

  private async findExistingIn(
    em: EntityManager,
    identity: RollbackIdentity,
  ): Promise<StoredRollback | null> {
    const rows = await em.execute<IdentityRow[]>(
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
      rows[0]!.kind !== 'ROLLBACK'
    ) {
      throw new RollbackIdentityConflictError(
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
    identity: RollbackIdentity,
  ): Promise<StoredRollback | null> {
    return this.findExistingIn(
      this.em.fork(),
      identity,
    );
  }

  private async findReference(
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
          processed_at,
          reference_external_transaction_id,
          reference_transaction_id
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
      idempotencyKey:
      row.idempotency_key,
      payloadHash:
      row.payload_hash,
      walletId: row.wallet_id,
      playerId: row.player_id,
      roundId: row.round_id,
      gameId: row.game_id,

      kind:
        row.kind as WagerTransactionKind,

      status:
        row.status as WagerTransactionStatus,

      money: Money.from({
        amount: String(row.amount),
        currency: row.currency,
      }),

      referenceExternalTransactionId:
        row.reference_external_transaction_id ??
        undefined,

      referenceTransactionId:
        row.reference_transaction_id ??
        undefined,

      createdAt: new Date(row.created_at),

      processedAt: row.processed_at
        ? new Date(row.processed_at)
        : undefined,

      attempts: 0,
    });
  }

  private async isAlreadyReversed(
    em: EntityManager,
    referenceId: string,
  ): Promise<boolean> {
    const rows = await em.execute<
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
      [referenceId],
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
        ON CONFLICT (
          consumer_name,
          message_id
        )
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

    if (inserted.length !== 0) {
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
    identity: RollbackIdentity,
    referenceExternalTransactionId: string,
    operation: (
      context: LockedRollbackContext,
    ) => Promise<T>,
    inbox?: InboxReceipt,
  ): Promise<T> {
    try {
      return await this.em.fork().transactional(
        async (tx) => {
          if (inbox) {
            await this.insertInbox(
              tx,
              inbox,
            );
          }

          // All financial changes for a wallet
          // are serialized by this row lock.
          const rows =
            await tx.execute<WalletRow[]>(
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
            throw new Error(
              'Wallet not found',
            );
          }

          const wallet =
            new LockedRollbackWallet(initial);

          const existing =
            await this.findExistingIn(
              tx,
              identity,
            );

          const referenceTransaction = existing
            ? null
            : await this.findReference(
              tx,
              identity.providerId,
              referenceExternalTransactionId,
            );

          const alreadyReversed =
            existing || !referenceTransaction
              ? false
              : await this.isAlreadyReversed(
                tx,
                referenceTransaction.id,
              );

          const context: LockedRollbackContext = {
            wallet,
            existing,
            referenceTransaction,
            alreadyReversed,


            saveRejected: async (
              transaction: WagerTransaction,
              snapshot: RollbackResponseSnapshot,
            ): Promise<void> => {
              if (existing) {
                throw new Error('Cannot reject an existing ROLLBACK identity');
              }

              if (
                !referenceTransaction ||
                transaction.status !== WagerTransactionStatus.Rejected ||
                transaction.failureCode !== 'ROLLBACK_INSUFFICIENT_FUNDS' ||
                snapshot.status !== WagerTransactionStatus.Rejected ||
                snapshot.failureCode !== transaction.failureCode ||
                snapshot.transactionId !== transaction.id ||
                snapshot.walletVersion !== wallet.version ||
                snapshot.balance.amount !== wallet.balance.toJSON().amount ||
                snapshot.balance.currency !== wallet.currency ||
                transaction.walletId !== wallet.id ||
                transaction.playerId !== wallet.playerId ||
                transaction.money.currency !== wallet.currency
              ) {
                throw new Error('Invalid rejected ROLLBACK context');
              }

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
                    reference_external_transaction_id,
                    reference_transaction_id,
                    failure_code,
                    response_snapshot,
                    created_at
                  )
                  VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    'ROLLBACK', 'REJECTED',
                    ?, ?, ?, ?, ?, ?::jsonb, NOW()
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
                  transaction.roundId,
                  transaction.gameId,
                  transaction.money.toJSON().amount,
                  transaction.money.currency,
                  transaction.referenceExternalTransactionId,
                  referenceTransaction.id,
                  transaction.failureCode,
                  JSON.stringify(snapshot),
                ],
              );

              const eventId = randomUUID();
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
                  'wager.rollback.rejected.v1',
                  JSON.stringify({
                    eventId,
                    schemaVersion: 1,
                    walletId: wallet.id,
                    transactionId: transaction.id,
                    providerId: identity.providerId,
                    externalTransactionId: identity.externalTransactionId,
                    referenceTransactionId: referenceTransaction.id,
                    referenceExternalTransactionId:
                      transaction.referenceExternalTransactionId,
                    kind: 'ROLLBACK',
                    status: 'REJECTED',
                    failureCode: transaction.failureCode,
                    amount: transaction.money.toJSON(),
                    balance: snapshot.balance,
                    walletVersion: snapshot.walletVersion,
                    occurredAt: new Date().toISOString(),
                  }),
                ],
              );
            },

            savePendingReference: async (
              transaction: WagerTransaction,
              snapshot: RollbackResponseSnapshot,
            ): Promise<void> => {
              if (existing) {
                throw new Error(
                  'Cannot create a pending ROLLBACK for an existing identity',
                );
              }

              if (
                transaction.status !==
                WagerTransactionStatus.PendingReference
              ) {
                throw new Error(
                  'ROLLBACK must be PENDING_REFERENCE',
                );
              }

              if (
                transaction.walletId !== wallet.id ||
                transaction.playerId !== wallet.playerId ||
                transaction.money.currency !== wallet.currency
              ) {
                throw new Error(
                  'Pending ROLLBACK wallet context mismatch',
                );
              }

              if (
                !transaction.referenceExternalTransactionId
              ) {
                throw new Error(
                  'Pending ROLLBACK reference is missing',
                );
              }

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
                    reference_external_transaction_id,
                    response_snapshot,
                    attempts,
                    next_attempt_at,
                    created_at
                  )
                  VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    'ROLLBACK',
                    'PENDING_REFERENCE',
                    ?, ?, ?, ?::jsonb,
                    0,
                    NOW(),
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
                  transaction.roundId,
                  transaction.gameId,
                  transaction.money.toJSON().amount,
                  transaction.money.currency,
                  transaction.referenceExternalTransactionId,
                  JSON.stringify(snapshot),
                ],
              );
            },

            saveProcessed: async (
              transaction: WagerTransaction,
              ledger: WalletLedgerEntry,
              snapshot: RollbackResponseSnapshot,
              details: RollbackPersistenceDetails,
            ): Promise<void> => {
              if (existing) {
                throw new Error(
                  'Cannot persist ROLLBACK for an existing identity',
                );
              }

              if (
                !referenceTransaction ||
                referenceTransaction.id !==
                details.referenceTransactionId
              ) {
                throw new Error(
                  'ROLLBACK reference changed',
                );
              }

              if (alreadyReversed) {
                throw new Error(
                  'Transaction already reversed',
                );
              }

              if (
                transaction.referenceTransactionId !==
                referenceTransaction.id
              ) {
                throw new Error(
                  'ROLLBACK domain reference was not validated',
                );
              }

              if (
                ledger.direction !==
                details.direction
              ) {
                throw new Error(
                  'ROLLBACK ledger direction mismatch',
                );
              }

              // Wallet update and all inserts
              // participate in this SQL transaction.
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
                    'ROLLBACK', 'PROCESSED',
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
                  details.referenceExternalTransactionId,
                  details.referenceTransactionId,
                  wallet.balance.toJSON().amount,
                  wallet.currency,
                  JSON.stringify(snapshot),
                ],
              );

              // The commit 19 trigger assigns
              // the next immutable ledger position.
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
                    ?, ?, ?, ?, ?, ?, ?, ?, NOW()
                  )
                `,
                [
                  ledger.id,
                  wallet.id,
                  transaction.id,
                  details.direction,
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
                  'wager.rollback.processed.v1',
                  JSON.stringify({
                    eventId,
                    schemaVersion: 1,

                    walletId: wallet.id,
                    transactionId:
                    transaction.id,

                    providerId:
                    identity.providerId,

                    externalTransactionId:
                    identity.externalTransactionId,

                    referenceExternalTransactionId:
                    details.referenceExternalTransactionId,

                    referenceTransactionId:
                    details.referenceTransactionId,

                    kind: 'ROLLBACK',
                    direction:
                    details.direction,

                    amount:
                      details.amount.toJSON(),

                    balance:
                    snapshot.balance,

                    walletVersion:
                    snapshot.walletVersion,

                    occurredAt:
                      now.toISOString(),
                  }),
                ],
              );
            },
          };

          const result =
            await operation(context);

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
      // Unique violations may indicate
      // concurrent identity or reference races.
      // Do not hide ledger arithmetic failures.
      if (
        pgErrorCode(error) === '23505'
      ) {
        throw new RollbackWriteConflictError();
      }

      throw error;
    }
  }
}
