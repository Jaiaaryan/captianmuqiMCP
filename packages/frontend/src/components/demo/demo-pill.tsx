'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { usePathname } from 'next/navigation';
import { FlaskConical } from 'lucide-react';
import { demo as demoApi, type DemoControl } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Icon } from '@/components/tool-editor/icon';
import { cn } from '@/lib/utils';
import { DemoPanel } from './demo-panel';
import { useDraggable } from './use-draggable';

const HEIGHT = 38;
/** Until the pill has been measured: icon, label, dot and padding at 14px. */
const DEFAULT_WIDTH = 102;
const INSET = 24;
const GAP = 8;
const HIDE_KEY = 'amcp.demo.pill.hiddenUntil';
const HIDE_MS = 60 * 60 * 1000;

/** The card material shared by the pill and its panel: opaque, no blur. */
export const PILL_SHADOW =
  'shadow-[0_1px_2px_rgba(0,0,0,.08),0_6px_16px_rgba(0,0,0,.10)] ' +
  'dark:shadow-[0_1px_2px_rgba(0,0,0,.18),0_6px_16px_rgba(0,0,0,.22)]';

function hiddenUntil(): number {
  try {
    const v = Number(localStorage.getItem(HIDE_KEY));
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

/**
 * The demo control: a draggable pill on every page for every signed-in user
 * (never on /login), whether demo mode is on or off: it is the switch. Renders
 * nothing where demo mode does not exist (Cloud).
 */
export function DemoPill() {
  const pathname = usePathname();
  const { token, user, isLoading } = useAuth();
  const [control, setControl] = useState<DemoControl | null>(null);
  // Hidden until this time (ms). The server render shows nothing anyway (not signed in yet).
  const [until, setUntil] = useState<number>(() => (typeof window === 'undefined' ? 0 : hiddenUntil()));
  const [now, setNow] = useState<number>(() => Date.now());
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const { position, dragging, dock, takeDragged, handlers } = useDraggable({ width, height: HEIGHT, inset: INSET });

  const signedIn = !isLoading && !!token && !!user;

  const refresh = useCallback(async (): Promise<void> => {
    if (!token) return;
    try {
      setControl(await demoApi.control(token));
    } catch {
      // Keep what we had; a failed read never shows a wrong state as fresh.
    }
  }, [token]);

  // Once per mount (and per session); every panel action refreshes again.
  useEffect(() => {
    if (!signedIn || !token) return;
    let live = true;
    demoApi
      .control(token)
      .then((c) => {
        if (live) setControl(c);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [signedIn, token]);

  // The pill's real width, so it snaps flush to the edge.
  const measure = useCallback((el: HTMLButtonElement | null) => {
    pillRef.current = el;
    observer.current?.disconnect();
    observer.current = null;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(Math.ceil(el.offsetWidth) || DEFAULT_WIDTH));
    ro.observe(el);
    observer.current = ro;
  }, []);

  // "Hide 1h": back by itself when the hour is up, also without a reload.
  useEffect(() => {
    const left = until - Date.now();
    if (left <= 0) return;
    const t = setTimeout(() => setNow(Date.now()), Math.min(left + 50, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [until]);
  const hidden = until > now;

  const close = useCallback(() => {
    setOpen(false);
    pillRef.current?.focus();
  }, []);

  // Esc closes; so does a press outside the pill and the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || pillRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    panelRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open, close]);

  const hide = () => {
    const t = Date.now();
    try {
      localStorage.setItem(HIDE_KEY, String(t + HIDE_MS));
    } catch {
      // Storage blocked: hidden until the next reload only.
    }
    setOpen(false);
    setNow(t);
    setUntil(t + HIDE_MS);
  };

  if (pathname === '/login' || !signedIn || hidden || !control?.available || !position) return null;

  // The panel shares the pill's outer edge; above it in the lower half of the screen, below it otherwise.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const panelStyle: CSSProperties = {
    ...(dock.side === 'left' ? { left: position.x } : { right: Math.max(0, vw - position.x - width) }),
    ...(position.y + HEIGHT / 2 > vh / 2 ? { bottom: vh - position.y + GAP } : { top: position.y + HEIGHT + GAP }),
    maxHeight: `calc(100dvh - ${INSET * 2}px)`,
    overflowY: 'auto',
  };

  return (
    <>
      <button
        ref={measure}
        type="button"
        aria-label={`Demo mode ${control.enabled ? 'on' : 'off'}`}
        aria-expanded={open}
        aria-controls={open ? 'demo-panel' : undefined}
        data-testid="demo-pill"
        data-side={dock.side}
        data-enabled={control.enabled ? 'true' : 'false'}
        {...handlers}
        onClick={() => {
          if (takeDragged()) return;
          setOpen((o) => !o);
        }}
        style={{ left: position.x, top: position.y, height: HEIGHT, touchAction: 'none' }}
        className={cn(
          'fixed z-[60] inline-flex select-none items-center gap-2 rounded-full bg-[var(--surface)] pl-3 pr-3.5',
          'text-[14px] font-medium leading-none text-[var(--text)]',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--text-2)]',
          dragging ? 'cursor-grabbing' : 'cursor-grab transition-[left,top] duration-200 ease-out',
          PILL_SHADOW,
        )}
      >
        <Icon as={FlaskConical} />
        <span>Demo</span>
        <span
          aria-hidden
          data-testid="demo-pill-dot"
          className={cn('h-2 w-2 shrink-0 rounded-full', control.enabled ? 'bg-[var(--ok-fill)]' : 'bg-[var(--text-3)]')}
        />
      </button>
      {open && (
        <DemoPanel
          ref={panelRef}
          control={control}
          onRefresh={refresh}
          style={panelStyle}
          onClose={close}
          onHide={hide}
        />
      )}
    </>
  );
}
