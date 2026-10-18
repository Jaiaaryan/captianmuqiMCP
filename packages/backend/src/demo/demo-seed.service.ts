import { Injectable, Logger, Optional } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { openEnvVars } from '../common/crypto/env-vars-at-rest';
import { PrismaService } from '../common/prisma.service';
import { assertSafeOutboundHost, SsrfBlockedError } from '../common/ssrf.util';
import { ConnectorsService } from '../connectors/connectors.service';
import { EditionService } from '../ee/licensing/edition.service';
import { McpServerService } from '../mcp-server/mcp-server.service';
import { McpServersService } from '../mcp-servers/mcp-servers.service';
import { McpApiKeysService } from '../roles/mcp-api-keys.service';
import { RolesService } from '../roles/roles.service';
import { normalizeCapabilities, SandboxScriptsService } from '../sandbox/sandbox-scripts.service';
import { inferParameters, mergeParameters } from '../sandbox/script-parameters.util';
import {
  DEMO_ACCOUNT_SPECS,
  DEMO_MOCK_HOST,
  DEMO_WORKSPACES,
  demoAccounts,
  demoCredentials,
  mockServiceUrl,
  type DemoAccount,
  type DemoAccountSpec,
  type DemoCredentials,
  type DemoUserKey,
  type DemoWorkspace,
  type MockService,
} from './demo.config';
import {
  DEMO_ANNOTATIONS,
  DEMO_CONNECTORS,
  DEMO_OFFERS_CHAIN,
  DEMO_OFFERS_TOOL,
  DEMO_ROLES,
  DEMO_SCRIPTS,
  DEMO_SERVER,
  demoRoleTools,
} from './demo-fixtures';
import { MockSystemsService } from './mock-systems.service';

export interface DemoWorkspaceResult {
  organizationId: string;
  serverId: string | null;
  connectorIds: Partial<Record<MockService, string>>;
}

export interface DemoSeedOptions {
  /**
   * Write the demo objects back even where they already match: the passwords
   * are re-hashed, the memberships, tool annotations, the Response Processing
   * chain and the saved scripts are rewritten. Used by the demo reset; a boot
   * never forces.
   */
  force?: boolean;
}

export interface DemoSeedResult {
  workspaces: Partial<Record<DemoWorkspace, DemoWorkspaceResult>>;
  /** The demo users that exist, with their MCP key (read back from the database, never logged). */
  users: Partial<Record<DemoUserKey, { id: string; mcpKey: string | null }>>;
  created: Record<string, number>;
  updated: Record<string, number>;
}

/** Order-insensitive deep equality for JSON values. */
function sameJson(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && sameJson([...a].sort(), [...b].sort());

/**
 * Builds the demo workspace whenever demo mode is turned on (at boot or by the
 * switch; DemoControlService calls it): the CODEBOUND test bed (workspaces Alpha and Beta, alice, carol and
 * bob, the four mock connectors, roles, the CODEBOUND MCP server per workspace,
 * one MCP key per user, the Response Processing chain and the saved scripts).
 *
 * Idempotent: everything is matched by a natural key (email, workspace name,
 * connector name, server slug, role name, script name, key name) and only
 * created when missing or written when it differs, so a restart on the same
 * database creates nothing new, and so does turning demo mode on again. A database where the kit's own `codebound
 * setup` already ran is reused, not duplicated. What a visitor changed in the
 * demo objects (a password, a script, a variable) is put back on the next boot
 * or the next time demo mode is turned on.
 *
 * Calls the services directly; nothing goes over HTTP.
 */
@Injectable()
export class DemoSeedService {
  private readonly logger = new Logger(DemoSeedService.name);
  private result: DemoSeedResult | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly connectors: ConnectorsService,
    private readonly mcpServer: McpServerService,
    private readonly mcpServers: McpServersService,
    private readonly roles: RolesService,
    private readonly apiKeys: McpApiKeysService,
    private readonly scripts: SandboxScriptsService,
    private readonly mocks: MockSystemsService,
    @Optional() private readonly edition?: EditionService,
  ) {}

  /**
   * Seeds, then logs one line saying what it created or put back (never a
   * password, key or credential). Throws when the seed fails.
   */
  async seedAndLog(port: number, options: DemoSeedOptions = {}): Promise<DemoSeedResult> {
    const r = await this.seed(port, options);
    const count = (o: Record<string, number>) =>
      Object.entries(o)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k} ${n}`)
        .join(', ') || 'nothing';
    this.logger.log(
      `Demo workspace ready: ${Object.keys(r.workspaces).length} workspaces, ${Object.keys(r.users).length} users; ` +
        `created ${count(r.created)}; updated ${count(r.updated)}.`,
    );
    return r;
  }

  /** The last seed's outcome, or null before (or without) one. */
  lastResult(): DemoSeedResult | null {
    return this.result;
  }

  /** The demo sign-ins that exist, for the public endpoint. */
  publishedAccounts(): DemoAccount[] {
    const users = this.result?.users ?? {};
    const all = demoAccounts();
    return DEMO_ACCOUNT_SPECS.map((spec, i) => (users[spec.key] ? all[i] : null)).filter(
      (a): a is DemoAccount => a !== null,
    );
  }

  /**
   * The outbound policy must let connectors reach the loopback mocks. Checked
   * against the effective policy (env, admin allowlist, loopback switch).
   */
  async assertMocksReachable(): Promise<void> {
    try {
      await assertSafeOutboundHost(DEMO_MOCK_HOST);
    } catch (err) {
      if (!(err instanceof SsrfBlockedError)) throw err;
      const message =
        `Demo mode needs the connectors to reach the mock systems on ${DEMO_MOCK_HOST}, ` +
        `but the outbound address policy blocks it (${err.message}). ` +
        `Add ${DEMO_MOCK_HOST} to SSRF_ALLOWED_HOSTS (e.g. SSRF_ALLOWED_HOSTS=${DEMO_MOCK_HOST}) and restart, ` +
        'or leave demo mode off.';
      this.logger.error(message);
      throw new Error(message);
    }
  }

  /**
   * The organization ids of the demo workspaces: from the last seed, else
   * looked up by name (oldest first, as the seed matches them). Never any other
   * organization.
   */
  async demoOrganizationIds(): Promise<Partial<Record<DemoWorkspace, string>>> {
    const out: Partial<Record<DemoWorkspace, string>> = {};
    for (const ws of Object.keys(DEMO_WORKSPACES) as DemoWorkspace[]) {
      const known = this.result?.workspaces[ws]?.organizationId;
      if (known) {
        out[ws] = known;
        continue;
      }
      const row = await this.prisma.organization.findFirst({
        where: { name: DEMO_WORKSPACES[ws].name },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (row) out[ws] = row.id;
    }
    return out;
  }

  async seed(port: number, options: DemoSeedOptions = {}): Promise<DemoSeedResult> {
    const force = options.force === true;
    const created: Record<string, number> = {};
    const updated: Record<string, number> = {};
    const bump = (o: Record<string, number>, k: string) => (o[k] = (o[k] ?? 0) + 1);
    const c = (k: string) => bump(created, k);
    const u = (k: string) => bump(updated, k);

    const accounts = demoAccounts();
    const credentials = demoCredentials();

    // 1. Workspaces.
    const orgIds = {} as Record<DemoWorkspace, string>;
    for (const ws of Object.keys(DEMO_WORKSPACES) as DemoWorkspace[]) {
      const name = DEMO_WORKSPACES[ws].name;
      const existing = await this.prisma.organization.findFirst({
        where: { name },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (existing) {
        orgIds[ws] = existing.id;
      } else {
        orgIds[ws] = (await this.prisma.organization.create({ data: { name }, select: { id: true } })).id;
        c('workspaces');
      }
    }

    // 2. Users and memberships.
    const userIds: Partial<Record<DemoUserKey, string>> = {};
    for (const [i, spec] of DEMO_ACCOUNT_SPECS.entries()) {
      const id = await this.ensureUser(spec, accounts[i].password, orgIds[spec.workspace], c, u, force);
      if (id) userIds[spec.key] = id;
    }

    // 3. Per workspace: connectors, server. The workspace admin owns them.
    const workspaces: DemoSeedResult['workspaces'] = {};
    const toolIdsByWs: Partial<Record<DemoWorkspace, Map<string, string>>> = {};
    for (const ws of Object.keys(DEMO_WORKSPACES) as DemoWorkspace[]) {
      const owner = DEMO_ACCOUNT_SPECS.find((s) => s.workspace === ws && s.memberRole === 'ADMIN');
      const ownerId = owner ? userIds[owner.key] : undefined;
      if (!ownerId) {
        this.logger.warn(`Demo workspace ${ws}: its admin could not be created; skipping its connectors.`);
        workspaces[ws] = { organizationId: orgIds[ws], serverId: null, connectorIds: {} };
        continue;
      }
      const { connectorIds, toolIds } = await this.ensureConnectors(
        ws, orgIds[ws], ownerId, port, credentials, c, u,
      );
      toolIdsByWs[ws] = toolIds;
      const serverId = await this.ensureServer(orgIds[ws], ownerId, Object.values(connectorIds), c, u);
      workspaces[ws] = { organizationId: orgIds[ws], serverId, connectorIds };
    }

    // 4. Roles in A, and the MCP roles of its users.
    const roleIds = new Map<string, string>();
    for (const role of DEMO_ROLES) {
      const tools = toolIdsByWs[role.workspace];
      if (!tools) continue;
      const orgId = orgIds[role.workspace];
      let row = await this.prisma.role.findFirst({ where: { organizationId: orgId, name: role.name }, select: { id: true } });
      if (!row) {
        row = await this.roles.create({ name: role.name, description: role.description, organizationId: orgId });
        c('roles');
      }
      roleIds.set(`${role.workspace}:${role.name}`, row.id);
      const wanted = (demoRoleTools([...tools.keys()])[role.name] ?? []).map((n) => tools.get(n) as string);
      const current = (await this.prisma.toolRoleAccess.findMany({ where: { roleId: row.id }, select: { toolId: true } })).map(
        (r) => r.toolId,
      );
      if (!sameSet(current, wanted)) {
        await this.roles.setToolAccess(row.id, wanted, orgId);
        u('role tool lists');
      }
    }
    for (const spec of DEMO_ACCOUNT_SPECS) {
      const userId = userIds[spec.key];
      if (!userId || !toolIdsByWs[spec.workspace]) continue;
      const orgId = orgIds[spec.workspace];
      const wanted = spec.mcpRoles.map((n) => roleIds.get(`${spec.workspace}:${n}`)).filter((x): x is string => !!x);
      const current = (
        await this.prisma.userRoleAssignment.findMany({ where: { userId, organizationId: orgId }, select: { roleId: true } })
      ).map((r) => r.roleId);
      if (!sameSet(current, wanted)) {
        await this.roles.setUserRoles(userId, wanted, orgId);
        u('role assignments');
      }
    }

    // 5. Tool annotations and the Response Processing chain (both workspaces).
    for (const ws of Object.keys(DEMO_WORKSPACES) as DemoWorkspace[]) {
      const tools = toolIdsByWs[ws];
      const supplierId = workspaces[ws]?.connectorIds.supplier;
      if (!tools || !supplierId) continue;
      let changed = false;
      for (const [name, annotations] of Object.entries(DEMO_ANNOTATIONS)) {
        const id = tools.get(name);
        if (!id) continue;
        const tool = await this.prisma.mcpTool.findUnique({ where: { id }, select: { annotations: true } });
        if (force || !sameJson(tool?.annotations ?? null, annotations)) {
          await this.prisma.mcpTool.update({ where: { id }, data: { annotations: annotations as any } });
          u('tool annotations');
          changed = true;
        }
      }
      const offersId = tools.get(DEMO_OFFERS_TOOL);
      if (offersId) {
        const tool = await this.prisma.mcpTool.findUnique({ where: { id: offersId }, select: { responseMapping: true } });
        const mapping = (tool?.responseMapping as Record<string, unknown> | null) ?? {};
        if (force || !sameJson(mapping.responseProcessing, DEMO_OFFERS_CHAIN)) {
          // The chain changes the response's shape, so a stored outputSchema no
          // longer describes it (as the tool update route does).
          await this.prisma.mcpTool.update({
            where: { id: offersId },
            data: { responseMapping: { ...mapping, responseProcessing: DEMO_OFFERS_CHAIN } as any, outputSchema: null as any },
          });
          u('response processing');
          changed = true;
        }
      }
      if (changed) await this.mcpServer.reloadConnectorTools(supplierId);
    }

    // 6. One MCP key per user, scoped to its workspace's CODEBOUND server.
    const users: DemoSeedResult['users'] = {};
    for (const spec of DEMO_ACCOUNT_SPECS) {
      const userId = userIds[spec.key];
      if (!userId) continue;
      const serverId = workspaces[spec.workspace]?.serverId ?? null;
      users[spec.key] = { id: userId, mcpKey: serverId ? await this.ensureKey(spec, userId, orgIds[spec.workspace], serverId, c, u) : null };
    }

    // 7. Saved scripts of workspace A, owned by alice.
    const aliceId = userIds.alice;
    const wsA = workspaces.A;
    if (aliceId && wsA && toolIdsByWs.A) {
      for (const def of DEMO_SCRIPTS) {
        await this.ensureScript(def, orgIds.A, aliceId, wsA.connectorIds, c, u, force);
      }
    }

    this.result = { workspaces, users, created, updated };
    return this.result;
  }

  private async ensureUser(
    spec: DemoAccountSpec,
    password: string,
    orgId: string,
    c: (k: string) => void,
    u: (k: string) => void,
    force = false,
  ): Promise<string | null> {
    let user = await this.prisma.user.findUnique({
      where: { email: spec.email },
      select: { id: true, passwordHash: true, emailVerified: true, organizationId: true, role: true },
    });
    if (!user) {
      // The demo users count as seats like anyone else; never past the limit.
      const seat = this.edition ? await this.edition.seatAvailable() : { ok: true };
      if (!seat.ok) {
        this.logger.warn(`Demo user ${spec.email} not created: the edition's seat limit is reached.`);
        return null;
      }
      user = await this.prisma.user.create({
        data: {
          email: spec.email,
          name: spec.name,
          passwordHash: await this.auth.hashPassword(password),
          emailVerified: true,
          role: spec.memberRole,
          organizationId: orgId,
        },
        select: { id: true, passwordHash: true, emailVerified: true, organizationId: true, role: true },
      });
      c('users');
    } else {
      const data: Record<string, unknown> = {};
      // Re-set on every boot, so a changed seed (or a visitor's password change) is undone.
      if (force || !user.passwordHash || !(await this.auth.comparePassword(password, user.passwordHash))) {
        data.passwordHash = await this.auth.hashPassword(password);
        data.passwordLoginDisabled = false;
      }
      if (force || !user.emailVerified) data.emailVerified = true;
      // Signs in to its own workspace.
      if (force || user.organizationId !== orgId || user.role !== spec.memberRole) {
        data.organizationId = orgId;
        data.role = spec.memberRole;
      }
      if (Object.keys(data).length > 0) {
        await this.prisma.user.update({ where: { id: user.id }, data });
        u('users');
      }
    }

    const membership = await this.prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId: user.id, organizationId: orgId } },
      select: { role: true, deactivatedAt: true },
    });
    if (!membership) {
      await this.prisma.organizationMember.create({ data: { userId: user.id, organizationId: orgId, role: spec.memberRole } });
      c('memberships');
    } else if (force || membership.role !== spec.memberRole || membership.deactivatedAt) {
      await this.prisma.organizationMember.update({
        where: { userId_organizationId: { userId: user.id, organizationId: orgId } },
        data: { role: spec.memberRole, deactivatedAt: null },
      });
      u('memberships');
    }
    return user.id;
  }

  private async ensureConnectors(
    ws: DemoWorkspace,
    orgId: string,
    ownerId: string,
    port: number,
    credentials: DemoCredentials,
    c: (k: string) => void,
    u: (k: string) => void,
  ): Promise<{ connectorIds: Partial<Record<MockService, string>>; toolIds: Map<string, string> }> {
    const connectorIds: Partial<Record<MockService, string>> = {};
    const toolIds = new Map<string, string>();
    for (const svc of DEMO_WORKSPACES[ws].services) {
      const def = DEMO_CONNECTORS[svc];
      let changed = false;
      let connector = await this.prisma.connector.findFirst({
        where: { organizationId: orgId, name: def.name },
        orderBy: { createdAt: 'asc' },
      });
      if (!connector) {
        // As POST /api/connectors/import-all stores it; auth and variables below.
        connector = await this.prisma.connector.create({
          data: {
            userId: ownerId,
            organizationId: orgId,
            name: def.name,
            type: def.type,
            baseUrl: def.baseUrl,
            isActive: true,
            authType: 'NONE',
            headers: def.headers,
          },
        });
        c('connectors');
        changed = true;
      }
      connectorIds[svc] = connector.id;

      // Variables, auth and switches: written only when they differ.
      const [urlVar, secretVar] = def.envVarNames;
      const wantedVars = { [urlVar]: mockServiceUrl(port, svc), [secretVar]: credentials[ws][svc] as string };
      const currentVars = (openEnvVars(connector.envVars) as Record<string, unknown> | null) ?? {};
      let currentAuth: unknown = null;
      try {
        currentAuth = this.connectors.getDecryptedAuthConfig(connector);
      } catch {
        currentAuth = null; // unreadable: write it again
      }
      const patch: Parameters<ConnectorsService['update']>[1] = {};
      if (!sameJson({ ...currentVars, ...wantedVars }, currentVars)) patch.envVars = { ...currentVars, ...wantedVars } as Record<string, string>;
      if (connector.authType !== def.authType || !sameJson(currentAuth, def.authConfig)) {
        patch.authType = def.authType;
        patch.authConfig = def.authConfig;
      }
      if (connector.baseUrl !== def.baseUrl) patch.baseUrl = def.baseUrl;
      if (!connector.isActive) patch.isActive = true;
      if (Object.keys(patch).length > 0) {
        await this.connectors.update(connector.id, patch);
        if (!changed) u('connectors');
        changed = true;
      }

      // Tools: the missing ones are created, a disabled one is switched back on.
      const existing = await this.prisma.mcpTool.findMany({
        where: { connectorId: connector.id },
        select: { id: true, name: true, isEnabled: true },
      });
      for (const t of def.tools) {
        const hit = existing.find((e) => e.name === t.name);
        if (hit) {
          toolIds.set(t.name, hit.id);
          if (!hit.isEnabled) {
            await this.prisma.mcpTool.update({ where: { id: hit.id }, data: { isEnabled: true } });
            u('tools');
            changed = true;
          }
          continue;
        }
        const row = await this.prisma.mcpTool.create({
          data: {
            connectorId: connector.id,
            name: t.name,
            description: t.description,
            isEnabled: true,
            parameters: t.parameters as any,
            endpointMapping: t.endpointMapping as any,
          },
          select: { id: true },
        });
        toolIds.set(t.name, row.id);
        c('tools');
        changed = true;
      }
      if (changed) await this.mcpServer.reloadConnectorTools(connector.id);
    }
    return { connectorIds, toolIds };
  }

  private async ensureServer(
    orgId: string,
    ownerId: string,
    connectorIds: string[],
    c: (k: string) => void,
    u: (k: string) => void,
  ): Promise<string> {
    let server = await this.prisma.mcpServerConfig.findFirst({
      where: { organizationId: orgId, slug: DEMO_SERVER.slug },
      select: { id: true, isActive: true },
    });
    if (!server) {
      server = await this.mcpServers.create(ownerId, orgId, DEMO_SERVER);
      c('mcp servers');
    } else if (!server.isActive) {
      await this.mcpServers.update(server.id, { isActive: true });
      u('mcp servers');
    }
    const current = await this.mcpServers.getConnectorIds(server.id);
    if (!sameSet(current, connectorIds)) {
      await this.mcpServers.assignConnectors(server.id, connectorIds);
      u('mcp server connectors');
    }
    return server.id;
  }

  /**
   * MCP keys are random (the key service takes no value), so a key is created
   * once and found again by its name afterwards; a revoked one is switched back on.
   */
  private async ensureKey(
    spec: DemoAccountSpec,
    userId: string,
    orgId: string,
    serverId: string,
    c: (k: string) => void,
    u: (k: string) => void,
  ): Promise<string> {
    const name = `demo-${spec.key}`;
    const existing = await this.prisma.mcpApiKey.findFirst({
      where: { userId, organizationId: orgId, name },
      orderBy: { createdAt: 'asc' },
      select: { id: true, key: true, isActive: true, mcpServerId: true },
    });
    if (!existing) {
      const created = await this.apiKeys.generate(userId, orgId, name, serverId);
      c('mcp keys');
      return created.key;
    }
    if (!existing.isActive || existing.mcpServerId !== serverId) {
      await this.prisma.mcpApiKey.update({ where: { id: existing.id }, data: { isActive: true, mcpServerId: serverId } });
      u('mcp keys');
    }
    return existing.key;
  }

  private async ensureScript(
    def: (typeof DEMO_SCRIPTS)[number],
    orgId: string,
    ownerId: string,
    connectorIds: Partial<Record<MockService, string>>,
    c: (k: string) => void,
    u: (k: string) => void,
    force = false,
  ): Promise<void> {
    if (def.uses.some((x) => !connectorIds[x.service])) return;
    const uses = def.uses.map((x) => ({ connectorId: connectorIds[x.service] as string, tools: x.tools }));
    const existing = await this.prisma.sandboxScript.findFirst({
      where: { organizationId: orgId, name: def.name },
      select: {
        id: true,
        code: true,
        description: true,
        parameters: true,
        capabilities: true,
        uses: { select: { connectorId: true, toolName: true } },
      },
    });
    if (!existing) {
      await this.scripts.create(orgId, ownerId, {
        name: def.name,
        code: def.code,
        description: def.description,
        uses,
        parameters: def.parameters,
        capabilities: def.capabilities,
      });
      c('scripts');
      return;
    }
    const wantedUses = uses.flatMap((x) => x.tools.map((t) => `${x.connectorId}/${t}`));
    const currentUses = existing.uses.map((x) => `${x.connectorId}/${x.toolName}`);
    const wantedParams = mergeParameters(inferParameters(def.code).names, def.parameters);
    const same =
      existing.code === def.code &&
      existing.description === def.description &&
      sameJson(existing.parameters, wantedParams) &&
      sameJson(normalizeCapabilities(existing.capabilities), normalizeCapabilities(def.capabilities)) &&
      sameSet(currentUses, wantedUses);
    if (same && !force) return;
    await this.scripts.update(orgId, existing.id, {
      // The version follows the code: only sent when it differs.
      ...(existing.code !== def.code && { code: def.code }),
      description: def.description,
      uses,
      parameters: def.parameters,
      capabilities: def.capabilities ?? {},
    });
    u('scripts');
  }
}
