import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';

import {
  Module,
  type INestApplicationContext,
} from '@nestjs/common';

import { Test } from '@nestjs/testing';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import {
  EntityManager,
  MikroORM,
} from '@mikro-orm/postgresql';

import {
  ScheduleModule,
} from '@nestjs/schedule';

import mikroOrmConfig from '../../src/config/mikro-orm.config.js';

import {
  PendingReferenceModule,
} from '../../src/modules/wagering/pending-reference.module.js';

import {
  PENDING_REFERENCE_CLAIMER,
  type ClaimPendingReferencesInput,
  type PendingReferenceClaimer,
} from '../../src/modules/wagering/application/ports/pending-reference-claimer.js';

import {
  MikroOrmPendingReferenceClaimer,
} from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-pending-reference-claimer.js';

import {
  CreateWalletUseCase,
} from '../../src/modules/wallet/application/use-cases/create-wallet.use-case.js';

import {
  MikroOrmWalletOpeningPersistence,
} from '../../src/modules/wallet/infrastructure/persistence/mikro-orm-wallet-opening.persistence.js';

import {
  ProcessBetUseCase,
} from '../../src/modules/wagering/application/use-cases/process-bet.use-case.js';

import {
  MikroOrmBetTransactionRunner,
} from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-bet-transaction-runner.js';

import {
  ProcessRefundUseCase,
} from '../../src/modules/wagering/application/use-cases/process-refund.use-case.js';

import {
  MikroOrmRefundTransactionRunner,
} from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-refund-transaction-runner.js';

import {
  WagerTransactionStatus,
} from '../../src/modules/wagering/domain/wager-transaction.js';

@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmConfig),
    ScheduleModule.forRoot(),
    PendingReferenceModule,
  ],
})
class SchedulerE2eModule {}

let app: INestApplicationContext;
let orm: MikroORM;

// Unique provider for this E2E execution.
// Other pending references must not consume
// this test worker's recovery batches.
const e2eProviderId = `worker-e2e-${randomUUID()}`;

const previousWorkerFlag =
  process.env.PENDING_REFERENCE_WORKER_ENABLED;

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
    throw new Error(
      `Transaction not found: ${transactionId}`,
    );
  }

  return rows[0];
}

async function waitForProcessed(
  transactionId: string,
): Promise<RecoveryState> {
  const deadline = Date.now() + 35_000;

  let lastStatus = 'UNKNOWN';

  while (Date.now() < deadline) {
    const state = await inspect(transactionId);

    lastStatus = state.status;

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
    'Automatic recovery did not complete within ' +
    `35 seconds. Transaction=${transactionId}, ` +
    `provider=${e2eProviderId}, ` +
    `lastStatus=${lastStatus}.`,
  );
}

beforeAll(async () => {
  process.env.PENDING_REFERENCE_WORKER_ENABLED =
    'true';

  // Override only this test module's claimer.
  // The underlying implementation remains real:
  // PostgreSQL transaction, lease and SKIP LOCKED.
  const moduleRef = await Test.createTestingModule({
    imports: [SchedulerE2eModule],
  })
    .overrideProvider(PENDING_REFERENCE_CLAIMER)
    .useFactory({
      factory: (
        em: EntityManager,
      ): PendingReferenceClaimer => {
        const realClaimer =
          new MikroOrmPendingReferenceClaimer(em);

        return {
          claimDue: (
            input: ClaimPendingReferencesInput,
          ) => {
            return realClaimer.claimDue({
              ...input,
              providerId: e2eProviderId,
            });
          },
        };
      },
      inject: [EntityManager],
    })
    .compile();

  // Initialize lifecycle hooks and the
  // actual @Interval scheduler.
  await moduleRef.init();

  app = moduleRef;

  // Share the ORM managed by NestJS.
  orm = app.get(MikroORM);
});

afterAll(async () => {
  try {
    if (app) {
      // Stops the scheduler and waits for
      // active worker shutdown hooks.
      await app.close();
    }
  } finally {
    if (previousWorkerFlag === undefined) {
      delete process.env
        .PENDING_REFERENCE_WORKER_ENABLED;
    } else {
      process.env
        .PENDING_REFERENCE_WORKER_ENABLED =
        previousWorkerFlag;
    }
  }
});

describe(
  'PENDING_REFERENCE automatic scheduler E2E',
  () => {
    test(
      'automatically processes REFUND after BET arrives',
      async () => {
        const playerId = randomUUID();

        // Must match the claimer override.
        const providerId = e2eProviderId;

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

        // 2. Referenced BET arrives.
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

        // 3. Real NestJS scheduler must recover
        // REFUND without a manual worker call.
        //
        // Only this E2E provider is eligible
        // for the overridden claimer.
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

        // 4. Duplicate REFUND must return
        // the persisted financial result.
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

        // No additional ledger entry, position
        // or outbox event can be created by replay.
        const final = await inspect(
          pending.transactionId,
        );

        expect(final).toEqual(recovered);
      },
      45_000,
    );
  },
);
