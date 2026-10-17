'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { mcpServers } from '@/lib/api';
import { AppShell } from '@/components/app-shell';
import { AppSelect } from '@/components/ui/select';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { BenchmarkTab } from './benchmark-tab';
import { errorText } from './format';
import { IsolationTab } from './isolation-tab';
import { RunsTab } from './runs-tab';
import { ScriptsTab } from './scripts-tab';
import { useSandboxData } from './use-sandbox-data';

type Tab = 'scripts' | 'runs' | 'isolation' | 'benchmark';

const TABS: { value: Tab; label: string }[] = [
  { value: 'scripts', label: 'Scripts' },
  { value: 'runs', label: 'Runs' },
  { value: 'isolation', label: 'Isolation tests' },
  { value: 'benchmark', label: 'Benchmark' },
];

export default function SandboxPage() {
  const { token, user } = useAuth();
  const [servers, setServers] = useState<{ id: string; name: string }[] | null>(null);
  const [serverId, setServerId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const role = user?.role;
  const canWrite = role !== 'VIEWER';
  const isAdmin = role === 'ADMIN';

  useEffect(() => {
    if (!token) return;
    mcpServers
      .list(token)
      .then((list) => {
        setServers(list);
        setServerId((current) => current || list[0]?.id || '');
      })
      .catch((err) => setError(errorText(err)));
  }, [token]);

  const picker = servers && servers.length > 0 && (
    <AppSelect
      aria-label="MCP server"
      value={serverId}
      onValueChange={setServerId}
      className="h-[34px] rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[12.5px] text-[var(--text-2)]"
      options={servers.map((s) => ({ value: s.id, label: s.name }))}
    />
  );

  return (
    <AppShell
      title="Code mode"
      subtitle="Agents run short scripts next to the data. Only the answer goes back to the model."
      actions={picker || undefined}
    >
      {error && <div role="alert" className="mb-4 rounded-lg bg-[var(--t-danger-bg)] px-3.5 py-2.5 text-[12.5px] text-[var(--t-danger-fg)]">{error}</div>}

      {servers?.length === 0 && (
        <Card className="p-8 text-center text-[13px] text-[var(--text-2)]">
          Code mode is part of an MCP server. <Link className="text-[var(--brand)] hover:underline" href="/mcp-server">Create one</Link> and assign a connector to it first.
        </Card>
      )}

      {/* keyed by server: choosing another one starts the data and every tab from a clean state */}
      {token && serverId && (
        <Workspace key={serverId} serverId={serverId} token={token} canWrite={canWrite} isAdmin={isAdmin} />
      )}
    </AppShell>
  );
}

/**
 * The four tabs of one server. They are mounted once and only hidden when another tab is
 * chosen, so drafts, scroll positions and results survive switching, and the data they
 * share is fetched once (useSandboxData) instead of on every switch.
 */
function Workspace({
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
  const data = useSandboxData(serverId, token);
  const [tab, setTab] = useState<Tab>('scripts');

  if (data.off) {
    return (
      <Card className="p-8 text-center text-[13px] text-[var(--text-2)]">
        Code mode is turned off on this instance (<span className="font-mono">SANDBOX_ENABLED=false</span>).
      </Card>
    );
  }

  return (
    <>
      <div role="tablist" aria-label="Code mode" className="mb-4 inline-flex gap-0.5 rounded-[10px] bg-[var(--surface-2)] p-[3px]">
        {TABS.map((t) => (
          <button
            key={t.value}
            id={`sandbox-tab-${t.value}`}
            role="tab"
            type="button"
            aria-selected={tab === t.value}
            aria-controls={`sandbox-panel-${t.value}`}
            onClick={() => setTab(t.value)}
            className={cn(
              'rounded-[7px] px-3.5 py-1.5 text-[12.5px] font-medium transition-colors',
              tab === t.value
                ? 'bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-sm)]'
                : 'text-[var(--text-3)] hover:text-[var(--text)]',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {TABS.map((t) => (
        // A bare wrapper: the `hidden` attribute would lose to a display class on the tab itself.
        <div
          key={t.value}
          id={`sandbox-panel-${t.value}`}
          role="tabpanel"
          aria-labelledby={`sandbox-tab-${t.value}`}
          hidden={tab !== t.value}
        >
          {t.value === 'scripts' && <ScriptsTab serverId={serverId} token={token} canWrite={canWrite} isAdmin={isAdmin} data={data} />}
          {t.value === 'runs' && <RunsTab isAdmin={isAdmin} data={data} />}
          {t.value === 'isolation' && <IsolationTab serverId={serverId} token={token} canWrite={canWrite} />}
          {t.value === 'benchmark' && <BenchmarkTab serverId={serverId} token={token} canWrite={canWrite} data={data} />}
        </div>
      ))}
    </>
  );
}
