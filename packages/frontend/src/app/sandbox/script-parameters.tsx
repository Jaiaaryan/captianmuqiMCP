'use client';

/*
 * INSERTION FOR scripts-tab.tsx (the editor of the saved-script form owns it; this
 * file is self-contained and changes nothing there by itself).
 *
 * 1. Imports:
 *      import type { SandboxParametersSchema } from '@/lib/api';
 *      import { ScriptParameters } from './script-parameters';
 *
 * 2. State: the draft gains one field.
 *      draft: { name; description; code; uses; parameters: SandboxParametersSchema | null }
 *      startNew():  setDraft({ ..., parameters: null })
 *      startEdit(): setDraft({ ..., parameters: detail.parameters })
 *
 * 3. Placement: directly under the code editor, in the 'new' and 'edit' modes
 *      <ScriptParameters
 *        code={draft.code}
 *        value={draft.parameters}
 *        onChange={(parameters) => setDraft((d) => ({ ...d, parameters }))}
 *        disabled={saving}
 *      />
 *    and read-only in 'view' mode (under the code):
 *      <ScriptParameters code={detail.code} value={detail.parameters} onChange={() => {}} readOnly />
 *
 * 4. save(): send the field with the other draft values.
 *      sandbox.createScript(serverId, { ..., parameters: draft.parameters }, token)
 *      sandbox.updateScript(detail!.id, { ..., parameters: draft.parameters }, token)
 *
 * The server merges the names the code reads into whatever is sent, so `null`
 * (nothing edited yet) is fine: the names found become required strings.
 */

import { useMemo } from 'react';
import { Check, ChevronDown, Circle, CircleDot } from 'lucide-react';
import type { SandboxParameter, SandboxParametersSchema } from '@/lib/api';
import { cn } from '@/lib/utils';
import { AppSelect } from '@/components/ui/select';
import { Icon } from '@/components/tool-editor/icon';
import { CELL, CONTENT, ITEM, TRIGGER } from '@/components/tool-editor/response-processing-styles';

// ---- name inference ----------------------------------------------------------
// A copy of inferParameters in packages/backend/src/sandbox/script-parameters.util.ts
// (regexes and helpers verbatim). Keep the two in sync: the server decides what is
// stored, this only previews which names the code reads.

function maskNonCode(code: string): string {
  const out = code.split('');
  const n = code.length;
  const blank = (from: number, to: number, ch: string) => {
    for (let k = from; k < to; k++) if (code[k] !== '\n') out[k] = ch;
  };
  /** Brace depth at the `${` of each open template substitution. */
  const substitutions: number[] = [];
  let depth = 0;

  /** Masks template text from `start`; stops after the closing backtick or after a `${`. */
  const scanTemplate = (start: number) => {
    let j = start;
    while (j < n) {
      if (code[j] === '\\') {
        j += 2;
        continue;
      }
      if (code[j] === '`') {
        blank(start, j, 's');
        return { end: j + 1, opened: false };
      }
      if (code[j] === '$' && code[j + 1] === '{') {
        blank(start, j, 's');
        return { end: j + 2, opened: true };
      }
      j++;
    }
    blank(start, n, 's');
    return { end: n, opened: false };
  };
  const enterTemplate = (start: number) => {
    const scanned = scanTemplate(start);
    if (scanned.opened) {
      substitutions.push(depth);
      depth++;
    }
    return scanned.end;
  };

  let i = 0;
  while (i < n) {
    const c = code[i];
    const next = code[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && code[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      blank(i, stop, ' ');
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && code[j] !== c && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1;
      const stop = Math.min(j, n);
      blank(i + 1, stop, 's');
      i = j + 1;
      continue;
    }
    if (c === '`') {
      i = enterTemplate(i + 1);
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (substitutions.length > 0 && depth === substitutions[substitutions.length - 1]) {
        substitutions.pop();
        i = enterTemplate(i + 1);
        continue;
      }
    }
    i++;
  }
  return out.join('');
}

const PARAMETER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const NOT_ARGUMENTS = new Set([
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
  '__proto__',
]);
const ARGS_DOT = /(?<![\w$.])args\s*\??\.\s*([A-Za-z_$][\w$]*)/g;
const ARGS_BRACKET = /(?<![\w$.])args\s*\[\s*(["'])(s*)\1\s*\]/g;
const DESTRUCTURE_START = /(?<![\w$.])(?:const|let|var)\s*\{/g;
const DESTRUCTURE_FROM_ARGS = /^\s*=\s*args(?![\w$.])/;

const isName = (name: string) => PARAMETER_NAME_PATTERN.test(name) && !NOT_ARGUMENTS.has(name);

function closingBrace(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

function destructuredKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let start = 0;
  const take = (end: number) => {
    const part = body.slice(start, end).trim();
    start = end + 1;
    const key = /^([A-Za-z_$][\w$]*)\s*(?:[:=,]|$)/.exec(part)?.[1];
    if (key) keys.push(key);
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) take(i);
  }
  take(body.length);
  return keys;
}

export function inferParameterNames(code: string): string[] {
  const masked = maskNonCode(code);
  const found: { name: string; at: number }[] = [];

  for (const m of masked.matchAll(ARGS_DOT)) {
    found.push({ name: m[1], at: m.index });
  }
  for (const m of masked.matchAll(ARGS_BRACKET)) {
    const open = m.index + m[0].indexOf(m[1]);
    found.push({ name: code.slice(open + 1, open + 1 + m[2].length), at: m.index });
  }
  for (const m of masked.matchAll(DESTRUCTURE_START)) {
    const open = m.index + m[0].length - 1;
    const close = closingBrace(masked, open);
    if (close < 0 || !DESTRUCTURE_FROM_ARGS.test(masked.slice(close + 1))) continue;
    for (const name of destructuredKeys(masked.slice(open + 1, close))) {
      found.push({ name, at: m.index });
    }
  }

  const names: string[] = [];
  for (const { name } of found.sort((a, b) => a.at - b.at)) {
    if (isName(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

// ---- component -----------------------------------------------------------------

const TYPES: SandboxParameter['type'][] = ['string', 'number', 'integer', 'boolean', 'array', 'object'];
const DESCRIPTION_MAX = 500;

interface Row {
  name: string;
  /** In the code now. A row that is not will be dropped on save, unless kept. */
  inCode: boolean;
  def: SandboxParameter;
  required: boolean;
}

const TH = 'h-6 px-1 text-left align-middle font-normal text-[var(--text-3)]';
const TD = 'h-7 px-0 align-middle';
const TEXT = 'block truncate px-1 text-[12.5px]';
const CHEVRON = <Icon as={ChevronDown} className="text-[var(--text-3)]" />;

export function ScriptParameters({
  code,
  value,
  onChange,
  disabled,
  readOnly,
}: {
  code: string;
  value: SandboxParametersSchema | null;
  onChange: (next: SandboxParametersSchema | null) => void;
  disabled?: boolean;
  /** Shows the values as text: the saved script, not a form. */
  readOnly?: boolean;
}) {
  const rows = useMemo<Row[]>(() => {
    const inferred = inferParameterNames(code);
    const known = value?.properties ?? {};
    const required = new Set(value?.required ?? []);
    // A name the code reads and nothing sets yet is a required string, as the server saves it.
    const fresh = (name: string, inCode: boolean): Row => ({
      name,
      inCode,
      def: known[name] ?? { type: 'string' },
      required: name in known ? required.has(name) : true,
    });
    return [
      ...inferred.map((name) => fresh(name, true)),
      ...Object.keys(known)
        .filter((name) => !inferred.includes(name))
        .map((name) => fresh(name, false)),
    ];
  }, [code, value]);

  const commit = (name: string, patch: { type?: SandboxParameter['type']; required?: boolean; description?: string }) => {
    const properties: Record<string, SandboxParameter> = {};
    const required: string[] = [];
    for (const row of rows) {
      let def = row.def;
      let isRequired = row.required;
      if (row.name === name) {
        if (patch.type !== undefined && patch.type !== def.type) {
          // Enum and items belong to the old type.
          const { enum: _enum, items: _items, ...rest } = def;
          def = { ...rest, type: patch.type };
        }
        if (patch.description !== undefined) {
          const { description: _description, ...rest } = def;
          def = patch.description === '' ? rest : { ...rest, description: patch.description };
        }
        if (patch.required !== undefined) isRequired = patch.required;
      }
      properties[row.name] = def;
      if (isRequired) required.push(row.name);
    }
    onChange(rows.length === 0 ? null : { type: 'object', properties, required });
  };

  return (
    <section data-testid="sp-root" aria-label="Parameters" className="mt-2 text-[12.5px]">
      <div className="flex h-6 items-center gap-1.5 px-1 text-[var(--text-2)]">
        <span>Parameters · {rows.length > 0 ? 'exposed as tool' : '—'}</span>
        {rows.length > 0 && <Icon as={Check} className="text-[var(--text)]" />}
      </div>
      {rows.length > 0 && (
        <table className="w-full table-fixed border-collapse">
          <thead>
            <tr>
              <th className={cn(TH, 'w-[22%]')}>name</th>
              <th className={cn(TH, 'w-[112px]')}>type</th>
              <th className={cn(TH, 'w-[88px]')}>required</th>
              <th className={TH}>description</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name} data-testid={`sp-row-${row.name}`} className="hover:bg-[var(--surface-2)]">
                <td className={TD}>
                  <span
                    className={cn(TEXT, 'font-mono', row.inCode ? 'text-[var(--text)]' : 'text-[var(--text-3)]')}
                    title={row.inCode ? row.name : `${row.name} (the code no longer reads it)`}
                  >
                    {row.name}
                  </span>
                </td>
                <td className={TD}>
                  {readOnly ? (
                    <span className={cn(TEXT, 'font-mono text-[var(--text-2)]')} data-testid={`sp-type-${row.name}`}>
                      {row.def.type}
                    </span>
                  ) : (
                    <AppSelect
                      aria-label={`Type of ${row.name}`}
                      testId={`sp-type-${row.name}`}
                      value={row.def.type}
                      disabled={disabled}
                      onValueChange={(v) => commit(row.name, { type: v as SandboxParameter['type'] })}
                      options={TYPES.map((t) => ({ value: t, label: t }))}
                      className={cn(TRIGGER, 'font-mono')}
                      chevron={CHEVRON}
                      contentClassName={CONTENT}
                      itemClassName={cn(ITEM, 'font-mono')}
                    />
                  )}
                </td>
                <td className={TD}>
                  {readOnly ? (
                    <span className={cn(TEXT, 'font-mono text-[var(--text-2)]')} data-testid={`sp-required-${row.name}`}>
                      {String(row.required)}
                    </span>
                  ) : (
                    <AppSelect
                      aria-label={`${row.name} is required`}
                      testId={`sp-required-${row.name}`}
                      value={row.required ? 'true' : 'false'}
                      disabled={disabled}
                      onValueChange={(v) => commit(row.name, { required: v === 'true' })}
                      options={[
                        { value: 'true', label: 'true', icon: <Icon as={CircleDot} /> },
                        { value: 'false', label: 'false', icon: <Icon as={Circle} /> },
                      ]}
                      className={cn(TRIGGER, 'font-mono')}
                      chevron={CHEVRON}
                      contentClassName={CONTENT}
                      itemClassName={cn(ITEM, 'font-mono')}
                    />
                  )}
                </td>
                <td className={TD}>
                  {readOnly ? (
                    <span className={cn(TEXT, 'text-[var(--text-2)]')} title={row.def.description} data-testid={`sp-desc-${row.name}`}>
                      {row.def.description ?? ''}
                    </span>
                  ) : (
                    <input
                      type="text"
                      data-testid={`sp-desc-${row.name}`}
                      aria-label={`Description of ${row.name}`}
                      className={cn(CELL, 'w-full font-sans')}
                      value={row.def.description ?? ''}
                      maxLength={DESCRIPTION_MAX}
                      disabled={disabled}
                      onChange={(e) => commit(row.name, { description: e.target.value })}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
