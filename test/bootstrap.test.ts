import { describe, expect, test } from 'bun:test';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module.js';

describe('Application bootstrap', () => {
  test('should initialize the root module', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(moduleRef).toBeDefined();

    await moduleRef.close();
  });
});