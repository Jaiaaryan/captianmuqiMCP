import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { AuditService } from './audit.service';

@ApiTags('Audit')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get('invocations')
  @ApiOperation({ summary: 'List tool invocation logs' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'toolId', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: ['SUCCESS', 'ERROR', 'TIMEOUT'] })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'connectorId', required: false, type: String })
  @ApiQuery({ name: 'mcpServerId', required: false, type: String })
  async listInvocations(
    @Req() req: any,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('toolId') toolId?: string,
    @Query('status') status?: 'SUCCESS' | 'ERROR' | 'TIMEOUT',
    @Query('search') search?: string,
    @Query('connectorId') connectorId?: string,
    @Query('mcpServerId') mcpServerId?: string,
  ) {
    return this.auditService.getRecentInvocations(
      limit ? parseInt(limit, 10) : 100,
      offset ? parseInt(offset, 10) : 0,
      { toolId, status: status as any, search, connectorId, mcpServerId, organizationId: req.user.organizationId },
    );
  }

  @Get('refusals')
  @ApiOperation({
    summary: 'List refused tool calls of this workspace',
    description:
      'Tool calls refused before anything ran (sandbox allow-list, read-only ' +
      'runs, role and unknown-tool refusals), recorded in the caller\'s ' +
      'workspace: tool_invocations rows and TOOL_REFUSED security events, newest first.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async listRefusals(@Req() req: any, @Query('limit') limit?: string) {
    return this.auditService.getRecentRefusals(
      req.user.organizationId,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get invocation statistics' })
  async getStats(@Req() req: any) {
    return this.auditService.getStats(req.user.organizationId);
  }

  @Get('analytics')
  @ApiOperation({
    summary: 'Get analytics data with daily time-series and top tools',
    description:
      'Returns 7-day daily breakdown of invocations by status, ' +
      'top 10 most-used tools, success rate, and average duration.',
  })
  @ApiQuery({ name: 'days', required: false, type: Number })
  async getAnalytics(@Req() req: any, @Query('days') days?: string) {
    return this.auditService.getAnalytics(
      req.user.organizationId,
      days ? parseInt(days, 10) : 7,
    );
  }

  @Get('breakdowns')
  @ApiOperation({
    summary: 'Usage & cost breakdowns by connector / MCP server / user',
    description:
      'Aggregates the last N days (default 30) of tool calls per connector, per ' +
      'MCP server and per user, with error counts, proxy-call metering and a ' +
      'volume-based cost estimate.',
  })
  @ApiQuery({ name: 'days', required: false, type: Number })
  async getBreakdowns(@Req() req: any, @Query('days') days?: string) {
    return this.auditService.getBreakdowns(
      req.user.organizationId,
      days ? parseInt(days, 10) : 30,
    );
  }
}
