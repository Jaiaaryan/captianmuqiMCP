'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExtraLib } from './monaco-setup';
import { RP_MODEL_DIR } from './rp-snippets';
import { FONT_FAMILY, FONT_SIZE, LINE_HEIGHT, PAD, SCROLLBAR, TEXT_LEFT, editorHeight } from './monaco-layout';
import { loadMonaco, preloadMonaco, type MonacoImplComponent } from './monaco-preload';
import { useTabPlaceholder } from '@/lib/use-tab-placeholder';

export { LINE_HEIGHT } from './monaco-layout';

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
   * data-testid of the textarea: an invisible mirror of the text, the keyboard
   * target while Monaco loads, and what Playwright's fill() and inputValue() use.
   * The editor container gets `<testId>-editor`.
   */
  testId?: string;
  /** Ghost text (`--text-3`) while the field is empty; Tab inserts it. */
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
  /** Editor text size and line height in px (defaults 12.5 / 20). */
  fontSize?: number;
  lineHeight?: number;
}

const MIRROR =
  'pointer-events-none absolute left-0 top-0 h-px w-px resize-none overflow-hidden border-0 p-0 opacity-0';
/** Only if the Monaco chunk cannot be fetched: the mirror becomes a plain visible textarea. */
const FALLBACK =
  'block w-full resize-none border-0 bg-transparent px-1.5 py-1 font-mono text-[var(--text)] outline-none placeholder:text-[var(--text-3)] focus-visible:outline-none!';

/** Character offset under the pointer inside the stand-in's single text node, else the end. */
function offsetAt(x: number, y: number, pre: HTMLElement | null, max: number): number {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  let node: Node | null = null;
  let offset = max;
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (pos) {
    node = pos.offsetNode;
    offset = pos.offset;
  } else {
    const range = doc.caretRangeFromPoint?.(x, y);
    if (range) {
      node = range.startContainer;
      offset = range.startOffset;
    }
  }
  if (!node || !pre?.contains(node) || node.nodeType !== Node.TEXT_NODE) return max;
  return Math.min(offset, max);
}

/**
 * Monaco, fetched the first time the field comes into view (or takes focus).
 * Until then a stand-in with the editor's size, font, padding and text; the
 * swap moves nothing. A field mounted out of view (the closed Response
 * Processing sheet) only prefetches the chunk when the browser is idle.
 */
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
  fontSize = FONT_SIZE,
  lineHeight = LINE_HEIGHT,
}: MonacoFieldProps) {
  const [ready, setReady] = useState(false);
  // Without IntersectionObserver every field counts as in view.
  const [wanted, setWanted] = useState(() => typeof window !== 'undefined' && typeof IntersectionObserver === 'undefined');
  const [failed, setFailed] = useState(false);
  const [Impl, setImpl] = useState<MonacoImplComponent | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // In view → wanted. Zero-area (edge-adjacent) intersections do not count: the
  // closed sheet sits just past the viewport's right edge.
  useEffect(() => {
    if (wanted) return;
    const el = boxRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting && e.intersectionRatio > 0)) setWanted(true);
      },
      { rootMargin: '200px 0px', threshold: [0, 0.01] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [wanted]);

  useEffect(() => {
    if (Impl || failed) return;
    if (!wanted) return preloadMonaco();
    let live = true;
    loadMonaco().then(
      (component) => live && setImpl(() => component),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [wanted, Impl, failed]);

  /** Focus and caret the user put in the stand-in; null if focus is elsewhere (never steal it). */
  const claimFocus = useCallback((): [number, number] | null => {
    const input = inputRef.current;
    if (!input || document.activeElement !== input) return null;
    return [input.selectionStart, input.selectionEnd];
  }, []);

  // Tab in the empty stand-in (or the fallback) accepts the placeholder, as the editor does.
  const tab = useTabPlaceholder<HTMLTextAreaElement>({ value, placeholder, onAccept: onChange });
  const standIn = !ready && !failed;
  const rows = Math.min(maxLines, Math.max(minLines, value.split('\n').length));
  // A trailing newline still gets its (empty) line, as in the editor.
  const shown = value.endsWith('\n') ? `${value}\u200b` : value;

  return (
    <div className={`relative ${className ?? ''}`} data-ready={ready || undefined}>
      {/* One element for the textarea's whole life, so focus survives the swap. */}
      <div
        ref={boxRef}
        onMouseDown={
          standIn
            ? (e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                const at = offsetAt(e.clientX, e.clientY, preRef.current, value.length);
                inputRef.current?.focus({ preventScroll: true });
                inputRef.current?.setSelectionRange(at, at);
                setWanted(true);
              }
            : undefined
        }
        className={
          ready
            ? 'absolute left-0 top-0 h-px w-px overflow-hidden'
            : failed
              ? 'relative'
              : 'amcp-monaco relative w-full cursor-text overflow-hidden focus-within:bg-[var(--surface-2)]'
        }
        style={
          standIn
            ? {
                minHeight: editorHeight(minLines, minLines, maxLines, lineHeight),
                maxHeight: editorHeight(maxLines, minLines, maxLines, lineHeight),
              }
            : undefined
        }
      >
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={tab.onKeyDown}
          onFocus={() => {
            setWanted(true);
            tab.onFocus();
          }}
          onBlur={tab.onBlur}
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
          style={failed ? { lineHeight: `${lineHeight}px`, fontSize } : undefined}
          className={failed ? FALLBACK : MIRROR}
        />
        {standIn && (
          <pre
            ref={preRef}
            aria-hidden
            className="m-0 whitespace-pre-wrap text-[var(--text)] [overflow-wrap:anywhere]"
            style={{
              fontFamily: FONT_FAMILY,
              fontSize,
              lineHeight: `${lineHeight}px`,
              fontFeatureSettings: '"liga" 0, "calt" 0',
              tabSize: 2,
              padding: `${PAD / 2}px ${SCROLLBAR}px ${PAD / 2}px ${TEXT_LEFT}px`,
            }}
          >
            {value === '' && placeholder ? <span className="text-[var(--text-3)]">{placeholder}</span> : shown}
          </pre>
        )}
      </div>
      {Impl && wanted && (
        <div className={ready ? undefined : 'invisible absolute inset-0'}>
          <Impl
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
            claimFocus={claimFocus}
            placeholder={placeholder}
            fontSize={fontSize}
            lineHeight={lineHeight}
          />
        </div>
      )}
    </div>
  );
}
