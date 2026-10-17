import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { boundPayload } from '../audit/bound-payload';
import { PrismaService } from '../common/prisma.service';
import { Prisma } from '../generated/prisma/client';
import {
  SCRIPT_MAX_CONNECTORS,
  SCRIPT_MAX_TOOLS,
  SCRIPT_NAME_MESSAGE,
  SCRIPT_NAME_PATTERN,
} from './sandbox-scripts.dto';
import { groupUses, type DeclaredUse, type ScriptUse } from './script-uses.util';
import { findToolReferences } from './tool-references.util';
import type { SandboxRunResult } from './types';

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

/** A script as returned by this service: its uses grouped by connector, with current names. */
type WithUses<T extends { uses: DeclaredUse[] }> = Omit<T, 'uses'> & { uses: ScriptUse[] };

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
 * Saved sandbox scripts and their run history. Scripts belong to the organization
 * and declare the connectors and tools they use; every query is filtered by
 * organizationId so a caller can only ever reach their own workspace's rows.
 */
@Injectable()
export class SandboxScriptsService {
  private readonly logger = new Logger(SandboxScriptsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(organizationId: string, opts: { includeCode?: boolean } = {}) {
    const rows = await this.prisma.sandboxScript.findMany({
      where: { organizationId },
      orderBy: { name: 'asc' },
      select: { ...SUMMARY_SELECT, code: opts.includeCode === true },
    });
    return this.present(organizationId, rows);
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
    input: { name: string; code: string; description?: string; uses?: UsesInput['connectors']; toolNames?: string[] },
    ctx: SaveContext = {},
  ) {
    if (!SCRIPT_NAME_PATTERN.test(input.name)) {
      throw new BadRequestException(SCRIPT_NAME_MESSAGE);
    }
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
          uses: { create: resolved.rows.map((r) => ({ organizationId, ...r })) },
        },
        include: { uses: USES_INCLUDE },
      });
      return this.outcome(organizationId, created, resolved);
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
    },
    ctx: SaveContext = {},
  ) {
    const declaresUses = patch.uses !== undefined || patch.toolNames !== undefined;
    if (patch.code === undefined && patch.description === undefined && !declaresUses) {
      throw new BadRequestException('Provide code, description and/or the tools the script uses');
    }
    const current = await this.prisma.sandboxScript.findFirst({
      where: { id, organizationId },
      include: { uses: USES_INCLUDE },
    });
    if (!current) throw new NotFoundException('Script not found');

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
          ...(reresolve && {
            uses: {
              deleteMany: {},
              create: resolved.rows.map((r) => ({ organizationId, ...r })),
            },
          }),
        },
        include: { uses: USES_INCLUDE },
      });
      return this.outcome(organizationId, updated, resolved);
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
    patch: { code?: string; description?: string; toolNames?: string[] },
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

  /** `updateByName` for the dashboard API: same author-only rule, addressed by id. */
  async updateByIdAsAuthor(
    organizationId: string,
    id: string,
    patch: { code?: string; description?: string; uses?: UsesInput['connectors'] },
    editorUserId: string | undefined,
    ctx: SaveContext = {},
  ) {
    const script = await this.get(organizationId, id);
    if (!isAuthor(script, editorUserId)) {
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
  private async present<T extends { uses: DeclaredUse[] }>(
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
    return rows.map((r) => ({ ...r, uses: groupUses(r.uses, current) }));
  }

  private async outcome<T extends { uses: DeclaredUse[] }>(
    organizationId: string,
    saved: T,
    resolved: ResolvedUses,
  ): Promise<SaveOutcome<WithUses<T>>> {
    const [script] = await this.present(organizationId, [saved]);
    return {
      script,
      added: resolved.added.map((a) => `${a.connectorName} / ${a.toolName}`),
      warnings: resolved.warnings,
    };
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
