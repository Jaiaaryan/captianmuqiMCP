import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FlowQueryDto } from './flow.dto';
import { FlowService, type FlowGraph } from './flow.service';

@ApiTags('Flow')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/flow')
export class FlowController {
  constructor(private readonly flow: FlowService) {}

  @Get()
  @ApiOperation({
    summary: 'Data-flow graph of one MCP server',
    description:
      'Nodes and edges from the agent through the MCP server and its tools to the connectors, ' +
      'with response processing, response mapping and saved scripts, and call statistics for the ' +
      'chosen window. 404 when the server is not in your organization.',
  })
  async getFlow(@Req() req: any, @Query() query: FlowQueryDto): Promise<FlowGraph> {
    return this.flow.buildGraph(req.user.organizationId, query.serverId, query.since ?? '24h');
  }
}
