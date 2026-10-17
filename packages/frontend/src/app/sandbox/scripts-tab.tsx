'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  sandbox,
  type SandboxRunResponse,
  type SandboxSaveNotes,
  type SandboxScript,
  type SandboxScriptSummary,
  type SandboxScriptUseInput,
  type SandboxSyntax,
} from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { errorText, formatBytes, formatMs, formatWhen, parseArgs } from './format';
import { BlockTitle, Pre, RunResultPanel } from './result-panel';
import { ConnectorFilter, type ConnectorOption } from './connector-filter';
import { ConnectorPin, ScriptUsesSection } from './script-uses';
import { UsesPicker } from './uses-picker';

type Mode = 'idle' | 'view' | 'edit' | 'new';

const NEW_SCRIPT_TEMPLATE = `// The tools you may call are listed in the run tool's description:
//   const rows = await tools.some_tool({ limit: 100 });
// \`args\` holds the arguments passed on each run.
// Aggregate here and return a small JSON value, not the rows.
return { tools: tools.list(), args };
`;

const INPUT =
  'w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] text-[var(--text)] outline-none placeholder:text-[var(--text-3)] focus:border-[var(--brand)]';

function syntaxMessage(s: SandboxSyntax): string {
  return `line ${s.line ?? '?'}, column ${s.column ?? '?'}: ${s.message ?? 'syntax error'}`;
}

/** The message after a save: whether the code parses, what was added from it, what to look at. */
function saveNotice(
  saved: { name: string; version: number; syntax: SandboxSyntax },
  notes: SandboxSaveNotes,
): { tone: 'ok' | 'warn'; text: string } {
  const parts = [
    saved.syntax.ok
      ? `Saved ${saved.name} (version ${saved.version}). The code parses.`
      : `Saved ${saved.name}, but the code does not parse (${syntaxMessage(saved.syntax)}).`,
  ];
  if (notes.added.length > 0) parts.push(`Also added from the code: ${notes.added.join(', ')}.`);
  parts.push(...notes.warnings);
  return { tone: saved.syntax.ok && notes.warnings.length === 0 ? 'ok' : 'warn', text: parts.join(' ') };
}

export function ScriptsTab({
  serverId,
  token,
  canWrite,
  isAdmin,
}: {
  serverId: string;
  token: string;
  canWrite: boolean;
  isAdmin: boolean;
}) {
  const [scripts, setScripts] = useState<SandboxScriptSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SandboxScript | null>(null);
  const [mode, setMode] = useState<Mode>('idle');
  const [draft, setDraft] = useState<{
    name: string;
    description: string;
    code: string;
    uses: SandboxScriptUseInput[];
  }>({ name: '', description: '', code: '', uses: [] });
  const [filter, setFilter] = useState<string[]>([]);
  const [argsText, setArgsText] = useState('');
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<SandboxRunResponse | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    try {
      setScripts(await sandbox.scripts(serverId, token));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, [serverId, token]);

  // The first load sets state when the request settles, not synchronously in the effect.
  useEffect(() => {
    sandbox
      .scripts(serverId, token)
      .then((rows) => {
        setScripts(rows);
        setLoadError(null);
      })
      .catch((err) => setLoadError(errorText(err)));
  }, [serverId, token]);

  const resetOutput = () => {
    setRun(null);
    setRunError(null);
    setNotice(null);
    setConfirmDelete(false);
  };

  const select = async (id: string) => {
    resetOutput();
    setSelectedId(id);
    setMode('view');
    setDetail(null);
    try {
      setDetail(await sandbox.script(id, token));
    } catch (err) {
      setNotice({ tone: 'error', text: errorText(err) });
    }
  };

  const startNew = () => {
    resetOutput();
    setSelectedId(null);
    setDetail(null);
    setDraft({ name: '', description: '', code: NEW_SCRIPT_TEMPLATE, uses: [] });
    setMode('new');
  };

  const startEdit = () => {
    if (!detail) return;
    resetOutput();
    setDraft({
      name: detail.name,
      description: detail.description ?? '',
      code: detail.code,
      uses: detail.uses.map((u) => ({ connectorId: u.connectorId, tools: [...u.tools] })),
    });
    setMode('edit');
  };

  const cancelEdit = () => {
    resetOutput();
    setMode(detail ? 'view' : 'idle');
  };

  const save = async () => {
    setSaving(true);
    setNotice(null);
    try {
      const saved =
        mode === 'new'
          ? await sandbox.createScript(
              serverId,
              {
                name: draft.name.trim(),
                code: draft.code,
                description: draft.description.trim() || undefined,
                uses: draft.uses,
              },
              token,
            )
          : await sandbox.updateScript(
              detail!.id,
              { code: draft.code, description: draft.description, uses: draft.uses },
              token,
            );
      await load();
      setSelectedId(saved.id);
      setDetail(saved);
      setMode('view');
      setNotice(saveNotice(saved, saved));
    } catch (err) {
      setNotice({ tone: 'error', text: errorText(err) });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!detail) return;
    try {
      await sandbox.deleteScript(detail.id, token);
      setSelectedId(null);
      setDetail(null);
      setMode('idle');
      setConfirmDelete(false);
      await load();
    } catch (err) {
      setNotice({ tone: 'error', text: errorText(err) });
      setConfirmDelete(false);
    }
  };

  const execute = async () => {
    const args = parseArgs(argsText);
    if (!args.ok) {
      setRunError(args.message);
      return;
    }
    setRunning(true);
    setRun(null);
    setRunError(null);
    try {
      // A saved script runs by id; text being edited runs as it stands.
      const body =
        mode === 'view' && detail
          ? { scriptId: detail.id, args: args.value }
          : { code: draft.code, args: args.value };
      setRun(await sandbox.run(serverId, body, token));
      if (mode === 'view') void load(); // the list shows the last run
    } catch (err) {
      setRunError(errorText(err));
    } finally {
      setRunning(false);
    }
  };

  const editing = mode === 'edit' || mode === 'new';
  const canEdit = canWrite && !!detail?.ownedByYou;
  const canDelete = canWrite && !!detail && (detail.ownedByYou || isAdmin);

  // Scripts belong to the organization; the selected server decides which of them it can run.
  const row = scripts?.find((s) => s.id === selectedId);
  const missing = row?.missingConnectors ?? [];
  const unavailable = mode === 'view' && !!row && row.availableOnServer === false;

  const options = useMemo<ConnectorOption[]>(() => {
    const byId = new Map<string, ConnectorOption>();
    for (const script of scripts ?? []) {
      for (const u of script.uses) {
        const o = byId.get(u.connectorId);
        if (o) o.count += 1;
        else byId.set(u.connectorId, { id: u.connectorId, name: u.connectorName, count: 1, exists: u.connectorExists });
      }
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [scripts]);
  // A ticked connector that no script uses any more (it was edited or deleted) filters nothing.
  const applied = filter.filter((id) => options.some((o) => o.id === id));
  const shown = scripts?.filter((s) => applied.length === 0 || s.uses.some((u) => applied.includes(u.connectorId)));

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
      {/* ── List ── */}
      <Card className="self-start overflow-hidden">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold">Saved scripts</div>
            <div className="text-[11px] text-[var(--text-3)]">Shared by your whole organization</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ConnectorFilter options={options} applied={applied} onApply={setFilter} />
            {canWrite && (
              <Button size="sm" variant="secondary" onClick={startNew}>
                New script
              </Button>
            )}
          </div>
        </div>
        {applied.length > 0 && (
          <div
            data-testid="filter-chips"
            className="flex flex-wrap items-center gap-1.5 border-b border-[var(--border)] bg-[var(--surface-2)] px-4 py-2"
          >
            <span className="text-[11.5px] text-[var(--text-3)]">Connector:</span>
            {applied.map((id) => (
              <button
                key={id}
                type="button"
                aria-label={`Remove ${options.find((o) => o.id === id)?.name} from the filter`}
                onClick={() => setFilter(applied.filter((x) => x !== id))}
                className="inline-flex items-center gap-1 rounded-full bg-[var(--brand-tint)] px-2 py-[2px] text-[11.5px] font-semibold text-[var(--brand)]"
              >
                {options.find((o) => o.id === id)?.name}
                <span aria-hidden="true">×</span>
              </button>
            ))}
            <button
              type="button"
              className="ml-auto text-[11.5px] text-[var(--text-2)] underline hover:text-[var(--text)]"
              onClick={() => setFilter([])}
            >
              Clear
            </button>
          </div>
        )}
        {loadError && <div className="px-4 py-3 text-[12.5px] text-[var(--danger)]">{loadError}</div>}
        {scripts === null && !loadError && <div className="px-4 py-6 text-[12.5px] text-[var(--text-3)]">Loading…</div>}
        {scripts?.length === 0 && (
          <div className="px-4 py-6 text-[12.5px] text-[var(--text-3)]">
            No saved scripts yet. An agent saves one with <span className="font-mono">sandbox_create_script</span>
            {canWrite ? ', or you can write one here.' : '.'}
          </div>
        )}
        {scripts && scripts.length > 0 && shown?.length === 0 && (
          <div className="px-4 py-6 text-[12.5px] text-[var(--text-3)]" data-testid="no-match">
            No script uses the selected connectors.{' '}
            <button type="button" className="underline" onClick={() => setFilter([])}>
              Clear the filter
            </button>
          </div>
        )}
        {applied.length > 0 && scripts && (shown?.length ?? 0) > 0 && (
          <div className="border-b border-[var(--border)] px-4 py-1.5 text-[11px] text-[var(--text-3)]">
            Showing {shown?.length} of {scripts.length} scripts
          </div>
        )}
        <ul>
          {shown?.map((s) => {
            const lacking = s.missingConnectors ?? [];
            return (
              <li key={s.id} className="relative border-b border-[var(--border)]">
                <button
                  type="button"
                  data-testid="script-row"
                  aria-pressed={selectedId === s.id}
                  onClick={() => void select(s.id)}
                  className={cn(
                    'flex w-full flex-col gap-1 px-4 py-3 pr-16 text-left transition-colors hover:bg-[var(--surface-2)]',
                    selectedId === s.id && 'bg-[var(--surface-2)]',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className="truncate font-mono text-[12.5px] font-semibold">{s.name}</span>
                    <Badge tone="neutral">v{s.version}</Badge>
                    {s.lastRunOk !== null && (
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ background: s.lastRunOk ? 'var(--ok)' : 'var(--danger)' }}
                        title={s.lastRunOk ? 'Last run succeeded' : 'Last run failed'}
                      />
                    )}
                  </span>
                  {s.description && <span className="line-clamp-2 text-[12px] text-[var(--text-2)]">{s.description}</span>}
                  {s.availableOnServer === false && (
                    <span className="text-[11.5px] font-medium text-[var(--t-warn-fg)]" data-testid="not-on-server">
                      Not on this server: needs {lacking.map((m) => m.name).join(', ')}
                    </span>
                  )}
                  <span className="text-[11px] text-[var(--text-3)]">
                    {s.lastRunAt
                      ? `Last run ${formatWhen(s.lastRunAt)}${
                          s.lastRunMeta?.ms !== undefined ? ` · ${formatMs(s.lastRunMeta.ms)}` : ''
                        }${
                          s.lastRunMeta?.bytesReturned !== undefined
                            ? ` · ${formatBytes(s.lastRunMeta.bytesReturned)} returned`
                            : ''
                        }`
                      : 'Never run'}
                    {s.ownedByYou ? ' · yours' : ''}
                  </span>
                </button>
                {/* Its own button, beside the row's: hover or focus it for the connectors and tools. */}
                <span className="absolute right-3 top-3">
                  <ConnectorPin
                    uses={s.uses}
                    missing={lacking.map((m) => m.id)}
                    onActivate={() => void select(s.id)}
                  />
                </span>
              </li>
            );
          })}
        </ul>
      </Card>

      {/* ── Detail / editor ── */}
      <Card className="min-w-0 p-5">
        {mode === 'idle' && (
          <div className="py-10 text-center text-[13px] text-[var(--text-3)]">
            Select a script to read and run it
            {canWrite ? ', or start a new one.' : '.'}
            <div className="mt-2 text-[12px]">
              An agent finds the same scripts with <span className="font-mono">sandbox_list_scripts</span> and runs one
              with <span className="font-mono">sandbox_run_script</span>.
            </div>
          </div>
        )}

        {mode !== 'idle' && (
          <div className="space-y-4">
            {/* Title row */}
            {mode === 'new' ? (
              <div>
                <label className="mb-1.5 block text-[11.5px] font-semibold text-[var(--text-2)]" htmlFor="script-name">
                  Name
                </label>
                <input
                  id="script-name"
                  className={cn(INPUT, 'h-9 font-mono')}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="delayed_orders_last_month"
                  autoComplete="off"
                />
                <div className="mt-1 text-[11px] text-[var(--text-3)]">
                  Lowercase letters, digits, “_” and “-”; starts with a letter.
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-mono text-[15px] font-semibold">{detail?.name ?? '…'}</h2>
                {detail && <Badge tone="neutral">v{detail.version}</Badge>}
                {detail && (
                  <Badge tone={detail.ownedByYou ? 'brand' : 'neutral'}>
                    {detail.ownedByYou ? 'yours' : 'written by someone else'}
                  </Badge>
                )}
              </div>
            )}

            {/* Description */}
            {editing ? (
              <div>
                <label className="mb-1.5 block text-[11.5px] font-semibold text-[var(--text-2)]" htmlFor="script-desc">
                  Description
                </label>
                <input
                  id="script-desc"
                  className={cn(INPUT, 'h-9')}
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  placeholder="What it answers"
                />
              </div>
            ) : (
              detail?.description && <p className="text-[13px] text-[var(--text-2)]">{detail.description}</p>
            )}

            {mode === 'view' && detail && <ScriptUsesSection uses={detail.uses} missing={missing.map((m) => m.id)} />}
            {unavailable && (
              <div
                role="status"
                data-testid="unavailable-notice"
                className="rounded-lg px-3.5 py-2.5 text-[12.5px]"
                style={{ background: 'var(--t-warn-bg)', color: 'var(--t-warn-fg)' }}
              >
                The selected MCP server does not have {missing.map((m) => `“${m.name}”`).join(', ')}. An agent connected
                to it is not offered this script, and it cannot run here. Choose a server that has{' '}
                {missing.length === 1 ? 'that connector' : 'those connectors'}, or add {missing.length === 1 ? 'it' : 'them'} to
                this server.
              </div>
            )}

            {/* Code */}
            <div>
              <BlockTitle>Code</BlockTitle>
              {editing ? (
                <textarea
                  aria-label="Script code"
                  spellCheck={false}
                  className={cn(INPUT, 'min-h-[260px] py-2.5 font-mono text-xs leading-relaxed')}
                  value={draft.code}
                  onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                />
              ) : (
                <Pre maxH="max-h-80">{detail ? detail.code : 'Loading…'}</Pre>
              )}
              {mode === 'view' && !detail?.ownedByYou && detail && (
                <div className="mt-1.5 text-[11.5px] text-[var(--text-3)]">
                  Only the author can edit a script: it runs with the permissions of whoever runs it. Save your own
                  copy under a new name to change it.
                </div>
              )}
            </div>

            {editing && (
              <UsesPicker
                token={token}
                value={draft.uses}
                onChange={(uses) => setDraft({ ...draft, uses })}
                names={Object.fromEntries((detail?.uses ?? []).map((u) => [u.connectorId, u.connectorName]))}
              />
            )}

            {/* Arguments + actions */}
            <div>
              <label className="mb-1.5 block text-[11.5px] font-semibold text-[var(--text-2)]" htmlFor="script-args">
                Arguments for the run (JSON, optional)
              </label>
              <textarea
                id="script-args"
                spellCheck={false}
                rows={2}
                className={cn(INPUT, 'py-2 font-mono text-xs')}
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder='{"asOf": "2026-10-15"}'
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => void execute()}
                disabled={running || (editing && !draft.code.trim()) || !canWrite || unavailable}
              >
                {running ? 'Running…' : editing ? 'Run this code' : 'Run'}
              </Button>
              {!canWrite && (
                <span className="text-[12px] text-[var(--text-3)]">Viewers can read scripts but not run them.</span>
              )}
              {mode === 'view' && canEdit && (
                <Button variant="secondary" onClick={startEdit}>
                  Edit
                </Button>
              )}
              {editing && (
                <>
                  <Button
                    variant="secondary"
                    onClick={() => void save()}
                    disabled={saving || !draft.code.trim() || (mode === 'new' && !draft.name.trim())}
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </Button>
                  <Button variant="ghost" onClick={cancelEdit}>
                    Cancel
                  </Button>
                </>
              )}
              {mode === 'view' && canDelete && !confirmDelete && (
                <Button variant="outlineDanger" className="ml-auto" onClick={() => setConfirmDelete(true)}>
                  Delete
                </Button>
              )}
              {confirmDelete && (
                <span className="ml-auto flex items-center gap-2 text-[12.5px]">
                  Delete this script?
                  <Button size="sm" variant="danger" onClick={() => void remove()}>
                    Yes, delete
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                    Keep
                  </Button>
                </span>
              )}
            </div>

            {notice && (
              <div
                role="status"
                data-testid="notice"
                className="rounded-lg border px-3.5 py-2.5 text-[12.5px]"
                style={
                  notice.tone === 'ok'
                    ? { background: 'var(--t-success-bg)', color: 'var(--t-success-fg)', borderColor: 'transparent' }
                    : notice.tone === 'warn'
                      ? { background: 'var(--t-warn-bg)', color: 'var(--t-warn-fg)', borderColor: 'transparent' }
                      : { background: 'var(--t-danger-bg)', color: 'var(--t-danger-fg)', borderColor: 'transparent' }
                }
              >
                {notice.text}
              </div>
            )}
            {runError && (
              <div role="alert" className="rounded-lg bg-[var(--t-danger-bg)] px-3.5 py-2.5 text-[12.5px] text-[var(--t-danger-fg)]">
                {runError}
              </div>
            )}
            {run && <RunResultPanel run={run} />}
          </div>
        )}
      </Card>
    </div>
  );
}
