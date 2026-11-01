import { timingSafeEqual } from 'node:crypto';

import {
  Controller,
  Get,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import type { Request } from 'express';

import {
  FinancialMetricsService,
} from './financial-metrics.service.js';

@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: FinancialMetricsService,
  ) {}

  @Get()
  getMetrics(
    @Req() request: Request,
  ): string {
    const expectedToken =
      process.env.METRICS_TOKEN;

    if (!expectedToken) {
      throw new ServiceUnavailableException(
        'Metrics endpoint is not configured',
      );
    }

    const providedToken =
      request.header('x-metrics-token') ?? '';

    const expected = Buffer.from(
      expectedToken,
      'utf8',
    );

    const received = Buffer.from(
      providedToken,
      'utf8',
    );

    if (
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    ) {
      throw new UnauthorizedException();
    }

    // Generate the response before setting
    // its content type, so exceptions can
    // still be returned as JSON.
    const payload = this.metrics.renderPrometheus();

    // Only authenticated, successful responses
    // are returned as Prometheus text.
    request.res?.setHeader(
      'Content-Type',
      'text/plain; version=0.0.4; charset=utf-8',
    );

    return payload;
  }
}
