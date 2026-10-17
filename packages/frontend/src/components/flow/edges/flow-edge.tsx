'use client';

import { memo } from 'react';
import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';
import type { FlowEdge, FlowEdgeKind } from '../types';
import { EdgeLabel } from './edge-label';

/**
 * Grayscale: kinds differ by dash pattern and width, never by hue. The one colour
 * is state: an edge whose calls failed in the window is drawn in danger.
 * mcp solid 1.5, tool/http solid 1, processing/mapping dotted,
 * script-use dashed, script-call solid thin.
 */
export const EDGE_STYLE: Record<FlowEdgeKind, { stroke: string; width: number; dash?: string }> = {
  mcp: { stroke: 'var(--text-2)', width: 1.5 },
  tool: { stroke: 'var(--text-3)', width: 1 },
  http: { stroke: 'var(--text-3)', width: 1 },
  processing: { stroke: 'var(--text-3)', width: 1, dash: '1 3' },
  mapping: { stroke: 'var(--text-3)', width: 1, dash: '1 3' },
  'script-use': { stroke: 'var(--text-3)', width: 1, dash: '4 4' },
  'script-call': { stroke: 'var(--text-3)', width: 0.75 },
};

/** An edge as the canvas hands it over: where its label sits, and whether it shows. */
export type FlowEdgeData = FlowEdge & { labelT: number; showLabel: boolean };

// Keyframes, rendered once by the canvas: patterned edges drift along the path while calls flow.
// stroke-dashoffset repaints the stroke only; it never triggers layout.
export const EDGE_CSS = `
@keyframes amcp-flow-dash { to { stroke-dashoffset: -16; } }
.amcp-flow-live { animation: amcp-flow-dash 0.9s linear infinite; }
@media (prefers-reduced-motion: reduce) { .amcp-flow-live { animation: none; } }
`;

/** Stroke width for a call volume: clamp(1, 1 + log10(calls + 1), 4). Kept for callers. */
export function edgeWidth(calls: number): number {
  return Math.min(4, Math.max(1, 1 + Math.log10(calls + 1)));
}

/**
 * A point at `t` on the left-to-right bezier getBezierPath draws (right handle to
 * left handle, default curvature): control points sit half the horizontal
 * distance in from either end.
 */
function pointOnPath(sx: number, sy: number, tx: number, ty: number, t: number): [number, number] {
  const d = Math.abs(tx - sx) / 2;
  const c1x = sx + d;
  const c2x = tx - d;
  const u = 1 - t;
  const x = u * u * u * sx + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * tx;
  const y = u * u * u * sy + 3 * u * u * t * sy + 3 * u * t * t * ty + t * t * t * ty;
  return [x, y];
}

function FlowEdgeBase({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps) {
  const edge = data as unknown as FlowEdgeData | undefined;
  const kind: FlowEdgeKind = edge?.kind ?? 'tool';
  const calls = edge?.stats?.calls ?? 0;
  const live = calls > 0;
  const failing = (edge?.stats?.errors ?? 0) > 0;
  const style = EDGE_STYLE[kind];

  const [path, midX, midY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const t = edge?.labelT ?? 0.5;
  const [labelX, labelY] = t === 0.5 ? [midX, midY] : pointOnPath(sourceX, sourceY, targetX, targetY, t);

  return (
    <g data-testid={edge ? `flow-edge-${edge.id}` : undefined} data-kind={kind}>
      <BaseEdge
        path={path}
        interactionWidth={16}
        className={live && style.dash ? 'amcp-flow-live' : undefined}
        style={{
          stroke: selected ? 'var(--text)' : failing ? 'var(--t-danger-fg)' : style.stroke,
          strokeWidth: style.width,
          strokeDasharray: style.dash,
          strokeLinecap: style.dash === '1 3' ? 'round' : undefined,
          opacity: live || kind === 'script-use' ? 1 : 0.6,
        }}
      />
      {edge?.showLabel !== false && <EdgeLabel x={labelX} y={labelY} stats={edge?.stats} />}
    </g>
  );
}

export const FlowEdgeComponent = memo(FlowEdgeBase);
