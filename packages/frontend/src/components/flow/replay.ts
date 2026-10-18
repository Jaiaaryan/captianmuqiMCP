// Replay of the window's events on the graph: which nodes and edges one event
// touched, the counts as of a position, and the pause before the next event.
// Pure; no React.
import type { FlowEvent, FlowGraph, ReplayCounts } from './types';

/** Longest pause between two replayed events at 1x, whatever the real gap. */
export const MAX_GAP_MS = 2000;
/** Shortest pause, so a burst of calls still reads as separate pulses. */
const MIN_GAP_MS = 40;

export const SPEEDS = [1, 4, 16] as const;
export type Speed = (typeof SPEEDS)[number];

export interface EventPath {
  nodes: string[];
  edges: string[];
}

/** What an event touches, looked up in a graph once. */
export interface ReplayIndex {
  path: (e: FlowEvent) => EventPath;
}

export function replayIndex(graph: FlowGraph): ReplayIndex {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const edgeIds = new Set(graph.edges.map((e) => e.id));
  const labelOf = new Map(graph.nodes.map((n) => [n.id, n.label]));
  const callEdges = new Map<string, { id: string; target: string }[]>();
  for (const e of graph.edges) {
    if (e.kind !== 'script-call' && e.kind !== 'script-use') continue;
    const list = callEdges.get(e.source) ?? [];
    list.push({ id: e.id, target: e.target });
    callEdges.set(e.source, list);
  }
  const mappingEdge = (toolNode: string, toolId: string): string | null => {
    const fromProcessing = `mapping:processing:${toolId}>mapping:${toolId}`;
    if (edgeIds.has(fromProcessing)) return fromProcessing;
    const fromTool = `mapping:${toolNode}>mapping:${toolId}`;
    return edgeIds.has(fromTool) ? fromTool : null;
  };

  return {
    path(e) {
      const nodes: string[] = [];
      const edges: string[] = [];
      const add = (list: string[], set: Set<string>, id: string | null) => {
        if (id && set.has(id) && !list.includes(id)) list.push(id);
      };
      if (e.kind === 'script') {
        if (!e.scriptId) return { nodes, edges };
        const script = `script:${e.scriptId}`;
        add(nodes, nodeIds, script);
        const called = new Set(e.tools ?? []);
        const seen = new Set<string>();
        for (const c of callEdges.get(script) ?? []) {
          if (!called.has(labelOf.get(c.target) ?? '') || seen.has(c.target)) continue;
          // Prefer the observed call edge; the declared one stands in when there is none.
          const observed = `script-call:${script}>${c.target}`;
          add(edges, edgeIds, edgeIds.has(observed) ? observed : c.id);
          seen.add(c.target);
        }
        return { nodes, edges };
      }
      if (!e.toolId) return { nodes, edges };
      const server = `server:${e.serverId}`;
      const tool = `tool:${e.toolId}`;
      add(nodes, nodeIds, 'agent');
      add(nodes, nodeIds, server);
      add(nodes, nodeIds, tool);
      add(edges, edgeIds, `mcp:agent>${server}`);
      add(edges, edgeIds, `tool:${server}>${tool}`);
      if (e.connectorId) {
        add(nodes, nodeIds, `connector:${e.connectorId}`);
        add(edges, edgeIds, `http:${tool}>connector:${e.connectorId}`);
      }
      // A refused call never left the gateway: it stops at the tool.
      if (e.status === 'refused') return { nodes, edges };
      const processing = `processing:${e.toolId}`;
      add(nodes, nodeIds, processing);
      add(edges, edgeIds, `processing:${tool}>${processing}`);
      // A processing failure ends the call before the mapping.
      if (e.kind === 'processing') return { nodes, edges };
      add(nodes, nodeIds, `mapping:${e.toolId}`);
      add(edges, edgeIds, mappingEdge(tool, e.toolId));
      return { nodes, edges };
    },
  };
}

/** Calls and errors of every node and edge after the first `position` events. */
export function countsAt(events: FlowEvent[], index: ReplayIndex, position: number): ReplayCounts {
  const counts: ReplayCounts = new Map();
  const end = Math.max(0, Math.min(events.length, position));
  for (let i = 0; i < end; i += 1) {
    const e = events[i];
    const n = e.count ?? 1;
    const failed = e.status !== 'ok';
    const { nodes, edges } = index.path(e);
    for (const id of [...nodes, ...edges]) {
      const c = counts.get(id) ?? { calls: 0, errors: 0 };
      c.calls += n;
      if (failed) c.errors += n;
      counts.set(id, c);
    }
  }
  return counts;
}

/** The pause before event `i` (its real gap to the previous one, compressed). */
export function gapBefore(events: FlowEvent[], i: number, speed: Speed): number {
  if (i <= 0 || i >= events.length) return MIN_GAP_MS;
  const real = Date.parse(events[i].ts) - Date.parse(events[i - 1].ts);
  const gap = Math.min(MAX_GAP_MS, Math.max(0, Number.isFinite(real) ? real : 0)) / speed;
  return Math.max(MIN_GAP_MS, gap);
}

/** `14:05:09`, in local time. */
export function clockTime(iso: string | undefined): string {
  if (!iso) return '--:--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
