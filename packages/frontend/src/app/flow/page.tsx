'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { mcpServers } from '@/lib/api';
import { AppShell } from '@/components/app-shell';
import { FlowCanvas } from '@/components/flow/flow-canvas';
import { FlowToolbar } from '@/components/flow/flow-toolbar';
import { FlowDrawer } from '@/components/flow/flow-drawer';
import { useFlowGraph } from '@/components/flow/use-flow-graph';
import type { FlowNode, FlowWindow } from '@/components/flow/types';

const WINDOWS: FlowWindow[] = ['1h', '24h', '7d'];

function FlowView() {
  const { token } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [servers, setServers] = useState<{ id: string; name: string }[]>([]);
  const [win, setWin] = useState<FlowWindow>('24h');
  const [selected, setSelected] = useState<FlowNode | null>(null);
  const [fitSignal, setFitSignal] = useState(0);

  useEffect(() => {
    if (!token) return;
    mcpServers
      .list(token)
      .then((list) => setServers(list.map((s) => ({ id: s.id, name: s.name || s.id }))))
      .catch(() => setServers([]));
  }, [token]);

  // The URL owns the server; fall back to the first one and write it back.
  const wanted = params.get('server') ?? '';
  const serverId = useMemo(
    () => (servers.some((s) => s.id === wanted) ? wanted : (servers[0]?.id ?? '')),
    [servers, wanted],
  );
  useEffect(() => {
    if (serverId && serverId !== wanted) router.replace(`${pathname}?server=${encodeURIComponent(serverId)}`);
  }, [serverId, wanted, pathname, router]);

  const onServerChange = useCallback(
    (id: string) => {
      setSelected(null);
      router.replace(`${pathname}?server=${encodeURIComponent(id)}`);
    },
    [pathname, router],
  );
  const onWindowChange = useCallback((w: FlowWindow) => {
    if (WINDOWS.includes(w)) setWin(w);
  }, []);

  const { graph } = useFlowGraph(token, serverId, win);
  const counts = graph ? { nodes: graph.nodes.length, edges: graph.edges.length } : null;

  return (
    <AppShell
      title="Flow"
      maxWidth="100%"
      hideFooter
      actions={
        <FlowToolbar
          servers={servers}
          serverId={serverId}
          onServerChange={onServerChange}
          window={win}
          onWindowChange={onWindowChange}
          onFit={() => setFitSignal((n) => n + 1)}
          counts={counts}
        />
      }
    >
      <div data-testid="flow-root" className="flex h-full min-h-[420px] gap-3">
        <div className="min-w-0 flex-1">
          <FlowCanvas
            graph={graph}
            selectedId={selected?.id ?? null}
            onSelect={setSelected}
            fitSignal={fitSignal}
            fitKey={`${serverId}:${win}`}
          />
        </div>
        {selected && <FlowDrawer node={selected} onClose={() => setSelected(null)} />}
      </div>
    </AppShell>
  );
}

export default function FlowPage() {
  return (
    <Suspense fallback={null}>
      <FlowView />
    </Suspense>
  );
}
