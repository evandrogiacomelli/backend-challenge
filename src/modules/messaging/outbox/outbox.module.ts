import { Module } from '@nestjs/common';

import {
  OUTBOX_DISPATCH_STORE,
  OUTBOX_PUBLISHER,
} from './application/ports/outbox-dispatcher.ports.js';

import {
  OutboxDispatcherService,
} from './application/services/outbox-dispatcher.service.js';

import {
  PostgresOutboxDispatchStore,
} from './infrastructure/persistence/postgres-outbox-dispatch.store.js';

import {
  createSqsConfiguration,
} from './infrastructure/sqs/sqs-client.config.js';

import {
  SqsFifoOutboxPublisher,
} from './infrastructure/sqs/sqs-fifo-outbox.publisher.js';

import {
  OutboxDispatchWorker,
} from './infrastructure/workers/outbox-dispatch.worker.js';

@Module({
  providers: [
    OutboxDispatcherService,
    OutboxDispatchWorker,

    {
      provide: OUTBOX_DISPATCH_STORE,
      useClass: PostgresOutboxDispatchStore,
    },

    {
      provide: OUTBOX_PUBLISHER,
      useFactory: () => {
        const { client, queueUrl } =
          createSqsConfiguration();

        return new SqsFifoOutboxPublisher(
          client,
          queueUrl,
        );
      },
    },
  ],

  exports: [
    OutboxDispatcherService,
    OUTBOX_DISPATCH_STORE,
  ],
})
export class OutboxModule {}
