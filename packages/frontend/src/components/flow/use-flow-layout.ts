'use client';

import { useEffect, useState } from 'react';
// Types only: dagre is evaluated in the worker, or loaded on demand where there is none.
import type { LayoutInput, NodeSizes, Positions } from './layout';
import type { FlowGraph } from './types';

/** What the layout needs of a graph: ids, kinds and links (what is posted to the worker). */
function layoutInput(graph: FlowGraph): LayoutInput {
  return {
    nodes: graph.nodes.map((n) => ({ id: n.id, kind: n.kind })),
    edges: graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
  };
}

type Answer = { id: number; positions: Positions } | { id: number; error: string };

let worker: Worker | null | undefined;
let nextId = 0;
const waiting = new Map<number, (answer: Answer) => void>();

/** One worker for the page's lifetime; null where workers do not exist (or fail to start). */
function layoutWorker(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === 'undefined') return (worker = null);
  try {
    worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<Answer>) => {
      const resolve = waiting.get(event.data.id);
      waiting.delete(event.data.id);
      resolve?.(event.data);
    };
    worker.onerror = () => {
      // A worker that cannot load: answer everything pending in-thread from now on.
      worker?.terminate();
      worker = null;
      for (const [id, resolve] of waiting) resolve({ id, error: 'worker failed' });
      waiting.clear();
    };
  } catch {
    worker = null;
  }
  return worker;
}

function requestLayout(graph: FlowGraph, sizes: NodeSizes): { id: number; answer: Promise<Positions> } {
  const id = (nextId += 1);
  const input = layoutInput(graph);
  const sync = () => import('./layout').then((m) => m.layoutPositions(input, sizes));
  const w = layoutWorker();
  if (!w) return { id, answer: sync() };
  const answer = new Promise<Answer>((resolve) => {
    waiting.set(id, resolve);
    w.postMessage({ id, graph: input, sizes });
  }).then((a) => ('positions' in a ? a.positions : sync()));
  return { id, answer };
}

/**
 * The structure a layout belongs to: the scope and the node and edge ids. A new
 * snapshot with the same structure (new counts, a renamed node, a reload after
 * an edit) keeps the positions: nothing moves unless the graph itself changed.
 */
export function graphKey(graph: FlowGraph | null): string {
  if (!graph) return '';
  const ids = graph.nodes.map((n) => `${n.kind}|${n.id}`).sort().join(',');
  const links = graph.edges.map((e) => `${e.source}>${e.target}`).sort().join(',');
  return `${graph.serverId ?? 'all'}#${hash(ids)}#${hash(links)}`;
}

/** FNV-1a, enough to tell structures apart in a cache key. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${text.length}.${(h >>> 0).toString(36)}`;
}

/**
 * Lays the graph out in a Web Worker (in-thread where there is none). Until the
 * answer lands the previous layout stays; its key tells which snapshot it belongs
 * to. An answer to an older request is ignored.
 */
export interface PlacedLayout {
  key: string;
  serverId: string | null;
  positions: Positions;
}

export function useFlowLayout(graph: FlowGraph | null, sizes: NodeSizes): PlacedLayout | null {
  const [layout, setLayout] = useState<PlacedLayout | null>(null);
  const key = graphKey(graph);

  useEffect(() => {
    if (!graph) return;
    const { id, answer } = requestLayout(graph, sizes);
    const serverId = graph.serverId;
    let current = true;
    void answer.then((positions) => {
      if (current) setLayout({ key, serverId, positions });
    });
    return () => {
      current = false;
      waiting.delete(id);
    };
    // The key stands for the graph: the same snapshot is not laid out twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, sizes]);

  return layout;
}
