import { HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { SecurityEvents } from '../audit/security-event.service';
import { PrismaService } from '../common/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { DEMO_ACCOUNT_SPECS, DEMO_WORKSPACES, type DemoAccount, type DemoWorkspace } from './demo.config';
import { DEMO_SCRIPTS } from './demo-fixtures';
import { DemoSeedService } from './demo-seed.service';
import { MockSystemsService } from './mock-systems.service';

/** At most one reset per this many milliseconds, per backend instance. */
export const DEMO_RESET_INTERVAL_MS = 10_000;

/** The refusal rows AuditService.logRefusal writes into tool_invocations. */
const REFUSAL_PREFIX = 'REFUSED ';

export interface DemoResetCounts {
  /** sandbox_runs deleted. */
  runs: number;
  /** tool_invocations deleted, refusals not included. */
  invocations: number;
  /** Refused calls deleted: refusal rows of tool_invocations plus TOOL_REFUSED security events. */
  refusals: number;
  /** Other security events of the demo workspaces deleted (sign-ins, key changes, ...). */
  securityEvents: number;
  /** Saved scripts deleted because the seed does not define them. */
  scriptsRemoved: number;
  /** Seeded scripts written back (or created again). */
  scriptsRestored: number;
  /** Response Processing chains written back. */
  chainsRestored: number;
  /** Memberships of the demo users in the other demo workspace, removed. */
  membershipsRemoved: number;
  /** Mock system request-log entries cleared. */
  mockRequests: number;
}

export interface DemoResetResult {
  ok: true;
  reset: DemoResetCounts;
  at: string;
}

export interface DemoStatus {
  enabled: true;
  lastResetAt: string | null;
  mock: { port: number | null; requests: number };
  workspaces: Array<{ id: string; name: string; letter: DemoWorkspace; serverId: string | null }>;
  accounts: DemoAccount[];
  currentWorkspace: DemoWorkspace | null;
}

/** Saved scripts the seed defines, per workspace (only A has any). */
const SEEDED_SCRIPTS: Record<DemoWorkspace, string[]> = {
  A: DEMO_SCRIPTS.map((s) => s.name),
  B: [],
};

/**
 * The demo's one-click reset: everything visitors produced in the two demo
 * workspaces goes, the seeded objects are written back. Every query is bound
 * to the demo workspaces' organization ids; no other organization is touched.
 */
@Injectable()
export class DemoResetService {
  private readonly logger = new Logger(DemoResetService.name);
  private lastAttempt = 0;
  private lastResetAt: Date | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly seed: DemoSeedService,
    private readonly mocks: MockSystemsService,
  ) {}

  /** The demo workspaces' organization ids, by letter. */
  async organizationIds(): Promise<Partial<Record<DemoWorkspace, string>>> {
    return this.seed.demoOrganizationIds();
  }

  /** Whether the user is an active ADMIN of one of the demo workspaces. */
  async isDemoAdmin(userId: string | undefined): Promise<boolean> {
    if (!userId) return false;
    const orgIds = Object.values(await this.organizationIds());
    if (orgIds.length === 0) return false;
    const row = await this.prisma.organizationMember.findFirst({
      where: { userId, organizationId: { in: orgIds }, role: 'ADMIN', deactivatedAt: null },
      select: { userId: true },
    });
    return !!row;
  }

  async status(currentOrganizationId: string | undefined): Promise<DemoStatus> {
    const orgIds = await this.organizationIds();
    const last = this.seed.lastResult();
    const workspaces: DemoStatus['workspaces'] = [];
    let currentWorkspace: DemoWorkspace | null = null;
    for (const ws of Object.keys(DEMO_WORKSPACES) as DemoWorkspace[]) {
      const id = orgIds[ws];
      if (!id) continue;
      workspaces.push({ id, name: DEMO_WORKSPACES[ws].name, letter: ws, serverId: last?.workspaces[ws]?.serverId ?? null });
      if (id === currentOrganizationId) currentWorkspace = ws;
    }
    return {
      enabled: true,
      lastResetAt: this.lastResetAt?.toISOString() ?? null,
      mock: { port: this.mocks.port(), requests: this.mocks.requestCount() },
      workspaces,
      // The same disclosure as GET /api/public/demo: the accounts that exist, with passwords.
      accounts: this.seed.publishedAccounts(),
      currentWorkspace,
    };
  }

  async reset(): Promise<DemoResetResult> {
    // Taken before any work, so two concurrent calls cannot both run.
    const now = Date.now();
    if (now - this.lastAttempt < DEMO_RESET_INTERVAL_MS) {
      const wait = Math.ceil((DEMO_RESET_INTERVAL_MS - (now - this.lastAttempt)) / 1000);
      throw new HttpException(`Demo reset: try again in ${wait} s`, HttpStatus.TOO_MANY_REQUESTS);
    }
    this.lastAttempt = now;

    const port = this.mocks.port();
    if (port === null) throw new ServiceUnavailableException('Demo reset: the mock systems are not running');
    const byLetter = await this.organizationIds();
    const orgIds = Object.values(byLetter).filter((x): x is string => !!x);
    if (orgIds.length === 0) throw new ServiceUnavailableException('Demo reset: the demo workspaces do not exist');
    const inDemo = { in: orgIds };

    // Scripts the seed does not define: every script of B, every unseeded one of A.
    const extraScripts: Prisma.SandboxScriptWhereInput[] = (Object.keys(byLetter) as DemoWorkspace[]).map((ws) =>
      SEEDED_SCRIPTS[ws].length > 0
        ? { organizationId: byLetter[ws] as string, name: { notIn: SEEDED_SCRIPTS[ws] } }
        : { organizationId: byLetter[ws] as string },
    );

    // A demo user's membership of the OTHER demo workspace (a visitor invited alice into B).
    const demoUsers = await this.prisma.user.findMany({
      where: { email: { in: DEMO_ACCOUNT_SPECS.map((s) => s.email) } },
      select: { id: true, email: true },
    });
    const strayMemberships: Prisma.OrganizationMemberWhereInput[] = [];
    for (const u of demoUsers) {
      const spec = DEMO_ACCOUNT_SPECS.find((s) => s.email === u.email);
      const home = spec ? byLetter[spec.workspace] : undefined;
      const others = orgIds.filter((id) => id !== home);
      if (others.length > 0) strayMemberships.push({ userId: u.id, organizationId: { in: others } });
    }

    const [runs, refusedRows, invocations, refusedEvents, events, scriptsRemoved, memberships] =
      await this.prisma.$transaction([
        this.prisma.sandboxRun.deleteMany({ where: { organizationId: inDemo } }),
        this.prisma.toolInvocation.deleteMany({
          where: { organizationId: inDemo, error: { startsWith: REFUSAL_PREFIX } },
        }),
        this.prisma.toolInvocation.deleteMany({
          where: {
            OR: [
              { organizationId: inDemo },
              // Rows written without an organization, for a tool of a demo workspace.
              { organizationId: null, tool: { connector: { organizationId: inDemo } } },
            ],
          },
        }),
        this.prisma.securityEvent.deleteMany({
          where: { organizationId: inDemo, event: SecurityEvents.TOOL_REFUSED },
        }),
        this.prisma.securityEvent.deleteMany({ where: { organizationId: inDemo } }),
        this.prisma.sandboxScript.deleteMany({ where: { OR: extraScripts } }),
        this.prisma.organizationMember.deleteMany({
          where: strayMemberships.length > 0 ? { OR: strayMemberships } : { userId: { in: [] } },
        }),
      ]);
    // The runs are gone, so are the scripts' last-run summaries.
    await this.prisma.sandboxScript.updateMany({
      where: { organizationId: inDemo },
      data: { lastRunAt: null, lastRunOk: null, lastRunMeta: Prisma.DbNull },
    });

    // Passwords, memberships, annotations, the chain and the scripts written back.
    const seeded = await this.seed.seed(port, { force: true });
    const n = (o: Record<string, number>, k: string) => o[k] ?? 0;
    const mockRequests = this.mocks.clearLog();

    const at = new Date();
    this.lastResetAt = at;
    const reset: DemoResetCounts = {
      runs: runs.count,
      invocations: invocations.count,
      refusals: refusedRows.count + refusedEvents.count,
      securityEvents: events.count,
      scriptsRemoved: scriptsRemoved.count,
      scriptsRestored: n(seeded.created, 'scripts') + n(seeded.updated, 'scripts'),
      chainsRestored: n(seeded.updated, 'response processing'),
      membershipsRemoved: memberships.count,
      mockRequests,
    };
    this.logger.log(
      `Demo reset: ${Object.entries(reset)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')}.`,
    );
    return { ok: true, reset, at: at.toISOString() };
  }
}
