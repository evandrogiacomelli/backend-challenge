
import {
  LockMode,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import { Money } from '../../../../shared/domain/money.js';
import { WalletLedgerEntryEntity } from '../../../ledger/infrastructure/persistence/wallet-ledger-entry.entity.js';
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
} from '../../application/ports/bet-transaction-runner.js';
import type { WagerTransaction } from '../../domain/wager-transaction.js';
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
  ): Promise<T> {
    try {
      return await this.em.fork().transactional(
        async (tx) => {
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

          // Recheck after the wallet lock. Another request
          // may have committed while we were waiting.
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

              tx.persist(transactionEntity);
              tx.persist(ledgerEntity);

              await tx.flush();
            },

            saveRejected: async (transaction, snapshot) => {
              tx.persist(
                toTransactionEntity(transaction, snapshot),
              );

              await tx.flush();
            },
          };

          return callback(context);
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
