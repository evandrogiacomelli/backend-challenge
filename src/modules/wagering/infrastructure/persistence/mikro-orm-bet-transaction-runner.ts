
import { LockMode } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import { Money } from '../../../../shared/domain/money.js';
import { WalletLedgerEntryEntity } from '../../../ledger/infrastructure/persistence/wallet-ledger-entry.entity.js';
import { Wallet } from '../../../wallet/domain/wallet.js';
import { WalletEntity } from '../../../wallet/infrastructure/persistence/wallet.entity.js';
import type {
  BetTransactionRunner,
  LockedBetContext,
} from '../../application/ports/bet-transaction-runner.js';
import {
  WalletNotFoundError,
} from '../../application/ports/bet-transaction-runner.js';
import type { WagerTransaction } from '../../domain/wager-transaction.js';
import { WagerTransactionEntity } from './wager-transaction.entity.js';

@Injectable()
export class MikroOrmBetTransactionRunner
  implements BetTransactionRunner {
  constructor(
    private readonly em: EntityManager,
  ) {}

  async withLockedWallet<T>(
    walletId: string,
    callback: (context: LockedBetContext) => Promise<T>,
  ): Promise<T> {
    const isolatedEm = this.em.fork();

    return isolatedEm.transactional(
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
          entity.amount = transaction.money.toJSON().amount;
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

          return entity;
        };

        const context: LockedBetContext = {
          wallet,

          saveProcessed: async (transaction, ledger) => {
            walletEntity.balanceAmount =
              wallet.balance.toJSON().amount;

            walletEntity.version = wallet.version;
            walletEntity.updatedAt = new Date();

            const transactionEntity =
              toTransactionEntity(transaction);

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

          saveRejected: async (transaction) => {
            tx.persist(toTransactionEntity(transaction));
            await tx.flush();
          },
        };

        return callback(context);
      },
      { clear: true },
    );
  }
}
