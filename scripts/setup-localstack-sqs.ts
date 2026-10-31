
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SQSClient,
  SetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';

const endpoint =
  process.env.SQS_ENDPOINT ?? 'http://localhost:4566';

const region =
  process.env.AWS_REGION ?? 'us-east-1';

const client = new SQSClient({
  region,
  endpoint,
  credentials: {
    accessKeyId: 'test',
    secretAccessKey: 'test',
  },
});

async function main(): Promise<void> {
  const dlq = await client.send(
    new CreateQueueCommand({
      QueueName: 'wager-events-dlq.fifo',
      Attributes: {
        FifoQueue: 'true',
        MessageRetentionPeriod: '1209600',
      },
    }),
  );

  if (!dlq.QueueUrl) {
    throw new Error('DLQ URL was not returned');
  }

  const dlqAttributes = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlq.QueueUrl,
      AttributeNames: ['QueueArn'],
    }),
  );

  const dlqArn = dlqAttributes.Attributes?.QueueArn;

  if (!dlqArn) {
    throw new Error('DLQ ARN was not returned');
  }

  const queue = await client.send(
    new CreateQueueCommand({
      QueueName: 'wager-events.fifo',
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
      },
    }),
  );

  if (!queue.QueueUrl) {
    throw new Error('Main queue URL was not returned');
  }

  await client.send(
    new SetQueueAttributesCommand({
      QueueUrl: queue.QueueUrl,
      Attributes: {
        VisibilityTimeout: '30',
        ReceiveMessageWaitTimeSeconds: '10',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: 5,
        }),
      },
    }),
  );

  console.log('SQS FIFO configured');
  console.log(`SQS_QUEUE_URL=${queue.QueueUrl}`);
  console.log(`SQS_DLQ_URL=${dlq.QueueUrl}`);
}

try {
  await main();
} finally {
  client.destroy();
}
