import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module.js';
import { SqsWagerConsumer } from '../src/modules/messaging/inbox/infrastructure/sqs/sqs-wager.consumer.js';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(
    AppModule,
    {
      logger: ['error', 'warn'],
    },
  );

  try {
    const consumer = app.get(SqsWagerConsumer);

    const result = await consumer.pollOnce();

    console.log(
      JSON.stringify(result, null, 2),
    );

    if (result.retried > 0) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

await main();
