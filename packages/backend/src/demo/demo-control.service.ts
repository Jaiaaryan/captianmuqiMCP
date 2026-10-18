import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SecurityEventService } from '../audit/security-event.service';
import { PrismaService } from '../common/prisma.service';
import { demoModeRequested } from './demo.config';
import { DemoResetService, type DemoStatus } from './demo-reset.service';
import { DemoSeedService } from './demo-seed.service';
import { DemoStateService } from './demo-state.service';
import { MockSystemsService } from './mock-systems.service';

/** At most one demo-mode toggle per this many milliseconds, per backend instance. */
export const DEMO_TOGGLE_INTERVAL_MS = 5_000;

/** Security event written when the switch changes. A string slug, as SecurityEvents are. */
export const DEMO_MODE_CHANGED = 'DEMO_MODE_CHANGED';

/** What the demo control (the pill) needs. */
export interface DemoControl {
  /** False on Cloud: there is no demo mode and the pill renders nothing. */
  available: boolean;
  enabled: boolean;
  /** The caller is an ADMIN of at least one workspace. */
  canToggle: boolean;
  /** The caller may reset the demo data: demo mode on, and an ADMIN of a demo workspace. */
  canReset: boolean;
  /** GET /api/demo/status, while demo mode is on. */
  status?: DemoStatus;
}

export interface DemoCaller {
  sub?: string;
  organizationId?: string;
}

/**
 * The demo-mode lifecycle: what turning it on and off does, at boot and from
 * the switch.
 *
 * - ON: start the mock systems, run the (idempotent) seed, persist the switch.
 * - OFF: persist the switch, stop the mock systems. Nothing is deleted: the
 *   demo workspaces, users and data stay, and the demo accounts can still sign
 *   in with the passwords they have.
 */
@Injectable()
export class DemoControlService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DemoControlService.name);
  private lastToggle = 0;
  private toggling = false;

  constructor(
    private readonly state: DemoStateService,
    private readonly mocks: MockSystemsService,
    private readonly seed: DemoSeedService,
    private readonly reset: DemoResetService,
    private readonly prisma: PrismaService,
    private readonly securityEvents: SecurityEventService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.state.available()) {
      if (demoModeRequested()) {
        this.logger.warn('DEMO_MODE=true is ignored on Cloud (DEPLOYMENT_MODE=cloud): demo mode refused.');
      }
      return;
    }
    if (!(await this.state.load())) return;
    try {
      await this.seed.assertMocksReachable();
    } catch (err: any) {
      // DEMO_MODE=true asked for it explicitly: a demo whose connectors cannot
      // reach its mocks is broken in a way a visitor would only discover tool
      // call by tool call, so the boot fails. Turned on by the switch alone,
      // it stays off for this boot (the setting is kept) and the log says why.
      if (demoModeRequested()) throw err;
      this.state.suspend();
      this.logger.error(`Demo mode stays off for this boot: ${err?.message ?? err}`);
      return;
    }
    const port = await this.mocks.start();
    try {
      await this.seed.seedAndLog(port);
    } catch (err: any) {
      // Not fatal: the instance still serves whatever exists; the public demo
      // endpoint then offers no sign-ins.
      this.logger.error(`Demo seed failed: ${err?.message ?? err}`);
    }
  }

  /** Whether the user is an active ADMIN of any workspace. */
  async canToggle(userId: string | undefined): Promise<boolean> {
    if (!userId) return false;
    const row = await this.prisma.organizationMember.findFirst({
      where: { userId, role: 'ADMIN', deactivatedAt: null },
      select: { userId: true },
    });
    return !!row;
  }

  async control(caller: DemoCaller): Promise<DemoControl> {
    if (!this.state.available()) return { available: false, enabled: false, canToggle: false, canReset: false };
    const canToggle = await this.canToggle(caller.sub);
    if (!this.state.isEnabled()) return { available: true, enabled: false, canToggle, canReset: false };
    const [status, canReset] = await Promise.all([
      this.reset.status(caller.organizationId),
      this.reset.isDemoAdmin(caller.sub),
    ]);
    return { available: true, enabled: true, canToggle, canReset, status };
  }

  async setEnabled(enabled: boolean, caller: DemoCaller): Promise<DemoControl> {
    if (!this.state.available()) throw new NotFoundException('Not found');
    if (!(await this.canToggle(caller.sub))) {
      throw new ForbiddenException('Only a workspace administrator can switch demo mode');
    }
    // Taken before any work, so two concurrent calls cannot both run.
    const now = Date.now();
    if (this.toggling || now - this.lastToggle < DEMO_TOGGLE_INTERVAL_MS) {
      const wait = Math.max(1, Math.ceil((DEMO_TOGGLE_INTERVAL_MS - (now - this.lastToggle)) / 1000));
      throw new HttpException(`Demo mode: try again in ${wait} s`, HttpStatus.TOO_MANY_REQUESTS);
    }
    this.lastToggle = now;
    this.toggling = true;
    const was = this.state.isEnabled();
    try {
      if (enabled) await this.turnOn(was);
      else await this.turnOff();
    } finally {
      this.toggling = false;
    }
    if (was !== enabled) {
      await this.securityEvents.log({
        event: DEMO_MODE_CHANGED,
        actorType: 'USER',
        organizationId: caller.organizationId ?? null,
        actorUserId: caller.sub ?? null,
        metadata: { enabled, userId: caller.sub ?? null },
      });
    }
    return this.control(caller);
  }

  private async turnOn(was: boolean): Promise<void> {
    try {
      await this.seed.assertMocksReachable();
    } catch (err: any) {
      throw new ConflictException(err?.message ?? 'The outbound address policy blocks the demo mock systems');
    }
    const startedHere = this.mocks.port() === null;
    let port: number;
    try {
      port = await this.mocks.start();
    } catch (err: any) {
      throw new ServiceUnavailableException(`Demo mock systems could not start: ${err?.message ?? err}`);
    }
    try {
      await this.seed.seedAndLog(port);
    } catch (err: any) {
      if (startedHere && !was) await this.mocks.stop();
      this.logger.error(`Demo seed failed: ${err?.message ?? err}`);
      throw new ServiceUnavailableException(was ? 'Demo seed failed' : 'Demo seed failed; demo mode stays off');
    }
    await this.state.set(true);
  }

  private async turnOff(): Promise<void> {
    await this.state.set(false);
    await this.mocks.stop();
  }
}
