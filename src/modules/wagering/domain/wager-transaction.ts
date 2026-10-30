
import { Money } from '../../../shared/domain/money.js';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export type LedgerDirection = 'CREDIT' | 'DEBIT';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  createdAt: Date;
  referenceTransactionId?: string;
  failureCode?: string;
  processedAt?: Date;
  resultingBalance?: Money;
  attempts: number;
  nextAttemptAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    private readonly _createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: string,
    private _processedAt?: Date,
    private _resultingBalance?: Money,
    private _attempts = 0,
    private _nextAttemptAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (
      !Object.values(WagerTransactionKind).includes(props.kind) ||
      props.kind === WagerTransactionKind.Opening
    ) {
      throw new Error('Invalid external transaction kind');
    }

    if (
      (props.kind === WagerTransactionKind.Refund ||
        props.kind === WagerTransactionKind.Rollback) &&
      !props.referenceExternalTransactionId?.trim()
    ) {
      throw new Error('Reference is required');
    }

    if (
      props.kind !== WagerTransactionKind.Loss &&
      !props.money.isPositive()
    ) {
      throw new Error('Transaction amount must be positive');
    }

    if (props.money.isNegative()) {
      throw new Error('Transaction amount cannot be negative');
    }

    const requiredFields = [
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
    ];

    if (requiredFields.some((value) => !value?.trim())) {
      throw new Error('Required transaction field is missing');
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      new Date(),
      WagerTransactionStatus.Pending,
    );
  }

  static createOpening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
  }): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new Error('Opening amount must be positive');
    }

    return new WagerTransaction(
      props.id,
      'SYSTEM',
      `opening:${props.walletId}`,
      `opening:${props.walletId}`,
      `internal-opening:${props.walletId}`,
      props.walletId,
      props.playerId,
      `opening:${props.walletId}`,
      'SYSTEM',
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      new Date(),
      WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      new Date(state.createdAt.getTime()),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt
        ? new Date(state.processedAt.getTime())
        : undefined,
      state.resultingBalance,
      state.attempts,
      state.nextAttemptAt
        ? new Date(state.nextAttemptAt.getTime())
        : undefined,
    );
  }

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): string | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt
      ? new Date(this._processedAt.getTime())
      : undefined;
  }

  get resultingBalance(): Money | undefined {
    return this._resultingBalance;
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt
      ? new Date(this._nextAttemptAt.getTime())
      : undefined;
  }

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  markPendingReference(): void {
    this.assertNotTerminal();

    if (!this.referenceExternalTransactionId) {
      throw new Error('Reference is required');
    }

    this._status = WagerTransactionStatus.PendingReference;
  }

  scheduleReferenceRetry(nextAttemptAt: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new Error('Transaction is not pending reference');
    }

    this._attempts += 1;
    this._nextAttemptAt = new Date(nextAttemptAt.getTime());
  }

  markProcessed(props: {
    resultingBalance: Money;
    reference?: WagerTransaction;
    at?: Date;
  }): void {
    this.assertNotTerminal();
    this.assertReference(props.reference);

    if (props.resultingBalance.currency !== this.money.currency) {
      throw new Error('Currency mismatch');
    }

    if (props.resultingBalance.isNegative()) {
      throw new Error('Resulting balance cannot be negative');
    }

    this._referenceTransactionId = props.reference?.id;
    this._resultingBalance = props.resultingBalance;
    this._processedAt = new Date(props.at?.getTime() ?? Date.now());
    this._nextAttemptAt = undefined;
    this._status = WagerTransactionStatus.Processed;
  }

  reject(code: string, resultingBalance?: Money): void {
    this.assertNotTerminal();
    this.assertFailureCode(code);
    this.assertSnapshotCurrency(resultingBalance);

    this._failureCode = code;
    this._resultingBalance = resultingBalance;
    this._nextAttemptAt = undefined;
    this._status = WagerTransactionStatus.Rejected;
  }

  fail(code: string): void {
    this.assertNotTerminal();
    this.assertFailureCode(code);

    this._failureCode = code;
    this._nextAttemptAt = undefined;
    this._status = WagerTransactionStatus.Failed;
  }

  ledgerDirectionFor(
    reference?: WagerTransaction,
  ): LedgerDirection | null {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
        return 'CREDIT';

      case WagerTransactionKind.Bet:
        return 'DEBIT';

      case WagerTransactionKind.Loss:
        return null;

      case WagerTransactionKind.Refund:
        this.assertReference(reference);
        return 'CREDIT';

      case WagerTransactionKind.Rollback:
        this.assertReference(reference);

        return reference!.kind === WagerTransactionKind.Bet
          ? 'CREDIT'
          : 'DEBIT';

      default:
        throw new Error('Invalid transaction kind');
    }
  }

  private assertReference(reference?: WagerTransaction): void {
    const referenceExpected =
      this.requiresReference() ||
      (this.kind === WagerTransactionKind.Win &&
        !!this.referenceExternalTransactionId);

    if (!referenceExpected) {
      return;
    }

    if (!reference) {
      throw new Error('Reference is required');
    }

    if (
      reference.id === this.id ||
      reference.externalTransactionId !==
      this.referenceExternalTransactionId
    ) {
      throw new Error('Invalid transaction reference');
    }

    if (reference.status !== WagerTransactionStatus.Processed) {
      throw new Error('Reference must be processed');
    }

    if (
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.roundId !== this.roundId ||
      reference.money.currency !== this.money.currency
    ) {
      throw new Error('Reference context mismatch');
    }

    if (this.kind === WagerTransactionKind.Win) {
      if (reference.kind !== WagerTransactionKind.Bet) {
        throw new Error('WIN must reference BET');
      }

      return;
    }

    if (!reference.money.equals(this.money)) {
      throw new Error('Reference amount mismatch');
    }

    if (
      this.kind === WagerTransactionKind.Refund &&
      reference.kind !== WagerTransactionKind.Bet
    ) {
      throw new Error('REFUND must reference BET');
    }

    if (
      this.kind === WagerTransactionKind.Refund &&
      reference.kind !== WagerTransactionKind.Bet
    ) {
      throw new Error('REFUND must reference BET');
    }

    const reversibleKinds: readonly WagerTransactionKind[] = [
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Refund,
    ];

    if (
      this.kind === WagerTransactionKind.Rollback &&
      !reversibleKinds.includes(reference.kind)
    ) {
      throw new Error('Invalid ROLLBACK reference kind');
    }
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new Error('Invalid transaction state');
    }
  }

  private assertFailureCode(code: string): void {
    if (!code.trim()) {
      throw new Error('Failure code is required');
    }
  }

  private assertSnapshotCurrency(balance?: Money): void {
    if (balance && balance.currency !== this.money.currency) {
      throw new Error('Currency mismatch');
    }
  }
}
