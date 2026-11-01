import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { ScheduleModule } from '@nestjs/schedule';

import mikroOrmConfig from './config/mikro-orm.config.js';

import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

import { WalletModule } from './modules/wallet/wallet.module.js';
import { OutboxModule } from './modules/messaging/outbox/outbox.module.js';
import { WagerInboxModule } from './modules/messaging/inbox/wager-inbox.module.js';
import { PendingReferenceModule } from './modules/wagering/pending-reference.module.js';
import { ObservabilityModule } from './modules/observability/observability.module.js';
import { HealthModule } from './modules/health/health.module.js';

@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmConfig),
    ScheduleModule.forRoot(),

    ObservabilityModule,

    WalletModule,
    OutboxModule,
    WagerInboxModule,
    PendingReferenceModule,
    HealthModule
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
