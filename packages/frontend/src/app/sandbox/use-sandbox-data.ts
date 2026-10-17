'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  connectors as connectorsApi,
  mcpServers,
  sandbox,
  type SandboxRunRecord,
  type SandboxScriptSummary,
} from '@/lib/api';
import type { ToolDeclInput } from '@/components/code/dts-from-tools';
import { errorText } from './format';

/**
 * Requests in flight, by key. A second caller for the same key (React StrictMode runs
 * every effect twice in development, or two tabs asking at once) gets the same promise
 * instead of a second request. An entry is dropped as soon as its request settles.
 */
const inflight = new Map<string, Promise<unknown>>();

function shared<T>(key: string, request: () => Promise<T>, fresh = false): Promise<T> {
  if (!fresh) {
    const pending = inflight.get(key);
    if (pending) return pending as Promise<T>;
  }
  const promise: Promise<T> = request().finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

interface Slot<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

const START = { data: null, error: null, loading: true };

/** One connector of the organization with its tools, as GET /api/connectors returns it. */
interface CatalogConnector {
  id: string;
  name: string;
  tools?: { name: string; description?: string | null; parameters?: unknown; outputSchema?: unknown }[];
}

interface ServerDetail {
  id: string;
  name: string;
  connectors?: { connectorId?: string; connector?: { id: string } }[];
}

const RUNS_LIMIT = 50;

/**
 * Everything the Code mode tabs read for one MCP server, fetched once when the page
 * opens and kept while the user switches tabs. Mutations call the matching refresh.
 * The caller keys its subtree by `serverId`, so another server starts from scratch.
 */
export function useSandboxData(serverId: string, token: string) {
  const [scripts, setScripts] = useState<Slot<SandboxScriptSummary[]>>(START);
  const [runs, setRuns] = useState<Slot<SandboxRunRecord[]>>(START);
  const [server, setServer] = useState<Slot<ServerDetail>>(START);
  const [catalog, setCatalog] = useState<Slot<CatalogConnector[]>>(START);
  const [off, setOff] = useState(false);

  const keys = useMemo(
    () => ({
      scripts: `scripts:${serverId}:${token}`,
      runs: `runs:${serverId}:${token}`,
      server: `server:${serverId}:${token}`,
      catalog: `catalog:${token}`,
    }),
    [serverId, token],
  );

  const fetchScripts = useCallback(
    (fresh = false) => shared(keys.scripts, () => sandbox.scripts(serverId, token), fresh),
    [keys, serverId, token],
  );
  const fetchRuns = useCallback(
    (fresh = false) => shared(keys.runs, () => sandbox.runs(serverId, token, RUNS_LIMIT), fresh),
    [keys, serverId, token],
  );

  // State is only set when a request settles, never synchronously inside the effect.
  useEffect(() => {
    let alive = true;
    const settle =
      <T,>(set: (s: Slot<T>) => void, onError?: (err: unknown) => void) =>
      (request: Promise<T>) =>
        request.then(
          (data) => alive && set({ data, error: null, loading: false }),
          (err) => {
            if (!alive) return;
            set({ data: null, error: errorText(err), loading: false });
            onError?.(err);
          },
        );
    void settle(setScripts, (err) => {
      // Code mode can be switched off for the whole instance (SANDBOX_ENABLED=false).
      if (err instanceof ApiError && err.status === 404 && /turned off/i.test(err.message)) setOff(true);
    })(fetchScripts());
    void settle(setRuns)(fetchRuns());
    void settle(setServer)(shared(keys.server, () => mcpServers.get(serverId, token) as Promise<ServerDetail>));
    void settle(setCatalog)(shared(keys.catalog, () => connectorsApi.list(token) as Promise<CatalogConnector[]>));
    return () => {
      alive = false;
    };
  }, [keys, serverId, token, fetchScripts, fetchRuns]);

  /** Re-reads the list after a create, save, delete or run. Resolves when the list is in. */
  const refreshScripts = useCallback(async () => {
    setScripts((s) => ({ ...s, loading: true }));
    try {
      const data = await fetchScripts(true);
      setScripts({ data, error: null, loading: false });
    } catch (err) {
      setScripts((s) => ({ ...s, error: errorText(err), loading: false }));
    }
  }, [fetchScripts]);

  const refreshRuns = useCallback(async () => {
    setRuns((s) => ({ ...s, loading: true }));
    try {
      const data = await fetchRuns(true);
      setRuns({ data, error: null, loading: false });
    } catch (err) {
      setRuns((s) => ({ ...s, error: errorText(err), loading: false }));
    }
  }, [fetchRuns]);

  // The tools of the connectors assigned to this server (the benchmark calls one of them).
  const toolNames = useMemo(() => {
    if (!server.data || !catalog.data) return [];
    const ids = new Set(
      (server.data.connectors ?? []).map((c) => c.connector?.id ?? c.connectorId).filter(Boolean) as string[],
    );
    return catalog.data
      .filter((c) => ids.has(c.id))
      .flatMap((c) => (c.tools ?? []).map((t) => t.name))
      .sort();
  }, [server.data, catalog.data]);

  // Every tool of the organization with its schemas, for the editor's `tools.` completions.
  const catalogTools = useMemo<ToolDeclInput[] | null>(
    () =>
      catalog.data
        ? catalog.data.flatMap((c) =>
            (c.tools ?? []).map((t) => ({
              name: String(t.name),
              description: t.description ?? null,
              parameters: (t.parameters ?? null) as ToolDeclInput['parameters'],
              outputSchema: (t.outputSchema ?? null) as ToolDeclInput['outputSchema'],
            })),
          )
        : catalog.error
          ? []
          : null,
    [catalog.data, catalog.error],
  );

  return {
    off,
    scripts: scripts.data,
    scriptsError: scripts.error,
    scriptsLoading: scripts.loading,
    refreshScripts,
    runs: runs.data,
    runsError: runs.error,
    runsLoading: runs.loading,
    refreshRuns,
    server: server.data,
    serverError: server.error ?? catalog.error,
    serverLoading: server.loading || catalog.loading,
    toolNames,
    catalogTools,
  };
}

export type SandboxData = ReturnType<typeof useSandboxData>;
