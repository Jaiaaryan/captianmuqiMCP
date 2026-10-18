'use client';

import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';

// Replay pulses: which edges are lit right now. Each edge subscribes to its own
// id, so a pulse re-renders the edges it travels and nothing else.

export type PulseTone = 'ok' | 'error';

export interface Pulse {
  /** Bumped per pulse; keys the animated path so the animation restarts. */
  n: number;
  tone: PulseTone;
  ms: number;
}

export class PulseStore {
  private pulses = new Map<string, Pulse>();
  private listeners = new Map<string, Set<() => void>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private n = 0;

  subscribe = (id: string, fn: () => void): (() => void) => {
    const set = this.listeners.get(id) ?? new Set();
    set.add(fn);
    this.listeners.set(id, set);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(id);
    };
  };

  get = (id: string): Pulse | null => this.pulses.get(id) ?? null;

  /** Light `ids` for `ms`; an edge lit again restarts. */
  fire(ids: string[], tone: PulseTone, ms: number): void {
    for (const id of ids) {
      this.n += 1;
      this.pulses.set(id, { n: this.n, tone, ms });
      clearTimeout(this.timers.get(id));
      this.timers.set(
        id,
        setTimeout(() => {
          this.pulses.delete(id);
          this.timers.delete(id);
          this.emit(id);
        }, ms),
      );
      this.emit(id);
    }
  }

  clear(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    const ids = [...this.pulses.keys()];
    this.pulses.clear();
    for (const id of ids) this.emit(id);
  }

  private emit(id: string): void {
    for (const fn of this.listeners.get(id) ?? []) fn();
  }
}

export interface FlowMotion {
  pulses: PulseStore | null;
  /** prefers-reduced-motion: static colour, no animation. */
  reduced: boolean;
  /** No call at all in the window: every edge in --border. */
  empty: boolean;
}

export const FlowMotionContext = createContext<FlowMotion>({ pulses: null, reduced: false, empty: false });

const NO_PULSE = () => null;
const NOOP = () => () => undefined;

/** The pulse on edge `id`, or null. */
export function usePulse(id: string | undefined): Pulse | null {
  const { pulses } = useContext(FlowMotionContext);
  return useSyncExternalStore(
    pulses && id ? (fn) => pulses.subscribe(id, fn) : NOOP,
    pulses && id ? () => pulses.get(id) : NO_PULSE,
    NO_PULSE,
  );
}

const QUERY = '(prefers-reduced-motion: reduce)';

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return reduced;
}
