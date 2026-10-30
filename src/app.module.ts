import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import mikroOrmConfig from './config/mikro-orm.config.js';
import { WalletModule } from './modules/wallet/wallet.module.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig), WalletModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
