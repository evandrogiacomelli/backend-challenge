import { randomUUID } from 'node:crypto';

import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import { Money } from '../../../../shared/domain/money.js';
import {
  InboxAlreadyProcessedError,
  InboxIncompleteError,
  InboxPayloadConflictError,
  type InboxReceipt,
} from '../../application/ports/bet-transaction-runner.js';
import {
  WinIdentityConflictError,
  WinWriteConflictError,
  type LockedWinContext,
  type StoredWin,
  type WinIdentity,
  type WinPersistenceDetails,
  type WinResponseSnapshot,
  type WinTransactionRunner,
  type WinWallet,
} from '../../application/ports/win-transaction-runner.js';
import type { WalletLedgerEntry } from '../../../ledger/domain/wallet-ledger-entry.js';
import type { WagerTransaction } from '../../domain/wager-transaction.js';

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance_amount: string;
  version: number;
}

interface WagerRow {
  id: string;
  kind: string;
  idempotency_key: string;
  external_transaction_id: string;
  payload_hash: string;
  response_snapshot: WinResponseSnapshot | null;
}

/**
 * A short-lived mutable wallet view, created only after SELECT FOR UPDATE.
 * This avoids coupling the persistence adapter to ORM entity hydration.
 */
class LockedWinWallet implements WinWallet {
  private balanceValue: Money;
  private versionValue: number;

  constructor(private readonly row: WalletRow) {
    this.balanceValue = Money.from({
      amount: String(row.balance_amount),
      currency: row.currency,
    });
    this.versionValue = Number(row.version);
  }

  get id(): string { return this.row.id; }
  get playerId(): string { return this.row.player_id; }
  get currency(): string { return this.row.currency; }
  get balance(): Money { return this.balanceValue; }
  get version(): number { return this.versionValue; }

  credit(money: Money): { balanceBefore: Money; balanceAfter: Money } {
    if (money.currency !== this.currency || !money.isPositive()) {
      throw new Error('Invalid WIN money');
    }

    const balanceBefore = this.balanceValue;
    this.balanceValue = this.balanceValue.add(money);
    this.versionValue += 1;
    return { balanceBefore, balanceAfter: this.balanceValue };
  }
}

function pgErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as {
    code?: string;
    driverException?: { code?: string };
    cause?: { code?: string };
  };
  return e.code ?? e.driverException?.code ?? e.cause?.code;
}

@Injectable()
export class MikroOrmWinTransactionRunner implements WinTransactionRunner {
  constructor(private readonly em: EntityManager) {}

  /**
   * Check both unique identities, not only the first matching row.
   * A BET using either identity is never interpreted as a WIN replay.
   */
  private async findExistingIn(
    em: EntityManager,
    identity: WinIdentity,
  ): Promise<StoredWin | null> {
    const rows = await em.execute<WagerRow[]>(
      `
      SELECT id, kind, idempotency_key, external_transaction_id,
             payload_hash, response_snapshot
      FROM wager_transactions
      WHERE provider_id = ?
        AND (idempotency_key = ? OR external_transaction_id = ?)
      LIMIT 2
      `,
      [identity.providerId, identity.idempotencyKey, identity.externalTransactionId],
      'all',
    );

    if (rows.length === 0) return null;
    if (rows.length > 1 || rows[0]!.kind !== 'WIN') {
      throw new WinIdentityConflictError('Identity belongs to another wager transaction');
    }

    const row = rows[0]!;
    return {
      idempotencyKey: row.idempotency_key,
      externalTransactionId: row.external_transaction_id,
      payloadHash: row.payload_hash,
      snapshot: row.response_snapshot,
    };
  }

  async findExisting(identity: WinIdentity): Promise<StoredWin | null> {
    return this.findExistingIn(this.em.fork(), identity);
  }

  private async insertInbox(em: EntityManager, inbox: InboxReceipt): Promise<void> {
    const inserted = await em.execute<Array<{ id: string }>>(
      `INSERT INTO inbox_messages
         (id, consumer_name, message_id, payload_hash, received_at)
       VALUES (?, ?, ?, ?, NOW())
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING id`,
      [randomUUID(), inbox.consumerName, inbox.messageId, inbox.payloadHash],
      'all',
    );

    if (inserted.length > 0) return;

    const found = await em.execute<Array<{
      payload_hash: string;
      processed_at: string | Date | null;
    }>>(
      `SELECT payload_hash, processed_at
       FROM inbox_messages
       WHERE consumer_name = ? AND message_id = ?`,
      [inbox.consumerName, inbox.messageId],
      'all',
    );

    const previous = found[0];
    if (!previous) throw new InboxIncompleteError();
    if (previous.payload_hash !== inbox.payloadHash) {
      throw new InboxPayloadConflictError();
    }
    if (previous.processed_at !== null) {
      throw new InboxAlreadyProcessedError();
    }
    throw new InboxIncompleteError();
  }

  async withLockedWallet<T>(
    walletId: string,
    identity: WinIdentity,
    operation: (context: LockedWinContext) => Promise<T>,
    inbox?: InboxReceipt,
  ): Promise<T> {
    try {
      return await this.em.fork().transactional(async (tx) => {
        if (inbox) await this.insertInbox(tx, inbox);

        const rows = await tx.execute<WalletRow[]>(
          `SELECT id, player_id, currency, balance_amount, version
           FROM wallets WHERE id = ? FOR UPDATE`,
          [walletId],
          'all',
        );

        const initial = rows[0];
        if (!initial) throw new Error('Wallet not found');

        const wallet = new LockedWinWallet(initial);
        const existing = await this.findExistingIn(tx, identity);

        const context: LockedWinContext = {
          wallet,
          existing,
          saveProcessed: async (
            transaction: WagerTransaction,
            ledger: WalletLedgerEntry,
            snapshot: WinResponseSnapshot,
            details: WinPersistenceDetails,
          ) => {
            if (existing) {
              throw new Error('Cannot persist a WIN for an existing identity');
            }

            // This UPDATE and all INSERTs below are inside the same SQL tx.
            const updated = await tx.execute<Array<{ id: string }>>(
              `UPDATE wallets
                 SET balance_amount = ?, version = ?, updated_at = NOW()
               WHERE id = ? AND version = ?
               RETURNING id`,
              [
                wallet.balance.toJSON().amount,
                wallet.version,
                wallet.id,
                Number(initial.version),
              ],
              'all',
            );

            if (updated.length !== 1) {
              throw new Error('Wallet version changed while locked');
            }

            await tx.execute(
              `INSERT INTO wager_transactions
                (id, provider_id, external_transaction_id, idempotency_key,
                 payload_hash, wallet_id, player_id, round_id, game_id,
                 kind, status, amount, currency, resulting_balance_amount,
                 resulting_balance_currency, response_snapshot, processed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'WIN', 'PROCESSED',
                       ?, ?, ?, ?, ?::jsonb, NOW())`,
              [
                transaction.id,
                identity.providerId,
                identity.externalTransactionId,
                identity.idempotencyKey,
                identity.payloadHash,
                wallet.id,
                wallet.playerId,
                details.roundId,
                details.gameId,
                details.amount.toJSON().amount,
                details.amount.currency,
                wallet.balance.toJSON().amount,
                wallet.currency,
                JSON.stringify(snapshot),
              ],
            );

            // AFTER INSERT trigger from commit 19 allocates next sequence.
            // If ledger continuity fails, this whole transaction rolls back.
            await tx.execute(
              `INSERT INTO wallet_ledger_entries
                (id, wallet_id, wager_transaction_id, direction, amount,
                 currency, balance_before, balance_after, created_at)
               VALUES (?, ?, ?, 'CREDIT', ?, ?, ?, ?, NOW())`,
              [
                ledger.id,
                wallet.id,
                transaction.id,
                details.amount.toJSON().amount,
                wallet.currency,
                details.balanceBefore.toJSON().amount,
                wallet.balance.toJSON().amount,
              ],
            );

            const eventId = randomUUID();
            const now = new Date();
            await tx.execute(
              `INSERT INTO outbox_messages
                (id, aggregate_id, event_type, payload, status,
                 attempts, next_attempt_at, occurred_at, created_at)
               VALUES (?, ?, ?, ?::jsonb, 'PENDING', 0, NOW(), NOW(), NOW())`,
              [
                eventId,
                wallet.id,
                'wager.win.processed.v1',
                JSON.stringify({
                  eventId,
                  schemaVersion: 1,
                  walletId: wallet.id,
                  transactionId: transaction.id,
                  kind: 'WIN',
                  amount: details.amount.toJSON(),
                  balance: snapshot.balance,
                  walletVersion: snapshot.walletVersion,
                  occurredAt: now.toISOString(),
                }),
              ],
            );
          },
        };

        const result = await operation(context);

        if (inbox) {
          await tx.execute(
            `UPDATE inbox_messages SET processed_at = NOW()
             WHERE consumer_name = ? AND message_id = ?
               AND processed_at IS NULL`,
            [inbox.consumerName, inbox.messageId],
          );
        }

        return result;
      });
    } catch (error) {
      // Only persistent uniqueness races become replay-eligible conflicts.
      // Constraint failures such as broken ledger arithmetic must propagate.
      if (pgErrorCode(error) === '23505') {
        throw new WinWriteConflictError();
      }
      throw error;
    }
  }
}
