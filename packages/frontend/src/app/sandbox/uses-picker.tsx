'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { connectors as connectorsApi, type SandboxScriptUseInput } from '@/lib/api';
import { cn } from '@/lib/utils';
import { errorText } from './format';
import { PinIcon } from './script-uses';

interface CatalogConnector {
  id: string;
  name: string;
  tools: { name: string; description?: string }[];
}

const BOX =
  'w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] text-[var(--text)] outline-none placeholder:text-[var(--text-3)] focus:border-[var(--brand)]';

/** A checkbox that can show "some of the tools". */
function Check({
  checked,
  indeterminate,
  onChange,
  label,
  className,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={checked}
      onChange={onChange}
      className={cn('h-4 w-4 shrink-0 cursor-pointer accent-[var(--brand)]', className)}
    />
  );
}

/**
 * Pick the connectors a script uses and, for each, the tools of it the script calls.
 * Lists every connector of the organization; the script is offered later only on MCP
 * servers that have all the connectors picked here.
 */
export function UsesPicker({
  token,
  value,
  onChange,
  names = {},
}: {
  token: string;
  value: SandboxScriptUseInput[];
  onChange: (next: SandboxScriptUseInput[]) => void;
  /** Names of connectors by id, for those that no longer exist. */
  names?: Record<string, string>;
}) {
  const [catalog, setCatalog] = useState<CatalogConnector[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    connectorsApi
      .list(token)
      .then((rows) =>
        setCatalog(
          rows
            .map((c: any) => ({
              id: String(c.id),
              name: String(c.name),
              tools: ((c.tools as any[]) ?? [])
                .map((t) => ({ name: String(t.name), description: t.description as string | undefined }))
                .sort((a, b) => a.name.localeCompare(b.name)),
            }))
            .sort((a: CatalogConnector, b: CatalogConnector) => a.name.localeCompare(b.name)),
        ),
      )
      .catch((err) => setError(errorText(err)));
  }, [token]);

  const picked = useMemo(() => new Map(value.map((v) => [v.connectorId, new Set(v.tools)])), [value]);

  const emit = (next: Map<string, Set<string>>) =>
    onChange(
      [...next]
        .filter(([, tools]) => tools.size > 0)
        .map(([connectorId, tools]) => ({ connectorId, tools: [...tools].sort() })),
    );
  const withTools = (connectorId: string, tools: Set<string>) => {
    const next = new Map(picked);
    next.set(connectorId, tools);
    emit(next);
  };
  const toggleTool = (connectorId: string, tool: string) => {
    const tools = new Set(picked.get(connectorId) ?? []);
    if (!tools.delete(tool)) tools.add(tool);
    withTools(connectorId, tools);
  };
  const toggleAll = (c: CatalogConnector) => {
    const current = picked.get(c.id) ?? new Set<string>();
    const all = c.tools.length > 0 && c.tools.every((t) => current.has(t.name));
    withTools(c.id, all ? new Set() : new Set(c.tools.map((t) => t.name)));
  };
  const toggleOpen = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const known = new Set((catalog ?? []).map((c) => c.id));
  const gone = value.filter((v) => catalog && !known.has(v.connectorId));
  const needle = query.trim().toLowerCase();
  const visible = (catalog ?? [])
    .map((c) => {
      const nameHit = c.name.toLowerCase().includes(needle);
      const tools = needle && !nameHit ? c.tools.filter((t) => t.name.toLowerCase().includes(needle)) : c.tools;
      return { c, tools, hit: !needle || nameHit || tools.length > 0 };
    })
    .filter((x) => x.hit);
  const total = value.reduce((n, v) => n + v.tools.length, 0);

  return (
    <div data-testid="uses-picker">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
          <PinIcon size={12} /> Connectors &amp; tools
        </span>
        <span className="text-[11.5px] text-[var(--text-3)]" data-testid="uses-count">
          {total === 0
            ? 'None picked'
            : `${value.length} connector${value.length === 1 ? '' : 's'}, ${total} tool${total === 1 ? '' : 's'}`}
        </span>
      </div>
      <p className="mb-2 text-[11.5px] text-[var(--text-3)]">
        Pick what the script calls. Tools called as <span className="font-mono">tools.name(...)</span> in the code are
        added when you save. A saved script can call only these tools, and a server offers it only if the server has all
        of these connectors.
      </p>

      {error && (
        <div role="alert" className="mb-2 rounded-lg bg-[var(--t-danger-bg)] px-3 py-2 text-[12px] text-[var(--t-danger-fg)]">
          {error}
        </div>
      )}
      {catalog === null && !error && <div className="text-[12.5px] text-[var(--text-3)]">Loading connectors…</div>}
      {catalog?.length === 0 && (
        <div className="text-[12.5px] text-[var(--text-3)]">This organization has no connectors yet.</div>
      )}

      {catalog && catalog.length > 0 && (
        <div className="overflow-hidden rounded-[9px] border border-[var(--border)]">
          <div className="border-b border-[var(--border)] bg-[var(--surface-2)] p-2">
            <input
              aria-label="Search connectors and tools"
              className={cn(BOX, 'h-8')}
              placeholder="Search connectors and tools"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <ul className="max-h-[300px] overflow-y-auto">
            {visible.length === 0 && (
              <li className="px-3 py-4 text-[12.5px] text-[var(--text-3)]">Nothing matches “{query}”.</li>
            )}
            {visible.map(({ c, tools }) => {
              const current = picked.get(c.id) ?? new Set<string>();
              const count = c.tools.filter((t) => current.has(t.name)).length;
              const expanded = open.has(c.id) || (needle !== '' && tools.length > 0);
              const stale = [...current].filter((t) => !c.tools.some((x) => x.name === t));
              return (
                <li key={c.id} data-testid="picker-connector" className="border-b border-[var(--border)] last:border-b-0">
                  <div className="flex items-center gap-2.5 px-3 py-2">
                    <Check
                      checked={c.tools.length > 0 && count === c.tools.length}
                      indeterminate={count > 0}
                      onChange={() => toggleAll(c)}
                      label={`All tools of ${c.name}`}
                    />
                    <button
                      type="button"
                      onClick={() => toggleOpen(c.id)}
                      aria-expanded={expanded}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <span className="truncate text-[13px] font-semibold">{c.name}</span>
                      <span className="shrink-0 text-[11.5px] text-[var(--text-3)]">
                        {count} of {c.tools.length} tool{c.tools.length === 1 ? '' : 's'}
                      </span>
                      <svg
                        className={cn('ml-auto h-3.5 w-3.5 shrink-0 text-[var(--text-3)] transition-transform', expanded && 'rotate-180')}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </button>
                  </div>
                  {expanded && (
                    <ul className="space-y-0.5 border-t border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 pl-9">
                      {tools.map((t) => (
                        <li key={t.name}>
                          <label className="flex cursor-pointer items-center gap-2 py-0.5" title={t.description}>
                            <Check
                              checked={current.has(t.name)}
                              onChange={() => toggleTool(c.id, t.name)}
                              label={`${c.name}: ${t.name}`}
                            />
                            <span className="truncate font-mono text-[12px]">{t.name}</span>
                          </label>
                        </li>
                      ))}
                      {stale.map((t) => (
                        <li key={`stale-${t}`}>
                          <label className="flex cursor-pointer items-center gap-2 py-0.5">
                            <Check checked onChange={() => toggleTool(c.id, t)} label={`${c.name}: ${t} (no longer exists)`} />
                            <span className="truncate font-mono text-[12px]">{t}</span>
                            <span className="text-[11px] text-[var(--danger)]">no longer exists: untick to remove</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {gone.length > 0 && (
        <div className="mt-2 rounded-lg bg-[var(--t-warn-bg)] px-3 py-2 text-[12px] text-[var(--t-warn-fg)]" role="status">
          <div className="font-semibold">Connectors that no longer exist</div>
          <ul className="mt-1 space-y-1">
            {gone.map((g) => (
              <li key={g.connectorId} className="flex items-center gap-2">
                <span>
                  <strong>{names[g.connectorId] ?? 'A deleted connector'}</strong>{' '}
                  <span className="font-mono">({g.tools.join(', ')})</span>
                </span>
                <button
                  type="button"
                  className="ml-auto underline"
                  onClick={() => onChange(value.filter((v) => v.connectorId !== g.connectorId))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-1">Remove them to save the script.</div>
        </div>
      )}
    </div>
  );
}
