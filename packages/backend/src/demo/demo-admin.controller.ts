import { Controller, ForbiddenException, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiExcludeController } from '@nestjs/swagger';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { DemoModeGuard } from './demo-mode.guard';
import { DemoResetService, type DemoResetResult, type DemoStatus } from './demo-reset.service';

/**
 * The signed-in side of demo mode: the demo control's status and the one-click
 * reset. 404 unless the instance runs in demo mode (checked before
 * authentication), and left out of the API docs for the same reason.
 */
@ApiExcludeController()
@UseGuards(DemoModeGuard, AuthGuard('jwt'), RolesGuard)
@Controller('api/demo')
export class DemoAdminController {
  constructor(private readonly demo: DemoResetService) {}

  /** Any signed-in user of a demo instance. */
  @Get('status')
  status(@Req() req: any): Promise<DemoStatus> {
    return this.demo.status(req.user?.organizationId);
  }

  /** An ADMIN of one of the demo workspaces; at most once per 10 s per instance. */
  @Post('reset')
  @HttpCode(200)
  @Roles('ADMIN')
  async reset(@Req() req: any): Promise<DemoResetResult> {
    if (!(await this.demo.isDemoAdmin(req.user?.sub))) {
      throw new ForbiddenException('Only an administrator of a demo workspace can reset the demo');
    }
    return this.demo.reset();
  }
}
