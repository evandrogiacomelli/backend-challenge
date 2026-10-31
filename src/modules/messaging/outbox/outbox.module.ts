
import { Module } from '@nestjs/common';

import { OUTBOX_DISPATCH_STORE } from './application/ports/outbox-dispatcher.ports.js';
import { PostgresOutboxDispatchStore } from './infrastructure/persistence/postgres-outbox-dispatch.store.js';

@Module({
  providers: [
    {
      provide: OUTBOX_DISPATCH_STORE,
      useClass: PostgresOutboxDispatchStore,
    },
  ],
  exports: [OUTBOX_DISPATCH_STORE],
})
export class OutboxModule {}
