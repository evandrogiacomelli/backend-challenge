
import { randomUUID } from 'node:crypto';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module.js';
import { OutboxDispatcherService } from '../src/modules/messaging/outbox/application/services/outbox-dispatcher.service.js';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(
    AppModule,
    {
      logger: ['error', 'warn'],
    },
  );

  try {
    const dispatcher = app.get(
      OutboxDispatcherService,
    );

    const result = await dispatcher.dispatchOnce({
      workerId:
        process.env.OUTBOX_WORKER_ID ?? randomUUID(),
      batchSize: 5,
      leaseSeconds: 120,
    });

    console.log(
      JSON.stringify(result, null, 2),
    );

    if (result.failed > 0 || result.lostLease > 0) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

await main();
