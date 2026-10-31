
import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { WalletLedgerEntry } from '../../../ledger/domain/wallet-ledger-entry.js';
import { Money } from '../../../../shared/domain/money.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction.js';
import {
  BET_TRANSACTION_RUNNER,
  type BetTransactionRunner,
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
}

export interface ProcessBetOutput {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: string;
  balance: {
    amount: string;
    currency: string;
  };
  walletVersion: number;
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

    const payloadHash = createHash('sha256')
      .update(canonicalPayload)
      .digest('hex');

    const transaction = WagerTransaction.create({
      id: randomUUID(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: WagerTransactionKind.Bet,
      money,
    });

    return this.runner.withLockedWallet(
      input.walletId,
      async ({ wallet, saveProcessed, saveRejected }) => {
        if (wallet.playerId !== input.playerId) {
          throw new Error('Wallet player mismatch');
        }

        if (wallet.currency !== money.currency) {
          throw new Error('Wallet currency mismatch');
        }

        if (wallet.balance.isLessThan(money)) {
          transaction.reject(
            'INSUFFICIENT_FUNDS',
            wallet.balance,
          );

          await saveRejected(transaction);

          return {
            transactionId: transaction.id,
            status: transaction.status,
            failureCode: 'INSUFFICIENT_FUNDS',
            balance: wallet.balance.toJSON(),
            walletVersion: wallet.version,
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

        await saveProcessed(transaction, ledger);

        return {
          transactionId: transaction.id,
          status: transaction.status,
          balance: wallet.balance.toJSON(),
          walletVersion: wallet.version,
        };
      },
    );
  }
}
