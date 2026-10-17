'use client';

import Link from 'next/link';
import { ArrowRight, X } from 'lucide-react';
import { Icon } from '@/components/tool-editor/icon';
import type { FlowNode } from './types';
import { formatBytes, formatCount, formatMs, formatRelativeTime } from './flow-format';

function ownerHref(node: FlowNode): string | null {
  const ref = node.ref ?? {};
  switch (node.kind) {
    case 'connector':
      return ref.connectorId ? `/connectors/${ref.connectorId}` : null;
    case 'tool':
    case 'processing':
    case 'mapping':
      // The connector page has no per-tool deep link yet.
      return ref.connectorId ? `/connectors/${ref.connectorId}` : null;
    case 'script':
      return '/sandbox';
    case 'server':
      return ref.serverId ? `/mcp-server/${ref.serverId}` : '/mcp-server';
    default:
      return null;
  }
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-[12.5px] text-[var(--text-3)]">{k}</dt>
      <dd className="min-w-0 truncate text-right font-mono text-[12px] text-[var(--text)]" title={v}>
        {v}
      </dd>
    </div>
  );
}

interface Props {
  node: FlowNode;
  onClose: () => void;
}

export function FlowDrawer({ node, onClose }: Props) {
  const stats = node.stats;
  const rows: [string, string][] = [];
  if (stats) {
    rows.push(['calls', formatCount(stats.calls)], ['errors', formatCount(stats.errors)]);
    const avg = formatMs(stats.avgMs);
    if (avg) rows.push(['avg', avg]);
    const bin = formatBytes(stats.bytesIn);
    if (bin) rows.push(['in', bin]);
    const bout = formatBytes(stats.bytesOut);
    if (bout) rows.push(['out', bout]);
    const last = formatRelativeTime(stats.lastAt);
    if (last) rows.push(['last', last]);
  }
  const meta = Object.entries(node.meta ?? {}).map(([k, v]) => [k, v === null ? '—' : String(v)] as [string, string]);
  const href = ownerHref(node);

  return (
    <aside
      data-testid="flow-drawer"
      aria-label={node.label}
      className="flex h-full w-[300px] flex-shrink-0 flex-col overflow-y-auto bg-[var(--surface)] p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-[11px] uppercase tracking-[0.04em] text-[var(--text-3)]">{node.kind}</div>
          <div className="mt-0.5 break-words text-[14px] font-semibold tracking-[-0.01em]">{node.label}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center text-[var(--text-2)] outline-none hover:bg-[var(--surface-2)] hover:text-[var(--text)] focus-visible:bg-[var(--surface-2)] focus-visible:outline-none!"
        >
          <Icon as={X} />
        </button>
      </div>

      {rows.length > 0 && (
        <dl className="mt-4">
          {rows.map(([k, v]) => (
            <Row key={k} k={k} v={v} />
          ))}
        </dl>
      )}
      {meta.length > 0 && (
        <dl className="mt-4">
          {meta.map(([k, v]) => (
            <Row key={k} k={k} v={v} />
          ))}
        </dl>
      )}

      {href && (
        <Link
          href={href}
          className="mt-4 inline-flex h-8 items-center gap-1.5 self-start px-2 text-[12.5px] font-medium text-[var(--text)] outline-none hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] focus-visible:outline-none!"
        >
          Open
          <Icon as={ArrowRight} />
        </Link>
      )}
    </aside>
  );
}
