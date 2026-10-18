'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { mcpServers } from '@/lib/api';
import { AppShell } from '@/components/app-shell';
import { FlowCanvas } from '@/components/flow/flow-canvas';
import { FlowToolbar } from '@/components/flow/flow-toolbar';
import { FlowDrawer } from '@/components/flow/flow-drawer';
import { FlowTimeline } from '@/components/flow/flow-timeline';
import { FlowAskBar } from '@/components/flow/flow-ask-bar';
import { ALL_SERVERS, useFlowGraph } from '@/components/flow/use-flow-graph';
import { useFlowEvents } from '@/components/flow/use-flow-events';
import { useReplay } from '@/components/flow/use-replay';
import { PulseStore, usePrefersReducedMotion } from '@/components/flow/flow-motion';
import type { FlowNode, FlowWindow } from '@/components/flow/types';

const WINDOWS: FlowWindow[] = ['1h', '24h', '7d'];

function FlowView() {
  const { token, user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [servers, setServers] = useState<{ id: string; name: string }[] | null>(null);
  const [win, setWin] = useState<FlowWindow>('24h');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fitSignal, setFitSignal] = useState(0);
  const [pulses] = useState(() => new PulseStore());
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (!token) return;
    mcpServers
      .list(token)
      .then((list) => setServers(list.map((s) => ({ id: s.id, name: s.name || s.id }))))
      .catch(() => setServers([]));
  }, [token]);

  // The URL owns the scope: `?server=<id>` for one server, nothing for all of them
  // (the default). An id that is not in the list falls back to all.
  const wanted = params.get('server') ?? '';
  const scope = useMemo(() => {
    if (!wanted || wanted === ALL_SERVERS) return ALL_SERVERS;
    if (servers && !servers.some((s) => s.id === wanted)) return ALL_SERVERS;
    return wanted;
  }, [servers, wanted]);

  const onServerChange = useCallback(
    (id: string) => {
      setSelectedId(null);
      router.replace(id === ALL_SERVERS ? pathname : `${pathname}?server=${encodeURIComponent(id)}`);
    },
    [pathname, router],
  );
  const onWindowChange = useCallback((w: FlowWindow) => {
    if (WINDOWS.includes(w)) setWin(w);
  }, []);
  const onSelect = useCallback((node: FlowNode | null) => setSelectedId(node?.id ?? null), []);

  const { graph, reload } = useFlowGraph(token, scope, win);
  const events = useFlowEvents(token, scope, win);
  const replay = useReplay(events?.events ?? null, graph, pulses);
  const selected = useMemo(
    () => (selectedId ? (graph?.nodes.find((n) => n.id === selectedId) ?? null) : null),
    [graph, selectedId],
  );
  const counts = graph ? { nodes: graph.nodes.length, edges: graph.edges.length } : null;

  return (
    <AppShell
      title="Flow"
      maxWidth="100%"
      hideFooter
      flush
      actions={
        <FlowToolbar
          servers={servers ?? []}
          serverId={scope}
          onServerChange={onServerChange}
          window={win}
          onWindowChange={onWindowChange}
          onFit={() => setFitSignal((n) => n + 1)}
          counts={counts}
        />
      }
    >
      <div data-testid="flow-root" data-scope={scope} className="relative flex min-h-[420px] flex-1">
        <div className="relative min-w-0 flex-1">
          <FlowCanvas
            graph={graph}
            selectedId={selected?.id ?? null}
            onSelect={onSelect}
            fitSignal={fitSignal}
            fitKey={scope}
            replay={replay.counts}
            pulses={pulses}
            reduced={reduced}
          >
            <FlowTimeline replay={replay} loading={!events} truncated={events?.truncated} from={events?.from} />
            <FlowAskBar token={token} scope={scope} window={win} graph={graph} selected={selected} />
          </FlowCanvas>
        </div>
        {selected && (
          <FlowDrawer
            node={selected}
            onClose={() => setSelectedId(null)}
            token={token}
            role={user?.role}
            onSaved={reload}
          />
        )}
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
