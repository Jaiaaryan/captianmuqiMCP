'use client';

import { useEffect, useState } from 'react';
import { flowApi } from '@/lib/api';
import { ALL_SERVERS, type FlowScope } from './use-flow-graph';
import type { FlowEvents, FlowWindow } from './types';

interface Settled {
  key: string;
  events: FlowEvents | null;
}

/**
 * The replay events of a scope and window, fetched once per pair (an edit
 * that reloads the graph does not refetch them). Null while loading or on error.
 */
export function useFlowEvents(token: string | null, scope: FlowScope, since: FlowWindow): FlowEvents | null {
  const [settled, setSettled] = useState<Settled | null>(null);
  const key = `${scope}:${since}`;

  useEffect(() => {
    if (!token || !scope) return;
    let current = true;
    flowApi
      .events(token, { serverId: scope === ALL_SERVERS ? undefined : scope, since })
      .then((body) => {
        if (current) setSettled({ key, events: body && Array.isArray(body.events) ? body : null });
      })
      .catch(() => {
        if (current) setSettled({ key, events: null });
      });
    return () => {
      current = false;
    };
  }, [token, scope, since, key]);

  return settled && settled.key === key ? settled.events : null;
}
