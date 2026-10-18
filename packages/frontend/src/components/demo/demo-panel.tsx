'use client';

import { forwardRef, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowRightLeft, Check, Copy, EyeOff, FlaskConical, RotateCcw, X } from 'lucide-react';
import { ApiError, auth, demo as demoApi, type DemoControl, type DemoResetResult } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Icon } from '@/components/tool-editor/icon';
import { cn } from '@/lib/utils';

type Letter = 'A' | 'B';

interface Account {
  email: string;
  password?: string;
  role: 'ADMIN' | 'VIEWER';
  mcpRoles: string[];
  workspace: Letter;
}

/** The demo accounts as the seed defines them, shown (disabled) while demo mode is off. */
const SEEDED_ACCOUNTS: Account[] = [
  { email: 'alice@alpha.codebound.test', role: 'ADMIN', mcpRoles: [], workspace: 'A' },
  { email: 'carol@alpha.codebound.test', role: 'VIEWER', mcpRoles: ['Staff'], workspace: 'A' },
  { email: 'bob@beta.codebound.test', role: 'ADMIN', mcpRoles: [], workspace: 'B' },
];

const PANEL_SHADOW =
  'shadow-[0_1px_2px_rgba(0,0,0,.08),0_14px_36px_rgba(0,0,0,.12)] ' +
  'dark:shadow-[0_1px_2px_rgba(0,0,0,.18),0_14px_36px_rgba(0,0,0,.28)]';
const action =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[13px] leading-none ' +
  'hover:bg-[var(--surface-2)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--text-2)] ' +
  'disabled:pointer-events-none';
const iconButton =
  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-3)] ' +
  'hover:bg-[var(--surface-2)] hover:text-[var(--text)] focus-visible:outline focus-visible:outline-1 ' +
  'focus-visible:outline-[var(--text-2)] disabled:pointer-events-none';

/** 1234 → "1.2k". */
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** `/mcp/cmgx1a2b3c4d5e6f7g8h` → `/mcp/cmgx1a2b…7g8h`. */
function shortMcp(serverId: string): string {
  return `/mcp/${serverId.length > 14 ? `${serverId.slice(0, 8)}…${serverId.slice(-4)}` : serverId}`;
}

/** The MCP endpoint as an AI client needs it: absolute, on the API's origin. */
function absoluteMcp(path: string): string {
  try {
    return new URL(path, process.env.NEXT_PUBLIC_API_URL || window.location.origin).toString();
  } catch {
    return path;
  }
}

/** "Alpha (CODEBOUND workspace A)" → "Alpha". */
function shortName(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/, '') || name;
}

function CopyButton({ value, label, disabled }: { value: string | null; label: string; disabled?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (permission, insecure origin): nothing to show.
    }
  };
  return (
    <button type="button" onClick={copy} aria-label={label} disabled={disabled || !value} className={cn(iconButton, 'ml-auto')}>
      <Icon as={copied ? Check : Copy} />
    </button>
  );
}

function Hairline() {
  return <div aria-hidden className="my-1 h-px bg-[color-mix(in_oklab,var(--border)_70%,transparent)]" />;
}

function Switch({
  on,
  disabled,
  onToggle,
}: {
  on: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Demo mode"
      disabled={disabled}
      onClick={onToggle}
      data-testid="demo-mode-switch"
      className={cn(
        'ml-auto inline-flex items-center gap-2 rounded-full leading-none',
        'focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[var(--text-2)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'relative inline-block h-5 w-9 shrink-0 rounded-full transition-colors',
          on ? 'bg-[var(--ok-fill)]' : 'bg-[var(--surface-3)]',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-4 w-4 rounded-full shadow-[0_1px_2px_rgba(0,0,0,.25)] transition-[left]',
            on ? 'left-[18px] bg-white' : 'left-0.5 bg-[var(--surface)]',
          )}
        />
      </span>
      <span className={cn('w-6 text-left text-[14px]', on ? 'text-[var(--t-success-fg)]' : 'text-[var(--text-3)]')}>
        {on ? 'On' : 'Off'}
      </span>
    </button>
  );
}

/** Rows that only work in demo mode: dimmed and inert while it is off. */
function LiveRows({ on, children }: { on: boolean; children: ReactNode }) {
  return (
    <div aria-disabled={!on || undefined} className={cn(!on && 'pointer-events-none opacity-[.45]')}>
      {children}
    </div>
  );
}

interface Props {
  control: DemoControl;
  /** Reads GET /api/demo/control again (after every action). */
  onRefresh: () => Promise<void>;
  style: CSSProperties;
  onClose: () => void;
  onHide: () => void;
}

type Outcome = { ok: true; text: string } | { ok: false; text: string };

/** The demo control's panel: the switch, the accounts, the MCP endpoints, reset, hide. */
export const DemoPanel = forwardRef<HTMLDivElement, Props>(function DemoPanel(
  { control, onRefresh, style, onClose, onHide },
  ref,
) {
  const { token, user, orgName, login } = useAuth();
  const [toggling, setToggling] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const outcomeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (outcomeTimer.current) clearTimeout(outcomeTimer.current);
    },
    [],
  );

  const on = control.enabled;
  const status = on ? control.status : undefined;
  const accounts: Account[] = status?.accounts?.length
    ? status.accounts.map((a) => ({
        email: a.email,
        password: a.password,
        role: a.role,
        mcpRoles: a.mcpRoles ?? [],
        workspace: a.workspace,
      }))
    : SEEDED_ACCOUNTS;
  const serverIds: Partial<Record<Letter, string>> = {};
  for (const w of status?.workspaces ?? []) if (w.serverId) serverIds[w.letter] = w.serverId;
  const current = status?.currentWorkspace ?? null;
  const currentName = current ? status?.workspaces.find((w) => w.letter === current)?.name : orgName;
  const canToggle = control.canToggle && !forbidden;
  const showReset = on ? control.canReset : control.canToggle;

  const showOutcome = (o: Outcome) => {
    setOutcome(o);
    if (outcomeTimer.current) clearTimeout(outcomeTimer.current);
    outcomeTimer.current = setTimeout(() => setOutcome(null), 5000);
  };

  const toggle = async () => {
    if (!token || toggling || !canToggle) return;
    setToggling(true);
    setConfirming(false);
    try {
      await demoApi.setEnabled(token, !on);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 403) setForbidden(true);
      else showOutcome({ ok: false, text: err instanceof Error ? err.message : 'Failed' });
    } finally {
      await onRefresh();
      setToggling(false);
    }
  };

  const switchTo = async (email: string, password: string | undefined) => {
    if (!password) return;
    setSwitching(email);
    try {
      const result = await auth.login(email, password);
      if (!result?.accessToken) throw new Error('no session');
      login(result.accessToken, result.user);
      // A full load, so every provider starts over with the new session.
      window.location.replace(`${window.location.origin}/`);
    } catch {
      setSwitching(null);
    }
  };

  const reset = async () => {
    if (!token) return;
    setConfirming(false);
    setResetting(true);
    try {
      const r: DemoResetResult = await demoApi.reset(token);
      showOutcome({
        ok: true,
        text: `runs ${r.reset.runs} · invocations ${r.reset.invocations} · scripts ${r.reset.scriptsRestored}`,
      });
    } catch (err: unknown) {
      showOutcome({ ok: false, text: err instanceof Error ? err.message : 'Reset failed' });
    } finally {
      setResetting(false);
      await onRefresh();
    }
  };

  return (
    <div
      ref={ref}
      id="demo-panel"
      role="dialog"
      aria-label="Demo"
      data-testid="demo-panel"
      data-enabled={on ? 'true' : 'false'}
      tabIndex={-1}
      style={style}
      className={cn(
        'fixed z-[60] w-[280px] rounded-[10px] bg-[var(--surface)] px-3 pb-2.5 pt-3 text-[14px] text-[var(--text)] outline-none',
        PANEL_SHADOW,
      )}
    >
      <header className="mb-1.5 flex h-6 items-center gap-2 leading-none">
        <Icon as={FlaskConical} />
        <span className="font-semibold">Demo</span>
        {on && (current || currentName) && (
          <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-3)]" data-testid="demo-current">
            {current ? `${current} · ` : ''}
            {currentName ? shortName(currentName) : ''}
          </span>
        )}
        <button type="button" onClick={onClose} aria-label="Close" className={cn(iconButton, 'ml-auto')}>
          <Icon as={X} />
        </button>
      </header>

      <div className="flex h-8 items-center gap-2 leading-none">
        <span className="text-[var(--text-2)]">Demo mode</span>
        <Switch on={on} disabled={!canToggle || toggling} onToggle={toggle} />
      </div>

      <Hairline />

      <LiveRows on={on}>
        <ul>
          {accounts.map((a) => {
            const local = a.email.split('@')[0];
            const isMe = on && user?.email?.toLowerCase() === a.email.toLowerCase();
            return (
              <li key={a.email} className="flex h-8 items-center gap-2 leading-none" title={a.email}>
                <span className="font-medium">{local}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-3)]">
                  <span className={a.role === 'ADMIN' ? 'font-medium text-[var(--brand)]' : undefined}>{a.role}</span>
                  {a.mcpRoles.map((r) => ` · ${r}`).join('')}
                  {` · ${a.workspace}`}
                </span>
                {isMe ? (
                  <span className="ml-auto inline-flex text-[var(--t-success-fg)]" aria-label="Signed in">
                    <Icon as={Check} />
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => switchTo(a.email, a.password)}
                    disabled={!on || !a.password || switching !== null}
                    data-testid={`demo-switch-${a.email}`}
                    className={cn(action, '-mr-1.5 ml-auto text-[var(--text-2)] hover:text-[var(--text)]')}
                  >
                    <Icon as={ArrowRightLeft} />
                    Switch
                  </button>
                )}
              </li>
            );
          })}
        </ul>

        <Hairline />

        <div className="font-mono text-[12.5px] text-[var(--text-3)]">
          {(['A', 'B'] as const).map((ws) => {
            const id = serverIds[ws];
            return (
              <div key={ws} data-testid={`demo-mcp-${ws}`} className="flex h-7 min-w-0 items-center gap-1.5 leading-none">
                <span className="shrink-0">{ws}</span>
                <span className="min-w-0 truncate text-[var(--text-2)]" title={id ? `/mcp/${id}` : undefined}>
                  {id ? shortMcp(id) : '/mcp/…'}
                </span>
                <CopyButton
                  value={id ? absoluteMcp(`/mcp/${id}`) : null}
                  label={`Copy MCP endpoint ${ws}`}
                  disabled={!on}
                />
              </div>
            );
          })}
        </div>

        {showReset && (
          <>
            <Hairline />
            <div className="flex h-8 items-center gap-1 leading-none">
              {confirming ? (
                <>
                  <button
                    type="button"
                    autoFocus
                    onClick={reset}
                    disabled={!on}
                    data-testid="demo-reset-confirm"
                    className={cn(action, '-ml-1.5 font-medium text-[var(--t-danger-fg)]')}
                  >
                    Reset
                  </button>
                  <span className="text-[var(--text-3)]">·</span>
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    className={cn(action, 'text-[var(--text-2)]')}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  disabled={!on || resetting}
                  data-testid="demo-reset"
                  className={cn(action, '-ml-1.5 text-[14px] text-[var(--t-danger-fg)]')}
                >
                  <Icon as={RotateCcw} className={resetting ? 'animate-spin' : undefined} />
                  Reset data
                </button>
              )}
            </div>
          </>
        )}
      </LiveRows>

      {outcome && (
        <div
          data-testid="demo-reset-result"
          role="status"
          className={cn(
            'flex h-6 items-center truncate font-mono text-[12.5px] leading-none',
            outcome.ok ? 'text-[var(--t-success-fg)]' : 'text-[var(--t-danger-fg)]',
          )}
        >
          {outcome.text}
        </div>
      )}

      <footer className="mt-1 flex h-7 items-center gap-2 leading-none">
        <span className="font-mono text-[12.5px] text-[var(--text-3)]" data-testid="demo-mock-count">
          {status ? `mock · ${compactCount(status.mock.requests)}` : 'mock · off'}
        </span>
        <button
          type="button"
          onClick={onHide}
          data-testid="demo-hide"
          className={cn(action, '-mr-1.5 ml-auto text-[var(--text-2)] hover:text-[var(--text)]')}
        >
          <Icon as={EyeOff} />
          Hide 1h
        </button>
      </footer>
    </div>
  );
});
