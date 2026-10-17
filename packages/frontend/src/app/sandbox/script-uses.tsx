'use client';

import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SandboxScriptUse } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { BlockTitle } from './result-panel';

/** A map pin, the mark for "this script is tied to these connectors". */
export function PinIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

export const toolCount = (uses: SandboxScriptUse[]) => uses.reduce((n, u) => n + u.tools.length, 0);

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One sentence for assistive technology: what the pin stands for. */
export function usesSummary(uses: SandboxScriptUse[]): string {
  if (uses.length === 0) return 'Uses no connector';
  return `Uses ${plural(uses.length, 'connector')} and ${plural(toolCount(uses), 'tool')}: ${uses
    .map((u) => `${u.connectorName} (${u.tools.join(', ')})`)
    .join('; ')}`;
}

/** The connectors with their tools, as the tooltip and the opened script show them. */
function UsesBreakdown({
  uses,
  missing,
  compact,
}: {
  uses: SandboxScriptUse[];
  missing: Set<string>;
  compact?: boolean;
}) {
  return (
    <ul className={cn('space-y-2.5', compact && 'space-y-2')}>
      {uses.map((u) => (
        <li key={u.connectorId} data-testid="use-connector">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[12.5px] font-semibold text-[var(--text)]">{u.connectorName}</span>
            {!u.connectorExists && <Badge tone="danger">removed</Badge>}
            {u.connectorExists && missing.has(u.connectorId) && <Badge tone="warn">not on this server</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {u.tools.map((t) => (
              <span
                key={t}
                className="rounded-[5px] border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-[1px] font-mono text-[11px] text-[var(--text-2)]"
              >
                {t}
              </span>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * The pin on a script card. Hover or focus it to see the connectors and tools; it is
 * its own button, next to (not inside) the card's button.
 *
 * The tooltip is drawn in a portal at a fixed position, so the list's rounded, clipped
 * card cannot cut it off.
 */
export function ConnectorPin({
  uses,
  missing = [],
  onActivate,
}: {
  uses: SandboxScriptUse[];
  /** Ids of connectors the selected MCP server does not have. */
  missing?: string[];
  onActivate?: () => void;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);

  const show = () => {
    const rect = button.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 280;
    // Right-aligned under the pin, kept inside the window.
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    setAt({ top: rect.bottom + 6, left });
  };
  const hide = () => setAt(null);

  if (uses.length === 0) return null;
  const warn = missing.length > 0 || uses.some((u) => !u.connectorExists);
  return (
    <>
      <button
        ref={button}
        type="button"
        data-testid="script-pin"
        aria-label={usesSummary(uses)}
        aria-describedby={at ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onKeyDown={(e) => e.key === 'Escape' && hide()}
        onClick={onActivate}
        className={cn(
          'inline-flex h-[22px] items-center gap-1 rounded-full border px-1.5 text-[11px] font-semibold outline-none transition-colors focus-visible:border-[var(--brand)]',
          warn
            ? 'border-transparent bg-[var(--t-warn-bg)] text-[var(--t-warn-fg)]'
            : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-2)] hover:text-[var(--text)]',
        )}
      >
        <PinIcon size={11} />
        {uses.length}
      </button>
      {at &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            data-testid="pin-tooltip"
            style={{ position: 'fixed', top: at.top, left: at.left, width: 280 }}
            className="z-[60] rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[var(--shadow)]"
          >
            <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
              Uses {plural(uses.length, 'connector')} · {plural(toolCount(uses), 'tool')}
            </div>
            <UsesBreakdown uses={uses} missing={new Set(missing)} compact />
          </div>,
          document.body,
        )}
    </>
  );
}

/** The "Connectors & tools" block of an opened script. */
export function ScriptUsesSection({
  uses,
  missing = [],
}: {
  uses: SandboxScriptUse[];
  missing?: string[];
}) {
  return (
    <div data-testid="script-uses">
      <BlockTitle>
        <span className="inline-flex items-center gap-1.5">
          <PinIcon size={12} /> Connectors &amp; tools
        </span>
      </BlockTitle>
      {uses.length === 0 ? (
        <p className="text-[12.5px] text-[var(--text-3)]">
          This script calls no tool. It works on the arguments it is given, so any MCP server offers it.
        </p>
      ) : (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
          <UsesBreakdown uses={uses} missing={new Set(missing)} />
          <p className="mt-3 text-[11.5px] text-[var(--text-3)]">
            A saved script can call only these tools, and an MCP server offers it to an agent only if the server has
            all of these connectors.
          </p>
        </div>
      )}
    </div>
  );
}
