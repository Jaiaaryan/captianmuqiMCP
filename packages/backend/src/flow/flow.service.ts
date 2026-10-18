import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { readTransform } from '../connectors/response-transform.util';
import { deriveToolAnnotations } from '../mcp-server/tool-annotations';
import { missingConnectors } from '../sandbox/script-uses.util';
import { FLOW_EVENTS_MAX, FLOW_WINDOWS, type FlowWindow } from './flow.dto';

/* ------------------------------------------------------------------ */
/*  Contract. Mirrors packages/frontend/src/components/flow/types.ts   */
/* ------------------------------------------------------------------ */

export type FlowNodeKind =
  | 'agent'
  | 'server'
  | 'connector'
  | 'tool'
  | 'processing'
  | 'mapping'
  | 'script';

export type FlowEdgeKind =
  | 'mcp'
  | 'tool'
  | 'http'
  | 'processing'
  | 'mapping'
  | 'script-use'
  | 'script-call';

export interface FlowStats {
  calls: number;
  errors: number;
  bytesIn?: number;
  bytesOut?: number;
  avgMs?: number;
  lastAt?: string;
}

export interface FlowNode {
  id: string;
  kind: FlowNodeKind;
  label: string;
  ref?: { serverId?: string; connectorId?: string; toolId?: string; scriptId?: string };
  stats?: FlowStats;
  meta?: Record<string, string | number | boolean | null>;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  kind: FlowEdgeKind;
  stats?: FlowStats;
}

export interface FlowGraph {
  /** The server drawn, or null when the graph shows every server of the organization. */
  serverId: string | null;
  since: string;
  generatedAt: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export type FlowEventKind = 'tool' | 'script' | 'processing';
export type FlowEventStatus = 'ok' | 'error' | 'refused';

/** One call in the window, for the replay. No payloads, no messages. */
export interface FlowEvent {
  ts: string;
  kind: FlowEventKind;
  serverId: string;
  connectorId?: string;
  toolId?: string;
  scriptId?: string;
  status: FlowEventStatus;
  durationMs: number | null;
  /** Identical failures stored once (repeatCount), when more than one. */
  count?: number;
  /** Script runs: the tool names the run called. */
  tools?: string[];
}

export interface FlowEvents {
  from: string;
  until: string;
  /** More events than `limit` in the window: the most recent ones are kept. */
  truncated: boolean;
  events: FlowEvent[];
}

/** A failure of the window, for the Ask context. */
export interface FlowRecentError {
  at: Date;
  nodeId: string;
  message: string;
}

/* ------------------------------------------------------------------ */
/*  Limits                                                             */
/* ------------------------------------------------------------------ */

/** A server that offers more tools than this shows only the most-called ones. */
export const FLOW_MAX_TOOLS = 500;
/** Servers drawn when the graph shows the whole organization. */
export const FLOW_MAX_SERVERS = 100;
/** Saved scripts read per organization. */
const MAX_SCRIPTS = 500;
/** Most recent script runs of the window that are aggregated. */
const MAX_RUNS = 2000;

const WINDOW_MS: Record<FlowWindow, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

/** How AuditService.logRefusal prefixes the error of a refused call. */
const REFUSAL_PREFIX = 'REFUSED ';
/** How a fatal processing failure reaches the audit log (response-transform.util.ts). */
const PROCESSING_FAILED = 'Response processing failed';
/** Sandbox error codes that mean a call was refused, not that it failed. */
const REFUSAL_CODES = new Set(['TOOL_NOT_ALLOWED', 'WRITE_NOT_ALLOWED', 'ROLE_FORBIDDEN', 'CROSS_ORG']);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Running totals for one hop; turned into FlowStats at the end. */
interface Acc {
  calls: number;
  errors: number;
  bytesIn?: number;
  bytesOut?: number;
  /** Sum of (average ms x calls) and the calls it covers, for a weighted mean. */
  msTotal: number;
  msCalls: number;
  lastAt?: Date;
}

const newAcc = (): Acc => ({ calls: 0, errors: 0, msTotal: 0, msCalls: 0 });

function addAcc(into: Acc, from: Acc): void {
  into.calls += from.calls;
  into.errors += from.errors;
  into.msTotal += from.msTotal;
  into.msCalls += from.msCalls;
  if (from.bytesOut !== undefined) into.bytesOut = (into.bytesOut ?? 0) + from.bytesOut;
  if (from.bytesIn !== undefined) into.bytesIn = (into.bytesIn ?? 0) + from.bytesIn;
  if (from.lastAt && (!into.lastAt || from.lastAt > into.lastAt)) into.lastAt = from.lastAt;
}

function toStats(a: Acc, keep: (keyof FlowStats)[] = ['bytesIn', 'bytesOut', 'avgMs', 'lastAt']): FlowStats {
  const stats: FlowStats = { calls: a.calls, errors: a.errors };
  if (keep.includes('bytesIn') && a.bytesIn !== undefined) stats.bytesIn = a.bytesIn;
  if (keep.includes('bytesOut') && a.bytesOut !== undefined) stats.bytesOut = a.bytesOut;
  if (keep.includes('avgMs') && a.msCalls > 0) stats.avgMs = Math.round(a.msTotal / a.msCalls);
  if (keep.includes('lastAt') && a.lastAt) stats.lastAt = a.lastAt.toISOString();
  return stats;
}

/** Mode a tool's response mapping runs in, the way readTransform and the engine decide it. */
function mappingMode(responseMapping: unknown): 'off' | 'select' | 'jmespath' {
  const t = readTransform(responseMapping as Record<string, unknown>);
  if (!t) return 'off';
  if (t.mode === 'jmespath' || (t.mode === undefined && t.expression)) return 'jmespath';
  return 'select';
}

/** True when the tool has a `transform` object (even a disabled one) or a legacy `fields` list. */
function hasMappingKey(responseMapping: unknown): boolean {
  if (!isPlainObject(responseMapping)) return false;
  if (isPlainObject(responseMapping.transform)) return true;
  return Array.isArray(responseMapping.fields) && responseMapping.fields.length > 0;
}

@Injectable()
export class FlowService {
  private readonly logger = new Logger(FlowService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The data flow of one MCP server, or of every server of the organization
   * (`serverId` null): who calls it, what it offers, where each tool's request
   * goes, how the response is shaped, and which saved scripts sit on top.
   * Statistics cover the window ending now.
   *
   * One query per table; everything is aggregated here. Every query is bound
   * to the organization, and a named server must belong to it (404 otherwise).
   * With several servers, connectors, tools and scripts appear once; each
   * server gets its own `server → tool` edges with its own counts.
   */
  async buildGraph(organizationId: string, serverId: string | null, since: FlowWindow): Promise<FlowGraph> {
    const generatedAt = new Date();
    const from = new Date(generatedAt.getTime() - WINDOW_MS[since]);

    const servers = await this.findServers(organizationId, serverId);
    const serverIds = servers.map((s) => s.id);
    const connectorIds = [...new Set(servers.flatMap((s) => s.connectors.map((c) => c.connectorId)))];
    const connectorsOf = new Map(servers.map((s) => [s.id, new Set(s.connectors.map((c) => c.connectorId))]));
    const serverWhere = serverIds.length === 1 ? serverIds[0] : { in: serverIds };
    if (!serverIds.length) {
      return {
        serverId: null,
        since: from.toISOString(),
        generatedAt: generatedAt.toISOString(),
        nodes: [{ id: 'agent', kind: 'agent', label: 'Agent', stats: { calls: 0, errors: 0 } }],
        edges: [],
      };
    }

    const [connectors, tools, invocationGroups, byteRows, scripts] = await Promise.all([
      this.prisma.connector.findMany({
        where: { organizationId, id: { in: connectorIds } },
        select: { id: true, name: true, type: true, authType: true, config: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.mcpTool.findMany({
        where: { isEnabled: true, connectorId: { in: connectorIds }, connector: { organizationId } },
        select: {
          id: true,
          connectorId: true,
          name: true,
          endpointMapping: true,
          responseMapping: true,
          annotations: true,
        },
        orderBy: { name: 'asc' },
      }),
      this.prisma.toolInvocation.groupBy({
        by: ['mcpServerId', 'toolId', 'status'],
        where: { organizationId, mcpServerId: serverWhere, createdAt: { gte: from } },
        _count: { _all: true },
        _sum: { repeatCount: true },
        _avg: { durationMs: true },
        _max: { createdAt: true },
      }),
      this.readBytes(organizationId, serverIds, from),
      this.prisma.sandboxScript.findMany({
        where: { organizationId },
        select: {
          id: true,
          name: true,
          version: true,
          uses: { select: { connectorId: true, toolName: true } },
        },
        orderBy: { name: 'asc' },
        take: MAX_SCRIPTS,
      }),
    ]);

    // ---- per-tool and per-(server, tool) statistics ----------------------
    const toolAcc = new Map<string, Acc>();
    const hopAcc = new Map<string, Acc>(); // `${serverId}\u0000${toolId}`
    for (const g of invocationGroups as any[]) {
      const sid: string = g.mcpServerId ?? serverIds[0];
      const rows = g._count?._all ?? 0;
      // A failure that repeats within a minute is stored once with repeatCount.
      const calls = g._sum?.repeatCount ?? rows;
      const last: Date | undefined = g._max?.createdAt ?? undefined;
      for (const [map, key] of [
        [toolAcc, g.toolId],
        [hopAcc, `${sid}\u0000${g.toolId}`],
      ] as [Map<string, Acc>, string][]) {
        const acc = map.get(key) ?? newAcc();
        acc.calls += calls;
        if (g.status !== 'SUCCESS') acc.errors += calls;
        if (g._avg?.durationMs != null && rows > 0) {
          acc.msTotal += g._avg.durationMs * rows;
          acc.msCalls += rows;
        }
        if (last && (!acc.lastAt || last > acc.lastAt)) acc.lastAt = last;
        map.set(key, acc);
      }
    }
    for (const [toolId, bytes] of byteRows) {
      const acc = toolAcc.get(toolId);
      if (acc) acc.bytesOut = bytes;
    }

    // ---- truncation ----------------------------------------------------
    const callsOf = (id: string) => toolAcc.get(id)?.calls ?? 0;
    const truncated = tools.length > FLOW_MAX_TOOLS;
    const shownTools = truncated
      ? [...tools]
          .sort((a, b) => callsOf(b.id) - callsOf(a.id) || a.name.localeCompare(b.name))
          .slice(0, FLOW_MAX_TOOLS)
      : tools;
    const shownToolIds = new Set(shownTools.map((t) => t.id));
    const connectorById = new Map(connectors.map((c) => [c.id, c]));
    const orderedTools = [...shownTools].sort(
      (a, b) => callsOf(b.id) - callsOf(a.id) || a.name.localeCompare(b.name),
    );

    // ---- scripts: offered when some server has all their connectors ------
    const visibleScripts = scripts.filter((s) =>
      servers.some(
        (srv) =>
          missingConnectors(
            s.uses.map((u) => ({ connectorId: u.connectorId, connectorName: '' })),
            [...(connectorsOf.get(srv.id) ?? [])],
          ).length === 0,
      ),
    );
    const visibleScriptIds = visibleScripts.map((s) => s.id);
    const runs = visibleScriptIds.length
      ? await this.prisma.sandboxRun.findMany({
          where: {
            organizationId,
            mcpServerId: serverWhere,
            createdAt: { gte: from },
            scriptId: { in: visibleScriptIds },
          },
          select: { scriptId: true, ok: true, meta: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: MAX_RUNS,
        })
      : [];

    const nodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];

    // ---- totals ---------------------------------------------------------
    const agentAcc = newAcc();
    const serverAcc = new Map<string, Acc>();
    const connectorAcc = new Map<string, Acc>();
    const toolById = new Map(tools.map((t) => [t.id, t]));
    for (const [key, a] of hopAcc) {
      const [sid, toolId] = key.split('\u0000');
      if (!toolById.has(toolId)) continue;
      addAcc(agentAcc, a);
      const s = serverAcc.get(sid) ?? newAcc();
      addAcc(s, a);
      serverAcc.set(sid, s);
    }
    for (const t of tools) {
      const a = toolAcc.get(t.id);
      if (!a) continue;
      const c = connectorAcc.get(t.connectorId) ?? newAcc();
      addAcc(c, a);
      connectorAcc.set(t.connectorId, c);
    }
    // Bytes leave the server per tool; with one server they are the tool totals.
    if (servers.length === 1) {
      const only = serverAcc.get(servers[0].id) ?? newAcc();
      for (const t of tools) {
        const b = toolAcc.get(t.id)?.bytesOut;
        if (b !== undefined) only.bytesOut = (only.bytesOut ?? 0) + b;
      }
      serverAcc.set(servers[0].id, only);
    }

    nodes.push({
      id: 'agent',
      kind: 'agent',
      label: 'Agent',
      stats: toStats(agentAcc, ['avgMs', 'lastAt']),
    });
    for (const srv of servers) {
      const id = `server:${srv.id}`;
      const acc = serverAcc.get(srv.id) ?? newAcc();
      const meta: Record<string, string | number | boolean | null> = { connectors: srv.connectors.length };
      if (truncated) meta.truncated = true;
      nodes.push({ id, kind: 'server', label: srv.name, ref: { serverId: srv.id }, stats: toStats(acc), meta });
      edges.push({
        id: `mcp:agent>${id}`,
        source: 'agent',
        target: id,
        kind: 'mcp',
        stats: toStats(acc, ['avgMs', 'lastAt']),
      });
    }

    // ---- connectors -----------------------------------------------------
    const toolCountByConnector = new Map<string, number>();
    for (const t of tools) {
      toolCountByConnector.set(t.connectorId, (toolCountByConnector.get(t.connectorId) ?? 0) + 1);
    }
    for (const c of connectors) {
      nodes.push({
        id: `connector:${c.id}`,
        kind: 'connector',
        label: c.name,
        ref: { connectorId: c.id },
        stats: toStats(connectorAcc.get(c.id) ?? newAcc(), ['avgMs', 'lastAt']),
        meta: { authType: c.authType, tools: toolCountByConnector.get(c.id) ?? 0 },
      });
    }

    // ---- tools, processing, mapping -------------------------------------
    const processingNodes: FlowNode[] = [];
    const mappingNodes: FlowNode[] = [];
    const toolNodeId = (id: string) => `tool:${id}`;
    const single = servers.length === 1 ? servers[0].id : undefined;

    for (const t of orderedTools) {
      const connector = connectorById.get(t.connectorId);
      if (!connector) continue;
      const acc = toolAcc.get(t.id) ?? newAcc();
      const id = toolNodeId(t.id);
      const mapping = isPlainObject(t.endpointMapping) ? t.endpointMapping : undefined;
      const readOnly =
        deriveToolAnnotations({
          name: t.name,
          connectorType: connector.type,
          endpointMapping: mapping as { method?: string; path?: string } | undefined,
          connectorConfig: { config: isPlainObject(connector.config) ? connector.config : null },
          annotations: t.annotations,
        }).readOnlyHint === true;
      const meta: Record<string, string | number | boolean | null> = { readOnly };
      if (typeof mapping?.method === 'string') meta.method = mapping.method.toUpperCase();

      // What the audit log holds is the raw upstream response, before the
      // processing chain and the mapping run: that is the tool's output here.
      const ref: FlowNode['ref'] = { toolId: t.id, connectorId: t.connectorId };
      if (single) ref.serverId = single;
      nodes.push({ id, kind: 'tool', label: t.name, ref, stats: toStats(acc), meta });
      for (const srv of servers) {
        if (!connectorsOf.get(srv.id)?.has(t.connectorId)) continue;
        const sid = `server:${srv.id}`;
        edges.push({
          id: `tool:${sid}>${id}`,
          source: sid,
          target: id,
          kind: 'tool',
          stats: toStats(hopAcc.get(`${srv.id}\u0000${t.id}`) ?? newAcc(), ['avgMs', 'lastAt']),
        });
      }
      edges.push({
        id: `http:${id}>connector:${t.connectorId}`,
        source: id,
        target: `connector:${t.connectorId}`,
        kind: 'http',
        stats: toStats(acc, ['bytesOut', 'avgMs', 'lastAt']),
      });

      const rm = t.responseMapping;
      const chain = isPlainObject(rm) && isPlainObject(rm.responseProcessing) ? rm.responseProcessing : null;
      const rawBytes = acc.bytesOut;
      let previous = id;

      if (chain) {
        const steps = Array.isArray(chain.steps) ? chain.steps.length : 0;
        const pid = `processing:${t.id}`;
        const stats: FlowStats = { calls: acc.calls, errors: acc.errors };
        if (rawBytes !== undefined) stats.bytesIn = rawBytes;
        processingNodes.push({
          id: pid,
          kind: 'processing',
          label: `${t.name} processing`,
          ref: { toolId: t.id, connectorId: t.connectorId },
          stats,
          meta: {
            steps,
            enabled: chain.enabled !== false,
            valid: Array.isArray(chain.steps) && chain.version === 1,
          },
        });
        edges.push({
          id: `processing:${id}>${pid}`,
          source: id,
          target: pid,
          kind: 'processing',
          stats: toStats(acc, ['bytesOut', 'avgMs', 'lastAt']),
        });
        previous = pid;
      }

      if (hasMappingKey(rm)) {
        const mid = `mapping:${t.id}`;
        const stats: FlowStats = { calls: acc.calls, errors: acc.errors };
        // The raw response enters the mapping when no processing chain sits before it.
        if (!chain && rawBytes !== undefined) stats.bytesIn = rawBytes;
        mappingNodes.push({
          id: mid,
          kind: 'mapping',
          label: `${t.name} mapping`,
          ref: { toolId: t.id, connectorId: t.connectorId },
          stats,
          meta: { mode: mappingMode(rm) },
        });
        edges.push({
          id: `mapping:${previous}>${mid}`,
          source: previous,
          target: mid,
          kind: 'mapping',
          stats: { calls: acc.calls, errors: acc.errors },
        });
      }
    }
    nodes.push(...processingNodes, ...mappingNodes);

    // ---- scripts ----------------------------------------------------------
    const toolsByConnectorAndName = new Map<string, string>();
    const toolIdsByName = new Map<string, { id: string; connectorId: string }[]>();
    for (const t of tools) {
      toolsByConnectorAndName.set(`${t.connectorId}\u0000${t.name}`, t.id);
      const list = toolIdsByName.get(t.name) ?? [];
      list.push({ id: t.id, connectorId: t.connectorId });
      toolIdsByName.set(t.name, list);
    }

    const scriptAcc = new Map<string, Acc>();
    const calledBy = new Map<string, Map<string, Acc>>(); // scriptId -> toolId -> runs that called it
    const scriptBytes = new Map<string, { bytesIn: number; bytesOut: number }>();
    const declaredConnectors = new Map(
      visibleScripts.map((s) => [s.id, new Set(s.uses.map((u) => u.connectorId))]),
    );
    for (const r of runs) {
      if (!r.scriptId) continue;
      const meta = isPlainObject(r.meta) ? r.meta : {};
      const acc = scriptAcc.get(r.scriptId) ?? newAcc();
      acc.calls += 1;
      if (!r.ok) acc.errors += 1;
      if (typeof meta.ms === 'number') {
        acc.msTotal += meta.ms;
        acc.msCalls += 1;
      }
      if (!acc.lastAt || r.createdAt > acc.lastAt) acc.lastAt = r.createdAt;
      scriptAcc.set(r.scriptId, acc);

      const bytes = scriptBytes.get(r.scriptId) ?? { bytesIn: 0, bytesOut: 0 };
      if (typeof meta.bytesFromConnectors === 'number') bytes.bytesIn += meta.bytesFromConnectors;
      if (typeof meta.bytesReturned === 'number') bytes.bytesOut += meta.bytesReturned;
      scriptBytes.set(r.scriptId, bytes);

      // toolsCalled lists each tool name once per run: the edge counts runs
      // that called the tool, not individual calls.
      const called = Array.isArray(meta.toolsCalled) ? meta.toolsCalled : [];
      for (const name of called) {
        if (typeof name !== 'string') continue;
        const candidates = toolIdsByName.get(name) ?? [];
        const own = declaredConnectors.get(r.scriptId);
        const hit = candidates.find((c) => own?.has(c.connectorId)) ?? candidates[0];
        if (!hit) continue;
        const perTool = calledBy.get(r.scriptId) ?? new Map<string, Acc>();
        const edgeAcc = perTool.get(hit.id) ?? newAcc();
        edgeAcc.calls += 1;
        if (!edgeAcc.lastAt || r.createdAt > edgeAcc.lastAt) edgeAcc.lastAt = r.createdAt;
        perTool.set(hit.id, edgeAcc);
        calledBy.set(r.scriptId, perTool);
      }
    }

    for (const s of visibleScripts) {
      const id = `script:${s.id}`;
      const acc = scriptAcc.get(s.id) ?? newAcc();
      const stats = toStats(acc, ['avgMs', 'lastAt']);
      const bytes = scriptBytes.get(s.id);
      if (bytes && acc.calls > 0) {
        stats.bytesIn = bytes.bytesIn;
        stats.bytesOut = bytes.bytesOut;
      }
      nodes.push({
        id,
        kind: 'script',
        label: s.name,
        ref: { scriptId: s.id },
        stats,
        meta: { version: s.version, tools: s.uses.length },
      });

      const seen = new Set<string>();
      for (const u of s.uses) {
        const toolId = toolsByConnectorAndName.get(`${u.connectorId}\u0000${u.toolName}`);
        if (!toolId || !shownToolIds.has(toolId) || seen.has(toolId)) continue;
        seen.add(toolId);
        edges.push({
          id: `script-use:${id}>${toolNodeId(toolId)}`,
          source: id,
          target: toolNodeId(toolId),
          kind: 'script-use',
        });
      }
      for (const [toolId, edgeAcc] of calledBy.get(s.id) ?? []) {
        if (!shownToolIds.has(toolId)) continue;
        edges.push({
          id: `script-call:${id}>${toolNodeId(toolId)}`,
          source: id,
          target: toolNodeId(toolId),
          kind: 'script-call',
          stats: toStats(edgeAcc, ['lastAt']),
        });
      }
    }

    return {
      serverId: serverId ? servers[0].id : null,
      since: from.toISOString(),
      generatedAt: generatedAt.toISOString(),
      nodes,
      edges,
    };
  }

  /**
   * The individual calls of the window, oldest first, for the replay: tool
   * invocations (refusals included) and saved-script runs. Times, ids, status
   * and duration only; the error text is read to classify a row and never
   * returned. When the window holds more than `limit`, the most recent are kept.
   */
  async listEvents(
    organizationId: string,
    serverId: string | null,
    since: string = '24h',
    until?: string,
    limit: number = FLOW_EVENTS_MAX,
  ): Promise<FlowEvents> {
    const now = new Date();
    let end = until ? new Date(until) : now;
    if (Number.isNaN(end.getTime()) || end > now) end = now;
    let start =
      (FLOW_WINDOWS as readonly string[]).includes(since)
        ? new Date(end.getTime() - WINDOW_MS[since as FlowWindow])
        : new Date(since);
    if (Number.isNaN(start.getTime())) throw new BadRequestException('since is not a time');
    const earliest = new Date(end.getTime() - WINDOW_MS['7d']);
    if (start < earliest) start = earliest;
    if (start > end) throw new BadRequestException('since is after until');
    const take = Math.max(1, Math.min(FLOW_EVENTS_MAX, Math.floor(limit))) + 1;

    const servers = await this.findServers(organizationId, serverId);
    const serverIds = servers.map((s) => s.id);
    const empty: FlowEvents = { from: start.toISOString(), until: end.toISOString(), truncated: false, events: [] };
    if (!serverIds.length) return empty;
    const serverWhere = serverIds.length === 1 ? serverIds[0] : { in: serverIds };
    const range = { gte: start, lte: end };

    const [invocations, runs] = await Promise.all([
      this.prisma.toolInvocation.findMany({
        where: { organizationId, mcpServerId: serverWhere, createdAt: range },
        select: {
          createdAt: true,
          mcpServerId: true,
          toolId: true,
          connectorId: true,
          status: true,
          durationMs: true,
          repeatCount: true,
          error: true,
          tool: { select: { connectorId: true } },
        },
        orderBy: { createdAt: 'desc' },
        take,
      }),
      this.prisma.sandboxRun.findMany({
        where: { organizationId, mcpServerId: serverWhere, createdAt: range },
        select: { createdAt: true, mcpServerId: true, scriptId: true, ok: true, errorCode: true, meta: true },
        orderBy: { createdAt: 'desc' },
        take,
      }),
    ]);

    const events: (FlowEvent & { at: number })[] = [];
    for (const r of invocations) {
      const error = typeof r.error === 'string' ? r.error : '';
      const refused = error.startsWith(REFUSAL_PREFIX);
      const status: FlowEventStatus = r.status === 'SUCCESS' ? 'ok' : refused ? 'refused' : 'error';
      const e: FlowEvent & { at: number } = {
        at: r.createdAt.getTime(),
        ts: r.createdAt.toISOString(),
        kind: status === 'error' && error.startsWith(PROCESSING_FAILED) ? 'processing' : 'tool',
        serverId: r.mcpServerId ?? serverIds[0],
        toolId: r.toolId,
        status,
        durationMs: r.durationMs ?? null,
      };
      const connectorId = r.connectorId ?? r.tool?.connectorId;
      if (connectorId) e.connectorId = connectorId;
      if ((r.repeatCount ?? 1) > 1) e.count = r.repeatCount;
      events.push(e);
    }
    for (const r of runs) {
      const meta = isPlainObject(r.meta) ? r.meta : {};
      const e: FlowEvent & { at: number } = {
        at: r.createdAt.getTime(),
        ts: r.createdAt.toISOString(),
        kind: 'script',
        serverId: r.mcpServerId,
        status: r.ok ? 'ok' : REFUSAL_CODES.has(r.errorCode ?? '') ? 'refused' : 'error',
        durationMs: typeof meta.ms === 'number' ? Math.round(meta.ms) : null,
      };
      if (r.scriptId) e.scriptId = r.scriptId;
      const called = Array.isArray(meta.toolsCalled)
        ? meta.toolsCalled.filter((n): n is string => typeof n === 'string').slice(0, 20)
        : [];
      if (called.length) e.tools = called;
      events.push(e);
    }

    events.sort((a, b) => b.at - a.at);
    const max = take - 1;
    const kept = events.slice(0, max).reverse();
    return {
      ...empty,
      truncated: events.length > max,
      events: kept.map(({ at: _at, ...e }) => e),
    };
  }

  /**
   * The latest failures of the window (tool calls and script runs), newest
   * first, each pointing at the node it belongs to. For the Ask context.
   */
  async recentErrors(
    organizationId: string,
    serverId: string | null,
    since: FlowWindow,
    n = 10,
  ): Promise<FlowRecentError[]> {
    const from = new Date(Date.now() - WINDOW_MS[since]);
    const servers = await this.findServers(organizationId, serverId);
    const serverIds = servers.map((s) => s.id);
    if (!serverIds.length) return [];
    const serverWhere = serverIds.length === 1 ? serverIds[0] : { in: serverIds };
    const [calls, runs] = await Promise.all([
      this.prisma.toolInvocation.findMany({
        where: { organizationId, mcpServerId: serverWhere, createdAt: { gte: from }, status: { not: 'SUCCESS' } },
        select: { createdAt: true, toolId: true, error: true },
        orderBy: { createdAt: 'desc' },
        take: n,
      }),
      this.prisma.sandboxRun.findMany({
        where: { organizationId, mcpServerId: serverWhere, createdAt: { gte: from }, ok: false },
        select: { createdAt: true, scriptId: true, errorCode: true, errorMessage: true },
        orderBy: { createdAt: 'desc' },
        take: n,
      }),
    ]);
    const out: FlowRecentError[] = [
      ...calls.map((c) => ({ at: c.createdAt, nodeId: `tool:${c.toolId}`, message: c.error ?? 'error' })),
      ...runs
        .filter((r) => r.scriptId)
        .map((r) => ({
          at: r.createdAt,
          nodeId: `script:${r.scriptId}`,
          message: [r.errorCode, r.errorMessage].filter(Boolean).join(': ') || 'error',
        })),
    ];
    return out.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, n);
  }

  /** The named server of the organization (404 otherwise), or all of them. */
  private async findServers(organizationId: string, serverId: string | null) {
    const select = { id: true, name: true, connectors: { select: { connectorId: true } } } as const;
    if (serverId) {
      const server = await this.prisma.mcpServerConfig.findFirst({
        where: { id: serverId, organizationId },
        select,
      });
      if (!server) throw new NotFoundException('MCP server not found');
      return [server];
    }
    return this.prisma.mcpServerConfig.findMany({
      where: { organizationId },
      select,
      orderBy: { name: 'asc' },
      take: FLOW_MAX_SERVERS,
    });
  }
  /**
   * Size of what each tool returned, per tool, in one aggregate query. The log
   * keeps a bounded excerpt of the output and records the original size in
   * `_amcp_truncated.originalBytes` when it cut it, so the sum uses that and
   * falls back to the stored size. A failure here only drops the byte counts.
   */
  private async readBytes(
    organizationId: string,
    serverIds: string[],
    from: Date,
  ): Promise<Map<string, number>> {
    try {
      const rows = await this.prisma.$queryRaw<{ tool_id: string; bytes: bigint | number | string | null }[]>`
        SELECT tool_id,
               SUM(COALESCE((output -> '_amcp_truncated' ->> 'originalBytes')::bigint,
                            octet_length(output::text)))::bigint AS bytes
        FROM tool_invocations
        WHERE organization_id = ${organizationId}
          AND mcp_server_id = ANY(${serverIds}::text[])
          AND created_at >= ${from}
          AND status = 'SUCCESS'
          AND output IS NOT NULL
        GROUP BY tool_id`;
      return new Map(rows.map((r) => [r.tool_id, Number(r.bytes ?? 0)]));
    } catch (err) {
      this.logger.warn(`Flow byte totals unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return new Map();
    }
  }
}
