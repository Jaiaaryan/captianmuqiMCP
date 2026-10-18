import { Controller, Get, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { type DemoAccount, type DemoWorkspace } from './demo.config';
import { DemoSeedService } from './demo-seed.service';
import { DemoStateService } from './demo-state.service';

export type PublicDemoInfo =
  | { enabled: false }
  | { enabled: true; accounts: DemoAccount[]; mcp: Partial<Record<DemoWorkspace, string>> };

/**
 * What the login page needs to offer the demo sign-ins. No authentication, and
 * rate-limited by the global throttler default.
 */
@ApiTags('Public')
@Controller('api/public')
export class DemoController {
  constructor(
    private readonly seed: DemoSeedService,
    private readonly state: DemoStateService,
  ) {}

  @Get('demo')
  @ApiOperation({
    summary: 'Demo sign-ins of a demo instance',
    description:
      'Returns `{ enabled: false }` unless demo mode is on (the demo switch of a self-hosted ' +
      'deployment; never on Cloud). In demo mode it returns the demo accounts WITH ' +
      'their passwords, deliberately: they are public sign-ins to a throwaway test bed whose ' +
      'connectors only reach the built-in mock systems. Also returns the MCP endpoint path of ' +
      "each demo workspace's CODEBOUND server. MCP keys are never returned.",
  })
  get(@Res({ passthrough: true }) res: Response): PublicDemoInfo {
    // Never cached by a browser or a proxy: the passwords follow the seed.
    res.setHeader('Cache-Control', 'no-store');
    if (!this.state.isEnabled()) return { enabled: false };
    const mcp: Partial<Record<DemoWorkspace, string>> = {};
    for (const [ws, w] of Object.entries(this.seed.lastResult()?.workspaces ?? {})) {
      if (w?.serverId) mcp[ws as DemoWorkspace] = `/mcp/${w.serverId}`;
    }
    return { enabled: true, accounts: this.seed.publishedAccounts(), mcp };
  }
}
