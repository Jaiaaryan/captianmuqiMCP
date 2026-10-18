'use client';

import Link from 'next/link';
import { ArrowRight, X } from 'lucide-react';
import { Icon } from '@/components/tool-editor/icon';
import type { FlowNode } from './types';
import { formatBytes, formatCount, formatMs, formatRelativeTime } from './flow-format';
import { ConnectorEditor, ProcessingEditor, ScriptEditor, ServerEditor } from './drawer-editors';

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
    <div className="flex min-h-7 items-center justify-between gap-3 leading-none">
      <dt className="text-[14px] text-[var(--text-3)]">{k}</dt>
      <dd className="min-w-0 truncate text-right font-mono text-[14px] tabular-nums text-[var(--text)]" title={v}>
        {v}
      </dd>
    </div>
  );
}

interface Props {
  node: FlowNode;
  onClose: () => void;
  token: string | null;
  role: string | undefined;
  /** After a save: reload the graph. */
  onSaved: () => void;
}

export function FlowDrawer({ node, onClose, token, role, onSaved }: Props) {
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
  const ref = node.ref ?? {};
  const editor = token
    ? { token, canWrite: !!role && role !== 'VIEWER', isAdmin: role === 'ADMIN', onSaved }
    : null;

  return (
    <aside
      data-testid="flow-drawer"
      aria-label={node.label}
      onKeyDown={(e) => {
        // Esc closes the drawer unless a field used it (a name being restored).
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.preventDefault();
          onClose();
        }
      }}
      className="flex h-full w-[320px] flex-shrink-0 flex-col overflow-y-auto bg-[var(--surface)] p-4 max-sm:absolute max-sm:inset-0 max-sm:z-20 max-sm:w-full"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-[14px] text-[var(--text-3)]">{node.kind}</div>
          <div className="mt-1 break-words text-[15px] font-semibold leading-5 tracking-[-0.01em]">{node.label}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          aria-keyshortcuts="Escape"
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-[var(--text-2)] outline-none hover:bg-[var(--surface-2)] hover:text-[var(--text)] focus-visible:bg-[var(--surface-2)] focus-visible:outline-none!"
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

      {editor && node.kind === 'connector' && ref.connectorId && (
        <ConnectorEditor key={node.id} connectorId={ref.connectorId} {...editor} />
      )}
      {editor && node.kind === 'server' && ref.serverId && <ServerEditor key={node.id} serverId={ref.serverId} {...editor} />}
      {editor &&
        (node.kind === 'tool' || node.kind === 'processing' || node.kind === 'mapping') &&
        ref.connectorId &&
        ref.toolId && <ProcessingEditor key={node.id} connectorId={ref.connectorId} toolId={ref.toolId} {...editor} />}
      {editor && node.kind === 'script' && ref.scriptId && <ScriptEditor key={node.id} scriptId={ref.scriptId} {...editor} />}

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
          className="mt-4 inline-flex h-8 items-center gap-1.5 self-start rounded-md px-2 text-[14px] font-medium text-[var(--text)] outline-none hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] focus-visible:outline-none!"
        >
          Open
          <Icon as={ArrowRight} />
        </Link>
      )}
    </aside>
  );
}
