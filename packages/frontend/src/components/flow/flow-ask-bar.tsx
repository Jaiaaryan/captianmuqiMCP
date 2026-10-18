'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowRight, ChevronDown, ChevronUp, CornerDownLeft, Sparkles } from 'lucide-react';
import { Icon } from '@/components/tool-editor/icon';
import { Kbd } from '@/components/tool-editor/kbd';
import { ApiError, flowApi } from '@/lib/api';
import { askQuestions } from './ask-questions';
import { ALL_SERVERS, type FlowScope } from './use-flow-graph';
import type { FlowGraph, FlowNode, FlowWindow } from './types';

/** Where the workspace's Knowledge Graph AI switch lives. */
export const LLM_SETTINGS_HREF = '/settings/organization';
const ROTATE_MS = 6000;
const MAX_CHARS = 500;

type Msg =
  | { id: number; role: 'q'; text: string }
  | { id: number; role: 'a'; text: string; model: string }
  | { id: number; role: 'err'; text: string };

const ICON_BTN =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--text-2)] outline-none hover:bg-[var(--surface-2)] hover:text-[var(--text)] focus-visible:bg-[var(--surface-2)] focus-visible:outline-none! disabled:text-[var(--text-3)] disabled:hover:bg-transparent';

interface Props {
  token: string | null;
  scope: FlowScope;
  window: FlowWindow;
  graph: FlowGraph | null;
  selected: FlowNode | null;
}

let nextId = 0;

export function FlowAskBar({ token, scope, window: win, graph, selected }: Props) {
  const [llm, setLlm] = useState<'unknown' | 'on' | 'off'>('unknown');
  const [threads, setThreads] = useState<Record<string, Msg[]>>({});
  const [expanded, setExpanded] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [rotation, setRotation] = useState({ key: '', n: 0 });
  const input = useRef<HTMLInputElement>(null);
  const settings = useRef<HTMLAnchorElement>(null);
  const thread = useRef<HTMLDivElement>(null);

  const messages = useMemo(() => threads[scope] ?? [], [threads, scope]);
  const questions = useMemo(() => askQuestions(graph, selected, win), [graph, selected, win]);
  // A new selection starts the rotation over at its own question.
  const rotationKey = `${scope}:${selected?.id ?? ''}`;
  const n = rotation.key === rotationKey ? rotation.n : 0;
  const placeholder = questions[n % questions.length];

  useEffect(() => {
    if (!token) return;
    let current = true;
    flowApi
      .askStatus(token)
      .then((s) => current && setLlm(s.enabled ? 'on' : 'off'))
      .catch(() => current && setLlm('unknown'));
    return () => {
      current = false;
    };
  }, [token]);

  useEffect(() => {
    const t = setInterval(
      () => setRotation((r) => ({ key: rotationKey, n: (r.key === rotationKey ? r.n : 0) + 1 })),
      ROTATE_MS,
    );
    return () => clearInterval(t);
  }, [rotationKey]);

  // ⌘K / Ctrl+K focuses the bar from anywhere on the page.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'k') return;
      e.preventDefault();
      (input.current ?? settings.current)?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (expanded && thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [expanded, messages.length]);

  const push = useCallback(
    (key: string, msg: Msg) => setThreads((t) => ({ ...t, [key]: [...(t[key] ?? []), msg] })),
    [],
  );

  const send = useCallback(async () => {
    const question = value.trim().slice(0, MAX_CHARS);
    if (!token || !question || busy || llm === 'off') return;
    const key = scope;
    setBusy(true);
    setExpanded(true);
    push(key, { id: (nextId += 1), role: 'q', text: question });
    try {
      const res = await flowApi.ask(token, {
        serverId: scope === ALL_SERVERS ? null : scope,
        window: win,
        ...(selected ? { nodeId: selected.id } : {}),
        question,
      });
      push(key, { id: (nextId += 1), role: 'a', text: res.answer, model: res.model });
      setValue('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.body?.code === 'LLM_OFF') {
        setLlm('off');
        push(key, { id: (nextId += 1), role: 'err', text: 'LLM off' });
      } else {
        // The question stays in the input to send again.
        push(key, { id: (nextId += 1), role: 'err', text: err instanceof Error ? err.message : 'Request failed' });
      }
    } finally {
      setBusy(false);
    }
  }, [value, token, busy, llm, scope, win, selected, push]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab' && !e.shiftKey && value === '' && placeholder) {
      e.preventDefault();
      setValue(placeholder);
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (expanded) setExpanded(false);
      else input.current?.blur();
    }
  };

  const off = llm === 'off';
  const hasThread = messages.length > 0;

  return (
    <div
      data-testid="flow-ask"
      data-state={off ? 'off' : busy ? 'busy' : expanded ? 'open' : 'closed'}
      className="pointer-events-auto flex min-w-[240px] max-w-full flex-1 basis-[320px] flex-col rounded-md bg-[var(--surface)] shadow-[var(--shadow)]"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && expanded) {
          e.stopPropagation();
          setExpanded(false);
        }
      }}
    >
      {expanded && hasThread && (
        <div
          ref={thread}
          data-testid="flow-ask-thread"
          role="log"
          aria-label="Answers"
          className="flex max-h-[min(50vh,360px)] flex-col gap-2 overflow-y-auto p-2"
        >
          {messages.map((m) =>
            m.role === 'q' ? (
              <div
                key={m.id}
                data-testid="flow-ask-question"
                className="max-w-[85%] self-end whitespace-pre-wrap break-words rounded-md bg-[var(--surface-2)] px-2.5 py-1.5 font-mono text-[14px] leading-5"
              >
                {m.text}
              </div>
            ) : m.role === 'a' ? (
              <div key={m.id} data-testid="flow-ask-answer" className="max-w-[92%] self-start">
                <div className="whitespace-pre-wrap break-words rounded-md bg-[var(--surface)] px-2.5 py-1.5 text-[14px] leading-5">
                  {m.text}
                </div>
                <div data-testid="flow-ask-model" className="px-2.5 font-mono text-[14px] leading-5 text-[var(--text-3)]">
                  {m.model}
                </div>
              </div>
            ) : (
              <div
                key={m.id}
                role="alert"
                data-testid="flow-ask-error"
                className="max-w-[92%] self-start px-2.5 py-1.5 text-[14px] font-medium leading-5 text-[var(--t-danger-fg)]"
              >
                {m.text}
              </div>
            ),
          )}
        </div>
      )}
      <div aria-busy={busy || undefined} className="flex h-10 items-center gap-1.5 px-2 leading-none">
        <Icon
          as={Sparkles}
          className={busy ? 'animate-pulse text-[var(--text)] motion-reduce:animate-none' : 'text-[var(--text-3)]'}
        />
        {off ? (
          <>
            <input
              data-testid="flow-ask-input"
              aria-label="Ask"
              disabled
              value=""
              readOnly
              placeholder="LLM off"
              className="h-8 min-w-0 flex-1 bg-transparent px-1 text-[14px] outline-none placeholder:text-[var(--text-3)]"
            />
            <Link
              ref={settings}
              href={LLM_SETTINGS_HREF}
              data-testid="flow-ask-settings"
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[14px] text-[var(--text)] outline-none hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] focus-visible:outline-none!"
            >
              Settings
              <Icon as={ArrowRight} />
            </Link>
          </>
        ) : (
          <>
            <input
              ref={input}
              data-testid="flow-ask-input"
              aria-label="Ask"
              aria-keyshortcuts="Meta+K Control+K"
              value={value}
              maxLength={MAX_CHARS}
              readOnly={busy}
              placeholder={placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
              className="h-8 min-w-0 flex-1 rounded-md bg-transparent px-1 text-[14px] text-[var(--text)] outline-none placeholder:text-[var(--text-3)] focus-visible:outline-none!"
            />
            {value === '' && !busy && <Kbd className="hidden text-[14px] sm:inline-flex">⌘K</Kbd>}
            <button
              type="button"
              data-testid="flow-ask-send"
              aria-label="Send"
              aria-keyshortcuts="Enter"
              disabled={busy || value.trim() === '' || !token}
              onClick={() => void send()}
              className={ICON_BTN}
            >
              <Icon as={CornerDownLeft} />
            </button>
          </>
        )}
        {hasThread && (
          <button
            type="button"
            data-testid="flow-ask-toggle"
            aria-label={expanded ? 'Collapse' : 'Expand'}
            aria-expanded={expanded}
            aria-keyshortcuts={expanded ? 'Escape' : undefined}
            onClick={() => setExpanded((x) => !x)}
            className={ICON_BTN}
          >
            <Icon as={expanded ? ChevronDown : ChevronUp} />
          </button>
        )}
      </div>
    </div>
  );
}
