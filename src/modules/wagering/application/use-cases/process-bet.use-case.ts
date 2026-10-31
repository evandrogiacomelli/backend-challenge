
import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { Money } from '../../../../shared/domain/money.js';
import { WalletLedgerEntry } from '../../../ledger/domain/wallet-ledger-entry.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction.js';
import {
  BET_TRANSACTION_RUNNER,
  BetIdentityConflictError,
  BetWriteConflictError,
  type BetIdentity,
  type BetResponseSnapshot,
  type BetTransactionRunner,
  type InboxReceipt,
  type StoredBet,
} from '../ports/bet-transaction-runner.js';

export interface ProcessBetInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  amount: string;
  currency: string;
  inbox?: InboxReceipt;
}

export interface ProcessBetOutput extends BetResponseSnapshot {
  idempotentReplay: boolean;
}

@Injectable()
export class ProcessBetUseCase {
  constructor(
    @Inject(BET_TRANSACTION_RUNNER)
    private readonly runner: BetTransactionRunner,
  ) {}

  async execute(
    input: ProcessBetInput,
  ): Promise<ProcessBetOutput> {
    const money = Money.from({
      amount: input.amount,
      currency: input.currency,
    });

    const canonicalPayload = JSON.stringify([
      WagerTransactionKind.Bet,
      input.providerId,
      input.externalTransactionId,
      input.walletId,
      input.playerId,
      input.roundId,
      input.gameId,
      money.toJSON().amount,
      money.currency,
    ]);

    const identity: BetIdentity = {
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash: createHash('sha256')
        .update(canonicalPayload)
        .digest('hex'),
    };

    // SQS messages must enter the transaction so that
    // the Inbox is recorded atomically with the BET.
    const existing = input.inbox
      ? null
      : await this.runner.findExisting(identity);

    if (existing) {
      return this.resolveExisting(existing, identity);
    }

    try {
      return await this.runner.withLockedWallet(
        input.walletId,
        identity,
        async (context) => {
          if (context.existing) {
            return this.resolveExisting(
              context.existing,
              identity,
            );
          }

          const wallet = context.wallet;

          if (wallet.playerId !== input.playerId) {
            throw new Error('Wallet player mismatch');
          }

          if (wallet.currency !== money.currency) {
            throw new Error('Wallet currency mismatch');
          }

          const transaction = WagerTransaction.create({
            id: randomUUID(),
            providerId: input.providerId,
            externalTransactionId:
            input.externalTransactionId,
            idempotencyKey: input.idempotencyKey,
            payloadHash: identity.payloadHash,
            walletId: input.walletId,
            playerId: input.playerId,
            roundId: input.roundId,
            gameId: input.gameId,
            kind: WagerTransactionKind.Bet,
            money,
          });

          if (wallet.balance.isLessThan(money)) {
            transaction.reject(
              'INSUFFICIENT_FUNDS',
              wallet.balance,
            );

            const snapshot: BetResponseSnapshot = {
              transactionId: transaction.id,
              status: WagerTransactionStatus.Rejected,
              failureCode: 'INSUFFICIENT_FUNDS',
              balance: wallet.balance.toJSON(),
              walletVersion: wallet.version,
            };

            await context.saveRejected(
              transaction,
              snapshot,
            );

            return {
              ...snapshot,
              idempotentReplay: false,
            };
          }

          const movement = wallet.debit(money);

          transaction.markProcessed({
            resultingBalance: wallet.balance,
          });

          const ledger = WalletLedgerEntry.create({
            id: randomUUID(),
            walletId: wallet.id,
            transactionId: transaction.id,
            direction: 'DEBIT',
            money,
            balanceBefore: movement.balanceBefore,
            balanceAfter: movement.balanceAfter,
            createdAt: new Date(),
          });

          const snapshot: BetResponseSnapshot = {
            transactionId: transaction.id,
            status: WagerTransactionStatus.Processed,
            balance: wallet.balance.toJSON(),
            walletVersion: wallet.version,
          };

          await context.saveProcessed(
            transaction,
            ledger,
            snapshot,
          );

          return {
            ...snapshot,
            idempotentReplay: false,
          };
        },
        input.inbox,
      );
    } catch (error) {
      if (error instanceof BetWriteConflictError) {
        // Another transaction may have committed the
        // same BET while this transaction was running.
        const committed = await this.runner.findExisting(
          identity,
        );

        if (committed) {
          if (!input.inbox) {
            return this.resolveExisting(
              committed,
              identity,
            );
          }

          // For SQS, replay must also register the Inbox
          // receipt within a new SQL transaction.
          return this.runner.withLockedWallet(
            input.walletId,
            identity,
            async ({ existing }) => {
              if (!existing) {
                throw error;
              }

              return this.resolveExisting(
                existing,
                identity,
              );
            },
            input.inbox,
          );
        }
      }

      throw error;
    }
  }

  private resolveExisting(
    existing: StoredBet,
    identity: BetIdentity,
  ): ProcessBetOutput {
    if (
      existing.matchedBy === 'externalTransactionId' &&
      existing.idempotencyKey !== identity.idempotencyKey
    ) {
      throw new BetIdentityConflictError(
        'EXTERNAL_TRANSACTION_ID_CONFLICT',
      );
    }

    if (
      existing.idempotencyKey !== identity.idempotencyKey ||
      existing.payloadHash !== identity.payloadHash ||
      existing.externalTransactionId !==
      identity.externalTransactionId
    ) {
      throw new BetIdentityConflictError(
        'IDEMPOTENCY_KEY_CONFLICT',
      );
    }

    if (!existing.snapshot) {
      throw new Error(
        'Original BET response snapshot is unavailable',
      );
    }

    return {
      ...existing.snapshot,
      balance: {
        ...existing.snapshot.balance,
      },
      idempotentReplay: true,
    };
  }
}
