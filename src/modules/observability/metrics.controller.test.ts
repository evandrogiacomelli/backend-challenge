import {
  afterEach,
  describe,
  expect,
  test,
} from 'bun:test';

import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import type { Request } from 'express';

import {
  FinancialMetricsService,
} from './financial-metrics.service.js';

import {
  MetricsController,
} from './metrics.controller.js';

function requestWithToken(
  token?: string,
): Request {
  return {
    header(name: string) {
      if (name === 'x-metrics-token') {
        return token;
      }

      return undefined;
    },
  } as Request;
}

describe('MetricsController', () => {
  const originalToken = process.env.METRICS_TOKEN;

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.METRICS_TOKEN;
    } else {
      process.env.METRICS_TOKEN = originalToken;
    }
  });

  test('rejects access when not configured', () => {
    delete process.env.METRICS_TOKEN;

    const controller = new MetricsController(
      new FinancialMetricsService(),
    );

    expect(() =>
      controller.getMetrics(
        requestWithToken(),
      ),
    ).toThrow(ServiceUnavailableException);
  });

  test('rejects missing or incorrect token', () => {
    process.env.METRICS_TOKEN =
      'a-secure-test-token';

    const controller = new MetricsController(
      new FinancialMetricsService(),
    );

    expect(() =>
      controller.getMetrics(
        requestWithToken(),
      ),
    ).toThrow(UnauthorizedException);

    expect(() =>
      controller.getMetrics(
        requestWithToken('wrong-token'),
      ),
    ).toThrow(UnauthorizedException);
  });

  test('exports metrics for valid token', () => {
    process.env.METRICS_TOKEN =
      'a-secure-test-token';

    const metrics = new FinancialMetricsService();

    metrics.recordSqsPoll({
      received: 2,
      acknowledged: 2,
      duplicates: 0,
      retried: 0,
    }, 100);

    const controller = new MetricsController(
      metrics,
    );

    const result = controller.getMetrics(
      requestWithToken(
        'a-secure-test-token',
      ),
    );

    expect(result).toContain(
      'financial_sqs_received_total 2',
    );

    expect(result).toContain(
      'financial_sqs_acknowledged_total 2',
    );
  });
});
