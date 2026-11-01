import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { Money } from '../../../../shared/domain/money.js';

import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction.js';

import type { InboxReceipt } from '../ports/bet-transaction-runner.js';

import {
  LOSS_TRANSACTION_RUNNER,
  LossIdentityConflictError,
  LossWriteConflictError,
  type LossIdentity,
  type LossResponseSnapshot,
  type LossTransactionRunner,
  type StoredLoss,
} from '../ports/loss-transaction-runner.js';

export interface ProcessLossInput {
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

export interface ProcessLossOutput
  extends LossResponseSnapshot {
  idempotentReplay: boolean;
}

@Injectable()
export class ProcessLossUseCase {
  constructor(
    @Inject(LOSS_TRANSACTION_RUNNER)
    private readonly runner: LossTransactionRunner,
  ) {}

  async execute(
    input: ProcessLossInput,
  ): Promise<ProcessLossOutput> {
    const money = Money.from({
      amount: input.amount,
      currency: input.currency,
    });

    const canonicalPayload = JSON.stringify([
      WagerTransactionKind.Loss,
      input.providerId,
      input.externalTransactionId,
      input.walletId,
      input.playerId,
      input.roundId,
      input.gameId,
      money.toJSON().amount,
      money.currency,
    ]);

    const identity: LossIdentity = {
      providerId: input.providerId,
      externalTransactionId:
      input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash: createHash('sha256')
        .update(canonicalPayload)
        .digest('hex'),
    };

    // SQS requires the Inbox to participate in
    // the same SQL transaction as the LOSS record.
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
        async (context) => {
          if (context.existing) {
            return this.resolveExisting(
              context.existing,
              identity,
            );
          }

          const wallet = context.wallet;

          if (wallet.playerId !== input.playerId) {
            throw new Error(
              'Wallet player mismatch',
            );
          }

          if (wallet.currency !== money.currency) {
            throw new Error(
              'Wallet currency mismatch',
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
            kind: WagerTransactionKind.Loss,
            money,
          });

          // LOSS does not modify the wallet.
          // The stake was already debited by BET.
          transaction.markProcessed({
            resultingBalance: wallet.balance,
          });

          const snapshot: LossResponseSnapshot = {
            transactionId: transaction.id,
            status: WagerTransactionStatus.Processed,
            balance: wallet.balance.toJSON(),
            walletVersion: wallet.version,
          };

          // Persistence must save only:
          // - the LOSS transaction
          // - its response snapshot
          // - its transactional Outbox event
          // - Inbox when supplied
          //
          // No wallet update and no ledger entry.
          await context.saveProcessed(
            transaction,
            snapshot,
            {
              roundId: input.roundId,
              gameId: input.gameId,
              amount: money,
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
      if (error instanceof LossWriteConflictError) {
        const committed =
          await this.runner.findExisting(identity);

        if (committed) {
          if (!input.inbox) {
            return this.resolveExisting(
              committed,
              identity,
            );
          }

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
    existing: StoredLoss,
    identity: LossIdentity,
  ): ProcessLossOutput {
    if (
      existing.externalTransactionId ===
      identity.externalTransactionId &&
      existing.idempotencyKey !==
      identity.idempotencyKey
    ) {
      throw new LossIdentityConflictError(
        'EXTERNAL_TRANSACTION_ID_CONFLICT',
      );
    }

    if (
      existing.idempotencyKey !==
      identity.idempotencyKey ||
      existing.payloadHash !==
      identity.payloadHash ||
      existing.externalTransactionId !==
      identity.externalTransactionId
    ) {
      throw new LossIdentityConflictError(
        'IDEMPOTENCY_KEY_CONFLICT',
      );
    }

    if (!existing.snapshot) {
      throw new Error(
        'Original LOSS response snapshot is unavailable',
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
