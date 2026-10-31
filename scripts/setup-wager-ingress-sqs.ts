import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

const client = new SQSClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpoint:
    process.env.SQS_ENDPOINT ??
    'http://127.0.0.1:4566',
  credentials: {
    accessKeyId: 'test',
    secretAccessKey: 'test',
  },
});

async function main(): Promise<void> {
  const dlq = await client.send(
    new CreateQueueCommand({
      QueueName: 'wager-transactions-dlq.fifo',
      Attributes: {
        FifoQueue: 'true',
        MessageRetentionPeriod: '1209600',
      },
    }),
  );

  if (!dlq.QueueUrl) {
    throw new Error('DLQ was not created');
  }

  const attributes = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlq.QueueUrl,
      AttributeNames: ['QueueArn'],
    }),
  );

  const dlqArn = attributes.Attributes?.QueueArn;

  if (!dlqArn) {
    throw new Error('DLQ ARN unavailable');
  }

  const queue = await client.send(
    new CreateQueueCommand({
      QueueName: 'wager-transactions.fifo',
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
      },
    }),
  );

  if (!queue.QueueUrl) {
    throw new Error('Ingress queue was not created');
  }

  await client.send(
    new SetQueueAttributesCommand({
      QueueUrl: queue.QueueUrl,
      Attributes: {
        VisibilityTimeout: '120',
        ReceiveMessageWaitTimeSeconds: '5',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: 5,
        }),
      },
    }),
  );

  console.log(
    `SQS_WAGER_QUEUE_URL=${queue.QueueUrl}`,
  );

  console.log(
    `SQS_WAGER_DLQ_URL=${dlq.QueueUrl}`,
  );
}

try {
  await main();
} finally {
  client.destroy();
}
