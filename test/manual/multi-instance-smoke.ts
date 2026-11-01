import { randomUUID } from 'node:crypto';

const ports = [3001, 3002, 3003];

const urls = ports.map(
  (port) => `http://localhost:${port}`,
);

interface WagerResult {
  transactionId: string;
  status: string;
  idempotentReplay: boolean;
  walletVersion: number;
  balance: {
    amount: string;
    currency: string;
  };
}

interface WalletResult {
  id: string;
  version: number;
  balance: {
    amount: string;
    currency: string;
  };
}

interface LedgerResult {
  items: Array<{
    id: string;
    sequence: string;
    direction: string;
    amount: string;
    balanceAfter: string;
  }>;
  nextCursor: string | null;
}

async function json<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${url}: ${text}`,
    );
  }

  return JSON.parse(text) as T;
}

function assert(
  condition: boolean,
  message: string,
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  console.log('Checking three independent instances');

  for (const url of urls) {
    const ready = await json<{
      status: string;
    }>(`${url}/health/ready`);

    assert(
      ready.status === 'ok',
      `Instance not ready: ${url}`,
    );
  }

  const playerId = randomUUID();
  const roundId = randomUUID();

  const wallet = await json<WalletResult>(
    `${urls[0]}/wallets`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        playerId,
        initialBalance: {
          amount: '100.00',
          currency: 'BRL',
        },
      }),
    },
  );

  console.log(`Wallet: ${wallet.id}`);

  const base = {
    kind: 'BET',
    providerId: 'multi-instance-test',
    walletId: wallet.id,
    playerId,
    roundId,
    gameId: 'multi-instance-game',
    amount: '10.00',
    currency: 'BRL',
  };

  async function sendBet(
    externalTransactionId: string,
    idempotencyKey: string,
    index: number,
  ): Promise<WagerResult> {
    const url = urls[index % urls.length];

    return json<WagerResult>(
      `${url}/wagering/transactions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          ...base,
          externalTransactionId,
        }),
      },
    );
  }

  // Scenario 1: 50 identical requests across
  // three independently running NestJS instances.
  const externalId = randomUUID();
  const idempotencyKey = randomUUID();

  const duplicates = await Promise.all(
    Array.from(
      { length: 50 },
      (_, index) =>
        sendBet(
          externalId,
          idempotencyKey,
          index,
        ),
    ),
  );

  const transactionIds = new Set(
    duplicates.map(
      (result) => result.transactionId,
    ),
  );

  const originalCount = duplicates.filter(
    (result) =>
      result.idempotentReplay === false,
  ).length;

  const replayCount = duplicates.filter(
    (result) =>
      result.idempotentReplay === true,
  ).length;

  assert(
    transactionIds.size === 1,
    'Duplicate requests created multiple transactions',
  );

  assert(
    originalCount === 1,
    `Expected 1 original, got ${originalCount}`,
  );

  assert(
    replayCount === 49,
    `Expected 49 replays, got ${replayCount}`,
  );

  assert(
    duplicates.every(
      (result) =>
        result.status === 'PROCESSED' &&
        result.balance.amount === '90.00' &&
        result.walletVersion === 2,
    ),
    'Inconsistent idempotent response snapshots',
  );

  console.log(
    'Scenario 1 PASS: 1 debit, 49 idempotent replays',
  );

  // Scenario 2: 30 distinct BETs compete for the
  // remaining BRL 90.00.
  const concurrentBets = await Promise.all(
    Array.from(
      { length: 30 },
      (_, index) =>
        sendBet(
          randomUUID(),
          randomUUID(),
          index,
        ),
    ),
  );

  const processed = concurrentBets.filter(
    (result) => result.status === 'PROCESSED',
  );

  const rejected = concurrentBets.filter(
    (result) => result.status === 'REJECTED',
  );

  assert(
    processed.length === 9,
    `Expected 9 processed BETs, got ${processed.length}`,
  );

  assert(
    rejected.length === 21,
    `Expected 21 rejected BETs, got ${rejected.length}`,
  );

  console.log(
    'Scenario 2 PASS: 9 processed, 21 rejected',
  );

  const balances = await Promise.all(
    urls.map((url) =>
      json<WalletResult>(
        `${url}/wallets/${wallet.id}`,
      ),
    ),
  );

  for (const balance of balances) {
    assert(
      balance.balance.amount === '0.00',
      'Unexpected final balance',
    );

    assert(
      balance.version === 11,
      `Unexpected wallet version: ${balance.version}`,
    );
  }

  const ledger = await json<LedgerResult>(
    `${urls[2]}/wallets/${wallet.id}/ledger?limit=50`,
  );

  assert(
    ledger.items.length === 11,
    `Expected 11 ledger entries, got ${ledger.items.length}`,
  );

  assert(
    ledger.nextCursor === null,
    'Unexpected additional ledger page',
  );

  const sequences = ledger.items.map(
    (entry) => entry.sequence,
  );

  assert(
    sequences.every(
      (sequence, index) =>
        sequence === String(index + 1),
    ),
    'Non-contiguous accounting sequence',
  );

  assert(
    new Set(
      ledger.items.map((entry) => entry.id),
    ).size === 11,
    'Duplicate ledger entries detected',
  );

  assert(
    ledger.items.at(-1)?.balanceAfter === '0.00',
    'Final ledger balance mismatch',
  );

  console.log('Scenario 3 PASS: ledger integrity');
  console.log('Final balance: 0.00 BRL');
  console.log('Final wallet version: 11');
  console.log('Ledger entries: 11');
  console.log('MULTI-INSTANCE TEST PASSED');
}

await main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
