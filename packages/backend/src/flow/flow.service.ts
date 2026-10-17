import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { readTransform } from '../connectors/response-transform.util';
import { deriveToolAnnotations } from '../mcp-server/tool-annotations';
import { missingConnectors } from '../sandbox/script-uses.util';
import type { FlowWindow } from './flow.dto';

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
  serverId: string;
  since: string;
  generatedAt: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

/* ------------------------------------------------------------------ */
/*  Limits                                                             */
/* ------------------------------------------------------------------ */

/** A server that offers more tools than this shows only the most-called ones. */
export const FLOW_MAX_TOOLS = 500;
/** Saved scripts read per organization. */
const MAX_SCRIPTS = 500;
/** Most recent script runs of the window that are aggregated. */
const MAX_RUNS = 2000;

const WINDOW_MS: Record<FlowWindow, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

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
   * The data flow of one MCP server: who calls it, what it offers, where each
   * tool's request goes, how the response is shaped, and which saved scripts
   * sit on top. Statistics cover the window ending now.
   *
   * One query per table; everything is aggregated here. Every query is bound
   * to the organization, and the server must belong to it (404 otherwise).
   */
  async buildGraph(organizationId: string, serverId: string, since: FlowWindow): Promise<FlowGraph> {
    const generatedAt = new Date();
    const from = new Date(generatedAt.getTime() - WINDOW_MS[since]);

    const server = await this.prisma.mcpServerConfig.findFirst({
      where: { id: serverId, organizationId },
      select: { id: true, name: true, connectors: { select: { connectorId: true } } },
    });
    if (!server) throw new NotFoundException('MCP server not found');

    const connectorIds = server.connectors.map((c) => c.connectorId);
    const serverNodeId = `server:${server.id}`;

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
        by: ['toolId', 'status'],
        where: { organizationId, mcpServerId: server.id, createdAt: { gte: from } },
        _count: { _all: true },
        _sum: { repeatCount: true },
        _avg: { durationMs: true },
        _max: { createdAt: true },
      }),
      this.readBytes(organizationId, server.id, from),
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

    // ---- per-tool statistics ------------------------------------------
    const toolAcc = new Map<string, Acc>();
    for (const g of invocationGroups) {
      const acc = toolAcc.get(g.toolId) ?? newAcc();
      const rows = g._count?._all ?? 0;
      // A failure that repeats within a minute is stored once with repeatCount.
      const calls = g._sum?.repeatCount ?? rows;
      acc.calls += calls;
      if (g.status !== 'SUCCESS') acc.errors += calls;
      if (g._avg?.durationMs != null && rows > 0) {
        acc.msTotal += g._avg.durationMs * rows;
        acc.msCalls += rows;
      }
      const last = g._max?.createdAt;
      if (last && (!acc.lastAt || last > acc.lastAt)) acc.lastAt = last;
      toolAcc.set(g.toolId, acc);
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

    // ---- scripts: offered here only when the server has all their connectors
    const visibleScripts = scripts.filter(
      (s) =>
        missingConnectors(
          s.uses.map((u) => ({ connectorId: u.connectorId, connectorName: '' })),
          connectorIds,
        ).length === 0,
    );
    const visibleScriptIds = visibleScripts.map((s) => s.id);
    const runs = visibleScriptIds.length
      ? await this.prisma.sandboxRun.findMany({
          where: {
            organizationId,
            mcpServerId: server.id,
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
    const serverAcc = newAcc();
    const connectorAcc = new Map<string, Acc>();
    for (const t of tools) {
      const a = toolAcc.get(t.id);
      if (!a) continue;
      addAcc(serverAcc, a);
      const c = connectorAcc.get(t.connectorId) ?? newAcc();
      addAcc(c, a);
      connectorAcc.set(t.connectorId, c);
    }

    nodes.push({
      id: 'agent',
      kind: 'agent',
      label: 'Agent',
      stats: toStats(serverAcc, ['avgMs', 'lastAt']),
    });
    const serverMeta: Record<string, string | number | boolean | null> = {
      connectors: connectors.length,
    };
    if (truncated) serverMeta.truncated = true;
    nodes.push({
      id: serverNodeId,
      kind: 'server',
      label: server.name,
      ref: { serverId: server.id },
      stats: toStats(serverAcc),
      meta: serverMeta,
    });
    edges.push({
      id: `mcp:agent>${serverNodeId}`,
      source: 'agent',
      target: serverNodeId,
      kind: 'mcp',
      stats: toStats(serverAcc, ['avgMs', 'lastAt']),
    });

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
      nodes.push({
        id,
        kind: 'tool',
        label: t.name,
        ref: { toolId: t.id, connectorId: t.connectorId, serverId: server.id },
        stats: toStats(acc),
        meta,
      });
      edges.push({
        id: `tool:${serverNodeId}>${id}`,
        source: serverNodeId,
        target: id,
        kind: 'tool',
        stats: toStats(acc, ['avgMs', 'lastAt']),
      });
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
          ref: { toolId: t.id },
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
          ref: { toolId: t.id },
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
      serverId: server.id,
      since: from.toISOString(),
      generatedAt: generatedAt.toISOString(),
      nodes,
      edges,
    };
  }

  /**
   * Size of what each tool returned, per tool, in one aggregate query. The log
   * keeps a bounded excerpt of the output and records the original size in
   * `_amcp_truncated.originalBytes` when it cut it, so the sum uses that and
   * falls back to the stored size. A failure here only drops the byte counts.
   */
  private async readBytes(
    organizationId: string,
    serverId: string,
    from: Date,
  ): Promise<Map<string, number>> {
    try {
      const rows = await this.prisma.$queryRaw<{ tool_id: string; bytes: bigint | number | string | null }[]>`
        SELECT tool_id,
               SUM(COALESCE((output -> '_amcp_truncated' ->> 'originalBytes')::bigint,
                            octet_length(output::text)))::bigint AS bytes
        FROM tool_invocations
        WHERE organization_id = ${organizationId}
          AND mcp_server_id = ${serverId}
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
