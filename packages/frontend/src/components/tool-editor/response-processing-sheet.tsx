'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, MoreHorizontal, Play, Plus, X, Ban, ArrowRightLeft } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { ActionMenu } from '@/components/ui/action-menu';
import { Icon } from './icon';
import { Kbd } from './kbd';
import {
  ACTION_ITEM,
  ACTION_MENU,
  BTN_GHOST,
  BTN_SECONDARY,
  ROW,
  TONE_TEXT,
} from './response-processing-styles';
import {
  OnErrorSelect,
  ProcessingSwitch,
  StatusBadge,
  addStepGroups,
  appendStep,
  useBuiltins,
  type ProcessingSummaryInfo,
} from './response-processing-controls';
import { emptyResponseProcessing, type ResponseProcessingChain } from './response-processing-model';
import type { SheetRequest } from './use-sheet-state';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

/** Menus and lists Radix renders in a portal of their own: focus there stays "inside". */
function inPortalledLayer(el: Element | null): boolean {
  return !!el?.closest('[data-radix-popper-content-wrapper],[role="listbox"],[role="menu"]');
}

/** Page scroll: the app scrolls in its <main>, the document as a fallback. */
function lockScroll(): () => void {
  const targets = [document.documentElement, ...Array.from(document.querySelectorAll<HTMLElement>('main'))];
  const saved = targets.map((el) => ({ el, overflow: el.style.overflow, paddingRight: el.style.paddingRight }));
  for (const el of targets) {
    const gutter = el.offsetWidth - el.clientWidth;
    el.style.overflow = 'hidden';
    if (gutter > 0 && el !== document.documentElement) el.style.paddingRight = `${gutter}px`;
  }
  return () => {
    for (const s of saved) {
      s.el.style.overflow = s.overflow;
      s.el.style.paddingRight = s.paddingRight;
    }
  };
}

/**
 * The frame of the full-width sheet that hosts the Response Processing editor: right-anchored,
 * `min(1480px, 96vw)` wide (the full width at 480px and below), full height, over a
 * scrim. It stays mounted while closed (hidden and inert) so the panel keeps its
 * sample, preview and undo; closing never discards anything.
 *
 * Slides in over 160 ms with the `translate` property, which ends at `none` so the
 * sheet does not become a containing block for Monaco's fixed overflow widgets.
 */
function SheetFrame({
  open,
  onClose,
  onKeyDown,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  children: React.ReactNode;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);

  // Scroll lock, initial focus, focus return.
  useEffect(() => {
    if (!open) return;
    const sheet = sheetRef.current;
    const previous = document.activeElement as HTMLElement | null;
    const unlock = lockScroll();
    // The panel may already have focused a step (opened from a summary row).
    if (sheet && !sheet.contains(document.activeElement)) sheet.focus({ preventScroll: true });
    return () => {
      unlock();
      if (previous && previous.isConnected && !inPortalledLayer(previous)) previous.focus({ preventScroll: true });
    };
  }, [open]);

  // Focus trap: Tab cycles inside; focus that escapes is brought back.
  useEffect(() => {
    if (!open) return;
    const sheet = sheetRef.current;
    if (!sheet) return;
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as Element | null;
      if (!t || sheet.contains(t) || inPortalledLayer(t)) return;
      sheet.focus({ preventScroll: true });
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.defaultPrevented) return;
      const active = document.activeElement;
      if (inPortalledLayer(active)) return;
      const items = Array.from(sheet.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el.getClientRects().length > 0,
      );
      if (items.length === 0) {
        e.preventDefault();
        sheet.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (active === first || active === sheet)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      data-testid="rp-sheet-layer"
      inert={!open}
      aria-hidden={!open || undefined}
      // Above the app sidebar (z-70); the panel's menus and lists open at z-90.
      className="fixed inset-0 z-[80]"
      style={{
        visibility: open ? 'visible' : 'hidden',
        // Visible at once when opening; hidden only after the slide-out.
        transition: open ? 'visibility 0s' : 'visibility 0s linear 160ms',
      }}
    >
      <div
        aria-hidden
        data-testid="rp-sheet-scrim"
        onClick={onClose}
        className="absolute inset-0 bg-[rgba(0,0,0,0.45)] transition-opacity duration-[160ms] ease-out"
        style={{ opacity: open ? 1 : 0 }}
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Response Processing"
        tabIndex={-1}
        data-testid="rp-sheet"
        data-state={open ? 'open' : 'closed'}
        onKeyDown={onKeyDown}
        className="@container/sheet absolute inset-y-0 right-0 flex w-[min(1480px,96vw)] flex-col bg-[var(--bg)] text-[var(--text)] shadow-[-12px_0_40px_rgba(0,0,0,0.35)] outline-none focus-visible:outline-none! max-[481px]:w-screen"
        style={{
          translate: open ? 'none' : '100% 0',
          transition: 'translate 160ms ease-out',
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */
/*  Sheet: frame + header + container-query body                       */
/* ------------------------------------------------------------------ */

interface SheetProps {
  open: boolean;
  onClose: () => void;
  /** Open/land requests (a step to focus, a preview to run) for the panel. */
  onRequest: (req: Omit<SheetRequest, 'nonce'>) => void;
  /** The editor state, shared with the page summary (the tool editor's `responseProcessing`). */
  state: ResponseProcessingChain | null | undefined;
  onChange: (next: ResponseProcessingChain) => void;
  /** Status and per-step problems, as the panel reports them. */
  info: ProcessingSummaryInfo | null;
  /** The chain differs from the last saved tool. */
  unsaved: boolean;
  connectorName?: string;
  toolName?: string;
  /** The panel (steps + response tree). */
  children: React.ReactNode;
}

/**
 * The Response Processing editor as a sheet. The header carries the chain-wide
 * controls (switch, status, unsaved, On error, + Step, Preview, Close); the body is
 * a size container (`@container/rp`) whose width picks the panel's layout band.
 */
export function ResponseProcessingSheet({
  open,
  onClose,
  onRequest,
  state,
  onChange,
  info,
  unsaved,
  connectorName,
  toolName,
  children,
}: SheetProps) {
  const { token } = useAuth();
  const { builtins, maxSteps } = useBuiltins(token);
  const chain = state ?? emptyResponseProcessing();
  const { steps } = chain;
  const on = chain.enabled;
  const status = info?.status ?? null;
  const set = (next: Partial<ResponseProcessingChain>) => onChange({ ...chain, ...next });

  const addGroups = addStepGroups(builtins, steps, (step, script) => {
    onChange(appendStep(chain, step));
    onRequest({ stepId: step.id, ...(script ? {} : { focus: 'reads' as const }) });
  });

  // Below 720px of sheet width `On error` moves into the header's ⋯ menu and the
  // key hints and the Close label go; at 480px and below Step and Preview are icons.
  const narrowOnError = '@max-[720px]/sheet:hidden';
  const wideOnly = '@max-[720px]/sheet:hidden';

  return (
    <SheetFrame
      open={open}
      onClose={onClose}
      onKeyDown={(e) => {
        // ⌘↵ previews from anywhere in the sheet (the panel handles it first inside its body).
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.defaultPrevented && steps.length > 0) {
          e.preventDefault();
          onRequest({ preview: true });
        }
      }}
    >
      {/* header: 60px; from 1100px of sheet width down the breadcrumb takes its own line */}
      <header
        data-testid="rp-sheet-header"
        className="flex h-[60px] flex-none items-center gap-4 px-7 leading-none @max-[1100px]/sheet:h-auto @max-[1100px]/sheet:flex-wrap @max-[1100px]/sheet:gap-x-3 @max-[1100px]/sheet:gap-y-3 @max-[1100px]/sheet:py-3 @max-[481px]/sheet:gap-x-2 @max-[481px]/sheet:px-4"
      >
        <nav
          aria-label="breadcrumb"
          data-testid="rp-sheet-breadcrumb"
          className={`${ROW} min-w-0 shrink gap-1.5 whitespace-nowrap text-sm text-[var(--text-3)] @min-[481px]/sheet:@max-[1100px]/sheet:basis-full @max-[481px]/sheet:order-[-2] @max-[481px]/sheet:basis-[calc(100%-48px)]`}
        >
          {connectorName && (
            <>
              <span className="min-w-0 shrink-[100] truncate">{connectorName}</span>
              <Icon as={ChevronRight} className="shrink-0" />
            </>
          )}
          {toolName && (
            <>
              <span className="min-w-[4ch] shrink truncate font-medium text-[var(--text)]">{toolName}</span>
              <Icon as={ChevronRight} className="shrink-0" />
            </>
          )}
          <span className="min-w-0 shrink-[10] truncate">Response Processing</span>
        </nav>
        <ProcessingSwitch
          on={on}
          onToggle={() => set({ enabled: !on })}
          testId="rp-toggle"
          labelClassName="@max-[481px]/sheet:sr-only"
        />
        {status && <StatusBadge status={status} testId="rp-status" />}
        {unsaved && (
          <span
            data-testid="rp-sheet-unsaved"
            className={`${ROW} h-[26px] shrink-0 whitespace-nowrap rounded-md bg-[var(--surface-2)] px-2.5 text-sm ${TONE_TEXT.warn}`}
          >
            unsaved
          </span>
        )}
        <span className="flex-1" />
        {steps.length > 0 && (
          <OnErrorSelect
            value={chain.onError}
            onChange={(onError) => set({ onError })}
            testId="rp-on-error"
            className={narrowOnError}
          />
        )}
        <ActionMenu
          contentClassName={ACTION_MENU}
          itemClassName={ACTION_ITEM}
          variant="flat"
          align="end"
          label="add step"
          testId="rp-add-step"
          className={`${BTN_SECONDARY} text-sm focus-visible:bg-[var(--surface-2)] data-[state=open]:bg-[var(--surface-3)] @max-[481px]/sheet:px-2.5`}
          disabled={steps.length >= maxSteps}
          groups={addGroups}
          trigger={
            <>
              <Icon as={Plus} />
              <span className="@max-[481px]/sheet:sr-only">Step</span>
            </>
          }
        />
        {steps.length > 0 && (
          <button
            type="button"
            data-testid="rp-preview"
            aria-label="Preview"
            aria-keyshortcuts="Meta+Enter Control+Enter"
            aria-busy={info?.previewing || undefined}
            disabled={!token || info?.previewing}
            onClick={() => onRequest({ preview: true })}
            className={`${BTN_SECONDARY} @max-[481px]/sheet:px-2.5`}
          >
            <Icon as={Play} />
            <span className="@max-[481px]/sheet:sr-only">Preview</span>
            <Kbd className={`text-sm ${wideOnly}`}>⌘↵</Kbd>
          </button>
        )}
        {steps.length > 0 && (
          <span className="hidden @max-[720px]/sheet:inline-flex">
            <ActionMenu
              contentClassName={ACTION_MENU}
              itemClassName={ACTION_ITEM}
              variant="flat"
              align="end"
              label="more"
              testId="rp-sheet-more"
              trigger={<Icon as={MoreHorizontal} size={18} />}
              className={`${ROW} h-9 rounded-md px-2 text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)] data-[state=open]:bg-[var(--surface-2)]`}
              groups={[
                {
                  label: 'On error',
                  items: [
                    { label: 'Fail', icon: <Icon as={Ban} />, tone: 'danger', checked: chain.onError === 'fail', onSelect: () => set({ onError: 'fail' }), testId: 'rp-sheet-more-fail' },
                    { label: 'Pass through', icon: <Icon as={ArrowRightLeft} />, tone: 'warn', checked: chain.onError === 'passthrough', onSelect: () => set({ onError: 'passthrough' }), testId: 'rp-sheet-more-passthrough' },
                  ],
                },
              ]}
            />
          </span>
        )}
        <span
          data-testid="rp-sheet-save-hint"
          aria-keyshortcuts="Meta+S Control+S"
          className={`${ROW} h-9 shrink-0 gap-2 whitespace-nowrap text-sm text-[var(--text-2)] ${wideOnly}`}
        >
          Save
          <Kbd className="text-sm">⌘S</Kbd>
        </span>
        <button
          type="button"
          data-testid="rp-sheet-close"
          aria-label="Close"
          aria-keyshortcuts="Escape"
          onClick={onClose}
          className={`${BTN_GHOST} h-9 shrink-0 px-2.5 @max-[481px]/sheet:order-[-1]`}
        >
          <Icon as={X} />
          <span className={wideOnly}>Close</span>
          <Kbd className={`text-sm ${wideOnly}`}>Esc</Kbd>
        </button>
      </header>

      {/* body: the size container the panel's layout bands answer to */}
      <div
        data-testid="rp-sheet-body"
        className="@container/rp min-h-0 flex-1 overflow-y-auto overscroll-contain px-7 pb-7 pt-2 @max-[481px]/sheet:px-4"
      >
        {children}
      </div>
    </SheetFrame>
  );
}
