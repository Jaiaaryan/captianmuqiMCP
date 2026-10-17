/// <reference lib="webworker" />
// Runs the dagre layout off the main thread. Protocol (see use-flow-layout.ts):
//   in:  { id: number, graph: LayoutInput, sizes: NodeSizes }
//   out: { id, positions } | { id, error }
// `id` is echoed so the page can drop answers to requests it no longer wants.
import { layoutPositions, type LayoutInput, type NodeSizes } from './layout';

interface LayoutRequest {
  id: number;
  graph: LayoutInput;
  sizes: NodeSizes;
}

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const { id, graph, sizes } = event.data;
  try {
    self.postMessage({ id, positions: layoutPositions(graph, sizes) });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
