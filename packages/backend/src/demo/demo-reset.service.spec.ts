import { HttpException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { DemoResetService, DEMO_RESET_INTERVAL_MS } from './demo-reset.service';

/**
 * The reset against an in-memory stand-in for Prisma. What matters: every
 * delete is bound to the two demo workspaces (a third organization's rows
 * survive), the seeded scripts stay, the counts are right, and the throttle.
 */

type Row = Record<string, any>;

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const ORG_X = 'org-x'; // someone else's workspace on the same instance

function world() {
  const tables: Record<string, Row[]> = {
    sandboxRun: [],
    toolInvocation: [],
    securityEvent: [],
    sandboxScript: [],
    organizationMember: [],
    user: [],
    mcpTool: [],
    connector: [],
  };

  // Enough of Prisma's where for the reset's queries.
  const match = (table: string, row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'OR') return (v as Row[]).some((w) => match(table, row, w));
      if (k === 'tool') {
        const tool = tables.mcpTool.find((t) => t.id === row.toolId);
        const conn = tool && tables.connector.find((c) => c.id === tool.connectorId);
        return !!conn && match('connector', conn, v.connector);
      }
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if ('in' in v) return (v.in as unknown[]).includes(row[k]);
        if ('notIn' in v) return !(v.notIn as unknown[]).includes(row[k]);
        if ('startsWith' in v) return typeof row[k] === 'string' && row[k].startsWith(v.startsWith);
      }
      return (row[k] ?? null) === v;
    });

  const model = (name: string) => ({
    findMany: jest.fn(async (q: Row = {}) => tables[name].filter((r) => match(name, r, q.where))),
    findFirst: jest.fn(async (q: Row = {}) => tables[name].find((r) => match(name, r, q.where)) ?? null),
    deleteMany: jest.fn(async (q: Row = {}) => {
      const before = tables[name].length;
      tables[name] = tables[name].filter((r) => !match(name, r, q.where));
      return { count: before - tables[name].length };
    }),
    updateMany: jest.fn(async (q: Row) => {
      const hit = tables[name].filter((r) => match(name, r, q.where));
      for (const r of hit) Object.assign(r, q.data);
      return { count: hit.length };
    }),
  });
  const prisma: Row = Object.fromEntries(Object.keys(tables).map((k) => [k, model(k)]));
  // Array form: the operations are already-started promises.
  prisma.$transaction = jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops));

  const seed = {
    demoOrganizationIds: jest.fn(async () => ({ A: ORG_A, B: ORG_B })),
    lastResult: jest.fn(() => ({
      workspaces: { A: { organizationId: ORG_A, serverId: 'srv-a' }, B: { organizationId: ORG_B, serverId: 'srv-b' } },
    })),
    publishedAccounts: jest.fn(() => [{ email: 'alice@alpha.codebound.test', password: 'p' }]),
    seed: jest.fn(async () => ({
      workspaces: {},
      users: {},
      created: { scripts: 1 },
      updated: { scripts: 3, 'response processing': 2, users: 3 },
    })),
  };
  const mocks = { port: jest.fn(() => 4191), requestCount: jest.fn(() => 1234), clearLog: jest.fn(() => 57) };

  // Users: the three demo users, and dave of the third workspace.
  tables.user.push(
    { id: 'u-alice', email: 'alice@alpha.codebound.test' },
    { id: 'u-carol', email: 'carol@alpha.codebound.test' },
    { id: 'u-bob', email: 'bob@beta.codebound.test' },
    { id: 'u-dave', email: 'dave@example.com' },
  );
  tables.organizationMember.push(
    { userId: 'u-alice', organizationId: ORG_A, role: 'ADMIN', deactivatedAt: null },
    { userId: 'u-carol', organizationId: ORG_A, role: 'VIEWER', deactivatedAt: null },
    { userId: 'u-bob', organizationId: ORG_B, role: 'ADMIN', deactivatedAt: null },
    // A visitor (bob) invited alice into B, and alice belongs to the third workspace too.
    { userId: 'u-alice', organizationId: ORG_B, role: 'VIEWER', deactivatedAt: null },
    { userId: 'u-alice', organizationId: ORG_X, role: 'VIEWER', deactivatedAt: null },
    { userId: 'u-dave', organizationId: ORG_X, role: 'ADMIN', deactivatedAt: null },
  );
  tables.connector.push(
    { id: 'c-a', organizationId: ORG_A },
    { id: 'c-x', organizationId: ORG_X },
  );
  tables.mcpTool.push({ id: 't-a', connectorId: 'c-a' }, { id: 't-x', connectorId: 'c-x' });

  for (const org of [ORG_A, ORG_B, ORG_X]) {
    tables.sandboxRun.push({ id: `run-${org}-1`, organizationId: org }, { id: `run-${org}-2`, organizationId: org });
    tables.toolInvocation.push(
      { id: `inv-${org}-ok`, organizationId: org, toolId: org === ORG_X ? 't-x' : 't-a', error: null },
      { id: `inv-${org}-ref`, organizationId: org, toolId: org === ORG_X ? 't-x' : 't-a', error: 'REFUSED ROLE_FORBIDDEN: no' },
    );
    tables.securityEvent.push(
      { id: `ev-${org}-ref`, organizationId: org, event: 'TOOL_REFUSED' },
      { id: `ev-${org}-login`, organizationId: org, event: 'LOGIN_SUCCESS' },
    );
  }
  // Without an organization: one for a tool of A (demo), one for a tool of X (not).
  tables.toolInvocation.push(
    { id: 'inv-null-a', organizationId: null, toolId: 't-a', error: null },
    { id: 'inv-null-x', organizationId: null, toolId: 't-x', error: null },
  );
  tables.securityEvent.push({ id: 'ev-null', organizationId: null, event: 'LOGIN_FAILED' });
  tables.sandboxScript.push(
    { id: 's-a-seed', organizationId: ORG_A, name: 'price_drift_check', lastRunAt: new Date(), lastRunOk: true, lastRunMeta: {} },
    { id: 's-a-seed2', organizationId: ORG_A, name: 'supplier_account' },
    { id: 's-a-visitor', organizationId: ORG_A, name: 'visitor_script' },
    // Same name as a seeded script, but in B, where the seed defines none.
    { id: 's-b-visitor', organizationId: ORG_B, name: 'price_drift_check' },
    { id: 's-x', organizationId: ORG_X, name: 'visitor_script', lastRunAt: new Date('2026-10-01'), lastRunOk: true },
  );

  const service = new DemoResetService(prisma as any, seed as any, mocks as any);
  return { tables, prisma, seed, mocks, service };
}

describe('DemoResetService', () => {
  beforeEach(() => jest.useFakeTimers({ now: new Date('2026-10-18T12:00:00Z') }));
  afterEach(() => jest.useRealTimers());

  it('deletes what visitors produced in the demo workspaces and reports the counts', async () => {
    const { tables, seed, mocks, service } = world();
    const out = await service.reset();

    expect(out).toEqual({
      ok: true,
      reset: {
        runs: 4,
        invocations: 3, // A ok, B ok, the org-less row of A's tool
        refusals: 4, // two refusal rows, two TOOL_REFUSED events
        securityEvents: 2,
        scriptsRemoved: 2,
        scriptsRestored: 4,
        chainsRestored: 2,
        membershipsRemoved: 1,
        mockRequests: 57,
      },
      at: '2026-10-18T12:00:00.000Z',
    });
    expect(seed.seed).toHaveBeenCalledWith(4191, { force: true });
    expect(mocks.clearLog).toHaveBeenCalled();

    expect(tables.sandboxScript.map((s) => s.id)).toEqual(['s-a-seed', 's-a-seed2', 's-x']);
    expect(tables.sandboxScript[0]).toMatchObject({ lastRunAt: null, lastRunOk: null, lastRunMeta: Prisma.DbNull });
    // alice keeps her own membership of A; her invitation into B is gone.
    expect(tables.organizationMember.filter((m) => m.userId === 'u-alice').map((m) => m.organizationId)).toEqual([
      ORG_A,
      ORG_X,
    ]);
  });

  it('never touches another organization', async () => {
    const { tables, service } = world();
    const before = JSON.parse(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(tables).map(([k, rows]) => [k, rows.filter((r) => r.organizationId === ORG_X)]),
        ),
      ),
    );
    await service.reset();
    const after = JSON.parse(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(tables).map(([k, rows]) => [k, rows.filter((r) => r.organizationId === ORG_X)]),
        ),
      ),
    );
    expect(after).toEqual(before);
    expect(before.sandboxRun).toHaveLength(2);
    expect(before.toolInvocation).toHaveLength(2);
    expect(before.securityEvent).toHaveLength(2);
    // Rows without an organization survive unless they belong to a demo tool.
    expect(tables.toolInvocation.map((r) => r.id)).toContain('inv-null-x');
    expect(tables.securityEvent.map((r) => r.id)).toContain('ev-null');
  });

  it('allows one reset per 10 s per instance', async () => {
    const { service, seed } = world();
    await service.reset();
    jest.advanceTimersByTime(DEMO_RESET_INTERVAL_MS - 1);
    const err = await service.reset().catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect(seed.seed).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    await expect(service.reset()).resolves.toMatchObject({ ok: true });
  });

  it('refuses when the demo workspaces do not exist', async () => {
    const { service, seed, prisma } = world();
    seed.demoOrganizationIds.mockResolvedValue({} as any);
    await expect(service.reset()).rejects.toThrow(/do not exist/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('knows a demo admin from anyone else', async () => {
    const { service } = world();
    expect(await service.isDemoAdmin('u-alice')).toBe(true);
    expect(await service.isDemoAdmin('u-bob')).toBe(true);
    expect(await service.isDemoAdmin('u-carol')).toBe(false);
    // ADMIN, but of the third workspace only.
    expect(await service.isDemoAdmin('u-dave')).toBe(false);
    expect(await service.isDemoAdmin(undefined)).toBe(false);
  });

  it('reports the status', async () => {
    const { service } = world();
    expect(await service.status(ORG_B)).toEqual({
      enabled: true,
      lastResetAt: null,
      mock: { port: 4191, requests: 1234 },
      workspaces: [
        { id: ORG_A, name: 'Alpha (CODEBOUND workspace A)', letter: 'A', serverId: 'srv-a' },
        { id: ORG_B, name: 'Beta (CODEBOUND workspace B)', letter: 'B', serverId: 'srv-b' },
      ],
      accounts: [{ email: 'alice@alpha.codebound.test', password: 'p' }],
      currentWorkspace: 'B',
    });
    await service.reset();
    const after = await service.status(ORG_X);
    expect(after.lastResetAt).toBe('2026-10-18T12:00:00.000Z');
    expect(after.currentWorkspace).toBeNull();
  });
});
