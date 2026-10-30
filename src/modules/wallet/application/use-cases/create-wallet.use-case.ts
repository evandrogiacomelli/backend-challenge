
import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { WalletLedgerEntry } from '../../../ledger/domain/wallet-ledger-entry.js';
import { WagerTransaction } from '../../../wagering/domain/wager-transaction.js';
import { Money } from '../../../../shared/domain/money.js';
import { Wallet } from '../../domain/wallet.js';
import {
  WALLET_OPENING_PERSISTENCE,
  type WalletOpeningPersistence,
  type WalletOpeningRecords,
} from '../ports/wallet-opening-persistence.js';

export interface CreateWalletInput {
  playerId: string;
  currency?: string;
  initialBalance?: {
    amount: string;
    currency: string;
  };
}

export interface CreateWalletOutput {
  id: string;
  playerId: string;
  balance: {
    amount: string;
    currency: string;
  };
  version: number;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(
    @Inject(WALLET_OPENING_PERSISTENCE)
    private readonly persistence: WalletOpeningPersistence,
  ) {}

  async execute(
    input: CreateWalletInput,
  ): Promise<CreateWalletOutput> {
    const currency =
      input.initialBalance?.currency ?? input.currency;

    if (!currency) {
      throw new Error('Currency is required');
    }

    if (
      input.currency &&
      input.initialBalance &&
      input.currency !== input.initialBalance.currency
    ) {
      throw new Error('Currency mismatch');
    }

    const initialBalance = Money.from({
      amount: input.initialBalance?.amount ?? '0.00',
      currency,
    });

    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: input.playerId,
      initialBalance,
    });

    let opening: WalletOpeningRecords | undefined;

    if (initialBalance.isPositive()) {
      const transaction = WagerTransaction.createOpening({
        id: randomUUID(),
        walletId: wallet.id,
        playerId: wallet.playerId,
        money: initialBalance,
      });

      transaction.markProcessed({
        resultingBalance: wallet.balance,
      });

      const ledger = WalletLedgerEntry.create({
        id: randomUUID(),
        walletId: wallet.id,
        transactionId: transaction.id,
        direction: 'CREDIT',
        money: initialBalance,
        balanceBefore: Money.zero(currency),
        balanceAfter: wallet.balance,
        createdAt: new Date(),
      });

      opening = {
        transaction,
        ledger,
      };
    }

    await this.persistence.save(wallet, opening);

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}
