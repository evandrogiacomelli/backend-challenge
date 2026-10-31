import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';

import { Money } from '../../../../shared/domain/money.js';
import { WalletLedgerEntry } from '../../../ledger/domain/wallet-ledger-entry.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction.js';
import type { InboxReceipt } from '../ports/bet-transaction-runner.js';
import {
  WIN_TRANSACTION_RUNNER,
  WinIdentityConflictError,
  WinWriteConflictError,
  type StoredWin,
  type WinIdentity,
  type WinResponseSnapshot,
  type WinTransactionRunner,
} from '../ports/win-transaction-runner.js';

export interface ProcessWinInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId?: string;
  inbox?: InboxReceipt;
}

export interface ProcessWinOutput extends WinResponseSnapshot {
  idempotentReplay: boolean;
}

@Injectable()
export class ProcessWinUseCase {
  constructor(
    @Inject(WIN_TRANSACTION_RUNNER)
    private readonly runner: WinTransactionRunner,
  ) {}

  async execute(input: ProcessWinInput): Promise<ProcessWinOutput> {
    if (input.referenceExternalTransactionId !== undefined) {
      throw new Error(
        'WIN reference validation is not implemented; do not ignore supplied references',
      );
    }

    const money = Money.from({
      amount: input.amount,
      currency: input.currency,
    });

    if (!money.isPositive()) {
      throw new Error('WIN amount must be positive');
    }

    const canonicalPayload = JSON.stringify([
      WagerTransactionKind.Win,
      input.providerId,
      input.externalTransactionId,
      input.walletId,
      input.playerId,
      input.roundId,
      input.gameId,
      money.toJSON().amount,
      money.currency,
    ]);

    const identity: WinIdentity = {
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash: createHash('sha256')
        .update(canonicalPayload)
        .digest('hex'),
    };

    // The persistent Inbox must be created inside the wallet-locked transaction.
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
            return this.resolveExisting(context.existing, identity);
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
            externalTransactionId: input.externalTransactionId,
            idempotencyKey: input.idempotencyKey,
            payloadHash: identity.payloadHash,
            walletId: input.walletId,
            playerId: input.playerId,
            roundId: input.roundId,
            gameId: input.gameId,
            kind: WagerTransactionKind.Win,
            money,
          });

          const movement = wallet.credit(money);
          transaction.markProcessed({ resultingBalance: wallet.balance });

          const ledger = WalletLedgerEntry.create({
            id: randomUUID(),
            walletId: wallet.id,
            transactionId: transaction.id,
            direction: 'CREDIT',
            money,
            balanceBefore: movement.balanceBefore,
            balanceAfter: movement.balanceAfter,
            createdAt: new Date(),
          });

          const snapshot: WinResponseSnapshot = {
            transactionId: transaction.id,
            status: WagerTransactionStatus.Processed,
            balance: wallet.balance.toJSON(),
            walletVersion: wallet.version,
          };

          await context.saveProcessed(transaction, ledger, snapshot, {
            roundId: input.roundId,
            gameId: input.gameId,
            amount: money,
            balanceBefore: movement.balanceBefore,
          });

          return { ...snapshot, idempotentReplay: false };
        },
        input.inbox,
      );
    } catch (error) {
      if (error instanceof WinWriteConflictError) {
        const committed = await this.runner.findExisting(identity);
        if (committed) {
          if (!input.inbox) {
            return this.resolveExisting(committed, identity);
          }
          return this.runner.withLockedWallet(
            input.walletId,
            identity,
            async ({ existing: replay }) => {
              if (!replay) throw error;
              return this.resolveExisting(replay, identity);
            },
            input.inbox,
          );
        }
      }
      throw error;
    }
  }

  private resolveExisting(
    existing: StoredWin,
    identity: WinIdentity,
  ): ProcessWinOutput {
    if (
      existing.idempotencyKey !== identity.idempotencyKey ||
      existing.externalTransactionId !== identity.externalTransactionId ||
      existing.payloadHash !== identity.payloadHash
    ) {
      throw new WinIdentityConflictError(
        'WIN idempotency identity or payload conflict',
      );
    }
    if (!existing.snapshot) {
      throw new Error('Original WIN response snapshot is unavailable');
    }
    return {
      ...existing.snapshot,
      balance: { ...existing.snapshot.balance },
      idempotentReplay: true,
    };
  }
}
