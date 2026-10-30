
import { Money } from '../../../shared/domain/money.js';

interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
}

interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovement {
  readonly direction: 'CREDIT' | 'DEBIT';
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new Error('Initial balance cannot be negative');
    }

    const now = new Date();

    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  credit(money: Money): WalletMovement {
    this.assertSameCurrency(money);
    this.assertPositiveAmount(money);

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.add(money);

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = new Date();

    return {
      direction: 'CREDIT',
      money,
      balanceBefore,
      balanceAfter,
    };
  }

  debit(money: Money): WalletMovement {
    this.assertSameCurrency(money);
    this.assertPositiveAmount(money);

    if (this._balance.isLessThan(money)) {
      throw new Error('Insufficient balance');
    }

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.subtract(money);

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = new Date();

    return {
      direction: 'DEBIT',
      money,
      balanceBefore,
      balanceAfter,
    };
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new Error('Currency mismatch');
    }
  }

  private assertPositiveAmount(money: Money): void {
    if (!money.isPositive()) {
      throw new Error('Amount must be positive');
    }
  }
}

