import { normalizeCapabilities } from '../sandbox/sandbox-scripts.service';
import { inferParameters, mergeParameters } from '../sandbox/script-parameters.util';
import { DEMO_WORKSPACES, demoAccounts, demoCredentials } from './demo.config';
import { DEMO_OFFERS_CHAIN } from './demo-fixtures';
import { DemoSeedService } from './demo-seed.service';

/**
 * The seed against an in-memory stand-in for Prisma and the services it calls.
 * What matters here is idempotency: a second boot on the same database creates
 * nothing and writes nothing, and a database prepared by the kit's own setup is
 * reused rather than duplicated. The live behaviour (real Prisma, real MCP
 * calls) is covered by the manual check in docs/demo-mode.md.
 */

type Row = Record<string, any>;

let nextId = 0;
const id = (p: string) => `${p}-${++nextId}`;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'userId_organizationId') return row.userId === v.userId && row.organizationId === v.organizationId;
    return row[k] === v;
  });
}

class Table {
  rows: Row[] = [];
  creates = 0;
  updates = 0;
  constructor(private readonly prefix: string) {}
  findFirst = jest.fn(async (q: any = {}) => this.rows.find((r) => matches(r, q.where)) ?? null);
  findUnique = jest.fn(async (q: any = {}) => this.rows.find((r) => matches(r, q.where)) ?? null);
  findMany = jest.fn(async (q: any = {}) => this.rows.filter((r) => matches(r, q.where)));
  create = jest.fn(async (q: any) => this.insert(q.data));
  update = jest.fn(async (q: any) => {
    const row = this.rows.find((r) => matches(r, q.where));
    if (!row) throw new Error(`${this.prefix}: no row`);
    Object.assign(row, q.data);
    this.updates++;
    return row;
  });
  insert(data: Row): Row {
    const row = { id: id(this.prefix), createdAt: new Date(), ...data };
    this.rows.push(row);
    this.creates++;
    return row;
  }
}

function world() {
  const t = {
    organization: new Table('org'),
    user: new Table('user'),
    organizationMember: new Table('member'),
    connector: new Table('conn'),
    mcpTool: new Table('tool'),
    role: new Table('role'),
    toolRoleAccess: new Table('tra'),
    userRoleAssignment: new Table('ura'),
    mcpServerConfig: new Table('srv'),
    mcpServerConnector: new Table('srvconn'),
    mcpApiKey: new Table('key'),
    sandboxScript: new Table('script'),
  };
  const prisma = t as any;

  const auth = {
    hashPassword: jest.fn(async (p: string) => `hash:${p}`),
    comparePassword: jest.fn(async (p: string, h: string) => h === `hash:${p}`),
  };
  const connectors = {
    update: jest.fn(async (cid: string, patch: Row) => {
      const data: Row = { ...patch };
      if (patch.authConfig) data.authConfig = `enc:${JSON.stringify(patch.authConfig)}`;
      return t.connector.update({ where: { id: cid }, data });
    }),
    getDecryptedAuthConfig: (c: Row) => (c.authConfig ? JSON.parse(String(c.authConfig).slice(4)) : undefined),
  };
  const mcpServer = { reloadConnectorTools: jest.fn(async () => undefined) };
  const mcpServers = {
    create: jest.fn(async (userId: string, organizationId: string, data: Row) =>
      t.mcpServerConfig.insert({ userId, organizationId, isActive: true, ...data }),
    ),
    update: jest.fn(async (sid: string, data: Row) => t.mcpServerConfig.update({ where: { id: sid }, data })),
    getConnectorIds: jest.fn(async (sid: string) =>
      t.mcpServerConnector.rows.filter((r) => r.mcpServerId === sid).map((r) => r.connectorId),
    ),
    assignConnectors: jest.fn(async (sid: string, ids: string[]) => {
      t.mcpServerConnector.rows = t.mcpServerConnector.rows.filter((r) => r.mcpServerId !== sid);
      for (const connectorId of ids) t.mcpServerConnector.insert({ mcpServerId: sid, connectorId });
    }),
  };
  const roles = {
    create: jest.fn(async (data: Row) => t.role.insert(data)),
    setToolAccess: jest.fn(async (roleId: string, toolIds: string[]) => {
      t.toolRoleAccess.rows = t.toolRoleAccess.rows.filter((r) => r.roleId !== roleId);
      for (const toolId of toolIds) t.toolRoleAccess.insert({ roleId, toolId });
    }),
    setUserRoles: jest.fn(async (userId: string, roleIds: string[], organizationId: string) => {
      t.userRoleAssignment.rows = t.userRoleAssignment.rows.filter(
        (r) => !(r.userId === userId && r.organizationId === organizationId),
      );
      for (const roleId of roleIds) t.userRoleAssignment.insert({ userId, roleId, organizationId });
      return { userId, roleIds };
    }),
  };
  const apiKeys = {
    generate: jest.fn(async (userId: string, organizationId: string, name: string, mcpServerId: string) =>
      t.mcpApiKey.insert({ userId, organizationId, name, mcpServerId, isActive: true, key: `mcp_${id('k')}` }),
    ),
  };
  const toRow = (organizationId: string, input: Row, current?: Row) => ({
    organizationId,
    name: input.name ?? current?.name,
    code: input.code ?? current?.code,
    description: input.description,
    parameters: mergeParameters(inferParameters(input.code ?? current?.code).names, input.parameters),
    capabilities: normalizeCapabilities(input.capabilities),
    uses: input.uses.flatMap((u: Row) =>
      u.tools.map((toolName: string) => ({ connectorId: u.connectorId, toolName })),
    ),
  });
  const scripts = {
    create: jest.fn(async (organizationId: string, createdById: string, input: Row) =>
      t.sandboxScript.insert({ ...toRow(organizationId, input), createdById }),
    ),
    update: jest.fn(async (organizationId: string, sid: string, patch: Row) =>
      t.sandboxScript.update({
        where: { id: sid },
        data: toRow(organizationId, patch, t.sandboxScript.rows.find((r) => r.id === sid)),
      }),
    ),
  };
  const edition = { seatAvailable: jest.fn(async () => ({ ok: true, limit: null })) };
  const mocks = { port: () => 4191 };

  const service = new DemoSeedService(
    prisma,
    auth as any,
    connectors as any,
    mcpServer as any,
    mcpServers as any,
    roles as any,
    apiKeys as any,
    scripts as any,
    mocks as any,
    edition as any,
  );
  return { t, service, auth, connectors, mcpServer, mcpServers, roles, apiKeys, scripts, edition };
}

const writes = (t: Record<string, Table>) =>
  Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.creates + v.updates]));

describe('DemoSeedService', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.DEPLOYMENT_MODE;
    process.env.DEMO_PASSWORD_SEED = 'seed-spec';
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('builds the whole test bed on an empty database', async () => {
    const { t, service } = world();
    const r = await service.seed(4191);

    expect(t.organization.rows.map((o) => o.name)).toEqual([DEMO_WORKSPACES.A.name, DEMO_WORKSPACES.B.name]);
    const accounts = demoAccounts();
    expect(t.user.rows.map((u) => [u.email, u.emailVerified, u.passwordHash])).toEqual(
      accounts.map((a) => [a.email, true, `hash:${a.password}`]),
    );
    const orgA = r.workspaces.A!.organizationId;
    const orgB = r.workspaces.B!.organizationId;
    expect(t.organizationMember.rows.map((m) => [m.userId, m.organizationId, m.role])).toEqual([
      [r.users.alice!.id, orgA, 'ADMIN'],
      [r.users.carol!.id, orgA, 'VIEWER'],
      [r.users.bob!.id, orgB, 'ADMIN'],
    ]);

    // Four connectors in A, three in B, every tool, variables per workspace.
    const inOrg = (org: string) => t.connector.rows.filter((c) => c.organizationId === org);
    expect(inOrg(orgA).map((c) => c.name)).toEqual(['Mock ERP', 'Mock Supplier', 'Mock Carrier', 'Mock Payroll']);
    expect(inOrg(orgB).map((c) => c.name)).toEqual(['Mock ERP', 'Mock Supplier', 'Mock Carrier']);
    expect(t.mcpTool.rows).toHaveLength(9 + 8);
    const creds = demoCredentials();
    const erpA = inOrg(orgA)[0];
    expect(erpA.envVars).toEqual({ MOCK_ERP_URL: 'http://127.0.0.1:4191/erp', MOCK_ERP_TOKEN: creds.A.erp });
    expect(erpA).toMatchObject({ baseUrl: '{{MOCK_ERP_URL}}', authType: 'BEARER_TOKEN' });
    const supB = inOrg(orgB)[1];
    expect(supB.envVars.MOCK_SUPPLIER_API_KEY).toBe(creds.B.supplier);
    expect(supB.authType).toBe('API_KEY');

    // Roles: HR has payroll only, Staff the rest; carol is Staff.
    const [hr, staff] = t.role.rows;
    const toolName = (tid: string) => t.mcpTool.rows.find((x) => x.id === tid)!.name;
    expect(t.toolRoleAccess.rows.filter((x) => x.roleId === hr.id).map((x) => toolName(x.toolId))).toEqual([
      'mock_payroll_list_salaries',
    ]);
    expect(t.toolRoleAccess.rows.filter((x) => x.roleId === staff.id)).toHaveLength(8);
    expect(t.userRoleAssignment.rows).toEqual([
      expect.objectContaining({ userId: r.users.carol!.id, roleId: staff.id, organizationId: orgA }),
    ]);

    // One CODEBOUND server per workspace with all its connectors; one key per user.
    expect(t.mcpServerConfig.rows.map((s) => [s.organizationId, s.slug, s.name])).toEqual([
      [orgA, 'codebound', 'CODEBOUND'],
      [orgB, 'codebound', 'CODEBOUND'],
    ]);
    expect(t.mcpServerConnector.rows).toHaveLength(7);
    expect(t.mcpApiKey.rows.map((k) => [k.name, k.mcpServerId])).toEqual([
      ['demo-alice', r.workspaces.A!.serverId],
      ['demo-carol', r.workspaces.A!.serverId],
      ['demo-bob', r.workspaces.B!.serverId],
    ]);
    expect(r.users.alice!.mcpKey).toBe(t.mcpApiKey.rows[0].key);

    // Annotations and the chain, in both workspaces.
    const tools = (name: string) => t.mcpTool.rows.filter((x) => x.name === name);
    for (const x of tools('mock_supplier_get_prices')) expect(x.annotations).toEqual({ readOnlyHint: true });
    for (const x of tools('mock_supplier_list_offers')) {
      expect(x.responseMapping.responseProcessing).toEqual(DEMO_OFFERS_CHAIN);
    }

    // Four scripts in A, owned by alice, with parameters; supplier_account is Level 3.
    expect(t.sandboxScript.rows.map((s) => [s.name, s.organizationId, s.createdById])).toEqual([
      ['price_drift_check', orgA, r.users.alice!.id],
      ['catalogue_total', orgA, r.users.alice!.id],
      ['stuck_orders', orgA, r.users.alice!.id],
      ['supplier_account', orgA, r.users.alice!.id],
    ]);
    const byName = (n: string) => t.sandboxScript.rows.find((s) => s.name === n)!;
    expect(byName('price_drift_check').parameters.required).toEqual(['threshold']);
    expect(byName('stuck_orders').parameters.required).toEqual(['days', 'as_of']);
    expect(byName('supplier_account').capabilities).toEqual({ env: true, http: true });
    expect(byName('price_drift_check').capabilities).toBeNull();
  });

  it('creates and writes nothing on a second boot', async () => {
    const w = world();
    const first = await w.service.seed(4191);
    const before = writes(w.t);
    jest.clearAllMocks();

    const second = await w.service.seed(4191);
    expect(writes(w.t)).toEqual(before);
    expect(second.created).toEqual({});
    expect(second.updated).toEqual({});
    expect(second.users).toEqual(first.users);
    expect(second.workspaces).toEqual(first.workspaces);
    for (const fn of [
      w.auth.hashPassword,
      w.connectors.update,
      w.mcpServer.reloadConnectorTools,
      w.mcpServers.create,
      w.mcpServers.assignConnectors,
      w.roles.create,
      w.roles.setToolAccess,
      w.roles.setUserRoles,
      w.apiKeys.generate,
      w.scripts.create,
      w.scripts.update,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('puts back what a visitor changed, without duplicating anything', async () => {
    const w = world();
    const r = await w.service.seed(4191);
    const alice = w.t.user.rows.find((u) => u.email === 'alice@alpha.codebound.test')!;
    alice.passwordHash = 'hash:visitor-changed-it';
    w.t.mcpApiKey.rows[0].isActive = false;
    w.t.sandboxScript.rows[0].code = 'return 1;';
    w.t.mcpTool.rows.find((x) => x.name === 'mock_erp_ping')!.isEnabled = false;
    const counts = Object.fromEntries(Object.entries(w.t).map(([k, v]) => [k, v.rows.length]));

    const again = await w.service.seed(4191);
    expect(Object.fromEntries(Object.entries(w.t).map(([k, v]) => [k, v.rows.length]))).toEqual(counts);
    expect(again.created).toEqual({});
    expect(again.updated).toEqual({ users: 1, tools: 1, 'mcp keys': 1, scripts: 1 });
    expect(alice.passwordHash).toBe(`hash:${demoAccounts()[0].password}`);
    expect(w.t.mcpApiKey.rows[0].isActive).toBe(true);
    expect(again.users.alice!.mcpKey).toBe(r.users.alice!.mcpKey);
  });

  it('writes the demo objects back with force, even when they match', async () => {
    const w = world();
    await w.service.seed(4191);
    jest.clearAllMocks();
    const counts = Object.fromEntries(Object.entries(w.t).map(([k, v]) => [k, v.rows.length]));

    const forced = await w.service.seed(4191, { force: true });
    expect(Object.fromEntries(Object.entries(w.t).map(([k, v]) => [k, v.rows.length]))).toEqual(counts);
    expect(forced.created).toEqual({});
    expect(forced.updated).toMatchObject({
      users: 3,
      memberships: 3,
      scripts: 4,
      'response processing': 2,
      'tool annotations': 2,
    });
    expect(w.auth.hashPassword).toHaveBeenCalledTimes(3);
    // The code is unchanged, so it is not sent (the version follows the code).
    for (const call of w.scripts.update.mock.calls) expect(call[2].code).toBeUndefined();
  });

  it('knows the demo organizations from the last seed, else by name', async () => {
    const w = world();
    const orgA = w.t.organization.insert({ name: DEMO_WORKSPACES.A.name });
    w.t.organization.insert({ name: 'Somebody else' });
    expect(await w.service.demoOrganizationIds()).toEqual({ A: orgA.id });
    const r = await w.service.seed(4191);
    expect(await w.service.demoOrganizationIds()).toEqual({
      A: r.workspaces.A!.organizationId,
      B: r.workspaces.B!.organizationId,
    });
  });

  it('reuses a workspace the kit already set up (same names), rewiring it to the demo mocks', async () => {
    const w = world();
    // What `codebound setup` leaves behind: the workspaces, alice unverified and
    // active in B, the connectors with the kit's own URLs, a CODEBOUND server.
    const orgA = w.t.organization.insert({ name: DEMO_WORKSPACES.A.name });
    const orgB = w.t.organization.insert({ name: DEMO_WORKSPACES.B.name });
    const alice = w.t.user.insert({
      email: 'alice@alpha.codebound.test',
      passwordHash: 'hash:kit-password',
      emailVerified: false,
      organizationId: orgB.id,
      role: 'ADMIN',
    });
    w.t.organizationMember.insert({ userId: alice.id, organizationId: orgA.id, role: 'ADMIN' });
    w.t.organizationMember.insert({ userId: alice.id, organizationId: orgB.id, role: 'ADMIN' });
    const erp = w.t.connector.insert({
      organizationId: orgA.id,
      userId: alice.id,
      name: 'Mock ERP',
      baseUrl: '{{MOCK_ERP_URL}}',
      authType: 'BEARER_TOKEN',
      authConfig: `enc:${JSON.stringify({ token: '{{MOCK_ERP_TOKEN}}' })}`,
      isActive: true,
      envVars: { MOCK_ERP_URL: 'http://localhost:4101', MOCK_ERP_TOKEN: 'cbk_erp_a_kit' },
    });
    const kitServer = w.t.mcpServerConfig.insert({ organizationId: orgA.id, slug: 'codebound', name: 'CODEBOUND', isActive: true });

    const r = await w.service.seed(4191);
    expect(w.t.organization.rows).toHaveLength(2);
    expect(r.workspaces.A!.organizationId).toBe(orgA.id);
    expect(r.workspaces.A!.serverId).toBe(kitServer.id);
    expect(w.t.connector.rows.filter((c) => c.organizationId === orgA.id && c.name === 'Mock ERP')).toHaveLength(1);
    expect(erp.envVars).toEqual({ MOCK_ERP_URL: 'http://127.0.0.1:4191/erp', MOCK_ERP_TOKEN: demoCredentials().A.erp });
    expect(alice).toMatchObject({
      emailVerified: true,
      organizationId: orgA.id,
      passwordHash: `hash:${demoAccounts()[0].password}`,
    });
    // Her membership of B is left as it is.
    expect(w.t.organizationMember.rows.filter((m) => m.userId === alice.id)).toHaveLength(2);
    expect(w.t.user.rows).toHaveLength(3);
  });

  it('never creates a user past the seat limit', async () => {
    const w = world();
    w.edition.seatAvailable.mockResolvedValue({ ok: false, limit: 3 } as any);
    const r = await w.service.seed(4191);
    expect(w.t.user.rows).toHaveLength(0);
    expect(r.users).toEqual({});
    expect(w.t.connector.rows).toHaveLength(0);
    expect(w.service.publishedAccounts()).toEqual([]);
  });

  it('publishes only the accounts that exist', async () => {
    const w = world();
    w.edition.seatAvailable
      .mockResolvedValueOnce({ ok: true, limit: 3 } as any)
      .mockResolvedValueOnce({ ok: true, limit: 3 } as any)
      .mockResolvedValue({ ok: false, limit: 3 } as any);
    await w.service.seed(4191);
    expect(w.service.publishedAccounts().map((a) => a.email)).toEqual([
      'alice@alpha.codebound.test',
      'carol@alpha.codebound.test',
    ]);
  });

  describe('seedAndLog', () => {
    it('seeds and logs one line without a secret', async () => {
      const w = world();
      const log = jest.spyOn((w.service as any).logger, 'log').mockImplementation(() => undefined);
      const r = await w.service.seedAndLog(4191);
      expect(r.users.alice).toBeDefined();
      expect(w.service.lastResult()).toBe(r);
      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0][0]);
      expect(line).toMatch(/^Demo workspace ready: 2 workspaces, 3 users; created /);
      for (const a of demoAccounts()) expect(line).not.toContain(a.password);
    });
  });

  describe('assertMocksReachable', () => {
    it('throws, naming the setting, when the outbound policy blocks the mocks', async () => {
      process.env.SSRF_GUARD = 'enabled';
      delete process.env.SSRF_ALLOWED_HOSTS;
      delete process.env.SSRF_ALLOW_LOCALHOST;
      const w = world();
      jest.spyOn((w.service as any).logger, 'error').mockImplementation(() => undefined);
      await expect(w.service.assertMocksReachable()).rejects.toThrow(/SSRF_ALLOWED_HOSTS=127\.0\.0\.1/);
    });

    it('passes when the mocks are allowed', async () => {
      process.env.SSRF_GUARD = 'enabled';
      process.env.SSRF_ALLOWED_HOSTS = 'localhost,127.0.0.1';
      await expect(world().service.assertMocksReachable()).resolves.toBeUndefined();
    });
  });
});
