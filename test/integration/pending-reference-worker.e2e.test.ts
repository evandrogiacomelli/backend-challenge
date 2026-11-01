import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';

import mikroOrmConfig from '../../src/config/mikro-orm.config.js';

import { CreateWalletUseCase } from '../../src/modules/wallet/application/use-cases/create-wallet.use-case.js';
import { MikroOrmWalletOpeningPersistence } from '../../src/modules/wallet/infrastructure/persistence/mikro-orm-wallet-opening.persistence.js';

import { ProcessBetUseCase } from '../../src/modules/wagering/application/use-cases/process-bet.use-case.js';
import { MikroOrmBetTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-bet-transaction-runner.js';

import { ProcessRefundUseCase } from '../../src/modules/wagering/application/use-cases/process-refund.use-case.js';
import { MikroOrmRefundTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-refund-transaction-runner.js';

import { WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction.js';

let orm: MikroORM;

interface RecoveryState {
  status: string;
  reference_transaction_id: string | null;
  balance: string;
  version: number;
  ledger_count: number;
  positions: number;
  refund_events: number;
}

async function inspect(
  transactionId: string,
): Promise<RecoveryState> {
  const rows = await orm.em.fork().execute<
    RecoveryState[]
  >(
    `
      SELECT
        t.status,
        t.reference_transaction_id::text,

        w.balance_amount::text AS balance,
        w.version,

        (
          SELECT COUNT(*)::int
          FROM wallet_ledger_entries l
          WHERE l.wallet_id = w.id
        ) AS ledger_count,

        (
          SELECT COUNT(*)::int
          FROM wallet_ledger_positions p
          WHERE p.wallet_id = w.id
        ) AS positions,

        (
          SELECT COUNT(*)::int
          FROM outbox_messages o
          WHERE o.aggregate_id = w.id
            AND o.event_type =
              'wager.refund.processed.v1'
        ) AS refund_events

      FROM wager_transactions t
      JOIN wallets w ON w.id = t.wallet_id
      WHERE t.id = ?
    `,
    [transactionId],
    'all',
  );

  if (!rows[0]) {
    throw new Error('Transaction not found');
  }

  return rows[0];
}

async function waitForProcessed(
  transactionId: string,
): Promise<RecoveryState> {
  const deadline = Date.now() + 35_000;

  while (Date.now() < deadline) {
    const state = await inspect(transactionId);

    if (state.status === 'PROCESSED') {
      return state;
    }

    if (
      state.status === 'REJECTED' ||
      state.status === 'FAILED'
    ) {
      throw new Error(
        `Recovery became terminal: ${state.status}`,
      );
    }

    await Bun.sleep(250);
  }

  throw new Error(
    'Automatic recovery did not complete within the test deadline. Confirm NestJS scheduler is running.',
  );
}

beforeAll(async () => {
  orm = await MikroORM.init(mikroOrmConfig);
});

afterAll(async () => {
  await orm?.close(true);
});

describe(
  'PENDING_REFERENCE automatic scheduler E2E',
  () => {
    test(
      'automatically processes REFUND after BET arrives',
      async () => {
        const playerId = randomUUID();
        const providerId =
          `worker-e2e-${randomUUID()}`;

        const wallet =
          await new CreateWalletUseCase(
            new MikroOrmWalletOpeningPersistence(
              orm.em.fork(),
            ),
          ).execute({
            playerId,
            initialBalance: {
              amount: '100.00',
              currency: 'BRL',
            },
          });

        const walletId = wallet.id;
        const roundId = randomUUID();
        const gameId = 'worker-e2e-game';
        const betExternalId = randomUUID();

        const refundInput = {
          providerId,
          externalTransactionId: randomUUID(),
          idempotencyKey: randomUUID(),
          referenceExternalTransactionId:
          betExternalId,
          walletId,
          playerId,
          roundId,
          gameId,
          amount: '30.00',
          currency: 'BRL',
        };

        // 1. REFUND arrives before BET.
        const pending =
          await new ProcessRefundUseCase(
            new MikroOrmRefundTransactionRunner(
              orm.em.fork(),
            ),
          ).execute(refundInput);

        expect(pending.status).toBe(
          WagerTransactionStatus.PendingReference,
        );

        const beforeBet = await inspect(
          pending.transactionId,
        );

        expect(beforeBet.status).toBe(
          'PENDING_REFERENCE',
        );

        expect(beforeBet.balance).toBe('100.00');
        expect(beforeBet.version).toBe(1);
        expect(beforeBet.ledger_count).toBe(1);

        // 2. Original BET arrives.
        const bet = await new ProcessBetUseCase(
          new MikroOrmBetTransactionRunner(
            orm.em.fork(),
          ),
        ).execute({
          providerId,
          externalTransactionId: betExternalId,
          idempotencyKey: randomUUID(),
          walletId,
          playerId,
          roundId,
          gameId,
          amount: '30.00',
          currency: 'BRL',
        });

        expect(bet.status).toBe(
          WagerTransactionStatus.Processed,
        );

        const afterBet = await inspect(
          pending.transactionId,
        );

        expect(afterBet.balance).toBe('70.00');
        expect(afterBet.version).toBe(2);

        // 3. No manual recovery call.
        // The separate NestJS worker must do it.
        const recovered = await waitForProcessed(
          pending.transactionId,
        );

        expect(recovered.status).toBe(
          'PROCESSED',
        );

        expect(
          recovered.reference_transaction_id,
        ).toBe(bet.transactionId);

        expect(recovered.balance).toBe('100.00');
        expect(recovered.version).toBe(3);

        expect(recovered.ledger_count).toBe(3);
        expect(recovered.positions).toBe(3);
        expect(recovered.refund_events).toBe(1);

        // 4. Replaying the same REFUND after
        // recovery must return the stored result.
        const replay =
          await new ProcessRefundUseCase(
            new MikroOrmRefundTransactionRunner(
              orm.em.fork(),
            ),
          ).execute(refundInput);

        expect(replay.idempotentReplay).toBe(true);

        expect(replay.transactionId).toBe(
          pending.transactionId,
        );

        expect(replay.status).toBe(
          WagerTransactionStatus.Processed,
        );

        expect(replay.balance.amount).toBe(
          '100.00',
        );

        // Replay cannot produce new ledger entries.
        const final = await inspect(
          pending.transactionId,
        );

        expect(final).toEqual(recovered);
      },
      45_000,
    );
  },
);
