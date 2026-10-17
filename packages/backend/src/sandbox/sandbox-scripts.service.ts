import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { boundPayload } from '../audit/bound-payload';
import { decrypt } from '../common/crypto/encryption.util';
import { interpolateString } from '../common/env-interpolation.util';
import { PrismaService } from '../common/prisma.service';
import { isMaskedEnvVar, isSecretName, secretContext } from '../connectors/connector-secrets.util';
import { Prisma } from '../generated/prisma/client';
import {
  SCRIPT_MAX_CONNECTORS,
  SCRIPT_MAX_TOOLS,
  SCRIPT_NAME_MESSAGE,
  SCRIPT_NAME_PATTERN,
} from './sandbox-scripts.dto';
import {
  inferParameters,
  mergeParameters,
  validateParameters,
  type ParametersSchema,
} from './script-parameters.util';
import type { ScriptRunCapabilities } from './script-http';
import { groupUses, missingConnectors, type DeclaredUse, type ScriptUse } from './script-uses.util';
import { findToolReferences } from './tool-references.util';
import type { SandboxRunResult, ScriptCapabilities } from './types';

const RESULT_PREVIEW_BYTES = 16 * 1024;
const ARGS_PREVIEW_BYTES = 8 * 1024;
const MAX_RUNS_PAGE = 200;

/** The declared connectors and tools of a script, one row per tool. */
const USES_SELECT = { connectorId: true, connectorName: true, toolName: true } as const;
const USES_INCLUDE = {
  select: USES_SELECT,
  orderBy: [
    { connectorName: 'asc' },
    { toolName: 'asc' },
  ] satisfies Prisma.SandboxScriptToolOrderByWithRelationInput[],
};

/** The columns a list row needs; `code` is added only on request. */
const SUMMARY_SELECT = {
  id: true,
  createdById: true,
  name: true,
  description: true,
  version: true,
  parameters: true,
  capabilities: true,
  lastRunAt: true,
  lastRunOk: true,
  lastRunMeta: true,
  createdAt: true,
  updatedAt: true,
  uses: USES_INCLUDE,
} as const;

export interface RecordRunInput {
  /** The run's id, when it was handed out before the run (the audit rows carry it). */
  id?: string;
  organizationId: string;
  mcpServerId: string;
  scriptId?: string;
  userId?: string;
  code: string;
  args?: Record<string, unknown>;
  result: SandboxRunResult;
}

/**
 * A script as returned by this service: its uses grouped by connector, with
 * current names, and the argument names its code reads right now.
 */
type WithUses<T extends { uses: DeclaredUse[] }> = Omit<T, 'uses'> & {
  uses: ScriptUse[];
  inferredParameters: string[];
};

/** A saved script that has parameters and that a given server can run: it becomes an MCP tool. */
export interface ExposedScript {
  id: string;
  name: string;
  description: string | null;
  version: number;
  parameters: ParametersSchema;
  uses: ScriptUse[];
}

/** What a person or an agent says a script uses. Either form, or both. */
export interface UsesInput {
  /** Picked in the dashboard: a connector and the tools of it the script calls. */
  connectors?: { connectorId: string; tools: string[] }[];
  /** Named by an agent, as in its tool list. The connector is looked up. */
  toolNames?: string[];
}

export interface SaveContext {
  /**
   * Connectors of the server the script is saved from. When a tool name exists on
   * several connectors of the organization, the one of this server is meant.
   */
  preferConnectorIds?: string[];
}

export interface SaveOutcome<S> {
  script: S;
  /** Tools found in the code and added to what the author declared, as "Connector / tool". */
  added: string[];
  /** Things the author should look at, such as a call that could not be matched. */
  warnings: string[];
}

interface ToolCandidate {
  connectorId: string;
  connectorName: string;
  toolName: string;
}

/** Json column input: JS null must be spelled Prisma.JsonNull. */
function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === undefined || value === null
    ? Prisma.JsonNull
    : (value as Prisma.InputJsonValue);
}

/**
 * The Level 3 switches as stored: only the ones that are on, or null when none
 * is (Level 2). Anything that is not exactly `true` is off.
 */
export function normalizeCapabilities(value: unknown): ScriptCapabilities | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const out: ScriptCapabilities = {
    ...(v.env === true && { env: true }),
    ...(v.http === true && { http: true }),
  };
  return out.env || out.http ? out : null;
}

function capabilitiesColumn(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  const caps = normalizeCapabilities(value);
  return caps === null ? Prisma.DbNull : (caps as Prisma.InputJsonValue);
}

const VAR_REF = /\{\{([^{}]+)\}\}/g;
/** Keys in a decrypted authConfig whose literal value is a credential. */
const AUTH_SECRET_KEY = /secret|passw|token|key|credential|private|signature|assertion|authorization|cookie|session|jwt|bearer/i;
const AUTH_NOT_SECRET_KEY = /(url|uri|endpoint|path|name|type|location)$|^in$/i;

/**
 * What a connector's authConfig says about its secrets: every variable it
 * references (all of them feed the credential), and its literal values under a
 * credential key (a password typed in directly rather than as a variable).
 */
function authConfigSecrets(node: unknown, key: string, vars: Set<string>, literals: Set<string>): void {
  if (typeof node === 'string') {
    let referenced = false;
    for (const m of node.matchAll(VAR_REF)) {
      vars.add(m[1].trim());
      referenced = true;
    }
    if (!referenced && AUTH_SECRET_KEY.test(key) && !AUTH_NOT_SECRET_KEY.test(key)) literals.add(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) authConfigSecrets(item, key, vars, literals);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) authConfigSecrets(v, k, vars, literals);
  }
}

function decryptedAuthConfig(authConfig: string | null): unknown {
  const key = process.env.ENCRYPTION_KEY;
  if (!authConfig || !key) return null;
  try {
    return JSON.parse(decrypt(authConfig, key));
  } catch {
    return null;
  }
}

/** The parameters column: SQL NULL (not a JSON null) when the script has none. */
function parametersColumn(value: ParametersSchema | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : (value as unknown as Prisma.InputJsonValue);
}

/**
 * Saved sandbox scripts and their run history. Scripts belong to the organization
 * and declare the connectors and tools they use; every query is filtered by
 * organizationId so a caller can only ever reach their own workspace's rows.
 */
@Injectable()
export class SandboxScriptsService {
  private readonly logger = new Logger(SandboxScriptsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(organizationId: string, opts: { includeCode?: boolean } = {}) {
    // The code is read to tell which arguments it reads; it leaves with the row only on request.
    const rows = await this.prisma.sandboxScript.findMany({
      where: { organizationId },
      orderBy: { name: 'asc' },
      select: { ...SUMMARY_SELECT, code: true },
    });
    const presented = await this.present(organizationId, rows);
    return opts.includeCode === true ? presented : presented.map(({ code: _code, ...row }) => row);
  }

  /**
   * The scripts an MCP server offers as tools of their own: those with
   * parameters, whose connectors the server has all of (the rule that decides
   * `sandbox_list_scripts` too). Read per request, so a script saved a moment ago
   * is on the next tool list.
   */
  async listExposed(organizationId: string, connectorIds: string[]): Promise<ExposedScript[]> {
    const rows = await this.prisma.sandboxScript.findMany({
      where: { organizationId, parameters: { not: Prisma.DbNull } },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        version: true,
        parameters: true,
        uses: USES_INCLUDE,
      },
    });
    const presented = await this.present(organizationId, rows.map((r) => ({ ...r, code: '' })));
    return presented
      .filter((s) => s.parameters !== null && missingConnectors(s.uses, connectorIds).length === 0)
      .map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        version: s.version,
        parameters: s.parameters as unknown as ParametersSchema,
        uses: s.uses,
      }));
  }

  async get(organizationId: string, id: string) {
    const script = await this.prisma.sandboxScript.findFirst({
      where: { id, organizationId },
      include: { uses: USES_INCLUDE },
    });
    if (!script) throw new NotFoundException('Script not found');
    return (await this.present(organizationId, [script]))[0];
  }

  async getByName(organizationId: string, name: string) {
    const script = await this.prisma.sandboxScript.findFirst({
      where: { organizationId, name },
      include: { uses: USES_INCLUDE },
    });
    return script ? (await this.present(organizationId, [script]))[0] : null;
  }

  async create(
    organizationId: string,
    userId: string | undefined,
    input: {
      name: string;
      code: string;
      description?: string;
      uses?: UsesInput['connectors'];
      toolNames?: string[];
      parameters?: unknown;
      /** Level 3 switches; the creator is the author, so they may set them. */
      capabilities?: unknown;
    },
    ctx: SaveContext = {},
  ) {
    if (!SCRIPT_NAME_PATTERN.test(input.name)) {
      throw new BadRequestException(SCRIPT_NAME_MESSAGE);
    }
    const params = this.resolveParameters(input.code, input.parameters, null);
    const resolved = await this.resolveUses(
      organizationId,
      input.code,
      { connectors: input.uses, toolNames: input.toolNames },
      [],
      ctx,
    );
    try {
      const created = await this.prisma.sandboxScript.create({
        data: {
          organizationId,
          createdById: userId ?? null,
          name: input.name,
          code: input.code,
          description: input.description ?? null,
          parameters: parametersColumn(params.parameters),
          capabilities: capabilitiesColumn(input.capabilities),
          uses: { create: resolved.rows.map((r) => ({ organizationId, ...r })) },
        },
        include: { uses: USES_INCLUDE },
      });
      return this.outcome(organizationId, created, resolved, params.warnings);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(`Script '${input.name}' already exists`);
      }
      throw err;
    }
  }

  async update(
    organizationId: string,
    id: string,
    patch: {
      code?: string;
      description?: string;
      uses?: UsesInput['connectors'];
      toolNames?: string[];
      parameters?: unknown;
      capabilities?: unknown;
    },
    ctx: SaveContext = {},
  ) {
    const declaresUses = patch.uses !== undefined || patch.toolNames !== undefined;
    if (
      patch.code === undefined &&
      patch.description === undefined &&
      patch.parameters === undefined &&
      patch.capabilities === undefined &&
      !declaresUses
    ) {
      throw new BadRequestException(
        'Provide code, description, parameters, capabilities and/or the tools the script uses',
      );
    }
    const current = await this.prisma.sandboxScript.findFirst({
      where: { id, organizationId },
      include: { uses: USES_INCLUDE },
    });
    if (!current) throw new NotFoundException('Script not found');

    // The parameters follow the code: re-read when it changes, or when the author sends them.
    const reparam = patch.code !== undefined || patch.parameters !== undefined;
    const params = reparam
      ? this.resolveParameters(patch.code ?? current.code, patch.parameters, current.parameters)
      : { parameters: undefined, warnings: [] as string[] };

    // What the script declares changes when the author sends a new list, or when
    // new code calls tools the old list lacks. Plain description edits leave it be.
    const reresolve = declaresUses || patch.code !== undefined;
    const resolved = reresolve
      ? await this.resolveUses(
          organizationId,
          patch.code ?? current.code,
          declaresUses ? { connectors: patch.uses, toolNames: patch.toolNames } : undefined,
          declaresUses ? [] : current.uses,
          ctx,
        )
      : { rows: current.uses, added: [], warnings: [] };

    try {
      const updated = await this.prisma.sandboxScript.update({
        where: { id, organizationId },
        data: {
          // The version tracks the code, so a description edit leaves it alone.
          ...(patch.code !== undefined && { code: patch.code, version: { increment: 1 } }),
          ...(patch.description !== undefined && { description: patch.description }),
          ...(params.parameters !== undefined && { parameters: parametersColumn(params.parameters) }),
          ...(patch.capabilities !== undefined && { capabilities: capabilitiesColumn(patch.capabilities) }),
          ...(reresolve && {
            uses: {
              deleteMany: {},
              create: resolved.rows.map((r) => ({ organizationId, ...r })),
            },
          }),
        },
        include: { uses: USES_INCLUDE },
      });
      return this.outcome(organizationId, updated, resolved, params.warnings);
    } catch (err) {
      if (isRecordMissing(err)) throw new NotFoundException('Script not found');
      throw err;
    }
  }

  /**
   * Edit on behalf of an agent session. Only the script's author may change it:
   * a saved script runs with the authority of whoever runs it, so letting any
   * member of the organization edit another member's script would let a user with
   * fewer permissions plant code that a more privileged user's agent then runs.
   * Anyone else saves their own copy under a new name.
   */
  async updateByName(
    organizationId: string,
    name: string,
    patch: { code?: string; description?: string; toolNames?: string[]; parameters?: unknown },
    editorUserId: string | undefined,
    ctx: SaveContext = {},
  ) {
    const script = await this.getByName(organizationId, name);
    if (!script) throw new NotFoundException(`Script '${name}' not found`);
    if (!isAuthor(script, editorUserId)) {
      throw new ForbiddenException(
        `Script '${name}' was created by someone else, so only they can edit it. ` +
          'Save your own copy under a new name with sandbox_create_script.',
      );
    }
    return this.update(organizationId, script.id, patch, ctx);
  }

  /**
   * `updateByName` for the dashboard API: same author-only rule, addressed by id.
   * One exception: an administrator may switch the Level 3 capabilities of
   * anyone's script (and nothing else in the same request). That changes what
   * the script may reach, not its code, so it plants nothing.
   */
  async updateByIdAsAuthor(
    organizationId: string,
    id: string,
    patch: {
      code?: string;
      description?: string;
      uses?: UsesInput['connectors'];
      parameters?: unknown;
      capabilities?: unknown;
    },
    editorUserId: string | undefined,
    ctx: SaveContext = {},
    opts: { isAdmin?: boolean } = {},
  ) {
    const script = await this.get(organizationId, id);
    const onlyCapabilities =
      patch.capabilities !== undefined &&
      patch.code === undefined &&
      patch.description === undefined &&
      patch.uses === undefined &&
      patch.parameters === undefined;
    if (!isAuthor(script, editorUserId) && !(opts.isAdmin === true && onlyCapabilities)) {
      throw new ForbiddenException(
        `Script '${script.name}' was created by someone else, so only they can edit it. ` +
          'Save your own copy under a new name.',
      );
    }
    return this.update(organizationId, script.id, patch, ctx);
  }

  async remove(organizationId: string, id: string): Promise<void> {
    const { count } = await this.prisma.sandboxScript.deleteMany({
      where: { id, organizationId },
    });
    if (count === 0) throw new NotFoundException('Script not found');
  }

  /**
   * Delete for the dashboard API. The author may delete their script and an
   * administrator may clear out anyone's; deleting plants no code, so unlike
   * editing it needs no author-only rule for administrators.
   */
  async removeAsUser(
    organizationId: string,
    id: string,
    actor: { userId: string | undefined; isAdmin: boolean },
  ): Promise<void> {
    const script = await this.get(organizationId, id);
    if (!actor.isAdmin && !isAuthor(script, actor.userId)) {
      throw new ForbiddenException('Only the script\'s author or an administrator can delete it');
    }
    await this.remove(organizationId, script.id);
  }

  /**
   * Newest runs first. A run keeps a preview of what the connectors returned, so
   * `onlyUserId` narrows the list to one caller's own runs; a caller whose tool
   * access is narrower than another's must not read that other's results.
   */
  listRuns(organizationId: string, mcpServerId: string, limit = 50, onlyUserId?: string) {
    return this.prisma.sandboxRun.findMany({
      where: { organizationId, mcpServerId, ...(onlyUserId !== undefined && { userId: onlyUserId }) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(Math.trunc(limit) || 50, 1), MAX_RUNS_PAGE),
    });
  }

  /**
   * What a Level 3 saved script gets for one run, or null for a Level 2 one.
   *
   * - `env`: the variables of the declared connectors, keyed by name (when two
   *   connectors have a variable of the same name, the first by connector name
   *   wins). Other connectors' variables are not there at all.
   * - `http.origins`: the origin of each declared connector's base URL, after
   *   its `{{VAR}}` placeholders are filled in.
   * - `secrets`: every secret value of every declared connector, used or not,
   *   for masking. A variable is secret when its name or value says so, when
   *   the adapter feeds it into a credential slot, or when the connector's
   *   authConfig references it; literal credentials in authConfig count too.
   *
   * A connector contributes to `env` and `http` only if the caller may call
   * every tool the script declares on it (`callable` is the caller's role-filtered
   * tool list): raw HTTP and the key reach further than any one tool, so a role
   * that withholds a declared tool withholds the connector. Its secrets are
   * still masked. Filtered by organizationId like every query here.
   */
  async runCapabilities(
    organizationId: string,
    script: { capabilities?: unknown; uses: ScriptUse[] },
    callable: { connectorId: string; name: string }[],
    opts: { allowWrites: boolean },
  ): Promise<ScriptRunCapabilities | null> {
    const caps = normalizeCapabilities(script.capabilities);
    if (!caps) return null;

    const ids = [...new Set(script.uses.map((u) => u.connectorId))];
    const connectors = ids.length
      ? await this.prisma.connector.findMany({
          where: { organizationId, id: { in: ids } },
          select: { id: true, name: true, baseUrl: true, envVars: true, authConfig: true, headers: true, config: true },
          orderBy: { name: 'asc' },
        })
      : [];
    const visible = new Set(callable.map((t) => `${t.connectorId}\u0000${t.name}`));
    const granted = new Set(
      script.uses
        .filter((u) => u.tools.length > 0 && u.tools.every((t) => visible.has(`${u.connectorId}\u0000${t}`)))
        .map((u) => u.connectorId),
    );

    const env: Record<string, string> = {};
    const origins = new Map<string, string>();
    const secrets = new Set<string>();
    for (const c of connectors) {
      const vars: Record<string, string> = {};
      const raw = c.envVars as Record<string, unknown> | null;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [name, value] of Object.entries(raw)) {
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            vars[name] = String(value);
          }
        }
      }
      const ctx = secretContext(c);
      const authVars = new Set<string>();
      const authLiterals = new Set<string>();
      authConfigSecrets(decryptedAuthConfig(c.authConfig), 'authConfig', authVars, authLiterals);
      for (const literal of authLiterals) secrets.add(literal);
      for (const [name, value] of Object.entries(vars)) {
        if (value && (isMaskedEnvVar(name, value, ctx) || authVars.has(name) || isSecretName(name))) {
          secrets.add(value);
        }
      }

      if (!granted.has(c.id)) continue;
      if (caps.env) {
        for (const [name, value] of Object.entries(vars)) {
          if (!Object.prototype.hasOwnProperty.call(env, name)) env[name] = value;
        }
      }
      if (caps.http) {
        try {
          const base = new URL(interpolateString(c.baseUrl, vars));
          if ((base.protocol === 'http:' || base.protocol === 'https:') && !origins.has(base.origin)) {
            origins.set(base.origin, c.name);
          }
        } catch {
          /* no usable base URL (a database connector, an unset variable): nothing to reach */
        }
      }
    }
    return {
      ...(caps.env && { env }),
      ...(caps.http && { http: { origins, allowWrites: opts.allowWrites } }),
      secrets: [...secrets],
    };
  }

  /**
   * Persist one run and, for a saved script, refresh its last-run summary.
   * Best effort: a storage failure is logged and never turns a finished run
   * into an error for the caller. Returns the run id, or null if not stored.
   */
  async recordRun(input: RecordRunInput): Promise<string | null> {
    const { result } = input;
    try {
      const run = await this.prisma.sandboxRun.create({
        data: {
          ...(input.id && { id: input.id }),
          organizationId: input.organizationId,
          mcpServerId: input.mcpServerId,
          scriptId: input.scriptId ?? null,
          userId: input.userId ?? null,
          code: input.code,
          args: toJson(
            input.args ? boundPayload(input.args, { maxBytes: ARGS_PREVIEW_BYTES }) : null,
          ),
          ok: result.ok,
          errorCode: result.error?.code ?? null,
          errorMessage: result.error?.message ?? null,
          resultPreview: toJson(
            result.ok ? boundPayload(result.result, { maxBytes: RESULT_PREVIEW_BYTES }) : null,
          ),
          meta: result.meta as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      if (input.scriptId) {
        await this.prisma.sandboxScript.updateMany({
          where: { id: input.scriptId, organizationId: input.organizationId },
          data: {
            lastRunAt: new Date(),
            lastRunOk: result.ok,
            lastRunMeta: {
              ms: result.meta.ms,
              connectorCalls: result.meta.connectorCalls,
              bytesFromConnectors: result.meta.bytesFromConnectors,
              bytesReturned: result.meta.bytesReturned,
            },
          },
        });
      }
      return run.id;
    } catch (err) {
      this.logger.warn(`Could not store sandbox run: ${(err as Error)?.message ?? err}`);
      return null;
    }
  }

  /** Groups each script's rows by connector and attaches the connectors' current names. */
  private async present<T extends { uses: DeclaredUse[]; code: string }>(
    organizationId: string,
    rows: T[],
  ): Promise<WithUses<T>[]> {
    const ids = [...new Set(rows.flatMap((r) => r.uses.map((u) => u.connectorId)))];
    const current = new Map<string, string>();
    if (ids.length > 0) {
      const found = await this.prisma.connector.findMany({
        where: { organizationId, id: { in: ids } },
        select: { id: true, name: true },
      });
      for (const c of found) current.set(c.id, c.name);
    }
    return rows.map((r) => ({
      ...r,
      uses: groupUses(r.uses, current),
      inferredParameters: inferParameters(r.code).names,
    }));
  }

  private async outcome<T extends { uses: DeclaredUse[]; code: string }>(
    organizationId: string,
    saved: T,
    resolved: ResolvedUses,
    extraWarnings: string[] = [],
  ): Promise<SaveOutcome<WithUses<T>>> {
    const [script] = await this.present(organizationId, [saved]);
    return {
      script,
      added: resolved.added.map((a) => `${a.connectorName} / ${a.toolName}`),
      warnings: [...resolved.warnings, ...extraWarnings],
    };
  }

  /**
   * The parameters a script is saved with: the author's (checked), kept as set and
   * updated with the names the code reads now. `supplied` undefined keeps what the
   * script had; null starts over from the code. A schema that cannot be exposed
   * (too many names read) is not stored, and the author is told.
   */
  private resolveParameters(
    code: string,
    supplied: unknown,
    existing: unknown,
  ): { parameters: ParametersSchema | null; warnings: string[] } {
    if (supplied !== undefined && supplied !== null) {
      const problem = validateParameters(supplied);
      if (problem) throw new BadRequestException(problem);
    }
    const base = supplied === undefined ? existing : supplied;
    const merged = mergeParameters(inferParameters(code).names, base);
    const problem = merged ? validateParameters(merged) : null;
    if (problem) {
      return { parameters: null, warnings: [`The script is not offered as a tool: ${problem}.`] };
    }
    return { parameters: merged, warnings: [] };
  }

  /**
   * The connectors and tools a script is saved with: what the author declared
   * (checked against the organization's real connectors and tools), plus what the
   * code calls that the author did not list and that can be matched to one tool.
   * `keep` is what the script already declared, kept when no new list is sent.
   */
  private async resolveUses(
    organizationId: string,
    code: string,
    input: UsesInput | undefined,
    keep: DeclaredUse[],
    ctx: SaveContext,
  ): Promise<ResolvedUses> {
    const prefer = new Set(ctx.preferConnectorIds ?? []);
    const rows = new Map<string, ToolCandidate>();
    const put = (r: ToolCandidate) => rows.set(`${r.connectorId}\u0000${r.toolName}`, r);
    for (const k of keep) put(k);

    // 1. Picked in the dashboard: every connector and tool must exist.
    const picked = input?.connectors ?? [];
    if (picked.length > SCRIPT_MAX_CONNECTORS) {
      throw new BadRequestException(`A script can use at most ${SCRIPT_MAX_CONNECTORS} connectors`);
    }
    if (picked.length > 0) {
      const ids = [...new Set(picked.map((p) => p.connectorId))];
      const connectors = await this.prisma.connector.findMany({
        where: { organizationId, id: { in: ids } },
        select: { id: true, name: true },
      });
      const nameOf = new Map(connectors.map((c) => [c.id, c.name]));
      const unknown = ids.filter((id) => !nameOf.has(id));
      if (unknown.length > 0) throw new BadRequestException(`Unknown connector '${unknown[0]}'`);

      const wanted = [...new Set(picked.flatMap((p) => p.tools))];
      const existing = wanted.length
        ? await this.prisma.mcpTool.findMany({
            where: { connectorId: { in: ids }, name: { in: wanted } },
            select: { connectorId: true, name: true },
          })
        : [];
      const exists = new Set(existing.map((t) => `${t.connectorId}\u0000${t.name}`));
      for (const p of picked) {
        const connectorName = nameOf.get(p.connectorId) as string;
        if (p.tools.length === 0) {
          throw new BadRequestException(
            `Pick at least one tool of '${connectorName}', or remove the connector`,
          );
        }
        for (const toolName of p.tools) {
          if (!exists.has(`${p.connectorId}\u0000${toolName}`)) {
            throw new BadRequestException(`Connector '${connectorName}' has no tool '${toolName}'`);
          }
          put({ connectorId: p.connectorId, connectorName, toolName });
        }
      }
    }

    // 2. Named by an agent: each must match exactly one tool.
    const named = [...new Set(input?.toolNames ?? [])];
    const detected = findToolReferences(code);
    const lookup = await this.lookupTools(organizationId, [...named, ...detected.names]);
    for (const name of named) {
      const hit = pick(lookup.get(name) ?? [], prefer);
      if (hit.kind === 'unknown') {
        throw new BadRequestException(`Unknown tool '${name}'. Use the names in the tool list.`);
      }
      if (hit.kind === 'ambiguous') {
        throw new BadRequestException(
          `Tool '${name}' exists on several connectors (${hit.connectors}); ` +
            'ask for it on the MCP server that has the one you mean.',
        );
      }
      put(hit.tool);
    }

    // 3. Called in the code but not declared: add what can be matched, say the rest.
    const added: ToolCandidate[] = [];
    const warnings: string[] = [];
    const declaredNames = new Set([...rows.values()].map((r) => r.toolName));
    for (const name of detected.names) {
      if (declaredNames.has(name)) continue;
      const hit = pick(lookup.get(name) ?? [], prefer);
      if (hit.kind === 'one') {
        put(hit.tool);
        added.push(hit.tool);
      } else if (hit.kind === 'ambiguous') {
        warnings.push(
          `tools.${name} exists on several connectors (${hit.connectors}); ` +
            'choose the one you mean under Connectors & tools.',
        );
      } else {
        warnings.push(`tools.${name} is not a tool of any connector in this organization.`);
      }
    }
    if (detected.dynamic) {
      warnings.push(
        'The code picks a tool by a computed name (tools[...]). That cannot be detected: ' +
          'declare those tools under Connectors & tools, or the script cannot call them.',
      );
    }

    const all = [...rows.values()];
    if (all.length > SCRIPT_MAX_TOOLS) {
      throw new BadRequestException(`A script can use at most ${SCRIPT_MAX_TOOLS} tools`);
    }
    if (new Set(all.map((r) => r.connectorId)).size > SCRIPT_MAX_CONNECTORS) {
      throw new BadRequestException(`A script can use at most ${SCRIPT_MAX_CONNECTORS} connectors`);
    }
    return { rows: all, added, warnings };
  }

  /** Tools of the organization's connectors with these names, by name. */
  private async lookupTools(organizationId: string, names: string[]) {
    const byName = new Map<string, ToolCandidate[]>();
    const unique = [...new Set(names)];
    if (unique.length === 0) return byName;
    const tools = await this.prisma.mcpTool.findMany({
      where: { name: { in: unique }, connector: { organizationId } },
      select: { name: true, connectorId: true, connector: { select: { name: true } } },
    });
    for (const t of tools) {
      const list = byName.get(t.name) ?? [];
      list.push({ connectorId: t.connectorId, connectorName: t.connector.name, toolName: t.name });
      byName.set(t.name, list);
    }
    return byName;
  }

}

interface ResolvedUses {
  rows: ToolCandidate[];
  added: ToolCandidate[];
  warnings: string[];
}

type Pick =
  | { kind: 'unknown' }
  | { kind: 'one'; tool: ToolCandidate }
  | { kind: 'ambiguous'; connectors: string };

/**
 * The one tool a name means. Several connectors may have a tool of that name; the
 * one on a connector of the server the script is saved from wins, and if that
 * still leaves more than one, the name is ambiguous.
 */
function pick(candidates: ToolCandidate[], prefer: Set<string>): Pick {
  if (candidates.length === 0) return { kind: 'unknown' };
  if (candidates.length === 1) return { kind: 'one', tool: candidates[0] };
  const preferred = candidates.filter((c) => prefer.has(c.connectorId));
  if (preferred.length === 1) return { kind: 'one', tool: preferred[0] };
  return { kind: 'ambiguous', connectors: candidates.map((c) => c.connectorName).join(', ') };
}

/** A script with no recorded author is editable only by a caller with no identity either. */
function isAuthor(script: { createdById: string | null }, userId: string | undefined): boolean {
  return (script.createdById ?? null) === (userId ?? null);
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

function isRecordMissing(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2025';
}
