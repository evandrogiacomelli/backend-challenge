
import { Money } from '../../../shared/domain/money.js';

export type LedgerDirection = 'CREDIT' | 'DEBIT';

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    private readonly _createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new Error('Ledger amount must be positive');
    }

    if (
      props.money.currency !== props.balanceBefore.currency ||
      props.money.currency !== props.balanceAfter.currency
    ) {
      throw new Error('Currency mismatch');
    }

    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      new Date(props.createdAt?.getTime() ?? Date.now()),
    );

    if (!entry.isBalanced()) {
      throw new Error('Unbalanced ledger entry');
    }

    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      new Date(state.createdAt.getTime()),
    );
  }

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  isBalanced(): boolean {
    if (
      !this.money.isPositive() ||
      this.money.currency !== this.balanceBefore.currency ||
      this.money.currency !== this.balanceAfter.currency
    ) {
      return false;
    }

    if (this.direction === 'CREDIT') {
      return this.balanceBefore
        .add(this.money)
        .equals(this.balanceAfter);
    }

    if (this.direction === 'DEBIT') {
      return this.balanceBefore
        .subtract(this.money)
        .equals(this.balanceAfter);
    }

    return false;
  }
}
