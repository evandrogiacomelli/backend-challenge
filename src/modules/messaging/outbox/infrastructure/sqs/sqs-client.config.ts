
import { SQSClient } from '@aws-sdk/client-sqs';

export interface SqsConfiguration {
  client: SQSClient;
  queueUrl: string;
}

export function createSqsConfiguration(): SqsConfiguration {
  const queueUrl = process.env.SQS_QUEUE_URL;
  const endpoint = process.env.SQS_ENDPOINT;
  const region = process.env.AWS_REGION ?? 'us-east-1';

  if (!queueUrl) {
    throw new Error('SQS_QUEUE_URL is required');
  }

  if (!queueUrl.endsWith('.fifo')) {
    throw new Error('SQS queue must be FIFO');
  }

  const client = new SQSClient({
    region,
    ...(endpoint
      ? {
        endpoint,
        credentials: {
          accessKeyId: 'test',
          secretAccessKey: 'test',
        },
      }
      : {}),
    maxAttempts: 2,
  });

  return {
    client,
    queueUrl,
  };
}
