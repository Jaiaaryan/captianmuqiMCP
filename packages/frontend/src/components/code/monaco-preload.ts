'use client';

import { useEffect } from 'react';
import type MonacoImplType from './monaco-impl';

/**
 * The one door to the Monaco chunk (editor core + self-hosted setup). Nothing
 * here imports Monaco statically, so a route that imports this file (or
 * `monaco-field`) carries none of it in its first-load JS.
 */

export type MonacoImplComponent = typeof MonacoImplType;

let loaded: MonacoImplComponent | null = null;
let pending: Promise<MonacoImplComponent> | null = null;

/** The editor component if its chunk has already arrived (render without waiting). */
export function loadedMonaco(): MonacoImplComponent | null {
  return loaded;
}

/** Fetch and evaluate the chunk once; a failed fetch may be retried. Client only. */
export function loadMonaco(): Promise<MonacoImplComponent> {
  pending ??= import('./monaco-impl').then(
    (m) => (loaded = m.default),
    (e: unknown) => {
      pending = null;
      throw e;
    },
  );
  return pending;
}

/**
 * Fetch the chunk when the browser is idle, never before first paint. Creates no
 * editor and starts no worker. Returns a cancel function.
 */
export function preloadMonaco(): () => void {
  if (typeof window === 'undefined' || loaded) return () => {};
  const run = () => void loadMonaco().catch(() => {});
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(run, { timeout: 4000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(run, 1500);
  return () => window.clearTimeout(id);
}

/** `preloadMonaco` while `active` (the Response Processing sheet is open, /sandbox is shown). */
export function useMonacoPreload(active = true) {
  useEffect(() => (active ? preloadMonaco() : undefined), [active]);
}
