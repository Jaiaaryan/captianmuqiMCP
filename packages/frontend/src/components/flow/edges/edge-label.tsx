'use client';

import { memo } from 'react';
import { EdgeLabelRenderer } from '@xyflow/react';
import { X } from 'lucide-react';
import { Icon } from '@/components/tool-editor/icon';
import { formatBytes, formatCount } from '../flow-format';
import type { FlowStats } from '../types';

interface Props {
  x: number;
  y: number;
  stats?: FlowStats;
}

/** `calls · bytes [X] errors` pill at the path midpoint; hidden when there were no calls. */
function EdgeLabelBase({ x, y, stats }: Props) {
  if (!stats || stats.calls <= 0) return null;
  const bytes = formatBytes(stats.bytesOut ?? stats.bytesIn);
  const errors = stats.errors ?? 0;
  return (
    <EdgeLabelRenderer>
      <span
        style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
        className="nodrag nopan pointer-events-none absolute inline-flex items-center gap-1.5 whitespace-nowrap bg-[var(--surface)] px-1.5 font-mono text-[11px] leading-[16px] tabular-nums text-[var(--text-2)]"
      >
        <span>
          {formatCount(stats.calls)}
          {bytes ? ` · ${bytes}` : ''}
        </span>
        {errors > 0 && (
          <span data-testid="flow-edge-errors" className="inline-flex items-center gap-1.5 font-medium text-[var(--t-danger-fg)]">
            <Icon as={X} />
            {formatCount(errors)}
          </span>
        )}
      </span>
    </EdgeLabelRenderer>
  );
}

export const EdgeLabel = memo(EdgeLabelBase);
