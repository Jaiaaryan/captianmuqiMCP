import { Module } from '@nestjs/common';
import { FlowController } from './flow.controller';
import { FlowService } from './flow.service';
import { FlowAskService } from './flow-ask.service';

/**
 * Data-flow graph of the Build layer (agent, servers, tools, connectors,
 * response processing, scripts), its replay events and the Ask bar.
 * PrismaService comes from the global PrismaModule, KgLlmService from the
 * global KgModule.
 */
@Module({
  controllers: [FlowController],
  providers: [FlowService, FlowAskService],
})
export class FlowModule {}
