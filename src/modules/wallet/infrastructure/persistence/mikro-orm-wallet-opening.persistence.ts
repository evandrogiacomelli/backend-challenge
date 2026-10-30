
import {
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import { WalletLedgerEntryEntity } from '../../../ledger/infrastructure/persistence/wallet-ledger-entry.entity.js';
import { WagerTransactionEntity } from '../../../wagering/infrastructure/persistence/wager-transaction.entity.js';
import type {
  WalletOpeningPersistence,
  WalletOpeningRecords,
} from '../../application/ports/wallet-opening-persistence.js';
import type { Wallet } from '../../domain/wallet.js';
import { WalletEntity } from './wallet.entity.js';

export class WalletAlreadyExistsError extends Error {
  constructor() {
    super('Wallet already exists for player and currency');
    this.name = 'WalletAlreadyExistsError';
  }
}

@Injectable()
export class MikroOrmWalletOpeningPersistence
  implements WalletOpeningPersistence {
  constructor(
    private readonly em: EntityManager,
  ) {}

  async save(
    wallet: Wallet,
    opening?: WalletOpeningRecords,
  ): Promise<void> {
    try {
      await this.em.transactional(
        async (tx) => {
          const walletEntity = new WalletEntity();

          walletEntity.id = wallet.id;
          walletEntity.playerId = wallet.playerId;
          walletEntity.currency = wallet.currency;
          walletEntity.balanceAmount =
            wallet.balance.toJSON().amount;
          walletEntity.version = wallet.version;
          walletEntity.createdAt = wallet.createdAt;
          walletEntity.updatedAt = wallet.updatedAt;

          tx.persist(walletEntity);

          if (opening) {
            const transaction = opening.transaction;
            const ledger = opening.ledger;

            const transactionEntity =
              new WagerTransactionEntity();

            transactionEntity.id = transaction.id;
            transactionEntity.providerId =
              transaction.providerId;
            transactionEntity.externalTransactionId =
              transaction.externalTransactionId;
            transactionEntity.idempotencyKey =
              transaction.idempotencyKey;
            transactionEntity.payloadHash =
              transaction.payloadHash;
            transactionEntity.wallet = walletEntity;
            transactionEntity.playerId =
              transaction.playerId;
            transactionEntity.roundId = transaction.roundId;
            transactionEntity.gameId = transaction.gameId;
            transactionEntity.kind = transaction.kind;
            transactionEntity.status = transaction.status;
            transactionEntity.amount =
              transaction.money.toJSON().amount;
            transactionEntity.currency =
              transaction.money.currency;
            transactionEntity.resultingBalanceAmount =
              transaction.resultingBalance?.toJSON().amount;
            transactionEntity.resultingBalanceCurrency =
              transaction.resultingBalance?.currency;
            transactionEntity.attempts = transaction.attempts;
            transactionEntity.createdAt = transaction.createdAt;
            transactionEntity.processedAt = transaction.processedAt;

            tx.persist(transactionEntity);

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

            tx.persist(ledgerEntity);
          }

          await tx.flush();
        },
        { clear: true },
      );
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new WalletAlreadyExistsError();
      }

      throw error;
    }
  }
}
