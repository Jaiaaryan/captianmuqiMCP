import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiExcludeController } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';
import { SelfHostedOnlyGuard } from '../common/self-hosted-only.guard';
import { DemoControlService, type DemoControl } from './demo-control.service';

export class SetDemoModeDto {
  @IsBoolean()
  enabled: boolean;
}

/**
 * The demo control (the pill): reads the switch and, for a workspace admin,
 * flips it. Exists whether demo mode is on or off; the switch itself is
 * refused on Cloud (404, before authentication).
 */
@ApiExcludeController()
@Controller('api/demo/control')
export class DemoControlController {
  constructor(private readonly demo: DemoControlService) {}

  /** Any signed-in user. On Cloud: `{ available: false, ... }`. */
  @Get()
  @UseGuards(AuthGuard('jwt'))
  get(@Req() req: any): Promise<DemoControl> {
    return this.demo.control({ sub: req.user?.sub, organizationId: req.user?.organizationId });
  }

  /** An ADMIN of any workspace; at most one toggle per 5 s per instance. */
  @Put()
  @UseGuards(SelfHostedOnlyGuard, AuthGuard('jwt'))
  set(@Req() req: any, @Body() body: SetDemoModeDto): Promise<DemoControl> {
    return this.demo.setEnabled(body.enabled, { sub: req.user?.sub, organizationId: req.user?.organizationId });
  }
}
