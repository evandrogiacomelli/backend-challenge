import {
  describe,
  expect,
  test,
} from 'bun:test';

import {
  RecoverPendingReferencesUseCase,
} from './recover-pending-references.use-case.js';

import type {
  PendingReferenceClaim,
  PendingReferenceClaimer,
} from '../ports/pending-reference-claimer.js';

import type {
  PendingReferenceRecovery,
  PendingReferenceRecoveryStatus,
} from '../ports/pending-reference-recovery.js';

function claim(
  id: string,
): PendingReferenceClaim {
  return {
    id,
    providerId: 'provider-1',
    externalTransactionId: `external-${id}`,
    idempotencyKey: `key-${id}`,
    payloadHash: `hash-${id}`,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'REFUND',
    amount: '30.00',
    currency: 'BRL',
    referenceExternalTransactionId: 'bet-1',
    attempts: 1,
    nextAttemptAt: new Date(),
  };
}

function harness(
  claims: PendingReferenceClaim[],
  process: (
    item: PendingReferenceClaim,
  ) => Promise<PendingReferenceRecoveryStatus>,
) {
  const received: string[] = [];

  const claimer: PendingReferenceClaimer = {
    async claimDue() {
      return claims;
    },
  };

  const recovery: PendingReferenceRecovery = {
    async recover(item) {
      received.push(item.id);

      return {
        transactionId: item.id,
        status: await process(item),
      };
    },
  };

  return {
    received,
    useCase: new RecoverPendingReferencesUseCase(
      claimer,
      recovery,
    ),
  };
}

describe(
  'RecoverPendingReferencesUseCase',
  () => {
    test(
      'processes an empty batch',
      async () => {
        const setup = harness(
          [],
          async () => 'PROCESSED',
        );

        const result = await setup.useCase.execute({
          limit: 10,
          leaseSeconds: 120,
        });

        expect(result.claimed).toBe(0);
        expect(result.processed).toBe(0);
        expect(result.failed).toBe(0);
      },
    );

    test(
      'counts processed, retry, rejected and stale claims',
      async () => {
        const statuses: PendingReferenceRecoveryStatus[] =
          [
            'PROCESSED',
            'RETRY_SCHEDULED',
            'REJECTED',
            'STALE_CLAIM',
          ];

        const setup = harness(
          [
            claim('1'),
            claim('2'),
            claim('3'),
            claim('4'),
          ],
          async () => statuses.shift()!,
        );

        const result = await setup.useCase.execute({
          limit: 10,
          leaseSeconds: 120,
        });

        expect(result.claimed).toBe(4);
        expect(result.processed).toBe(1);
        expect(result.retryScheduled).toBe(1);
        expect(result.rejected).toBe(1);
        expect(result.staleClaims).toBe(1);
        expect(result.failed).toBe(0);

        expect(setup.received).toEqual([
          '1',
          '2',
          '3',
          '4',
        ]);
      },
    );

    test(
      'continues the batch after a recovery failure',
      async () => {
        const setup = harness(
          [
            claim('first'),
            claim('second'),
          ],
          async (item) => {
            if (item.id === 'first') {
              throw new Error('Database unavailable');
            }

            return 'PROCESSED';
          },
        );

        const result = await setup.useCase.execute({
          limit: 10,
          leaseSeconds: 120,
        });

        expect(result.claimed).toBe(2);
        expect(result.failed).toBe(1);
        expect(result.processed).toBe(1);

        expect(result.failures).toEqual([
          {
            transactionId: 'first',
            message: 'Database unavailable',
          },
        ]);

        expect(setup.received).toEqual([
          'first',
          'second',
        ]);
      },
    );
  },
);
