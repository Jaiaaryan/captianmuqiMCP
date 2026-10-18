import { Body, Controller, Get, HttpCode, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { FlowAskDto, FlowEventsQueryDto, FlowQueryDto } from './flow.dto';
import { FlowService, type FlowEvents, type FlowGraph } from './flow.service';
import { FlowAskService, type FlowAskAnswer } from './flow-ask.service';

/** Questions one user may ask per minute. */
export const FLOW_ASK_PER_MINUTE = 10;

/**
 * Throttle bucket of an Ask request: the user the bearer token names, so the
 * limit is per user rather than per address. The global ThrottlerGuard runs
 * before the JWT guard, so the token is decoded here without verifying it:
 * the key only picks a bucket, and an unverifiable token is rejected by the
 * JWT guard right after. Falls back to the client address.
 */
export function flowAskTracker(req: Record<string, any>): string {
  const header = String(req?.headers?.authorization ?? '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = token.split('.')[1];
  if (payload) {
    try {
      const sub = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))?.sub;
      if (typeof sub === 'string' && sub) return `user:${sub}`;
    } catch {
      /* not a JWT: fall back to the address */
    }
  }
  return `ip:${req?.ip ?? ''}`;
}

@ApiTags('Flow')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/flow')
export class FlowController {
  constructor(
    private readonly flow: FlowService,
    private readonly asker: FlowAskService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Data-flow graph of one MCP server, or of every server of the organization',
    description:
      'Nodes and edges from the agent through the MCP server(s) and their tools to the connectors, ' +
      'with response processing, response mapping and saved scripts, and call statistics for the ' +
      'chosen window. Without `serverId` every server of the organization is drawn. 404 when the ' +
      'server is not in your organization.',
  })
  async getFlow(@Req() req: any, @Query() query: FlowQueryDto): Promise<FlowGraph> {
    return this.flow.buildGraph(req.user.organizationId, query.serverId ?? null, query.since ?? '24h');
  }

  @Get('events')
  @ApiOperation({
    summary: 'The individual calls of a window, oldest first, for the replay',
    description:
      'Tool invocations (refusals included) and saved-script runs: time, kind, server, connector, ' +
      'tool or script, status (`ok` | `error` | `refused`) and duration. No payloads or messages. ' +
      'At most `limit` (≤ 2000); when the window holds more, the most recent are kept and ' +
      '`truncated` is true.',
  })
  async getEvents(@Req() req: any, @Query() query: FlowEventsQueryDto): Promise<FlowEvents> {
    return this.flow.listEvents(
      req.user.organizationId,
      query.serverId ?? null,
      query.since ?? '24h',
      query.until,
      query.limit,
    );
  }

  @Get('ask')
  @ApiOperation({ summary: 'Whether the Ask bar can answer in this workspace, and with which model' })
  async askStatus(@Req() req: any): Promise<{ enabled: boolean; model?: string }> {
    return this.asker.status(req.user.organizationId);
  }

  @Post('ask')
  @HttpCode(200)
  @Throttle({ default: { limit: FLOW_ASK_PER_MINUTE, ttl: 60_000, getTracker: flowAskTracker } })
  @ApiOperation({
    summary: 'Ask a question about the flow graph',
    description:
      'Answers from the graph of the window, the selected node and the latest errors, through the ' +
      "workspace's Knowledge Graph LLM. The context is trimmed (≤ 8 KB graph) and redacted before it " +
      'is sent. 409 `{ code: "LLM_OFF" }` when no provider is configured or the workspace has the ' +
      'Knowledge Graph AI switch off. 10 questions per minute per user.',
  })
  async ask(@Req() req: any, @Body() dto: FlowAskDto): Promise<FlowAskAnswer> {
    return this.asker.ask(req.user.organizationId, dto);
  }
}
