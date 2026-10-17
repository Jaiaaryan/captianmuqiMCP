import { Module } from '@nestjs/common';
import { ResponseProcessingController } from './response-processing.controller';
import { ResponseProcessingService } from './response-processing.service';

/** Editor REST API for response processing. PrismaService comes from the global PrismaModule. */
@Module({
  controllers: [ResponseProcessingController],
  providers: [ResponseProcessingService],
})
export class ResponseProcessingModule {}
