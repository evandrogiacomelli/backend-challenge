import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Enable NestJS lifecycle hooks for SIGINT/SIGTERM.
  // Workers can stop accepting new work and drain
  // operations already in progress.
  app.enableShutdownHooks([
    'SIGINT',
    'SIGTERM',
  ]);

  await app.listen(
    Number(process.env.PORT ?? 3000),
  );
}

await bootstrap();
