'use client';

import { useCallback, useEffect, useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useTheme } from '@/lib/theme-context';
import { edgeTypes, nodeTypes, NODE_SIZE } from './node-registry';
import { useFlowLayout } from './use-flow-layout';
import { EDGE_CSS, type FlowEdgeData } from './edges/flow-edge';
import type { FlowGraph, FlowNode } from './types';

const EMPTY: { nodes: Node[]; edges: Edge[] } = { nodes: [], edges: [] };

/** Grayscale MiniMap: the server and agent read strongest, the rest recede. */
function miniMapColor(node: Node): string {
  return node.type === 'server' || node.type === 'agent' ? 'var(--text-2)' : 'var(--text-3)';
}

// React Flow reads its colours from these variables; point them at the app's.
const THEME_VARS = {
  '--xy-background-color': 'var(--surface-2)',
  '--xy-background-pattern-color': 'var(--surface-3)',
  '--xy-controls-button-background-color': 'var(--surface)',
  '--xy-controls-button-background-color-hover': 'var(--surface-2)',
  '--xy-controls-button-border-color': 'transparent',
  '--xy-controls-box-shadow': 'none',
  '--xy-controls-button-color': 'var(--text-2)',
  '--xy-controls-button-color-hover': 'var(--text)',
  '--xy-minimap-background-color': 'var(--surface)',
  // No translucent mask: the viewport is outlined instead.
  '--xy-minimap-mask-background-color': 'transparent',
  '--xy-minimap-mask-stroke-color': 'var(--text-3)',
  '--xy-minimap-mask-stroke-width': '1',
  '--xy-attribution-background-color': 'transparent',
} as React.CSSProperties;

const FIT = { padding: 0.15, maxZoom: 1, duration: 200 };

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.closest('[role="listbox"]') != null;
}

interface Props {
  graph: FlowGraph | null;
  selectedId: string | null;
  onSelect: (node: FlowNode | null) => void;
  /** Bumped by the toolbar's Fit button. */
  fitSignal: number;
  /** Changes with server or window; fits the view again. */
  fitKey: string;
}

// Edge-label placement: where several edges leave one node (the server's fan-out)
// the label sits near the target end, where they are spread out; where several
// converge on one node it sits near the source end. Elsewhere at the midpoint.
const CROWDED = 3;
const NEAR_TARGET = 0.78;
const NEAR_SOURCE = 0.22;
// With many edges, labels of single calls are noise.
const MANY_EDGES = 20;

function buildEdges(graph: FlowGraph, ids: Set<string>): Edge[] {
  const edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  const out = new Map<string, number>();
  const into = new Map<string, number>();
  for (const e of edges) {
    out.set(e.source, (out.get(e.source) ?? 0) + 1);
    into.set(e.target, (into.get(e.target) ?? 0) + 1);
  }
  const many = edges.length > MANY_EDGES;
  return edges.map((e) => {
    const fanOut = out.get(e.source)! > CROWDED;
    const fanIn = into.get(e.target)! > CROWDED;
    const data: FlowEdgeData = {
      ...e,
      labelT: fanOut && !fanIn ? NEAR_TARGET : fanIn && !fanOut ? NEAR_SOURCE : 0.5,
      showLabel: !many || (e.stats?.calls ?? 0) >= 2,
    };
    return { id: e.id, source: e.source, target: e.target, type: e.kind, data: data as unknown as Record<string, unknown> };
  });
}

function Canvas({ graph, selectedId, onSelect, fitSignal, fitKey }: Props) {
  const { fitView } = useReactFlow();
  const { resolvedTheme } = useTheme();
  const initialized = useNodesInitialized();
  const placed = useFlowLayout(graph, NODE_SIZE);

  // Built once per graph snapshot and layout answer. While a new snapshot of the same
  // server is being laid out, the previous positions stay; nothing shows before the first.
  const current = useMemo(() => {
    if (!graph || !placed || placed.serverId !== graph.serverId) return EMPTY;
    const nodes: Node[] = [];
    for (const n of graph.nodes) {
      const position = placed.positions[n.id];
      if (!position) continue;
      const { width, height } = NODE_SIZE[n.kind];
      // Explicit size: the MiniMap and fitView read it without a measuring pass.
      nodes.push({ id: n.id, type: n.kind, position, width, height, data: n as unknown as Record<string, unknown> });
    }
    return { nodes, edges: buildEdges(graph, new Set(nodes.map((n) => n.id))) };
  }, [graph, placed]);

  // Only the selected node gets a new object; every other node keeps its identity.
  const nodes = useMemo(
    () => current.nodes.map((n) => (n.id === selectedId ? { ...n, selected: true } : n)),
    [current.nodes, selectedId],
  );
  const layoutNodes = current.nodes;

  const onNodeClick = useCallback<NodeMouseHandler>((_, node) => onSelect(node.data as unknown as FlowNode), [onSelect]);
  const onPaneClick = useCallback(() => onSelect(null), [onSelect]);

  // Fit on load, on server/window change, and from the toolbar. Selection
  // changes do not touch the view.
  useEffect(() => {
    if (layoutNodes.length === 0) return;
    if (!initialized) return;
    void fitView(FIT);
  }, [initialized, layoutNodes, fitKey, fitSignal, fitView]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.key === 'Escape') onSelect(null);
      else if (e.key === 'f') void fitView(FIT);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fitView, onSelect]);

  // Nothing to draw yet: an empty surface. React Flow mounts with the first layout, so
  // page hydration does not also build the canvas, its controls and the MiniMap.
  if (current.nodes.length === 0) {
    return <div data-testid="flow-empty" className="h-full w-full bg-[var(--surface-2)]" />;
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={current.edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      colorMode={resolvedTheme}
      style={THEME_VARS}
      fitView
      fitViewOptions={FIT}
      minZoom={0.1}
      maxZoom={1.5}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      panOnDrag
      zoomOnScroll
      onNodeClick={onNodeClick}
      onPaneClick={onPaneClick}
    >
      <style>{EDGE_CSS}</style>
      <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} />
      <Controls showInteractive={false} position="bottom-left" />
      <MiniMap
        pannable
        zoomable
        position="bottom-right"
        style={{ width: 140, height: 90 }}
        nodeColor={miniMapColor}
        nodeBorderRadius={0}
      />
    </ReactFlow>
  );
}

export function FlowCanvas(props: Props) {
  return (
    <div
      data-testid="flow-canvas"
      className="h-full min-h-[420px] w-full overflow-hidden"
    >
      <ReactFlowProvider>
        <Canvas {...props} />
      </ReactFlowProvider>
    </div>
  );
}
