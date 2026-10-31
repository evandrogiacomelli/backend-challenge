import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
  SQSClient as AwsSqsClient,
} from '@aws-sdk/client-sqs';

import mikroOrmConfig from '../../src/config/mikro-orm.config.js';
import { SqsWagerConsumer } from '../../src/modules/messaging/inbox/infrastructure/sqs/sqs-wager.consumer.js';
import { WalletLedgerEntryEntity } from '../../src/modules/ledger/infrastructure/persistence/wallet-ledger-entry.entity.js';
import { ProcessBetUseCase } from '../../src/modules/wagering/application/use-cases/process-bet.use-case.js';
import { MikroOrmBetTransactionRunner } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-bet-transaction-runner.js';
import { CreateWalletUseCase } from '../../src/modules/wallet/application/use-cases/create-wallet.use-case.js';
import { MikroOrmWalletOpeningPersistence } from '../../src/modules/wallet/infrastructure/persistence/mikro-orm-wallet-opening.persistence.js';
import { WalletEntity } from '../../src/modules/wallet/infrastructure/persistence/wallet.entity.js';

interface QueuePair {
  sourceUrl: string;
  dlqUrl: string;
}

interface TestWallet {
  id: string;
  playerId: string;
}

let orm: MikroORM;
let sqs: SQSClient;

async function createQueuePair(): Promise<QueuePair> {
  const suffix = randomUUID();

  const dlq = await sqs.send(
    new CreateQueueCommand({
      QueueName: `wager-dlq-test-${suffix}.fifo`,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
      },
    }),
  );

  if (!dlq.QueueUrl) {
    throw new Error('DLQ URL missing');
  }

  const attributes = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlq.QueueUrl,
      AttributeNames: ['QueueArn'],
    }),
  );

  const dlqArn = attributes.Attributes?.QueueArn;
  if (!dlqArn) {
    throw new Error('DLQ ARN missing');
  }

  const source = await sqs.send(
    new CreateQueueCommand({
      QueueName: `wager-source-test-${suffix}.fifo`,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: '30',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: 3,
        }),
      },
    }),
  );

  if (!source.QueueUrl) {
    throw new Error('Source queue URL missing');
  }

  return {
    sourceUrl: source.QueueUrl,
    dlqUrl: dlq.QueueUrl,
  };
}

async function deleteQueuePair(pair: QueuePair): Promise<void> {
  // Delete source first, then its DLQ.
  await sqs.send(
    new DeleteQueueCommand({ QueueUrl: pair.sourceUrl }),
  );
  await sqs.send(
    new DeleteQueueCommand({ QueueUrl: pair.dlqUrl }),
  );
}

async function send(
  queueUrl: string,
  groupId: string,
  body: string,
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageGroupId: groupId,
      // Transport-level dedup ID is unique for an intentional replay.
      // The envelope's messageId stays unchanged for persistent Inbox dedup.
      MessageDeduplicationId: randomUUID(),
      MessageBody: body,
    }),
  );
}

async function receiveFromDlq(
  queueUrl: string,
): Promise<Message | undefined> {
  const response = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 1,
      VisibilityTimeout: 30,
    }),
  );
  return response.Messages?.[0];
}

function fastRetryClient(): SQSClient {
  // Test-only seam: exercise real LocalStack redrive without waiting
  // for the production consumer's exponential visibility backoff.
  return {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof ChangeMessageVisibilityCommand) {
        return sqs.send(
          new ChangeMessageVisibilityCommand({
            ...command.input,
            VisibilityTimeout: 0,
          }),
        );
      }
      return sqs.send(command as never);
    },
  } as unknown as SQSClient;
}

function failingProcessor(): ProcessBetUseCase {
  return {
    async execute(): Promise<never> {
      throw new Error('SIMULATED_PERSISTENT_FAILURE');
    },
  } as unknown as ProcessBetUseCase;
}

function realProcessor(): ProcessBetUseCase {
  return new ProcessBetUseCase(
    new MikroOrmBetTransactionRunner(orm.em.fork()),
  );
}

async function createWallet(): Promise<TestWallet> {
  const playerId = randomUUID();
  const useCase = new CreateWalletUseCase(
    new MikroOrmWalletOpeningPersistence(orm.em.fork()),
  );
  const result = await useCase.execute({
    playerId,
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  return { id: result.id, playerId };
}

function validEnvelope(wallet: TestWallet): string {
  return JSON.stringify({
    messageId: randomUUID(),
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'dlq-integration-provider',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: randomUUID(),
      gameId: 'dlq-integration-game',
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
    },
  });
}

async function drainUntilDlq(
  pair: QueuePair,
  processor: ProcessBetUseCase,
): Promise<{ message: Message; failures: number }> {
  const consumer = new SqsWagerConsumer(
    fastRetryClient(),
    pair.sourceUrl,
    processor,
  );
  let failures = 0;

  // AWS may transfer on a receive subsequent to maxReceiveCount.
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await consumer.pollOnce();
    failures += result.retried;

    const message = await receiveFromDlq(pair.dlqUrl);
    if (message) {
      return { message, failures };
    }
  }

  throw new Error('Message was not moved into DLQ');
}

async function walletBalance(walletId: string): Promise<string> {
  const wallet = await orm.em.fork().findOneOrFail(
    WalletEntity,
    walletId,
  );
  return String(wallet.balanceAmount);
}

async function debitCount(walletId: string): Promise<number> {
  return orm.em.fork().count(WalletLedgerEntryEntity, {
    wallet: walletId,
    direction: 'DEBIT',
  });
}

beforeAll(async () => {
  orm = await MikroORM.init(mikroOrmConfig);
  sqs = new AwsSqsClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
    credentials: {
      accessKeyId: 'test',
      secretAccessKey: 'test',
    },
  });
});

afterAll(async () => {
  sqs?.destroy();
  await orm?.close(true);
});

describe('SQS FIFO DLQ and recovery', () => {
  test('should send malformed messages to the real DLQ', async () => {
    const pair = await createQueuePair();
    const malformed = '{"messageId":';

    try {
      await send(pair.sourceUrl, randomUUID(), malformed);

      const { message, failures } = await drainUntilDlq(
        pair,
        failingProcessor(),
      );

      expect(failures).toBeGreaterThanOrEqual(3);
      expect(message.Body).toBe(malformed);
      expect(message.ReceiptHandle).toBeDefined();
    } finally {
      await deleteQueuePair(pair);
    }
  }, 60000);

  test('should ACK a transient failure without going to DLQ', async () => {
    const pair = await createQueuePair();
    let calls = 0;

    const transient = {
      async execute(): Promise<{ status: string }> {
        calls++;
        if (calls === 1) {
          throw new Error('SIMULATED_TRANSIENT_FAILURE');
        }
        return { status: 'PROCESSED' };
      },
    } as unknown as ProcessBetUseCase;

    const wallet = {
      id: randomUUID(),
      playerId: randomUUID(),
    };

    try {
      await send(pair.sourceUrl, wallet.id, validEnvelope(wallet));
      const consumer = new SqsWagerConsumer(
        fastRetryClient(),
        pair.sourceUrl,
        transient,
      );

      const first = await consumer.pollOnce();
      const second = await consumer.pollOnce();

      expect(first.retried).toBe(1);
      expect(first.acknowledged).toBe(0);
      expect(second.acknowledged).toBe(1);
      expect(second.retried).toBe(0);
      expect(calls).toBe(2);
      expect(await receiveFromDlq(pair.dlqUrl)).toBeUndefined();
    } finally {
      await deleteQueuePair(pair);
    }
  }, 60000);

  test('should safely replay unchanged DLQ envelope and avoid a second debit', async () => {
    const pair = await createQueuePair();
    const wallet = await createWallet();
    const envelope = validEnvelope(wallet);

    try {
      await send(pair.sourceUrl, wallet.id, envelope);

      // Infrastructure unavailable throughout normal retries.
      const { message } = await drainUntilDlq(
        pair,
        failingProcessor(),
      );

      expect(message.Body).toBe(envelope);
      expect(await walletBalance(wallet.id)).toBe('100.00');
      expect(await debitCount(wallet.id)).toBe(0);

      // Operator has resolved the outage: send UNMODIFIED body.
      // Use a new SQS dedup ID to bypass its five-minute cache.
      await send(pair.sourceUrl, wallet.id, message.Body!);

      // Delete from DLQ only AFTER successful re-publication.
      await sqs.send(new DeleteMessageCommand({
        QueueUrl: pair.dlqUrl,
        ReceiptHandle: message.ReceiptHandle!,
      }));

      const consumer = new SqsWagerConsumer(
        sqs,
        pair.sourceUrl,
        realProcessor(),
      );

      const recovered = await consumer.pollOnce();
      expect(recovered.acknowledged).toBe(1);
      expect(recovered.duplicates).toBe(0);
      expect(await walletBalance(wallet.id)).toBe('70.00');
      expect(await debitCount(wallet.id)).toBe(1);

      // A later operator replay of the same envelope must be harmless.
      await send(pair.sourceUrl, wallet.id, envelope);
      const duplicate = await consumer.pollOnce();

      expect(duplicate.acknowledged).toBe(1);
      expect(duplicate.duplicates).toBe(1);
      expect(await walletBalance(wallet.id)).toBe('70.00');
      expect(await debitCount(wallet.id)).toBe(1);
    } finally {
      await deleteQueuePair(pair);
    }
  }, 60000);
});
