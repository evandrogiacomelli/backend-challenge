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

  const port = Number(process.env.PORT ?? 3000);

  await app.listen(port);
}

await bootstrap();
