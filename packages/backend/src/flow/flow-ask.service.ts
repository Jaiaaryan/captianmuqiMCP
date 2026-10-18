import { BadGatewayException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { KgLlmService } from '../knowledge-graph/kg-llm.service';
import { chatText, resolveLlmConfig } from '../knowledge-graph/llm-client';
import { redactPii } from '../knowledge-graph/redact';
import type { FlowAskDto, FlowWindow } from './flow.dto';
import { FlowService, type FlowEdge, type FlowGraph, type FlowNode, type FlowRecentError } from './flow.service';

/** Bytes of the trimmed graph sent with a question. */
export const ASK_GRAPH_BYTES = 8 * 1024;
/** Bytes of the selected node's details. */
const ASK_NODE_BYTES = 2 * 1024;
/** Characters kept of one error message. */
const ASK_ERROR_CHARS = 240;
/** Output ceiling: 120 words is about 180 tokens; room for other scripts. */
const ASK_MAX_TOKENS = 400;

export const ASK_SYSTEM_PROMPT = [
  'You answer questions about the data flow of an AnythingMCP workspace: an agent calls MCP servers,',
  'servers offer tools, tools call connectors (external APIs), responses may pass through response',
  'processing and a mapping, and saved scripts call tools.',
  'The user message holds the question and a JSON context: the graph of the chosen window',
  '(nodes as [id, kind, label, calls, errors], edges as [source, target, kind, calls, errors]),',
  'the selected node, and the latest errors with their age.',
  'Rules: answer in the language of the question; at most 120 words; plain sentences, no lists,',
  'no markdown; name node ids or labels and paths when you refer to them; use only the context and',
  'never invent data; when the context does not hold the answer, say what is missing.',
].join(' ');

export interface FlowAskAnswer {
  answer: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

function age(at: Date, now: number): string {
  const s = Math.max(0, Math.round((now - at.getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');

/**
 * What a question is sent with: the graph trimmed to ids, kinds, labels and
 * counts (at most ASK_GRAPH_BYTES; the selected node, its neighbours and the
 * nodes with errors or calls first), the selected node's details, and the
 * latest errors. Pure; redaction happens in the caller.
 */
export function buildAskContext(
  graph: FlowGraph,
  window: FlowWindow,
  nodeId: string | undefined,
  errors: FlowRecentError[],
  now: number = Date.now(),
): string {
  const selected = nodeId ? graph.nodes.find((n) => n.id === nodeId) : undefined;
  const near = new Set<string>();
  if (selected) {
    near.add(selected.id);
    for (const e of graph.edges) {
      if (e.source === selected.id) near.add(e.target);
      if (e.target === selected.id) near.add(e.source);
    }
  }
  // The selected node, then its neighbours, then by errors and calls.
  const group = (n: FlowNode) => (n.id === selected?.id ? 0 : near.has(n.id) ? 1 : 2);
  const ordered = [...graph.nodes].sort(
    (a, b) =>
      group(a) - group(b) ||
      (b.stats?.errors ?? 0) - (a.stats?.errors ?? 0) ||
      (b.stats?.calls ?? 0) - (a.stats?.calls ?? 0) ||
      a.id.localeCompare(b.id),
  );

  const nodes: (string | number)[][] = [];
  const kept = new Set<string>();
  const edges: (string | number)[][] = [];
  const base = { window, server: graph.serverId ?? 'all', omittedNodes: 0, omittedEdges: 0 };
  let used = size({ ...base, nodes, edges });
  for (const n of ordered) {
    const row = [n.id, n.kind, n.label.slice(0, 80), n.stats?.calls ?? 0, n.stats?.errors ?? 0];
    const cost = size(row) + 1;
    // Leave about a quarter of the budget for edges.
    if (used + cost > ASK_GRAPH_BYTES * 0.75) break;
    nodes.push(row);
    kept.add(n.id);
    used += cost;
  }
  const byCalls = [...graph.edges]
    .filter((e) => kept.has(e.source) && kept.has(e.target))
    .sort((a, b) => (b.stats?.errors ?? 0) - (a.stats?.errors ?? 0) || (b.stats?.calls ?? 0) - (a.stats?.calls ?? 0));
  for (const e of byCalls) {
    const row = [e.source, e.target, e.kind, e.stats?.calls ?? 0, e.stats?.errors ?? 0];
    const cost = size(row) + 1;
    if (used + cost > ASK_GRAPH_BYTES) break;
    edges.push(row);
    used += cost;
  }
  const trimmed = {
    ...base,
    omittedNodes: graph.nodes.length - nodes.length,
    omittedEdges: graph.edges.length - edges.length,
    nodes,
    edges,
  };

  let node: Record<string, unknown> | null = null;
  if (selected) {
    const link = (e: FlowEdge) => [e.source, e.target, e.kind, e.stats?.calls ?? 0, e.stats?.errors ?? 0];
    node = {
      id: selected.id,
      kind: selected.kind,
      label: selected.label,
      calls: selected.stats?.calls ?? 0,
      errors: selected.stats?.errors ?? 0,
      avgMs: selected.stats?.avgMs,
      lastCall: selected.stats?.lastAt ? age(new Date(selected.stats.lastAt), now) : undefined,
      meta: selected.meta ?? {},
      edges: [] as unknown[],
    };
    for (const e of graph.edges) {
      if (e.source !== selected.id && e.target !== selected.id) continue;
      if (size(node) + size(link(e)) > ASK_NODE_BYTES) break;
      (node.edges as unknown[]).push(link(e));
    }
  }

  const labels = new Map(graph.nodes.map((n) => [n.id, n.label]));
  const recentErrors = errors.slice(0, 10).map((e) => ({
    age: age(e.at, now),
    node: e.nodeId,
    label: labels.get(e.nodeId),
    message: e.message.replace(/\s+/g, ' ').slice(0, ASK_ERROR_CHARS),
  }));

  return JSON.stringify({ graph: trimmed, selected: node, recentErrors });
}

/**
 * The Ask bar: one question about the flow graph, answered by the workspace's
 * LLM (the Knowledge Graph's provider settings). Off unless the Knowledge
 * Graph's AI switch is on for the workspace and a provider is configured.
 * The question and the answer are never logged.
 */
@Injectable()
export class FlowAskService {
  private readonly logger = new Logger(FlowAskService.name);

  constructor(
    private readonly flow: FlowService,
    private readonly kgLlm: KgLlmService,
  ) {}

  async status(organizationId: string): Promise<{ enabled: boolean; model?: string }> {
    const cfg = resolveLlmConfig();
    if (!cfg || !(await this.kgLlm.isEnabled(organizationId))) return { enabled: false };
    return { enabled: true, model: cfg.model };
  }

  async ask(organizationId: string, dto: FlowAskDto): Promise<FlowAskAnswer> {
    const cfg = resolveLlmConfig();
    if (!cfg || !(await this.kgLlm.isEnabled(organizationId))) {
      throw new ConflictException({ statusCode: 409, code: 'LLM_OFF', message: 'LLM off' });
    }
    const window = dto.window ?? '24h';
    const serverId = dto.serverId ?? null;
    const [graph, errors] = await Promise.all([
      this.flow.buildGraph(organizationId, serverId, window),
      this.flow.recentErrors(organizationId, serverId, window, 10),
    ]);
    const context = redactPii(buildAskContext(graph, window, dto.nodeId, errors));
    const question = redactPii(dto.question);
    const user = `Question: ${question}\n\nContext: ${context}`;

    try {
      const { text, usage } = await chatText(cfg, ASK_SYSTEM_PROMPT, user, ASK_MAX_TOKENS);
      return { answer: text, model: cfg.model, ...(usage ? { usage } : {}) };
    } catch (err) {
      // Status only: a provider's error body may echo the prompt.
      const status = err instanceof Error ? (/^LLM (\d{3}|empty reply)/.exec(err.message)?.[0] ?? 'LLM error') : 'LLM error';
      this.logger.warn(`Flow ask failed (${cfg.provider}/${cfg.model}): ${status}`);
      throw new BadGatewayException({ statusCode: 502, code: 'LLM_ERROR', message: status });
    }
  }
}
