'use client';

import { useMemo } from 'react';
import { Check, X } from 'lucide-react';
import { Icon } from './icon';
import { MonacoField } from '@/components/code/monaco-field';
import { declarationsFromSample } from '@/components/code/dts-from-sample';

type Syntax = { state: 'empty' } | { state: 'ok' } | { state: 'error'; message: string } | { state: 'unknown' };

/** Compile (never run) the body the way the server wraps it. */
export function checkSyntax(code: string): Syntax {
  if (!code.trim()) return { state: 'empty' };
  try {
    // Constructing a Function only parses; nothing is executed.
    new Function('value', 'params', 'response', code);
    return { state: 'ok' };
  } catch (e) {
    if (e instanceof SyntaxError) return { state: 'error', message: e.message };
    return { state: 'unknown' };
  }
}

/** Check icon when it parses, X + `syntax` (message on hover) when not; nothing while empty. */
export function SyntaxMark({ code }: { code: string }) {
  const syntax = useMemo(() => checkSyntax(code), [code]);
  if (syntax.state === 'empty' || syntax.state === 'unknown') return null;
  const error = syntax.state === 'error';
  return (
    <span
      role="img"
      data-state={syntax.state}
      aria-label={error ? `syntax error: ${syntax.message}` : 'syntax ok'}
      title={error ? syntax.message : undefined}
      className={`inline-flex items-center gap-1.5 font-mono text-[12px] ${
        error ? 'font-medium text-[var(--text)]' : 'text-[var(--text-3)]'
      }`}
    >
      <Icon as={error ? X : Check} />
      {error && 'syntax'}
    </span>
  );
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  testId?: string;
  invalid?: boolean;
  /** The tool's recorded response and the step's paths: they type `value` and `response`. */
  sample?: unknown;
  each?: string;
  reads?: string;
  onSubmit?: () => void;
  onEscape?: () => void;
}

/** A script step's body in Monaco, typed from the sample; sized to its content (3–20 lines). */
export function CodeField({ value, onChange, ariaLabel, testId, invalid, sample, each, reads, onSubmit, onEscape }: Props) {
  const extraLibs = useMemo(
    () => [{ path: 'file:///amcp/response-processing.d.ts', content: declarationsFromSample(sample, { each, reads }) }],
    [sample, each, reads],
  );
  return (
    <MonacoField
      className="rounded-md bg-[var(--surface)] px-2 py-2 [&_.amcp-monaco:focus-within]:bg-transparent"
      value={value}
      onChange={onChange}
      language="javascript"
      extraLibs={extraLibs}
      minLines={2}
      maxLines={20}
      fontSize={14}
      lineHeight={22}
      ariaLabel={ariaLabel}
      testId={testId}
      invalid={invalid}
      placeholder="return value;"
      onSubmit={onSubmit}
      onEscape={onEscape}
      snippets="response-processing"
    />
  );
}
