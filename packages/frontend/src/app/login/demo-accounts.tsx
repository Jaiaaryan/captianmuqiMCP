'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Copy, Eye, EyeOff, User } from 'lucide-react';
import type { PublicDemoAccount } from '@/lib/api';
import { Icon } from '@/components/tool-editor/icon';
import { cn } from '@/lib/utils';

const iconButton =
  'inline-flex h-6 w-6 shrink-0 items-center justify-center text-[var(--text-3)] ' +
  'hover:bg-[var(--surface-2)] hover:text-[var(--text)] ' +
  'focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--text-2)] ' +
  'disabled:opacity-40 disabled:pointer-events-none';

/** Copies to the clipboard; a refusal (no permission, insecure origin) is swallowed. */
function CopyButton({ value, label, testId }: { value: string; label: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable: nothing to show.
    }
  };

  return (
    <button type="button" onClick={copy} aria-label={label} data-testid={testId} className={iconButton}>
      <Icon as={copied ? Check : Copy} />
    </button>
  );
}

/** "/mcp/<id>" for display; an absolute URL loses its origin, anything else is shown as given. */
function mcpPath(value: string): string {
  try {
    const u = new URL(value);
    return u.pathname + u.search;
  } catch {
    return value;
  }
}

function DemoRow({
  account,
  disabled,
  onUse,
}: {
  account: PublicDemoAccount;
  disabled: boolean;
  onUse: (account: PublicDemoAccount) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const { email, name, role, workspace, password } = account;
  // An account with MCP roles is told apart by them (`VIEWER · Staff`), the others by workspace.
  const mcpRoles = Array.isArray(account.mcpRoles) ? account.mcpRoles : [];
  const qualifier = mcpRoles.length > 0 ? mcpRoles.join(', ') : workspace;

  return (
    <li
      data-testid={`demo-row-${workspace}-${role.toLowerCase()}`}
      className="flex h-8 items-center gap-1.5 text-[13px]"
    >
      <span className="flex w-[64px] min-w-0 shrink-0 items-center gap-1.5 text-[var(--text)]">
        <Icon as={User} className="text-[var(--text-3)]" />
        <span className="truncate" title={email}>{name}</span>
      </span>

      <span
        data-testid={`demo-role-${email}`}
        title={account.workspaceName || undefined}
        className="w-[96px] shrink-0 truncate text-[11px] font-medium tracking-wide"
      >
        <span className={role === 'ADMIN' ? 'text-[var(--brand)]' : 'text-[var(--text-2)]'}>{role}</span>
        <span className="text-[var(--text-3)]"> · {qualifier}</span>
      </span>

      <span className="flex min-w-0 flex-1 items-center gap-0.5">
        <span
          title={revealed ? password : undefined}
          className={cn(
            'min-w-0 flex-1 truncate',
            revealed ? 'font-mono text-[11.5px] text-[var(--text)]' : 'tracking-[0.1em] text-[var(--text-3)]',
          )}
        >
          {revealed ? password : '••••••••'}
        </span>
        <button
          type="button"
          onClick={() => setRevealed((r) => !r)}
          aria-label={`${revealed ? 'Hide' : 'Show'} password for ${name}`}
          aria-pressed={revealed}
          data-testid={`demo-reveal-${email}`}
          className={iconButton}
        >
          <Icon as={revealed ? EyeOff : Eye} />
        </button>
        <CopyButton value={password} label={`Copy password for ${name}`} testId={`demo-copy-${email}`} />
      </span>

      <button
        type="button"
        onClick={() => onUse(account)}
        disabled={disabled}
        aria-label={`Use ${name}`}
        data-testid={`demo-use-${email}`}
        className={cn(
          'inline-flex h-6 shrink-0 items-center gap-1 px-1.5 text-[12px] font-medium text-[var(--text-2)]',
          'hover:bg-[var(--surface-2)] hover:text-[var(--text)]',
          'focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--text-2)]',
          'disabled:opacity-40 disabled:pointer-events-none',
        )}
      >
        Use
        <Icon as={ArrowRight} />
      </button>
    </li>
  );
}

/** Demo instance only: one row per ready-made account, plus the two workspaces' MCP endpoints. */
export function DemoAccounts({
  accounts,
  mcp,
  disabled,
  onUse,
}: {
  accounts: PublicDemoAccount[];
  mcp: { A: string; B: string };
  disabled: boolean;
  onUse: (account: PublicDemoAccount) => void;
}) {
  return (
    <section data-testid="demo-root" aria-label="Demo" className="mt-5 border-t border-[var(--border)] pt-3">
      <h2 className="mb-1 text-[11px] font-medium uppercase tracking-wider text-[var(--text-3)]">Demo</h2>

      <ul>
        {accounts.map((a) => (
          <DemoRow key={a.email} account={a} disabled={disabled} onUse={onUse} />
        ))}
      </ul>

      <div className="mt-2 flex gap-3 font-mono text-[11.5px] text-[var(--text-3)]">
        <span className="flex h-6 shrink-0 items-center uppercase tracking-wider">MCP</span>
        <div className="min-w-0 flex-1">
          {(['A', 'B'] as const).map((ws) =>
            mcp[ws] ? (
              <div key={ws} data-testid={`demo-mcp-${ws}`} className="flex h-6 min-w-0 items-center gap-1.5">
                <span className="shrink-0">{ws}</span>
                <span className="truncate" title={mcp[ws]}>{mcpPath(mcp[ws])}</span>
                <CopyButton value={mcp[ws]} label={`Copy MCP endpoint ${ws}`} />
              </div>
            ) : null,
          )}
        </div>
      </div>
    </section>
  );
}
