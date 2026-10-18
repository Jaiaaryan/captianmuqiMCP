'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, X } from 'lucide-react';
import { Icon } from '@/components/tool-editor/icon';
import { ApiError } from '@/lib/api';

// The drawer's in-place fields: a row per value, saved on blur or toggle, the
// result shown in place (a check for a moment, the API's sentence on failure).

export type SavePhase = 'idle' | 'saving' | 'ok' | 'error';

export interface SaveState {
  phase: SavePhase;
  message?: string;
}

const OK_MS = 1600;

export function errorSentence(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Request failed';
}

/** Runs one save at a time and reports its phase. */
export function useSave(): [SaveState, (fn: () => Promise<unknown>) => Promise<boolean>] {
  const [state, setState] = useState<SaveState>({ phase: 'idle' });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    if (timer.current) clearTimeout(timer.current);
    setState({ phase: 'saving' });
    try {
      await fn();
      setState({ phase: 'ok' });
      timer.current = setTimeout(() => setState({ phase: 'idle' }), OK_MS);
      return true;
    } catch (err) {
      setState({ phase: 'error', message: errorSentence(err) });
      return false;
    }
  }, []);
  return [state, run];
}

/** Check icon after a save, the API sentence after a failure, nothing otherwise. */
export function SaveMark({ state, testId }: { state: SaveState; testId?: string }) {
  if (state.phase === 'ok') {
    return (
      <span role="status" data-testid={testId} data-phase="ok" className="inline-flex text-[var(--t-success-fg)]">
        <Icon as={Check} />
        <span className="sr-only">Saved</span>
      </span>
    );
  }
  if (state.phase === 'saving') {
    return <span role="status" data-testid={testId} data-phase="saving" aria-busy className="inline-flex w-4" />;
  }
  return null;
}

/** The failure sentence under a field. */
export function SaveError({ state, testId }: { state: SaveState; testId?: string }) {
  if (state.phase !== 'error') return null;
  return (
    <div
      role="alert"
      data-testid={testId}
      className="flex items-start gap-1.5 pb-1 text-[14px] font-medium leading-5 text-[var(--t-danger-fg)]"
    >
      <Icon as={X} className="mt-0.5" />
      <span className="min-w-0 break-words">{state.message}</span>
    </div>
  );
}

/** One row: label left, value or control right. */
export function FieldRow({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} className="flex min-h-9 items-center justify-between gap-3 leading-none">
      <span className="shrink-0 text-[14px] text-[var(--text-3)]">{label}</span>
      <span className="flex min-w-0 flex-1 items-center justify-end gap-2">{children}</span>
    </div>
  );
}

/** `On` / `Off` for readers who cannot change the value. */
export function ReadValue({ on, testId }: { on: boolean; testId?: string }) {
  return (
    <span
      data-testid={testId}
      data-state={on ? 'on' : 'off'}
      className={`text-[14px] font-medium ${on ? 'text-[var(--t-success-fg)]' : 'text-[var(--text-3)]'}`}
    >
      {on ? 'On' : 'Off'}
    </span>
  );
}

/** The app's switch (Response Processing look): filled `--ok-fill` when on, the value beside it. */
export function Switch({
  on,
  label,
  onToggle,
  disabled,
  testId,
}: {
  on: boolean;
  label: string;
  onToggle: () => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-testid={testId}
      data-state={on ? 'on' : 'off'}
      disabled={disabled}
      onClick={onToggle}
      className="inline-flex shrink-0 items-center gap-2 rounded-full leading-none outline-none focus-visible:outline-none! focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] disabled:cursor-default disabled:opacity-60"
    >
      <span
        className={`relative h-[22px] w-10 shrink-0 rounded-full transition-colors motion-reduce:transition-none ${
          on ? 'bg-[var(--ok-fill)]' : 'bg-[var(--surface-3)]'
        }`}
      >
        <span
          className={`absolute top-[3px] h-4 w-4 rounded-full shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-[left] motion-reduce:transition-none ${
            on ? 'left-[21px] bg-white' : 'left-[3px] bg-[var(--surface)]'
          }`}
        />
      </span>
      <span className={`w-7 text-left text-[14px] font-medium ${on ? 'text-[var(--t-success-fg)]' : 'text-[var(--text-3)]'}`}>
        {on ? 'On' : 'Off'}
      </span>
    </button>
  );
}

/**
 * A name, saved on blur or Enter when changed. Empty is never saved (the last
 * saved name comes back); Esc restores it too.
 */
export function NameField({
  value,
  label,
  onSave,
  testId,
}: {
  value: string;
  label: string;
  onSave: (next: string) => Promise<boolean>;
  testId?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [saved, setSaved] = useState(value);
  const [busy, setBusy] = useState(false);
  // A new value from outside (another node, a reload) replaces the draft.
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setSaved(value);
    setDraft(value);
  }

  const commit = async () => {
    const next = draft.trim();
    if (!next) {
      setDraft(saved);
      return;
    }
    if (next === saved || busy) {
      setDraft(next);
      return;
    }
    setBusy(true);
    const ok = await onSave(next);
    setBusy(false);
    if (ok) {
      setSaved(next);
      setDraft(next);
    }
    // On failure the typed name stays, next to the API's sentence.
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setDraft(saved);
      // Blur after the restore lands, so blur does not save the old draft.
      const el = e.currentTarget;
      requestAnimationFrame(() => el.blur());
    }
  };

  return (
    <input
      aria-label={label}
      data-testid={testId}
      value={draft}
      readOnly={busy}
      maxLength={200}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={onKeyDown}
      className="h-8 w-full min-w-0 rounded-md bg-[var(--surface-2)] px-2 text-[14px] text-[var(--text)] outline-none focus-visible:outline-none! focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
    />
  );
}
