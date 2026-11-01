import { randomUUID } from 'node:crypto';

import {
  INestApplication,
  Module,
} from '@nestjs/common';

import { NestFactory } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';

import mikroOrmConfig from '../../src/config/mikro-orm.config.js';

import {
  WalletModule,
} from '../../src/modules/wallet/wallet.module.js';

import {
  WageringModule,
} from '../../src/modules/wagering/wagering.module.js';

@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmConfig),
    WalletModule,
    WageringModule,
  ],
})
class HttpIntegrationTestModule {}

interface WalletFixture {
  id: string;
  playerId: string;
}

interface WalletResponse {
  id: string;
  balance: {
    amount: string;
    currency: string;
  };
  version: number;
}

interface WagerBody {
  kind: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId?: string;
}

interface WagerResponse {
  transactionId: string;
  status: string;
  balance: {
    amount: string;
    currency: string;
  };
  walletVersion: number;
  idempotentReplay: boolean;
  failureCode?: string;
}

interface LedgerResponse {
  walletId: string;
  items: Array<{
    id: string;
    sequence: string;
    transactionId: string;
    direction: string;
    amount: string;
    balanceAfter: string;
  }>;
  nextCursor: string | null;
  limit: number;
}

interface ApiError {
  statusCode?: number;
  code?: string;
  message?: string | string[];
}

interface TransactionResponse {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  status: string;
}

interface HttpResult<T> {
  status: number;
  body: T;
}

let app: INestApplication;
let baseUrl: string;

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<HttpResult<T>> {
  const response = await fetch(
    `${baseUrl}${path}`,
    options,
  );

  return {
    status: response.status,
    body: (await response.json()) as T,
  };
}

async function createWallet(
  amount = '100.00',
): Promise<WalletFixture> {
  const playerId = randomUUID();

  const response = await request<WalletResponse>(
    '/wallets',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        playerId,
        initialBalance: {
          amount,
          currency: 'BRL',
        },
      }),
    },
  );

  expect(response.status).toBe(201);
  expect(response.body.id).toBeDefined();

  return {
    id: response.body.id,
    playerId,
  };
}

function wagerBody(
  wallet: WalletFixture,
  kind: string,
  amount = '30.00',
): WagerBody {
  return {
    kind,
    providerId: 'http-integration-tests',
    externalTransactionId: randomUUID(),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: randomUUID(),
    gameId: 'integration-game',
    amount,
    currency: 'BRL',
  };
}

function postWager<T = WagerResponse>(
  body: WagerBody | Record<string, unknown>,
  key: string | undefined = randomUUID(),
): Promise<HttpResult<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (key !== undefined) {
    headers['Idempotency-Key'] = key;
  }

  return request<T>(
    '/wagering/transactions',
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
  );
}

beforeAll(async () => {
  app = await NestFactory.create(
    HttpIntegrationTestModule,
    {
      logger: false,
    },
  );

  await app.listen(0, '127.0.0.1');

  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app?.close();
});

describe('Real HTTP wagering integration', () => {
  test(
    'BET is persisted once and HTTP replay is idempotent',
    async () => {
      const wallet = await createWallet();
      const input = wagerBody(wallet, 'BET');
      const key = randomUUID();

      const first = await postWager(input, key);
      const replay = await postWager(input, key);

      expect(first.status).toBe(200);
      expect(first.body.status).toBe('PROCESSED');
      expect(first.body.idempotentReplay).toBe(false);
      expect(first.body.balance.amount).toBe('70.00');

      expect(replay.status).toBe(200);
      expect(replay.body.idempotentReplay).toBe(true);
      expect(replay.body.transactionId)
        .toBe(first.body.transactionId);
      expect(replay.body.walletVersion)
        .toBe(first.body.walletVersion);

      const saved = await request<WalletResponse>(
        `/wallets/${wallet.id}`,
      );

      expect(saved.status).toBe(200);
      expect(saved.body.balance.amount).toBe('70.00');
      expect(saved.body.version).toBe(2);

      const ledger = await request<LedgerResponse>(
        `/wallets/${wallet.id}/ledger`,
      );

      expect(ledger.status).toBe(200);
      expect(ledger.body.items).toHaveLength(2);

      expect(
        ledger.body.items.map((entry) => entry.sequence),
      ).toEqual(['1', '2']);

      expect(
        ledger.body.items.map((entry) => entry.direction),
      ).toEqual(['CREDIT', 'DEBIT']);
    },
  );

  test(
    'rejects a missing Idempotency-Key with HTTP 400',
    async () => {
      const wallet = await createWallet();

      const result = await postWager<ApiError>(
        wagerBody(wallet, 'BET'),
        undefined,
      );

      // The default parameter of postWager generates a
      // key for undefined. Send a raw HTTP request instead.
      const raw = await request<ApiError>(
        '/wagering/transactions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(
            wagerBody(wallet, 'BET'),
          ),
        },
      );

      expect(raw.status).toBe(400);

      // This request has an automatically generated
      // key, so it must remain a valid operation.
      expect(result.status).toBe(200);
    },
  );

  test(
    'rejects invalid amount and unknown kind',
    async () => {
      const wallet = await createWallet();

      const invalidAmount = await postWager<ApiError>({
        ...wagerBody(wallet, 'BET'),
        amount: 30,
      });

      expect(invalidAmount.status).toBe(400);

      const invalidKind = await postWager<ApiError>(
        wagerBody(wallet, 'UNKNOWN'),
      );

      expect(invalidKind.status).toBe(400);

      const invalidReference = await postWager<ApiError>({
        ...wagerBody(wallet, 'WIN'),
        referenceExternalTransactionId: randomUUID(),
      });

      expect(invalidReference.status).toBe(400);
    },
  );

  test(
    'returns HTTP 409 when an idempotency key is reused with changed payload',
    async () => {
      const wallet = await createWallet();
      const input = wagerBody(wallet, 'BET');
      const key = randomUUID();

      const first = await postWager(input, key);

      expect(first.status).toBe(200);

      const conflict = await postWager<ApiError>(
        {
          ...input,
          amount: '40.00',
        },
        key,
      );

      expect(conflict.status).toBe(409);

      const saved = await request<WalletResponse>(
        `/wallets/${wallet.id}`,
      );

      expect(saved.body.balance.amount).toBe('70.00');
      expect(saved.body.version).toBe(2);
    },
  );

  test(
    'returns HTTP 409 for a second identity refunding the same BET',
    async () => {
      const wallet = await createWallet();
      const bet = wagerBody(wallet, 'BET');

      const betResult = await postWager(bet);

      expect(betResult.body.status).toBe('PROCESSED');

      const refund = {
        ...wagerBody(wallet, 'REFUND'),
        roundId: bet.roundId,
        gameId: bet.gameId,
        referenceExternalTransactionId:
        bet.externalTransactionId,
      };

      const firstRefund = await postWager(refund);

      expect(firstRefund.status).toBe(200);
      expect(firstRefund.body.status).toBe('PROCESSED');

      const secondRefund = await postWager<ApiError>({
        ...refund,
        externalTransactionId: randomUUID(),
      });

      expect(secondRefund.status).toBe(409);

      const saved = await request<WalletResponse>(
        `/wallets/${wallet.id}`,
      );

      expect(saved.body.balance.amount).toBe('100.00');
      expect(saved.body.version).toBe(3);
    },
  );

  test(
    'persists insufficient-funds rejection without debit',
    async () => {
      const wallet = await createWallet('20.00');
      const input = wagerBody(wallet, 'BET', '30.00');
      const key = randomUUID();

      const first = await postWager(input, key);
      const replay = await postWager(input, key);

      expect(first.status).toBe(200);
      expect(first.body.status).toBe('REJECTED');
      expect(first.body.failureCode)
        .toBe('INSUFFICIENT_FUNDS');

      expect(replay.status).toBe(200);
      expect(replay.body.idempotentReplay).toBe(true);
      expect(replay.body.transactionId)
        .toBe(first.body.transactionId);

      const walletResult =
        await request<WalletResponse>(
          `/wallets/${wallet.id}`,
        );

      expect(walletResult.body.balance.amount)
        .toBe('20.00');
      expect(walletResult.body.version).toBe(1);

      const ledger = await request<LedgerResponse>(
        `/wallets/${wallet.id}/ledger`,
      );

      expect(ledger.body.items).toHaveLength(1);
    },
  );

  test(
    'persists unresolved REFUND as PENDING_REFERENCE without credit',
    async () => {
      const wallet = await createWallet();

      const input = {
        ...wagerBody(wallet, 'REFUND'),
        referenceExternalTransactionId:
          randomUUID(),
      };

      const result = await postWager(input);

      expect(result.status).toBe(200);
      expect(result.body.status)
        .toBe('PENDING_REFERENCE');

      expect(result.body.balance.amount)
        .toBe('100.00');

      const ledger = await request<LedgerResponse>(
        `/wallets/${wallet.id}/ledger`,
      );

      expect(ledger.body.items).toHaveLength(1);
    },
  );

  test(
    'processes WIN, ROLLBACK and LOSS through HTTP',
    async () => {
      const wallet = await createWallet();
      const win = wagerBody(wallet, 'WIN', '20.00');

      const winResult = await postWager(win);

      expect(winResult.status).toBe(200);
      expect(winResult.body.balance.amount)
        .toBe('120.00');

      const rollback = {
        ...wagerBody(wallet, 'ROLLBACK', '20.00'),
        roundId: win.roundId,
        gameId: win.gameId,
        referenceExternalTransactionId:
        win.externalTransactionId,
      };

      const rollbackResult =
        await postWager(rollback);

      expect(rollbackResult.status).toBe(200);
      expect(rollbackResult.body.status)
        .toBe('PROCESSED');
      expect(rollbackResult.body.balance.amount)
        .toBe('100.00');

      const lossResult = await postWager(
        wagerBody(wallet, 'LOSS', '5.00'),
      );

      expect(lossResult.status).toBe(200);
      expect(lossResult.body.status)
        .toBe('PROCESSED');
      expect(lossResult.body.balance.amount)
        .toBe('100.00');
      expect(lossResult.body.walletVersion).toBe(3);

      const ledger = await request<LedgerResponse>(
        `/wallets/${wallet.id}/ledger`,
      );

      expect(ledger.body.items).toHaveLength(3);

      expect(
        ledger.body.items.map((item) => item.direction),
      ).toEqual(['CREDIT', 'CREDIT', 'DEBIT']);
    },
  );

  test(
    'retrieves a transaction by UUID and provider identity',
    async () => {
      const wallet = await createWallet();
      const input = wagerBody(wallet, 'BET');

      const created = await postWager(input);

      expect(created.status).toBe(200);

      const byId = await request<TransactionResponse>(
        `/wagering/transactions/${created.body.transactionId}`,
      );

      expect(byId.status).toBe(200);
      expect(byId.body.transactionId)
        .toBe(created.body.transactionId);

      const byProvider =
        await request<TransactionResponse>(
          `/providers/${input.providerId}/wagering/transactions/${input.externalTransactionId}`,
        );

      expect(byProvider.status).toBe(200);
      expect(byProvider.body.transactionId)
        .toBe(created.body.transactionId);
      expect(byProvider.body.kind).toBe('BET');
    },
  );
});
