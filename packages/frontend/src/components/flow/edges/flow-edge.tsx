'use client';

import { memo, useContext, useId } from 'react';
import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';
import type { FlowEdge, FlowEdgeKind } from '../types';
import { EdgeLabel } from './edge-label';
import { FlowMotionContext, usePulse } from '../flow-motion';

/**
 * Kinds differ by dash pattern and width, never by hue. Hue is state, per edge
 * and window: success when every call succeeded, warn when some failed, danger
 * when all failed (or were refused), text-3 without calls, border when the
 * whole window is empty.
 * mcp solid 1.5, tool/http solid 1, processing/mapping dotted,
 * script-use dashed, script-call solid thin.
 */
export const EDGE_STYLE: Record<FlowEdgeKind, { width: number; dash?: string }> = {
  mcp: { width: 1.5 },
  tool: { width: 1 },
  http: { width: 1 },
  processing: { width: 1, dash: '1 3' },
  mapping: { width: 1, dash: '1 3' },
  'script-use': { width: 1, dash: '4 4' },
  'script-call': { width: 0.75 },
};

/** An edge as the canvas hands it over: where its label sits, and whether it shows. */
export type FlowEdgeData = FlowEdge & { labelT: number; showLabel: boolean };

export type EdgeState = 'idle' | 'ok' | 'warn' | 'danger';

export function edgeState(calls: number, errors: number): EdgeState {
  if (calls <= 0) return 'idle';
  if (errors <= 0) return 'ok';
  return errors >= calls ? 'danger' : 'warn';
}

const STATE_COLOR: Record<EdgeState, string> = {
  idle: 'var(--text-3)',
  ok: 'var(--t-success-fg)',
  warn: 'var(--t-warn-fg)',
  danger: 'var(--t-danger-fg)',
};

/** Animation speed bucket by call volume: 1 (<10), 2 (<100), 3 (≥100). */
export function speedBucket(calls: number): 1 | 2 | 3 {
  return calls >= 100 ? 3 : calls >= 10 ? 2 : 1;
}

// Rendered once by the canvas. Only stroke-dashoffset moves: it repaints the
// stroke and never triggers layout, and no JS runs per frame. Reduced motion:
// static colour, no dash, no movement.
export const EDGE_CSS = `
@keyframes amcp-flow-dash { to { stroke-dashoffset: -24; } }
.amcp-flow-anim { stroke-dasharray: 6 18; animation: amcp-flow-dash linear infinite; }
.amcp-flow-s1 { animation-duration: 2.4s; }
.amcp-flow-s2 { animation-duration: 1.2s; }
.amcp-flow-s3 { animation-duration: 0.6s; }
@keyframes amcp-flow-pulse { from { stroke-dashoffset: 28; } to { stroke-dashoffset: -100; } }
.amcp-flow-pulse { stroke-dasharray: 28 200; animation: amcp-flow-pulse var(--amcp-pulse-ms, 600ms) ease-out forwards; }
.amcp-flow-static { stroke-dasharray: none; animation: none; }
@media (prefers-reduced-motion: reduce) {
  .amcp-flow-anim, .amcp-flow-pulse { animation: none; stroke-dasharray: none; }
}
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
  const { reduced, empty } = useContext(FlowMotionContext);
  const pulse = usePulse(edge?.id);
  const gradientId = `amcp-g-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const kind: FlowEdgeKind = edge?.kind ?? 'tool';
  const calls = edge?.stats?.calls ?? 0;
  const errors = edge?.stats?.errors ?? 0;
  const state = edgeState(calls, errors);
  const live = state !== 'idle';
  const style = EDGE_STYLE[kind];
  const color = empty ? 'var(--border)' : STATE_COLOR[state];
  const pulseColor = pulse ? STATE_COLOR[pulse.tone === 'ok' ? 'ok' : 'danger'] : color;

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
  const motionClass = reduced ? 'amcp-flow-static' : `amcp-flow-anim amcp-flow-s${speedBucket(calls)}`;

  return (
    <g
      data-testid={edge ? `flow-edge-${edge.id}` : undefined}
      data-kind={kind}
      data-state={empty ? 'empty' : state}
      data-pulse={pulse ? pulse.tone : undefined}
    >
      {(live || pulse) && (
        <defs>
          {/* Faint at the source, full at the target: the direction of the flow. */}
          <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1={sourceX} y1={sourceY} x2={targetX} y2={targetY}>
            <stop offset="0%" style={{ stopColor: pulseColor, stopOpacity: pulse ? 0.5 : 0.15 }} />
            <stop offset="100%" style={{ stopColor: pulseColor, stopOpacity: 1 }} />
          </linearGradient>
        </defs>
      )}
      <BaseEdge
        path={path}
        interactionWidth={16}
        style={{
          stroke: selected ? 'var(--text)' : color,
          strokeWidth: style.width,
          strokeDasharray: style.dash,
          strokeLinecap: style.dash === '1 3' ? 'round' : undefined,
          opacity: selected ? 1 : live ? 0.45 : kind === 'script-use' ? 1 : 0.6,
        }}
      />
      {live && !empty && (
        <path
          d={path}
          fill="none"
          className={`amcp-flow-flow ${motionClass}`}
          stroke={`url(#${gradientId})`}
          strokeWidth={style.width + 0.75}
          strokeLinecap="round"
          pointerEvents="none"
        />
      )}
      {pulse && (
        <path
          key={pulse.n}
          d={path}
          fill="none"
          pathLength={100}
          className={reduced ? 'amcp-flow-pulse amcp-flow-static' : 'amcp-flow-pulse'}
          stroke={reduced ? pulseColor : `url(#${gradientId})`}
          strokeWidth={style.width + 2}
          strokeLinecap="round"
          pointerEvents="none"
          style={{ ['--amcp-pulse-ms' as string]: `${pulse.ms}ms` }}
        />
      )}
      {edge?.showLabel !== false && <EdgeLabel x={labelX} y={labelY} stats={edge?.stats} />}
    </g>
  );
}

export const FlowEdgeComponent = memo(FlowEdgeBase);
