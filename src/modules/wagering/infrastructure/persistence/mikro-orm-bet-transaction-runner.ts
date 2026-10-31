import { randomUUID } from 'node:crypto';

import {
  LockMode,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import { Money } from '../../../../shared/domain/money.js';
import { WalletLedgerEntryEntity } from '../../../ledger/infrastructure/persistence/wallet-ledger-entry.entity.js';
import { OutboxMessageEntity } from '../../../messaging/outbox/infrastructure/persistence/outbox-message.entity.js';
import { Wallet } from '../../../wallet/domain/wallet.js';
import { WalletEntity } from '../../../wallet/infrastructure/persistence/wallet.entity.js';
import {
  BetWriteConflictError,
  WalletNotFoundError,
  type BetIdentity,
  type BetResponseSnapshot,
  type BetTransactionRunner,
  type LockedBetContext,
  type StoredBet,
  InboxAlreadyProcessedError,
  InboxPayloadConflictError,
  InboxIncompleteError,
  type InboxReceipt,
} from '../../application/ports/bet-transaction-runner.js';
import type { WagerTransaction } from '../../domain/wager-transaction.js';
import { WagerTransactionStatus } from '../../domain/wager-transaction.js';
import { WagerTransactionEntity } from './wager-transaction.entity.js';

@Injectable()
export class MikroOrmBetTransactionRunner
  implements BetTransactionRunner {
  constructor(
    private readonly em: EntityManager,
  ) {}

  async findExisting(
    identity: BetIdentity,
  ): Promise<StoredBet | null> {
    const em = this.em.fork();

    const byKey = await em.findOne(
      WagerTransactionEntity,
      {
        providerId: identity.providerId,
        idempotencyKey: identity.idempotencyKey,
      },
    );

    if (byKey) {
      return this.toStoredBet(byKey, 'idempotencyKey');
    }

    const byExternal = await em.findOne(
      WagerTransactionEntity,
      {
        providerId: identity.providerId,
        externalTransactionId:
        identity.externalTransactionId,
      },
    );

    if (byExternal) {
      return this.toStoredBet(
        byExternal,
        'externalTransactionId',
      );
    }

    return null;
  }

  async withLockedWallet<T>(
    walletId: string,
    identity: BetIdentity,
    callback: (context: LockedBetContext) => Promise<T>,
    inbox?: InboxReceipt,
  ): Promise<T> {
    try {
      return await this.em.fork().transactional(
        async (tx) => {

          if (inbox) {
            const inserted = await tx.execute<
              Array<{ id: string }>
            >(
              `INSERT INTO inbox_messages (
                id,
                consumer_name,
                message_id,
                payload_hash,
                received_at
              )
              VALUES (?, ?, ?, ?, NOW())
              ON CONFLICT (consumer_name, message_id)
              DO NOTHING
              RETURNING id`,
              [
                randomUUID(),
                inbox.consumerName,
                inbox.messageId,
                inbox.payloadHash,
              ],
              'all',
            );

            if (inserted.length === 0) {
              const rows = await tx.execute<
                Array<{
                  payload_hash: string;
                  processed_at: Date | null;
                }>
              >(
                `
                SELECT payload_hash, processed_at
                FROM inbox_messages
                WHERE consumer_name = ?
                  AND message_id = ?
                `,
                [inbox.consumerName, inbox.messageId],
                'all',
              );

              const previous = rows[0];

              if (!previous) {
                throw new InboxIncompleteError();
              }

              if (previous.payload_hash !== inbox.payloadHash) {
                throw new InboxPayloadConflictError();
              }

              if (previous.processed_at !== null) {
                throw new InboxAlreadyProcessedError();
              }

              throw new InboxIncompleteError();
            }
          }

          const walletEntity = await tx.findOne(
            WalletEntity,
            { id: walletId },
            {
              lockMode: LockMode.PESSIMISTIC_WRITE,
              refresh: true,
            },
          );

          if (!walletEntity) {
            throw new WalletNotFoundError();
          }

          const byKey = await tx.findOne(
            WagerTransactionEntity,
            {
              providerId: identity.providerId,
              idempotencyKey: identity.idempotencyKey,
            },
          );

          let existing: StoredBet | null = null;

          if (byKey) {
            existing = this.toStoredBet(
              byKey,
              'idempotencyKey',
            );
          } else {
            const byExternal = await tx.findOne(
              WagerTransactionEntity,
              {
                providerId: identity.providerId,
                externalTransactionId:
                identity.externalTransactionId,
              },
            );

            if (byExternal) {
              existing = this.toStoredBet(
                byExternal,
                'externalTransactionId',
              );
            }
          }

          const wallet = Wallet.rehydrate({
            id: walletEntity.id,
            playerId: walletEntity.playerId,
            currency: walletEntity.currency,
            balance: Money.from({
              amount: walletEntity.balanceAmount,
              currency: walletEntity.currency,
            }),
            version: walletEntity.version,
            createdAt: walletEntity.createdAt,
            updatedAt: walletEntity.updatedAt,
          });

          const toTransactionEntity = (
            transaction: WagerTransaction,
            snapshot: BetResponseSnapshot,
          ): WagerTransactionEntity => {
            const entity = new WagerTransactionEntity();

            entity.id = transaction.id;
            entity.providerId = transaction.providerId;
            entity.externalTransactionId =
              transaction.externalTransactionId;
            entity.idempotencyKey = transaction.idempotencyKey;
            entity.payloadHash = transaction.payloadHash;
            entity.wallet = walletEntity;
            entity.playerId = transaction.playerId;
            entity.roundId = transaction.roundId;
            entity.gameId = transaction.gameId;
            entity.kind = transaction.kind;
            entity.status = transaction.status;
            entity.amount =
              transaction.money.toJSON().amount;
            entity.currency = transaction.money.currency;

            entity.referenceExternalTransactionId =
              transaction.referenceExternalTransactionId;

            entity.resultingBalanceAmount =
              transaction.resultingBalance?.toJSON().amount;

            entity.resultingBalanceCurrency =
              transaction.resultingBalance?.currency;

            entity.failureCode = transaction.failureCode;
            entity.attempts = transaction.attempts;
            entity.createdAt = transaction.createdAt;
            entity.processedAt = transaction.processedAt;

            entity.responseSnapshot = {
              ...snapshot,
              balance: { ...snapshot.balance },
            };

            return entity;
          };

          const context: LockedBetContext = {
            wallet,
            existing,

            saveProcessed: async (
              transaction,
              ledger,
              snapshot,
            ) => {
              walletEntity.balanceAmount =
                wallet.balance.toJSON().amount;
              walletEntity.version = wallet.version;
              walletEntity.updatedAt = new Date();

              const transactionEntity =
                toTransactionEntity(transaction, snapshot);

              const ledgerEntity =
                new WalletLedgerEntryEntity();

              ledgerEntity.id = ledger.id;
              ledgerEntity.wallet = walletEntity;
              ledgerEntity.transaction = transactionEntity;
              ledgerEntity.direction = ledger.direction;
              ledgerEntity.amount =
                ledger.money.toJSON().amount;
              ledgerEntity.currency = ledger.money.currency;
              ledgerEntity.balanceBefore =
                ledger.balanceBefore.toJSON().amount;
              ledgerEntity.balanceAfter =
                ledger.balanceAfter.toJSON().amount;
              ledgerEntity.createdAt = ledger.createdAt;

              const outboxEntity =
                this.createOutboxMessage(
                  transaction,
                  snapshot,
                );

              tx.persist(transactionEntity);
              tx.persist(ledgerEntity);
              tx.persist(outboxEntity);

              await tx.flush();
            },

            saveRejected: async (
              transaction,
              snapshot,
            ) => {
              const transactionEntity =
                toTransactionEntity(transaction, snapshot);

              const outboxEntity =
                this.createOutboxMessage(
                  transaction,
                  snapshot,
                );

              tx.persist(transactionEntity);
              tx.persist(outboxEntity);

              await tx.flush();
            },
          };


          const result = await callback(context);

          if (inbox) {
            await tx.execute(
              `
              UPDATE inbox_messages
              SET processed_at = NOW()
              WHERE consumer_name = ?
                AND message_id = ?
                AND processed_at IS NULL
              `,
              [inbox.consumerName, inbox.messageId],
            );
          }

          return result;

        },
        { clear: true },
      );
    } catch (error) {
      if (
        error instanceof UniqueConstraintViolationException
      ) {
        throw new BetWriteConflictError();
      }

      throw error;
    }
  }

  protected createOutboxMessage(
    transaction: WagerTransaction,
    snapshot: BetResponseSnapshot,
  ): OutboxMessageEntity {
    if (
      transaction.status !==
      WagerTransactionStatus.Processed &&
      transaction.status !==
      WagerTransactionStatus.Rejected
    ) {
      throw new Error(
        'Cannot publish event for non-terminal BET',
      );
    }

    const now = new Date();
    const occurredAt = transaction.processedAt ?? now;

    const entity = new OutboxMessageEntity();

    entity.id = randomUUID();
    entity.aggregateId = transaction.walletId;

    entity.eventType =
      transaction.status === WagerTransactionStatus.Processed
        ? 'wager.bet.processed.v1'
        : 'wager.bet.rejected.v1';

    entity.payload = {
      eventId: entity.id,
      schemaVersion: 1,
      transactionId: transaction.id,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      providerId: transaction.providerId,
      externalTransactionId:
      transaction.externalTransactionId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      status: transaction.status,
      amount: transaction.money.toJSON().amount,
      currency: transaction.money.currency,
      resultingBalance: { ...snapshot.balance },
      walletVersion: snapshot.walletVersion,
      failureCode: snapshot.failureCode ?? null,
      occurredAt: occurredAt.toISOString(),
    };

    entity.status = 'PENDING';
    entity.attempts = 0;
    entity.nextAttemptAt = now;
    entity.occurredAt = occurredAt;
    entity.createdAt = now;

    return entity;
  }

  private toStoredBet(
    entity: WagerTransactionEntity,
    matchedBy: StoredBet['matchedBy'],
  ): StoredBet {
    return {
      matchedBy,
      providerId: entity.providerId,
      externalTransactionId:
      entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey,
      payloadHash: entity.payloadHash,
      snapshot: entity.responseSnapshot
        ? entity.responseSnapshot as unknown as BetResponseSnapshot
        : null,
    };
  }
}
