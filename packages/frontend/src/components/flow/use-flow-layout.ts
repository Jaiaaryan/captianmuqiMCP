'use client';

import { useEffect, useState } from 'react';
import { layoutInput, layoutPositions, type NodeSizes, type Positions } from './layout';
import type { FlowGraph } from './types';

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
  const sync = () => layoutPositions(input, sizes);
  const w = layoutWorker();
  if (!w) return { id, answer: Promise.resolve().then(sync) };
  const answer = new Promise<Answer>((resolve) => {
    waiting.set(id, resolve);
    w.postMessage({ id, graph: input, sizes });
  }).then((a) => ('positions' in a ? a.positions : sync()));
  return { id, answer };
}

/** The graph a layout belongs to: the same server, window and snapshot. */
export function graphKey(graph: FlowGraph | null): string {
  return graph ? `${graph.serverId}:${graph.since}:${graph.generatedAt}` : '';
}

/**
 * Lays the graph out in a Web Worker (in-thread where there is none). Until the
 * answer lands the previous layout stays; its key tells which snapshot it belongs
 * to. An answer to an older request is ignored.
 */
export interface PlacedLayout {
  key: string;
  serverId: string;
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
