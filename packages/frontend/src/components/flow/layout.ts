import dagre from '@dagrejs/dagre';
import type { FlowEdge, FlowGraph, FlowNode, FlowNodeKind } from './types';

export type NodeSizes = Record<FlowNodeKind, { width: number; height: number }>;

/** What the layout needs of a graph: ids, kinds and links, nothing to render. */
export interface LayoutInput {
  nodes: Pick<FlowNode, 'id' | 'kind'>[];
  edges: Pick<FlowEdge, 'id' | 'source' | 'target'>[];
}

/** Top-left corner of every node, by id. */
export type Positions = Record<string, { x: number; y: number }>;

const RANK_SEP = 80;
const NODE_SEP = 24;
// The server and the scripts fan out into the tool column: a wider gap gives
// their edges room to spread and their labels room to sit apart.
const GAP_BEFORE: Partial<Record<number, number>> = { 2: 200 };

// Left-to-right order of the Build layer. Scripts share the server's column,
// stacked under it: they call tools the way the server offers them, so their
// edges run rightwards into the tool column like the server's.
const COLUMN: Record<FlowNodeKind, number> = {
  agent: 0,
  server: 1,
  script: 1,
  tool: 2,
  processing: 3,
  mapping: 4,
  connector: 5,
};

/** Strips a graph to what the layout reads (and what is sent to the worker). */
export function layoutInput(graph: FlowGraph): LayoutInput {
  return {
    nodes: graph.nodes.map((n) => ({ id: n.id, kind: n.kind })),
    edges: graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
  };
}

/**
 * Dagre orders the nodes inside each column; the column of every kind is fixed
 * (rank constraints via `minlen`, x forced afterwards) so a tool without a
 * processing chain still lines up with the rest. Script nodes sit outside the
 * dagre run and are stacked under the server. Pure: runs in the layout worker.
 */
export function layoutPositions(graph: LayoutInput, sizes: NodeSizes): Positions {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  const body = graph.nodes.filter((n) => n.kind !== 'script');
  const scripts = graph.nodes.filter((n) => n.kind === 'script');
  const bodyIds = new Set(body.map((n) => n.id));
  const kindOf = new Map(graph.nodes.map((n) => [n.id, n.kind] as const));

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', ranksep: RANK_SEP, nodesep: NODE_SEP, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of body) g.setNode(n.id, { width: sizes[n.kind].width, height: sizes[n.kind].height });
  for (const e of edges) {
    if (!bodyIds.has(e.source) || !bodyIds.has(e.target)) continue;
    const span = COLUMN[kindOf.get(e.target)!] - COLUMN[kindOf.get(e.source)!];
    g.setEdge(e.source, e.target, { minlen: Math.max(1, span) });
  }
  dagre.layout(g);

  // Column x: the widest node of the column decides its width.
  const colWidth: number[] = [];
  for (const n of graph.nodes) {
    const c = COLUMN[n.kind];
    colWidth[c] = Math.max(colWidth[c] ?? 0, sizes[n.kind].width);
  }
  const colX: number[] = [];
  let x = 0;
  for (let c = 0; c < 6; c += 1) {
    if (c > 0 && colWidth[c]) x += GAP_BEFORE[c] ?? RANK_SEP;
    colX[c] = x;
    if (colWidth[c]) x += colWidth[c];
  }
  const left = (kind: FlowNodeKind) => colX[COLUMN[kind]] + (colWidth[COLUMN[kind]] - sizes[kind].width) / 2;

  const positions: Positions = {};
  let serverBottom: number | null = null;
  for (const n of body) {
    const p = g.node(n.id);
    const top = p.y - sizes[n.kind].height / 2;
    if (n.kind === 'server') serverBottom = Math.max(serverBottom ?? -Infinity, top + sizes[n.kind].height);
    positions[n.id] = { x: left(n.kind), y: top };
  }

  let y = serverBottom !== null ? serverBottom + NODE_SEP * 2 : 0;
  for (const n of scripts) {
    positions[n.id] = { x: left(n.kind), y };
    y += sizes[n.kind].height + NODE_SEP;
  }
  return positions;
}
