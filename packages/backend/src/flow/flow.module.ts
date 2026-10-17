import { Module } from '@nestjs/common';
import { FlowController } from './flow.controller';
import { FlowService } from './flow.service';

/**
 * Read-only data-flow graph of the Build layer (agent, server, tools,
 * connectors, response processing, scripts). PrismaService comes from the
 * global PrismaModule.
 */
@Module({
  controllers: [FlowController],
  providers: [FlowService],
})
export class FlowModule {}
