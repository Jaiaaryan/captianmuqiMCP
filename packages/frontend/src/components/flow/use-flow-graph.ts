'use client';

import { useEffect, useState } from 'react';
import { AUTH_EXPIRED_EVENT } from '@/lib/api';
import type { FlowGraph, FlowWindow } from './types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

export interface UseFlowGraph {
  graph: FlowGraph | null;
  loading: boolean;
  /** Set when the request failed (404 until the backend route exists). */
  error: string | null;
}

interface Settled {
  key: string;
  graph: FlowGraph | null;
  error: string | null;
}

const IDLE: UseFlowGraph = { graph: null, loading: false, error: null };

/** Fetches `GET /api/flow`. A failure leaves `graph` null instead of throwing. */
export function useFlowGraph(token: string | null, serverId: string, since: FlowWindow): UseFlowGraph {
  const [settled, setSettled] = useState<Settled | null>(null);
  const key = `${serverId}:${since}`;

  useEffect(() => {
    if (!token || !serverId) return;
    const ctrl = new AbortController();
    const qs = new URLSearchParams({ serverId, since });
    fetch(`${API_BASE}/api/flow?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    })
      .then(async (res) => {
        if (res.status === 401) window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as FlowGraph;
        if (!body || !Array.isArray(body.nodes) || !Array.isArray(body.edges)) throw new Error('shape');
        setSettled({ key, graph: body, error: null });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setSettled({ key, graph: null, error: err instanceof Error ? err.message : 'error' });
      });
    return () => ctrl.abort();
  }, [token, serverId, since, key]);

  // Nothing to fetch without a session and a server.
  if (!token || !serverId) return IDLE;
  // A result for another server or window is stale: show nothing until the new one lands.
  if (!settled || settled.key !== key) return { graph: null, loading: true, error: null };
  return { graph: settled.graph, loading: false, error: settled.error };
}
