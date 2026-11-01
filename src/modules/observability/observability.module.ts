import {
  Global,
  Module,
} from '@nestjs/common';

import {
  FinancialMetricsService,
} from './financial-metrics.service.js';

import {
  MetricsController,
} from './metrics.controller.js';

@Global()
@Module({
  controllers: [
    MetricsController,
  ],
  providers: [
    FinancialMetricsService,
  ],
  exports: [
    FinancialMetricsService,
  ],
})
export class ObservabilityModule {}
