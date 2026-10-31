import { SQSClient } from '@aws-sdk/client-sqs';
import { Module } from '@nestjs/common';

import { WageringModule } from '../../wagering/wagering.module.js';
import {
  SQS_WAGER_CLIENT,
  SQS_WAGER_QUEUE_URL,
  SqsWagerConsumer,
} from './infrastructure/sqs/sqs-wager.consumer.js';

@Module({
  imports: [WageringModule],
  providers: [
    SqsWagerConsumer,
    {
      provide: SQS_WAGER_QUEUE_URL,
      useFactory: () => {
        const queueUrl =
          process.env.SQS_WAGER_QUEUE_URL;

        if (!queueUrl?.endsWith('.fifo')) {
          throw new Error(
            'SQS_WAGER_QUEUE_URL must be a FIFO queue',
          );
        }

        return queueUrl;
      },
    },
    {
      provide: SQS_WAGER_CLIENT,
      useFactory: () => {
        const endpoint = process.env.SQS_ENDPOINT;

        return new SQSClient({
          region:
            process.env.AWS_REGION ?? 'us-east-1',
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
      },
    },
  ],
  exports: [SqsWagerConsumer],
})
export class WagerInboxModule {}
