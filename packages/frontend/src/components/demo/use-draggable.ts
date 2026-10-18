'use client';

import { useCallback, useRef, useState, useSyncExternalStore } from 'react';

/** Where the pill rests: against one horizontal edge, `bottom` px above the viewport's bottom. */
export interface DockPosition {
  side: 'left' | 'right';
  bottom: number;
}

const STORAGE_KEY = 'amcp.demo.pill';
/** Pointer travel (px) below which a press is a click, not a drag. */
const DRAG_THRESHOLD = 4;

// 80 px clears the footer row (theme toggle) that sits in the same corner on /sandbox.
export const DEFAULT_DOCK: DockPosition = { side: 'right', bottom: 80 };

// The viewport as an external store: "<w>x<h>", empty on the server.
const subscribeViewport = (cb: () => void) => {
  window.addEventListener('resize', cb);
  return () => window.removeEventListener('resize', cb);
};
const viewportSnapshot = () => `${window.innerWidth}x${window.innerHeight}`;
const noViewport = () => '';

function readDock(): DockPosition {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_DOCK;
    const v = JSON.parse(raw);
    if ((v?.side === 'left' || v?.side === 'right') && Number.isFinite(v?.bottom)) {
      return { side: v.side, bottom: v.bottom };
    }
  } catch {
    // Unreadable or blocked storage: the default corner.
  }
  return DEFAULT_DOCK;
}

function writeDock(dock: DockPosition): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(dock));
  } catch {
    // Storage blocked: the position just does not survive a reload.
  }
}

/**
 * A fixed element dragged with pointer events. While dragging it follows the
 * pointer freely; on release it snaps to the nearest horizontal edge (`inset`
 * px in), keeps its height (clamped into the viewport) and persists that in
 * localStorage. A press that barely moves stays a click: the element's own
 * onClick fires (as it does for Enter and Space), and `takeDragged()` tells it
 * to ignore the click that ends a drag.
 */
export function useDraggable({ width, height, inset }: { width: number; height: number; inset: number }) {
  // Read on the client only; the server render has no viewport, so nothing is placed there.
  const [dock, setDock] = useState<DockPosition>(() => (typeof window === 'undefined' ? DEFAULT_DOCK : readDock()));
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const size2d = useSyncExternalStore(subscribeViewport, viewportSnapshot, noViewport);
  const viewport = size2d ? { w: Number(size2d.split('x')[0]), h: Number(size2d.split('x')[1]) } : null;
  const press = useRef<{ id: number; dx: number; dy: number; sx: number; sy: number; moved: boolean } | null>(null);
  const dragged = useRef(false);

  const clampBottom = useCallback(
    (bottom: number, h: number) => Math.min(Math.max(bottom, inset), Math.max(inset, h - height - inset)),
    [inset, height],
  );

  /** The resting top-left corner for the current dock and viewport. */
  const rest = viewport
    ? {
        x: dock.side === 'left' ? inset : viewport.w - width - inset,
        y: viewport.h - height - clampBottom(dock.bottom, viewport.h),
      }
    : null;

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !rest) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    press.current = { id: e.pointerId, dx: e.clientX - rest.x, dy: e.clientY - rest.y, sx: e.clientX, sy: e.clientY, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    if (!p.moved && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) < DRAG_THRESHOLD) return;
    p.moved = true;
    const w = window.innerWidth;
    const h = window.innerHeight;
    setDrag({
      x: Math.min(Math.max(e.clientX - p.dx, 0), w - width),
      y: Math.min(Math.max(e.clientY - p.dy, 0), h - height),
    });
  };

  const end = (e: React.PointerEvent<HTMLElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    press.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!p.moved) return;
    dragged.current = true;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const x = Math.min(Math.max(e.clientX - p.dx, 0), w - width);
    const y = Math.min(Math.max(e.clientY - p.dy, 0), h - height);
    const next: DockPosition = {
      side: x + width / 2 < w / 2 ? 'left' : 'right',
      bottom: Math.round(clampBottom(h - y - height, h)),
    };
    setDrag(null);
    setDock(next);
    writeDock(next);
  };

  const pos = drag ?? rest;
  return {
    /** Null until mounted (the viewport is unknown during the server render). */
    position: pos,
    dragging: drag !== null,
    dock,
    /** True once after a drag ended: the click that follows it is not a click. */
    takeDragged: () => {
      const was = dragged.current;
      dragged.current = false;
      return was;
    },
    handlers: { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end },
  };
}
