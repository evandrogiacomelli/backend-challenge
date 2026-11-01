import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';

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
  REFUND_TRANSACTION_RUNNER,
  RefundAlreadyAppliedError,
  RefundIdentityConflictError,
  RefundInvalidReferenceError,
  RefundReferenceNotFoundError,
  RefundWriteConflictError,
  type RefundIdentity,
  type RefundResponseSnapshot,
  type RefundTransactionRunner,
  type StoredRefund,
} from '../ports/refund-transaction-runner.js';

export interface ProcessRefundInput {
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

export interface ProcessRefundOutput
  extends RefundResponseSnapshot {
  idempotentReplay: boolean;
}

@Injectable()
export class ProcessRefundUseCase {
  constructor(
    @Inject(REFUND_TRANSACTION_RUNNER)
    private readonly runner: RefundTransactionRunner,
  ) {}

  async execute(
    input: ProcessRefundInput,
  ): Promise<ProcessRefundOutput> {
    if (
      !input.referenceExternalTransactionId?.trim()
    ) {
      throw new RefundInvalidReferenceError(
        'REFERENCE_REQUIRED',
      );
    }

    if (
      input.referenceExternalTransactionId ===
      input.externalTransactionId
    ) {
      throw new RefundInvalidReferenceError(
        'SELF_REFERENCE_NOT_ALLOWED',
      );
    }

    const money = Money.from({
      amount: input.amount,
      currency: input.currency,
    });

    if (
      new Decimal(
        money.toJSON().amount,
      ).lte(0)
    ) {
      throw new RefundInvalidReferenceError(
        'REFUND_AMOUNT_MUST_BE_POSITIVE',
      );
    }

    const canonicalPayload = JSON.stringify([
      WagerTransactionKind.Refund,
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

    const identity: RefundIdentity = {
      providerId: input.providerId,
      externalTransactionId:
      input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash: createHash('sha256')
        .update(canonicalPayload)
        .digest('hex'),
    };

    // HTTP replay can return immediately.
    // SQS must enter the SQL transaction to
    // persist the Inbox receipt atomically.
    const existing = input.inbox
      ? null
      : await this.runner.findExisting(identity);

    if (existing) {
      return this.resolveExisting(
        existing,
        identity,
      );
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

          if (
            wallet.playerId !== input.playerId
          ) {
            throw new RefundInvalidReferenceError(
              'WALLET_PLAYER_MISMATCH',
            );
          }

          if (
            wallet.currency !== money.currency
          ) {
            throw new RefundInvalidReferenceError(
              'WALLET_CURRENCY_MISMATCH',
            );
          }


          const transaction = WagerTransaction.create({
            id: randomUUID(),
            providerId: input.providerId,
            externalTransactionId:
            input.externalTransactionId,
            idempotencyKey: input.idempotencyKey,
            referenceExternalTransactionId:
            input.referenceExternalTransactionId,
            payloadHash: identity.payloadHash,
            walletId: input.walletId,
            playerId: input.playerId,
            roundId: input.roundId,
            gameId: input.gameId,
            kind: WagerTransactionKind.Refund,
            money,
          });

          const reference = context.referenceBet;

          if (!reference) {
            // Persist the operation without moving money.
            transaction.markPendingReference();

            const snapshot: RefundResponseSnapshot = {
              transactionId: transaction.id,
              status: WagerTransactionStatus.PendingReference,
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

// Reference exists: preserve the existing
// financial validation and processing.
          this.validateReference(
            reference,
            input,
            money,
          );

          if (context.alreadyRefunded) {
            throw new RefundAlreadyAppliedError();
          }


          // Credit the wallet while the PostgreSQL
          // adapter holds SELECT FOR UPDATE.
          //
          // Example:
          // BEFORE = 70.00
          // AMOUNT = 30.00
          // AFTER  = 100.00
          const movement = wallet.credit(money);

          // REFUND requires the original BET
          // aggregate for domain validation.
          transaction.markProcessed({
            resultingBalance:
            movement.balanceAfter,
            reference,
          });

          const ledger =
            WalletLedgerEntry.create({
              id: randomUUID(),

              walletId: wallet.id,
              transactionId: transaction.id,

              direction: 'CREDIT',

              money,

              balanceBefore:
              movement.balanceBefore,

              balanceAfter:
              movement.balanceAfter,

              createdAt: new Date(),
            });

          const snapshot:
            RefundResponseSnapshot = {
            transactionId:
            transaction.id,

            status:
            WagerTransactionStatus.Processed,

            balance:
              movement.balanceAfter.toJSON(),

            walletVersion:
            wallet.version,
          };

          // Transaction, wallet, ledger, Outbox
          // and optional Inbox must be committed
          // atomically by the persistence adapter.
          await context.saveProcessed(
            transaction,
            snapshot,
            {
              referenceBetTransactionId:
              reference.id,

              roundId:
              input.roundId,

              gameId:
              input.gameId,

              amount:
              money,

              // CRITICAL:
              // Use the original wallet balance,
              // NEVER the refund amount.
              balanceBefore:
              movement.balanceBefore,
            },
            ledger,
          );

          return {
            ...snapshot,
            idempotentReplay: false,
          };
        },

        input.inbox,
      );
    } catch (error) {
      if (
        error instanceof RefundWriteConflictError
      ) {
        const committed =
          await this.runner.findExisting(
            identity,
          );

        if (committed) {
          if (!input.inbox) {
            return this.resolveExisting(
              committed,
              identity,
            );
          }

          // SQS replay must persist the Inbox
          // receipt inside a SQL transaction.
          return this.runner.withLockedWallet(
            input.walletId,
            identity,
            input.referenceExternalTransactionId,

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

  private validateReference(
    reference: WagerTransaction,
    input: ProcessRefundInput,
    money: Money,
  ): void {
    if (
      reference.kind !==
      WagerTransactionKind.Bet
    ) {
      throw new RefundInvalidReferenceError(
        'REFERENCE_IS_NOT_BET',
      );
    }

    if (
      reference.status !==
      WagerTransactionStatus.Processed
    ) {
      throw new RefundInvalidReferenceError(
        'REFERENCE_BET_NOT_PROCESSED',
      );
    }

    if (
      reference.providerId !==
      input.providerId ||
      reference.externalTransactionId !==
      input.referenceExternalTransactionId
    ) {
      throw new RefundInvalidReferenceError(
        'REFERENCE_IDENTITY_MISMATCH',
      );
    }

    if (
      reference.walletId !==
      input.walletId ||
      reference.playerId !==
      input.playerId
    ) {
      throw new RefundInvalidReferenceError(
        'REFERENCE_WALLET_MISMATCH',
      );
    }

    if (
      reference.roundId !==
      input.roundId ||
      reference.gameId !==
      input.gameId
    ) {
      throw new RefundInvalidReferenceError(
        'REFERENCE_GAME_MISMATCH',
      );
    }

    if (
      reference.money.currency !==
      money.currency
    ) {
      throw new RefundInvalidReferenceError(
        'REFERENCE_CURRENCY_MISMATCH',
      );
    }

    if (!reference.money.equals(money)) {
      throw new RefundInvalidReferenceError(
        'REFUND_AMOUNT_MISMATCH',
      );
    }
  }

  private resolveExisting(
    existing: StoredRefund,
    identity: RefundIdentity,
  ): ProcessRefundOutput {
    if (
      existing.externalTransactionId ===
      identity.externalTransactionId &&
      existing.idempotencyKey !==
      identity.idempotencyKey
    ) {
      throw new RefundIdentityConflictError(
        'EXTERNAL_TRANSACTION_ID_CONFLICT',
      );
    }

    if (
      existing.idempotencyKey !==
      identity.idempotencyKey ||
      existing.externalTransactionId !==
      identity.externalTransactionId ||
      existing.payloadHash !==
      identity.payloadHash
    ) {
      throw new RefundIdentityConflictError(
        'IDEMPOTENCY_KEY_CONFLICT',
      );
    }

    if (!existing.snapshot) {
      throw new Error(
        'Original REFUND response snapshot is unavailable',
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
