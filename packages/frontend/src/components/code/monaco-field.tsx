'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import type { ExtraLib } from './monaco-setup';
import { RP_MODEL_DIR } from './rp-snippets';

export const LINE_HEIGHT = 20;

// Monaco touches `window` on import: client only, loaded on demand.
const MonacoImpl = dynamic(() => import('./monaco-impl'), { ssr: false, loading: () => null });

export interface MonacoFieldProps {
  value: string;
  onChange: (value: string) => void;
  language?: 'javascript' | 'json';
  extraLibs?: ExtraLib[];
  /** Extra TS diagnostic codes to hide (1108, `return` outside a function, always is). */
  ignoreDiagnostics?: number[];
  minLines?: number;
  maxLines?: number;
  ariaLabel: string;
  /**
   * data-testid of the textarea. It is the visible fallback while Monaco loads and,
   * once Monaco is up, an invisible mirror of the model: Playwright's fill() and
   * inputValue() keep working on it. The editor container gets `<testId>-editor`.
   */
  testId?: string;
  placeholder?: string;
  invalid?: boolean;
  /** ⌘↵ / Ctrl↵. Without it the keydown is re-dispatched on the field, so page handlers see it. */
  onSubmit?: () => void;
  /**
   * Esc while no editor widget (suggestions, hover, find) is open. Without it the
   * keydown is re-dispatched on the field, so the page's own Esc handling sees it.
   */
  onEscape?: () => void;
  /** Offer the Response Processing snippets (convert, clean, filter) in this editor. */
  snippets?: 'response-processing';
  className?: string;
}

const MIRROR =
  'pointer-events-none absolute left-0 top-0 h-px w-px resize-none overflow-hidden border-0 p-0 opacity-0';

export function MonacoField({
  value,
  onChange,
  language = 'javascript',
  extraLibs,
  ignoreDiagnostics,
  minLines = 6,
  maxLines = 20,
  ariaLabel,
  testId,
  placeholder,
  invalid,
  onSubmit,
  onEscape,
  snippets,
  className,
}: MonacoFieldProps) {
  const [ready, setReady] = useState(false);
  const rows = Math.min(maxLines, Math.max(minLines, value.split('\n').length));
  return (
    <div className={`relative ${className ?? ''}`} data-ready={ready || undefined}>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        tabIndex={ready ? -1 : undefined}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        data-testid={testId}
        data-mirror={ready || undefined}
        placeholder={placeholder}
        style={ready ? undefined : { lineHeight: `${LINE_HEIGHT}px` }}
        className={
          ready
            ? MIRROR
            : 'block w-full resize-none border-0 bg-transparent px-1.5 py-1 font-mono text-[12.5px] text-[var(--text)] outline-none placeholder:text-[var(--text-3)] focus:bg-[var(--surface-2)] focus-visible:outline-none!'
        }
      />
      <div className={ready ? undefined : 'invisible absolute inset-0'}>
        <MonacoImpl
          value={value}
          onChange={onChange}
          language={language}
          extraLibs={extraLibs}
          ignoreDiagnostics={ignoreDiagnostics}
          minLines={minLines}
          maxLines={maxLines}
          editorLabel="Code editor"
          testId={testId}
          onSubmit={onSubmit}
          onEscape={onEscape}
          modelDir={snippets === 'response-processing' ? RP_MODEL_DIR : '/amcp/'}
          onReady={() => setReady(true)}
        />
      </div>
    </div>
  );
}
