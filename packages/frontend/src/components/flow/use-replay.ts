'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { countsAt, gapBefore, replayIndex, type Speed } from './replay';
import type { PulseStore } from './flow-motion';
import type { FlowEvent, FlowGraph, ReplayCounts } from './types';

interface ReplayState {
  /** The events this state belongs to; another list starts over at its end. */
  of: FlowEvent[] | null;
  /** Events applied so far, 0..length. */
  position: number;
  playing: boolean;
  /** The user has played or scrubbed: the graph shows the replay's counts. */
  active: boolean;
  speed: Speed;
}

export interface Replay {
  total: number;
  position: number;
  playing: boolean;
  active: boolean;
  speed: Speed;
  /** Counts as of the position while active, else null (the window's totals). */
  counts: ReplayCounts | null;
  /** The event last applied, if any. */
  current: FlowEvent | null;
  toggle: () => void;
  seek: (position: number) => void;
  setSpeed: (speed: Speed) => void;
}

const fresh = (events: FlowEvent[] | null, speed: Speed): ReplayState => ({
  of: events,
  position: events?.length ?? 0,
  playing: false,
  active: false,
  speed,
});

/**
 * Plays the window's events on the graph. Moves only when the user presses
 * play, and stops at the end with the final counts; scrubbing pauses.
 */
export function useReplay(events: FlowEvent[] | null, graph: FlowGraph | null, pulses: PulseStore): Replay {
  const [raw, setRaw] = useState<ReplayState>(() => fresh(events, 1));
  const state = raw.of === events ? raw : fresh(events, raw.speed);
  const total = events?.length ?? 0;
  const index = useMemo(() => (graph ? replayIndex(graph) : null), [graph]);

  const update = useCallback(
    (fn: (s: ReplayState) => Partial<ReplayState>) =>
      setRaw((prev) => {
        const base = prev.of === events ? prev : fresh(events, prev.speed);
        return { ...base, ...fn(base) };
      }),
    [events],
  );

  const toggle = useCallback(
    () =>
      update((s) => {
        if (!total) return {};
        if (s.playing) return { playing: false };
        // From the end, play starts over.
        return { playing: true, active: true, position: s.position >= total ? 0 : s.position };
      }),
    [update, total],
  );
  const seek = useCallback(
    (position: number) =>
      update(() => ({ position: Math.max(0, Math.min(total, Math.round(position))), playing: false, active: true })),
    [update, total],
  );
  const setSpeed = useCallback((speed: Speed) => update(() => ({ speed })), [update]);

  const { playing, position, speed } = state;
  useEffect(() => {
    if (!playing || !events || !index || position >= events.length) return;
    const wait = gapBefore(events, position, speed);
    const timer = setTimeout(() => {
      const e = events[position];
      const { edges } = index.path(e);
      pulses.fire(edges, e.status === 'ok' ? 'ok' : 'error', Math.min(900, Math.max(250, 700 / Math.sqrt(speed))));
      update((s) => {
        const next = s.position + 1;
        return { position: next, playing: next < events.length };
      });
    }, wait);
    return () => clearTimeout(timer);
  }, [playing, position, speed, events, index, pulses, update]);

  // Another window or server, or the page going: no pulse outlives its replay.
  useEffect(() => () => pulses.clear(), [events, pulses]);

  const counts = useMemo(
    () => (state.active && events && index ? countsAt(events, index, position) : null),
    [state.active, events, index, position],
  );

  return {
    total,
    position,
    playing,
    active: state.active,
    speed,
    counts,
    current: events && position > 0 ? events[position - 1] : null,
    toggle,
    seek,
    setSpeed,
  };
}
