
import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { Money } from '../../../../shared/domain/money.js';

import { WalletLedgerEntry } from '../../../ledger/domain/wallet-ledger-entry.js';

import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction.js';

import type {
  InboxReceipt,
} from '../ports/bet-transaction-runner.js';

import {
  ROLLBACK_TRANSACTION_RUNNER,
  RollbackAlreadyAppliedError,
  RollbackIdentityConflictError,
  RollbackInvalidReferenceError,
  RollbackWriteConflictError,
  type RollbackIdentity,
  type RollbackResponseSnapshot,
  type RollbackTransactionRunner,
  type StoredRollback,
} from '../ports/rollback-transaction-runner.js';

export interface ProcessRollbackInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;

  referenceExternalTransactionId: string;

  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;

  amount: string;
  currency: string;

  inbox?: InboxReceipt;
}

export interface ProcessRollbackOutput
  extends RollbackResponseSnapshot {
  idempotentReplay: boolean;
}

@Injectable()
export class ProcessRollbackUseCase {
  constructor(
    @Inject(ROLLBACK_TRANSACTION_RUNNER)
    private readonly runner: RollbackTransactionRunner,
  ) {}

  async execute(
    input: ProcessRollbackInput,
  ): Promise<ProcessRollbackOutput> {
    if (!input.referenceExternalTransactionId?.trim()) {
      throw new RollbackInvalidReferenceError(
        'REFERENCE_REQUIRED',
      );
    }

    if (
      input.referenceExternalTransactionId ===
      input.externalTransactionId
    ) {
      throw new RollbackInvalidReferenceError(
        'SELF_REFERENCE_NOT_ALLOWED',
      );
    }

    const money = Money.from({
      amount: input.amount,
      currency: input.currency,
    });

    if (!money.isPositive()) {
      throw new RollbackInvalidReferenceError(
        'ROLLBACK_AMOUNT_MUST_BE_POSITIVE',
      );
    }

    const canonicalPayload = JSON.stringify([
      WagerTransactionKind.Rollback,
      input.providerId,
      input.externalTransactionId,
      input.idempotencyKey,
      input.referenceExternalTransactionId,
      input.walletId,
      input.playerId,
      input.roundId,
      input.gameId,
      money.toJSON().amount,
      money.currency,
    ]);

    const identity: RollbackIdentity = {
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash: createHash('sha256')
        .update(canonicalPayload)
        .digest('hex'),
    };

    // SQS enters the locked transaction to ensure
    // the Inbox receipt is committed atomically.
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
        input.referenceExternalTransactionId,
        async (context) => {
          if (context.existing) {
            return this.resolveExisting(
              context.existing,
              identity,
            );
          }

          const wallet = context.wallet;

          if (wallet.playerId !== input.playerId) {
            throw new RollbackInvalidReferenceError(
              'WALLET_PLAYER_MISMATCH',
            );
          }

          if (wallet.currency !== money.currency) {
            throw new RollbackInvalidReferenceError(
              'WALLET_CURRENCY_MISMATCH',
            );
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
            kind: WagerTransactionKind.Rollback,
            money,
            referenceExternalTransactionId:
            input.referenceExternalTransactionId,
          });

          const reference = context.referenceTransaction;

          if (!reference) {
            transaction.markPendingReference();

            const snapshot: RollbackResponseSnapshot = {
              transactionId: transaction.id,
              status:
              WagerTransactionStatus.PendingReference,
              balance: wallet.balance.toJSON(),
              walletVersion: wallet.version,
            };

            await context.savePendingReference(
              transaction,
              snapshot,
            );

            return {
              ...snapshot,
              idempotentReplay: false,
            };
          }

          this.validateReference(
            reference,
            input,
            money,
          );

          if (context.alreadyReversed) {
            throw new RollbackAlreadyAppliedError();
          }

          const direction =
            transaction.ledgerDirectionFor(reference);

          if (direction === null) {
            throw new RollbackInvalidReferenceError(
              'REFERENCE_HAS_NO_FINANCIAL_MOVEMENT',
            );
          }

          // A compensating debit must never produce
          // a negative wallet balance.
          //
          // Persist the rejection instead of throwing
          // and rolling back the entire SQL transaction.
          if (
            direction === 'DEBIT' &&
            wallet.balance.isLessThan(money)
          ) {
            const failureCode =
              'ROLLBACK_INSUFFICIENT_FUNDS';

            transaction.reject(
              failureCode,
              wallet.balance,
            );

            const snapshot: RollbackResponseSnapshot = {
              transactionId: transaction.id,
              status: WagerTransactionStatus.Rejected,
              failureCode,
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

          const movement =
            direction === 'CREDIT'
              ? wallet.credit(money)
              : wallet.debit(money);

          transaction.markProcessed({
            resultingBalance: movement.balanceAfter,
            reference,
          });

          // Never modify the original ledger entry.
          // Record a new compensating entry.
          const ledger = WalletLedgerEntry.create({
            id: randomUUID(),
            walletId: wallet.id,
            transactionId: transaction.id,
            direction,
            money,
            balanceBefore: movement.balanceBefore,
            balanceAfter: movement.balanceAfter,
            createdAt: new Date(),
          });

          const snapshot: RollbackResponseSnapshot = {
            transactionId: transaction.id,
            status: WagerTransactionStatus.Processed,
            balance: movement.balanceAfter.toJSON(),
            walletVersion: wallet.version,
          };

          await context.saveProcessed(
            transaction,
            ledger,
            snapshot,
            {
              referenceTransactionId: reference.id,
              referenceExternalTransactionId:
              input.referenceExternalTransactionId,
              roundId: input.roundId,
              gameId: input.gameId,
              direction,
              amount: money,
              balanceBefore: movement.balanceBefore,
            },
          );

          return {
            ...snapshot,
            idempotentReplay: false,
          };
        },
        input.inbox,
      );
    } catch (error) {
      if (error instanceof RollbackWriteConflictError) {
        const committed =
          await this.runner.findExisting(identity);

        if (committed) {
          if (!input.inbox) {
            return this.resolveExisting(
              committed,
              identity,
            );
          }

          // Re-enter the SQL transaction so the
          // Inbox receipt is committed for SQS.
          return this.runner.withLockedWallet(
            input.walletId,
            identity,
            input.referenceExternalTransactionId,
            async ({ existing: lockedExisting }) => {
              if (!lockedExisting) {
                throw error;
              }

              return this.resolveExisting(
                lockedExisting,
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

  private validateReference(
    reference: WagerTransaction,
    input: ProcessRollbackInput,
    money: Money,
  ): void {
    if (
      reference.status !==
      WagerTransactionStatus.Processed
    ) {
      throw new RollbackInvalidReferenceError(
        'REFERENCE_NOT_PROCESSED',
      );
    }

    if (
      reference.kind !== WagerTransactionKind.Bet &&
      reference.kind !== WagerTransactionKind.Win &&
      reference.kind !== WagerTransactionKind.Refund
    ) {
      throw new RollbackInvalidReferenceError(
        'INVALID_REFERENCE_KIND',
      );
    }

    if (
      reference.providerId !== input.providerId ||
      reference.externalTransactionId !==
      input.referenceExternalTransactionId
    ) {
      throw new RollbackInvalidReferenceError(
        'REFERENCE_IDENTITY_MISMATCH',
      );
    }

    if (
      reference.walletId !== input.walletId ||
      reference.playerId !== input.playerId
    ) {
      throw new RollbackInvalidReferenceError(
        'REFERENCE_WALLET_MISMATCH',
      );
    }

    if (
      reference.roundId !== input.roundId ||
      reference.gameId !== input.gameId
    ) {
      throw new RollbackInvalidReferenceError(
        'REFERENCE_GAME_MISMATCH',
      );
    }

    if (
      reference.money.currency !== money.currency
    ) {
      throw new RollbackInvalidReferenceError(
        'REFERENCE_CURRENCY_MISMATCH',
      );
    }

    if (!reference.money.equals(money)) {
      throw new RollbackInvalidReferenceError(
        'ROLLBACK_AMOUNT_MISMATCH',
      );
    }
  }

  private resolveExisting(
    existing: StoredRollback,
    identity: RollbackIdentity,
  ): ProcessRollbackOutput {
    if (
      existing.externalTransactionId ===
      identity.externalTransactionId &&
      existing.idempotencyKey !==
      identity.idempotencyKey
    ) {
      throw new RollbackIdentityConflictError(
        'EXTERNAL_TRANSACTION_ID_CONFLICT',
      );
    }

    if (
      existing.idempotencyKey !==
      identity.idempotencyKey ||
      existing.externalTransactionId !==
      identity.externalTransactionId ||
      existing.payloadHash !== identity.payloadHash
    ) {
      throw new RollbackIdentityConflictError(
        'IDEMPOTENCY_KEY_CONFLICT',
      );
    }

    if (!existing.snapshot) {
      throw new Error(
        'Original ROLLBACK snapshot is unavailable',
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
