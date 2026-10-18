'use client';

import { useCallback, useEffect, useState } from 'react';
import { AUTH_EXPIRED_EVENT } from '@/lib/api';
import type { FlowGraph, FlowWindow } from './types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

/** `all`: every server of the organization; otherwise one server id. */
export type FlowScope = string;
export const ALL_SERVERS: FlowScope = 'all';

export interface UseFlowGraph {
  graph: FlowGraph | null;
  loading: boolean;
  /** Set when the request failed. */
  error: string | null;
  /** Fetch the same scope and window again; the current graph stays until the answer lands. */
  reload: () => void;
}

interface Settled {
  key: string;
  scope: FlowScope;
  graph: FlowGraph | null;
  error: string | null;
}

/** The query of a scope: no serverId for every server. */
export function scopeQuery(scope: FlowScope, extra: Record<string, string>): string {
  const qs = new URLSearchParams(extra);
  if (scope && scope !== ALL_SERVERS) qs.set('serverId', scope);
  return qs.toString();
}

/** Fetches `GET /api/flow`. A failure leaves `graph` null instead of throwing. */
export function useFlowGraph(token: string | null, scope: FlowScope, since: FlowWindow): UseFlowGraph {
  const [settled, setSettled] = useState<Settled | null>(null);
  const [nonce, setNonce] = useState(0);
  const key = `${scope}:${since}`;
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!token || !scope) return;
    const ctrl = new AbortController();
    fetch(`${API_BASE}/api/flow?${scopeQuery(scope, { since })}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    })
      .then(async (res) => {
        if (res.status === 401) window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as FlowGraph;
        if (!body || !Array.isArray(body.nodes) || !Array.isArray(body.edges)) throw new Error('shape');
        setSettled({ key, scope, graph: body, error: null });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setSettled({ key, scope, graph: null, error: err instanceof Error ? err.message : 'error' });
      });
    return () => ctrl.abort();
  }, [token, scope, since, key, nonce]);

  // Nothing to fetch without a session and a scope.
  if (!token || !scope) return { graph: null, loading: false, error: null, reload };
  // Another window of the same scope: keep showing the last graph (the view
  // stays where the user left it) until the new one lands. Another scope: nothing.
  if (!settled || settled.key !== key) {
    const keep = settled && settled.scope === scope ? settled.graph : null;
    return { graph: keep, loading: true, error: null, reload };
  }
  return { graph: settled.graph, loading: false, error: settled.error, reload };
}
