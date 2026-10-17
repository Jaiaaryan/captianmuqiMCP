'use client';

import type { KeyboardEvent, ReactNode } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { X, type LucideIcon } from 'lucide-react';
import { Icon } from '@/components/tool-editor/icon';
import type { FlowNode, FlowNodeKind } from '../types';
import { formatBytes, formatCount } from '../flow-format';

export const NODE_SIZE: Record<FlowNodeKind, { width: number; height: number }> = {
  agent: { width: 140, height: 44 },
  server: { width: 180, height: 52 },
  connector: { width: 240, height: 56 },
  tool: { width: 240, height: 56 },
  processing: { width: 240, height: 52 },
  mapping: { width: 240, height: 52 },
  script: { width: 240, height: 56 },
};

export type ChipTone = 'default' | 'muted' | 'danger' | 'ok';

export interface NodeChip {
  text: string;
  tone?: ChipTone;
  /** Leading lucide icon (`X` for errors, `Check` for valid). */
  icon?: LucideIcon;
}

// Grayscale skeleton; colour only for state: errors in danger, valid in success.
const TONE_CLASS: Record<ChipTone, string> = {
  default: 'text-[var(--text-2)]',
  muted: 'text-[var(--text-3)]',
  danger: 'font-medium text-[var(--t-danger-fg)]',
  ok: 'text-[var(--t-success-fg)]',
};

const HANDLE_STYLE = {
  width: 6,
  height: 6,
  minWidth: 6,
  minHeight: 6,
  borderRadius: 0,
  background: 'var(--text-3)',
  border: 'none',
} as const;

/** `12×` calls chip; `0×` is muted. */
export function callsChip(calls: number | undefined): NodeChip {
  const n = calls ?? 0;
  return { text: `${formatCount(n)}×`, tone: n > 0 ? 'default' : 'muted' };
}

/** `[X] 3` errors chip, only when there are errors. */
export function errorsChip(errors: number | undefined): NodeChip | null {
  return errors && errors > 0 ? { text: formatCount(errors), icon: X, tone: 'danger' } : null;
}

/** `1.2 KB → 340 B`, only when both sides are known. */
export function bytesChip(bytesIn: number | undefined, bytesOut: number | undefined): NodeChip | null {
  if (bytesIn == null || bytesOut == null) return null;
  return { text: `${formatBytes(bytesIn)} → ${formatBytes(bytesOut)}`, tone: 'muted' };
}

export function compact(chips: Array<NodeChip | null | false | undefined>): NodeChip[] {
  return chips.filter((c): c is NodeChip => !!c && (c.text !== '' || !!c.icon));
}

interface BaseNodeProps extends Pick<NodeProps, 'selected'> {
  node: FlowNode;
  icon: LucideIcon;
  /** Code chips next to the label (`ro`, `v3`, check icon). */
  codes?: NodeChip[];
  /** Stats line, right-aligned under the label. */
  stats: NodeChip[];
}

export function BaseNode({ node, icon: KindIcon, selected, codes = [], stats }: BaseNodeProps) {
  const { width, height } = NODE_SIZE[node.kind];

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.currentTarget.click();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={node.label}
      aria-pressed={!!selected}
      data-testid={`flow-node-${node.id}`}
      data-kind={node.kind}
      data-selected={selected ? 'true' : undefined}
      onKeyDown={onKeyDown}
      style={{ width, height }}
      className={`flex cursor-pointer flex-col justify-center gap-0.5 bg-[var(--surface)] px-2.5 text-[var(--text)] outline-none hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] focus-visible:outline-1! focus-visible:outline-offset-0! focus-visible:outline-[var(--text)]! ${
        selected ? 'outline outline-1 outline-offset-0 outline-[var(--text)]' : ''
      }`}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} style={HANDLE_STYLE} />
      <div className="flex min-w-0 items-start gap-1.5">
        <Icon as={KindIcon} className="mt-px text-[var(--text-2)]" />
        <span
          className="line-clamp-2 min-w-0 flex-1 text-[12.5px] font-medium leading-4 break-words"
          title={node.label}
        >
          {node.label}
        </span>
        {codes.length > 0 && <Chips chips={codes} />}
      </div>
      <div className="flex min-w-0 justify-end">
        <Chips chips={stats} />
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} style={HANDLE_STYLE} />
    </div>
  );
}

function Chips({ chips }: { chips: NodeChip[] }): ReactNode {
  return (
    <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap font-mono text-[11.5px] leading-4 tabular-nums">
      {chips.map((chip, i) => (
        <span
          key={`${i}-${chip.text}`}
          className={`inline-flex items-center gap-1.5 ${TONE_CLASS[chip.tone ?? 'default']}`}
        >
          {chip.icon && <Icon as={chip.icon} />}
          {chip.text}
        </span>
      ))}
    </span>
  );
}
