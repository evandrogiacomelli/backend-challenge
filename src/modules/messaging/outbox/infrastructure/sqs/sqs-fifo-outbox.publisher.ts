
import {
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

import type {
  OutboxDelivery,
  OutboxPublisher,
} from '../../application/ports/outbox-dispatcher.ports.js';

export class SqsFifoOutboxPublisher
  implements OutboxPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {
    if (!queueUrl.endsWith('.fifo')) {
      throw new Error('SQS queue must be FIFO');
    }
  }

  async publish(message: OutboxDelivery): Promise<void> {
    if (!message.id || !message.aggregateId) {
      throw new Error(
        'Outbox message must have an ID and aggregate ID',
      );
    }

    const body = JSON.stringify({
      eventId: message.id,
      eventType: message.eventType,
      aggregateId: message.aggregateId,
      occurredAt: message.occurredAt.toISOString(),
      payload: message.payload,
    });

    const response = await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: body,
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: {
            DataType: 'String',
            StringValue: message.eventType,
          },
        },
      }),
      {
        abortSignal: AbortSignal.timeout(10_000),
      },
    );

    if (!response.MessageId) {
      throw new Error(
        'SQS did not confirm message publication',
      );
    }
  }
}
