import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { ResponseProcessingController } from './response-processing.controller';
import { ResponseProcessingService } from './response-processing.service';
import { RatesService } from './rates.service';

/**
 * Editor REST API for response processing, and the exchange-rate table of
 * `currency@1` (RatesService registers it for every chain run at init).
 * PrismaService comes from the global PrismaModule.
 */
@Module({
  imports: [SettingsModule],
  controllers: [ResponseProcessingController],
  providers: [ResponseProcessingService, RatesService],
  exports: [RatesService],
})
export class ResponseProcessingModule {}
