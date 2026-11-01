import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import mikroOrmConfig from './config/mikro-orm.config.js';
import { WalletModule } from './modules/wallet/wallet.module.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { OutboxModule } from './modules/messaging/outbox/outbox.module.js';
import { WagerInboxModule} from './modules/messaging/inbox/wager-inbox.module.js';
import { PendingReferenceModule } from './modules/wagering/pending-reference.module.js';
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmConfig),
    WalletModule,
    OutboxModule,
    WagerInboxModule,
    ScheduleModule.forRoot(),
    PendingReferenceModule
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
