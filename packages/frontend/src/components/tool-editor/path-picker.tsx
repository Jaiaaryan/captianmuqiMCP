'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Braces,
  Brackets,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Hash,
  Plus,
  ToggleLeft,
  Type,
  type LucideIcon,
} from 'lucide-react';
import { Icon } from './icon';
import { CELL, LINE_TONE, TRIGGER, type FieldTone } from './response-processing-styles';

/* ------------------------------------------------------------------ */
/*  Paths over a sample (pure)                                         */
/* ------------------------------------------------------------------ */

export type PathMode = 'each' | 'reads' | 'writes';
export type JsonType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export function jsonType(v: unknown): JsonType {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'object';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  return 'string';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `items` / `.items` / `['a b']`, the way the server prints a key. */
export function joinKey(base: string, name: string): string {
  if (/^[A-Za-z_$][\w$]*$/.test(name)) return base ? `${base}.${name}` : name;
  return `${base}['${name.replace(/'/g, "\\'")}']`;
}

type Token = { kind: 'key'; name: string } | { kind: 'index'; index: number } | { kind: 'wildcard' };

/** Lenient client-side reading of `$.a.b[*]`, `a['x y'][0]`. Null when it does not parse. */
export function parsePath(raw: string): Token[] | null {
  let s = raw.trim();
  if (s.startsWith('$')) s = s.slice(1);
  const tokens: Token[] = [];
  const re = /\.?([A-Za-z_$][\w$]*)|\[\s*(\*|-?\d+|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*\]/y;
  let i = 0;
  while (i < s.length) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) return null;
    if (m[1] !== undefined) tokens.push({ kind: 'key', name: m[1] });
    else if (m[2] === '*') tokens.push({ kind: 'wildcard' });
    else if (/^-?\d+$/.test(m[2])) tokens.push({ kind: 'index', index: Number(m[2]) });
    else tokens.push({ kind: 'key', name: m[2].slice(1, -1).replace(/\\(.)/g, '$1') });
    i = re.lastIndex;
  }
  return tokens;
}

/**
 * The first element a step with this `each` works on: the server walks every
 * element, the picker shows the first. Empty `each` is the response itself, or
 * its first element when the response is an array.
 */
export function eachElement(sample: unknown, each: string | undefined): { found: boolean; value: unknown } {
  const tokens = each && each.trim() && each.trim() !== '$' ? parsePath(each) : [];
  if (!tokens) return { found: false, value: undefined };
  let v: unknown = sample;
  for (const t of tokens) {
    if (t.kind === 'key') {
      if (!isObject(v) || !(t.name in v)) return { found: false, value: undefined };
      v = v[t.name];
    } else if (t.kind === 'index') {
      if (!Array.isArray(v)) return { found: false, value: undefined };
      v = v[t.index < 0 ? v.length + t.index : t.index];
    } else if (Array.isArray(v)) {
      v = v[0];
    } else if (isObject(v)) {
      v = Object.values(v)[0];
    } else {
      return { found: false, value: undefined };
    }
  }
  const last = tokens[tokens.length - 1];
  if ((!last || last.kind !== 'wildcard') && Array.isArray(v)) v = v[0];
  return { found: v !== undefined, value: v };
}

/** Resolves `a.b` / `$.a.b` / `a[0]` (no wildcards) inside `root`. */
export function resolvePath(root: unknown, path: string): { found: boolean; value: unknown } {
  const tokens = parsePath(path);
  if (!tokens) return { found: false, value: undefined };
  let v: unknown = root;
  for (const t of tokens) {
    if (t.kind === 'key') {
      if (!isObject(v) || !(t.name in v)) return { found: false, value: undefined };
      v = v[t.name];
    } else if (t.kind === 'index') {
      if (!Array.isArray(v)) return { found: false, value: undefined };
      v = v[t.index < 0 ? v.length + t.index : t.index];
      if (v === undefined) return { found: false, value: undefined };
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: v };
}

/* ------------------------------------------------------------------ */
/*  What the picker can show                                           */
/* ------------------------------------------------------------------ */

const KEY_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const EACH_PATH = /^\$(?:\.[A-Za-z_$][\w$]*|\[\*\])*\[\*\]$/;
const NEW_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Whether a stored path is one the picker writes; anything else needs the raw fields. */
export function pickerCanShow(mode: PathMode, path: string | undefined): boolean {
  const p = (path ?? '').trim();
  if (!p) return true;
  if (mode === 'each') return EACH_PATH.test(p);
  return p === '$' || KEY_PATH.test(p);
}

/** The field's label: `any` for the whole response, `element` for `$`, the path without `$.` (and a closing `[*]`) otherwise. */
export function pathLabel(mode: PathMode, path: string): string {
  const p = path.trim();
  if (mode === 'each') return p ? p.replace(/^\$\.?/, '').replace(/\[\*\]$/, '') || 'response' : 'any';
  return p === '$' ? 'element' : p;
}

/* ------------------------------------------------------------------ */
/*  Problems a path has against the sample                             */
/* ------------------------------------------------------------------ */

export interface PathProblem {
  field: PathMode;
  code: 'not a list' | 'not in sample' | 'exists' | 'missing';
  tone: FieldTone;
}

interface PathStep {
  use: string;
  each?: string;
  reads: string;
  writes: string;
  mode: string;
}

/** The keys earlier steps write on the same elements: they exist by the time this step runs. */
export function earlierWrites(steps: PathStep[], index: number): { key: string; step: number }[] {
  const each = (steps[index]?.each ?? '').trim();
  const out: { key: string; step: number }[] = [];
  for (let i = 0; i < index; i += 1) {
    const s = steps[i];
    const w = s.writes.trim();
    if ((s.each ?? '').trim() === each && w && w !== '$' && !out.some((o) => o.key === w)) out.push({ key: w, step: i + 1 });
  }
  return out;
}

/**
 * What the sample says about a step's paths. Danger: `each` is not a list (built-ins
 * need one), `add` onto a key that exists, `replace` of one that does not. Warn: a
 * path the sample does not have (the sample may be partial).
 */
export function samplePathProblems(steps: PathStep[], index: number, sample: unknown, script: boolean): PathProblem[] {
  if (sample === undefined) return [];
  const step = steps[index];
  const out: PathProblem[] = [];
  const each = (step.each ?? '').trim();
  if (each && each !== '$') {
    const tokens = parsePath(each);
    if (tokens) {
      const target = tokens[tokens.length - 1]?.kind === 'wildcard' ? tokens.slice(0, -1) : tokens;
      let v: unknown = sample;
      let found = true;
      for (const t of target) {
        if (t.kind === 'key' && isObject(v) && t.name in v) v = v[t.name];
        else if (t.kind === 'wildcard' && Array.isArray(v)) v = v[0];
        else if (t.kind === 'index' && Array.isArray(v)) v = v[t.index];
        else {
          found = false;
          break;
        }
      }
      if (!found || v === undefined) out.push({ field: 'each', code: 'not in sample', tone: 'warn' });
      else if (!Array.isArray(v) && !script) out.push({ field: 'each', code: 'not a list', tone: 'danger' });
    }
  }
  const root = eachElement(sample, step.each);
  if (!root.found) return out;
  const earlier = new Set(earlierWrites(steps, index).map((e) => e.key));
  const has = (p: string) => earlier.has(p) || resolvePath(root.value, p).found;
  const reads = step.reads.trim();
  if (reads && reads !== '$' && !reads.includes('*') && parsePath(reads) && !has(reads)) {
    out.push({ field: 'reads', code: 'not in sample', tone: 'warn' });
  }
  const writes = step.writes.trim();
  if (writes && writes !== '$' && !writes.includes('*') && parsePath(writes)) {
    const exists = has(writes);
    if (step.mode === 'add' && exists) out.push({ field: 'writes', code: 'exists', tone: 'danger' });
    if (step.mode === 'replace' && !exists) out.push({ field: 'writes', code: 'missing', tone: 'danger' });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Rows                                                               */
/* ------------------------------------------------------------------ */

export interface PathRow {
  /** Row identity (and expansion key). */
  id: string;
  /** What choosing the row writes into the field; null: not selectable here. */
  path: string | null;
  label: string;
  type?: JsonType;
  /** Right-aligned: a sample value, or `N items` / `N keys`. */
  right?: string;
  /** Trailing flag: `exists`, `step 02`. */
  flag?: string;
  depth: number;
  parent: string | null;
  expandable: boolean;
  inner?: { value: unknown; base: string };
  special?: 'any' | 'new' | 'nosample';
}

const MAX_KEYS = 200;

function hasArray(v: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (Array.isArray(v)) return true;
  if (!isObject(v)) return false;
  return Object.values(v).slice(0, MAX_KEYS).some((x) => hasArray(x, depth + 1));
}

function rightText(v: unknown, type: JsonType): string {
  if (type === 'array') {
    const n = (v as unknown[]).length;
    return `${n} ${n === 1 ? 'item' : 'items'}`;
  }
  if (type === 'object') {
    const n = Object.keys(v as object).length;
    return `${n} ${n === 1 ? 'key' : 'keys'}`;
  }
  const text = type === 'string' ? JSON.stringify(v) : String(v);
  return text.length > 28 ? `${text.slice(0, 27)}…` : text;
}

/** The rows directly under `value`. */
export function childRows(value: unknown, base: string, mode: PathMode, depth: number, parent: string | null): PathRow[] {
  if (!isObject(value)) return [];
  const out: PathRow[] = [];
  for (const [label, v] of Object.entries(value).slice(0, MAX_KEYS)) {
    const path = joinKey(base, label);
    const type = jsonType(v);
    const right = rightText(v, type);
    if (mode === 'each') {
      if (type === 'array') {
        const first = (v as unknown[])[0];
        const sel = `${path}[*]`;
        out.push({ id: sel, path: sel, label, type, right, depth, parent, expandable: isObject(first) && hasArray(first), inner: { value: first, base: sel } });
      } else {
        // Not a list: shown dimmed, opened only on the way to a nested one.
        out.push({ id: path, path: null, label, type, right, depth, parent, expandable: type === 'object' && hasArray(v), inner: { value: v, base: path } });
      }
    } else if (type === 'object') {
      out.push({ id: path, path, label, type, right, depth, parent, expandable: Object.keys(v as object).length > 0, inner: { value: v, base: path } });
    } else {
      out.push({ id: path, path, label, type, right, depth, parent, expandable: false });
    }
  }
  return out;
}

export function rootRows(
  sample: unknown,
  mode: PathMode,
  each: string | undefined,
  allowWhole: boolean,
  earlier: { key: string; step: number }[] = [],
): PathRow[] {
  if (sample === undefined) return [{ id: '#nosample', path: null, label: 'no sample', depth: 0, parent: null, expandable: false, special: 'nosample' }];
  if (mode === 'each') {
    const rows: PathRow[] = [
      { id: '#any', path: '', label: 'any', right: 'whole response', depth: 0, parent: null, expandable: false, special: 'any' },
    ];
    if (Array.isArray(sample)) {
      const first = sample[0];
      rows.push({ id: '$[*]', path: '$[*]', label: 'response', type: 'array', right: rightText(sample, 'array'), depth: 0, parent: null, expandable: isObject(first) && hasArray(first), inner: { value: first, base: '$[*]' } });
    }
    return [...rows, ...childRows(sample, '$', 'each', 0, null)];
  }
  const rows: PathRow[] = [];
  if (mode === 'writes') rows.push({ id: '#new', path: null, label: 'new key…', depth: 0, parent: null, expandable: false, special: 'new' });
  if (allowWhole) rows.push({ id: '#any', path: '$', label: 'any', right: 'element', depth: 0, parent: null, expandable: false, special: 'any' });
  const el = eachElement(sample, each);
  const children = el.found ? childRows(el.value, '', mode, 0, null) : [];
  if (mode === 'writes') for (const r of children) r.flag = 'exists';
  for (const e of earlier) {
    if (children.some((r) => r.path === e.key)) continue;
    children.push({ id: `#earlier-${e.key}`, path: e.key, label: e.key, flag: `step ${String(e.step).padStart(2, '0')}`, depth: 0, parent: null, expandable: false });
  }
  return [...rows, ...children];
}

export function visibleRows(roots: PathRow[], expanded: Set<string>, mode: PathMode): PathRow[] {
  const out: PathRow[] = [];
  const walk = (rows: PathRow[]) => {
    for (const r of rows) {
      out.push(r);
      if (r.expandable && expanded.has(r.id) && r.inner && r.depth < 12) {
        const kids = childRows(r.inner.value, r.inner.base, mode, r.depth + 1, r.id);
        if (mode === 'writes') for (const k of kids) k.flag = 'exists';
        walk(kids);
      }
    }
  };
  walk(roots);
  return out;
}

/** Expanded set that reveals `value`: every expandable ancestor whose child base prefixes it. */
export function revealPath(roots: PathRow[], value: string, mode: PathMode): Set<string> {
  const open = new Set<string>();
  if (!value) return open;
  const prefixes = (p: string) => value.startsWith(`${p}.`) || value.startsWith(`${p}[`);
  const walk = (rows: PathRow[]) => {
    for (const r of rows) {
      if (r.expandable && r.inner && prefixes(r.inner.base) && r.depth < 12) {
        open.add(r.id);
        walk(childRows(r.inner.value, r.inner.base, mode, r.depth + 1, r.id));
      }
    }
  };
  walk(roots);
  return open;
}

/* ------------------------------------------------------------------ */
/*  Presentation                                                       */
/* ------------------------------------------------------------------ */

const TYPE_ICON: Record<JsonType, LucideIcon> = {
  object: Braces,
  array: Brackets,
  string: Type,
  number: Hash,
  boolean: ToggleLeft,
  null: CircleSlash,
};

/** Width of a monospace field, sized to its content. */
export function chWidth(text: string, placeholder = '', min = 3): React.CSSProperties {
  return { width: `${Math.max(min, (text || placeholder).length) + 1}ch` };
}

interface PickerProps {
  value: string;
  onChange: (value: string) => void;
  mode: PathMode;
  /** Most recent recorded response; undefined: the picker shows `no sample`. */
  sample: unknown;
  /** The step's `each`, for `reads` / `writes`. */
  each?: string;
  /** Offer `any` (the whole element, `$`) first: script steps. */
  allowWhole?: boolean;
  /** Keys earlier steps write on the same elements. */
  earlier?: { key: string; step: number }[];
  placeholder?: string;
  ariaLabel: string;
  testId: string;
  tone?: FieldTone;
  /** Leading icon inside the trigger. */
  icon?: LucideIcon;
  /** Muted word before the value (`on`). */
  prefix?: string;
}

/**
 * One path field. By default a picker: the user clicks a key and the picker writes
 * the path. `advanced` shows the stored path verbatim in a monospace input, with
 * the picker behind a chevron; only there can `$`, `[*]` and bracket keys be typed.
 */
export function PathField(props: PickerProps & { advanced: boolean }) {
  const { advanced, value, onChange, placeholder, ariaLabel, testId, tone, prefix } = props;
  if (!advanced) return <TreePicker {...props} variant="field" />;
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1">
      {prefix && <span className="text-[12.5px] text-[var(--text-3)]">{prefix}</span>}
      <input
        type="text"
        value={value}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={tone === 'danger' || undefined}
        data-testid={testId}
        data-value={value}
        title={value || undefined}
        onChange={(e) => onChange(e.target.value)}
        style={chWidth(value, placeholder)}
        className={`${CELL} max-w-[220px] truncate ${tone ? LINE_TONE[tone] : ''}`}
      />
      <TreePicker {...props} variant="chevron" />
    </span>
  );
}

function TreePicker({
  value,
  onChange,
  mode,
  sample,
  each,
  allowWhole = false,
  earlier,
  placeholder,
  ariaLabel,
  testId,
  tone,
  icon: Lead,
  prefix,
  variant,
}: PickerProps & { variant: 'field' | 'chevron' }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [active, setActive] = useState(-1);
  const [newKey, setNewKey] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const triggerId = variant === 'field' ? testId : `${testId}-pick`;

  const roots = useMemo(() => rootRows(sample, mode, each, allowWhole, earlier), [sample, mode, each, allowWhole, earlier]);
  const rows = useMemo(() => visibleRows(roots, expanded, mode), [roots, expanded, mode]);

  const onOpenChange = (next: boolean) => {
    if (next) {
      const reveal = revealPath(roots, value, mode);
      setExpanded(reveal);
      setNewKey(null);
      setActive(visibleRows(roots, reveal, mode).findIndex((r) => r.path !== null && r.path === value));
    }
    setOpen(next);
  };

  useEffect(() => {
    if (!open || newKey !== null) return;
    const id = requestAnimationFrame(() => treeRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(id);
  }, [open, newKey]);

  useEffect(() => {
    if (!open || active < 0) return;
    document.getElementById(`${baseId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, baseId]);

  const choose = (path: string) => {
    onChange(path);
    setOpen(false);
  };

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const activate = (row: PathRow | undefined) => {
    if (!row) return;
    if (row.special === 'new') setNewKey('');
    else if (row.path !== null) choose(row.path);
    else if (row.expandable) toggle(row.id);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // ⌘↵ belongs to the panel (Preview); everything else stays in the picker.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') return;
    e.stopPropagation();
    const row = active >= 0 ? rows[active] : undefined;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((a) => Math.min(a + 1, rows.length - 1));
        return;
      case 'ArrowUp':
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
        return;
      case 'ArrowRight':
        if (!row) return;
        e.preventDefault();
        if (row.expandable && !expanded.has(row.id)) toggle(row.id);
        else if (row.expandable) setActive(active + 1);
        return;
      case 'ArrowLeft':
        if (!row) return;
        e.preventDefault();
        if (expanded.has(row.id)) toggle(row.id);
        else if (row.parent !== null) setActive(rows.findIndex((r) => r.id === row.parent));
        return;
      case 'Home':
        e.preventDefault();
        setActive(0);
        return;
      case 'End':
        e.preventDefault();
        setActive(rows.length - 1);
        return;
      case 'Enter':
      case ' ':
        e.preventDefault();
        activate(row);
        return;
      case 'Tab':
        setOpen(false);
        return;
    }
    // A letter jumps to the next key that starts with it.
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && /\S/.test(e.key)) {
      const ch = e.key.toLowerCase();
      for (let k = 1; k <= rows.length; k += 1) {
        const i = (active + k + rows.length) % rows.length;
        if (!rows[i].special && rows[i].label.toLowerCase().startsWith(ch)) {
          setActive(i);
          break;
        }
      }
    }
  };

  const onNewKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') return;
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      if (newKey && NEW_KEY.test(newKey)) choose(newKey);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      setNewKey(null);
    }
  };

  const crumb =
    mode === 'each' ? 'response' : each?.trim() ? `${each.trim().replace(/^\$\.?/, '') || 'response'} ›` : 'response ›';
  const shown = value ? pathLabel(mode, value) : '';

  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      {variant === 'field' ? (
        <DropdownMenu.Trigger
          aria-label={ariaLabel}
          aria-invalid={tone === 'danger' || undefined}
          data-testid={testId}
          data-value={value}
          data-tone={tone}
          title={value || undefined}
          className={`${TRIGGER} max-w-[240px] font-mono ${value ? 'text-[var(--text)]' : 'text-[var(--text-3)]'} ${tone ? LINE_TONE[tone] : ''}`}
        >
          {prefix && <span className="font-sans text-[var(--text-3)]">{prefix}</span>}
          {Lead && <Icon as={Lead} className="text-[var(--text-3)]" />}
          <span className={`truncate ${shown ? '' : 'italic'} ${shown === 'any' ? 'text-[var(--text-2)]' : ''}`}>
            {shown || placeholder}
          </span>
          <Icon as={ChevronDown} className="text-[var(--text-3)]" />
        </DropdownMenu.Trigger>
      ) : (
        <DropdownMenu.Trigger
          aria-label={`pick ${ariaLabel}`}
          data-testid={triggerId}
          className="inline-flex h-6 items-center px-0.5 text-[var(--text-3)] outline-none hover:bg-[var(--surface-2)] hover:text-[var(--text)] focus-visible:bg-[var(--surface-3)] data-[state=open]:bg-[var(--surface-3)] focus-visible:outline-none!"
        >
          <Icon as={ChevronDown} />
        </DropdownMenu.Trigger>
      )}
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          data-testid="rp-path-picker"
          onCloseAutoFocus={(e) => {
            // Back to the trigger, but never scroll the editor.
            e.preventDefault();
            document.querySelector<HTMLElement>(`[data-testid="${triggerId}"]`)?.focus({ preventScroll: true });
          }}
          className="z-50 flex max-h-[360px] w-[340px] flex-col bg-[var(--surface)] shadow-[var(--shadow)] focus-visible:outline-none! [&_*:focus-visible]:outline-none!"
        >
          <div
            data-testid="rp-path-mode"
            className="flex h-7 shrink-0 items-center gap-1.5 px-2.5 font-mono text-[11px] text-[var(--text-3)]"
          >
            <span className="text-[var(--text-2)]">{mode}</span>
            <span>·</span>
            <span className="truncate">{crumb}</span>
          </div>
          <div
            ref={treeRef}
            id={`${baseId}-tree`}
            role="tree"
            tabIndex={0}
            aria-label={ariaLabel}
            aria-activedescendant={active >= 0 ? `${baseId}-${active}` : undefined}
            data-testid="rp-path-tree"
            onKeyDown={onKeyDown}
            className="min-h-0 overflow-y-auto pb-1 outline-none"
          >
            {rows.map((r, i) => {
              if (r.special === 'new' && newKey !== null) {
                return (
                  <div key={r.id} id={`${baseId}-${i}`} className="flex h-7 items-center gap-1.5 pl-1.5 pr-2.5">
                    <Icon as={Plus} className="text-[var(--text-3)]" />
                    <input
                      autoFocus
                      type="text"
                      value={newKey}
                      spellCheck={false}
                      placeholder="key"
                      aria-label={`new key for ${ariaLabel}`}
                      aria-invalid={(newKey !== '' && !NEW_KEY.test(newKey)) || undefined}
                      data-testid="rp-path-newkey-input"
                      onChange={(e) => setNewKey(e.target.value.replace(/[^A-Za-z0-9_]/g, ''))}
                      onKeyDown={onNewKeyDown}
                      className={`${CELL} flex-1`}
                    />
                  </div>
                );
              }
              const selected = r.path !== null && r.path === value;
              const dim = r.path === null && !r.special;
              return (
                <div
                  key={r.id}
                  id={`${baseId}-${i}`}
                  role="treeitem"
                  aria-level={r.depth + 1}
                  aria-expanded={r.expandable ? expanded.has(r.id) : undefined}
                  aria-selected={selected}
                  aria-disabled={(r.path === null && !r.expandable && r.special !== 'new') || undefined}
                  data-testid={
                    r.special === 'any'
                      ? 'rp-path-any'
                      : r.special === 'new'
                        ? 'rp-path-newkey'
                        : r.special === 'nosample'
                          ? 'rp-path-nosample'
                          : `rp-path-node-${r.path ?? r.id}`
                  }
                  data-active={i === active || undefined}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => setActive(i)}
                  onClick={() => activate(r)}
                  style={{ paddingLeft: 6 + r.depth * 16 }}
                  className={`flex h-7 items-center gap-1.5 pr-2.5 font-mono text-[12.5px] ${
                    r.special === 'nosample' ? 'cursor-default' : 'cursor-pointer'
                  } ${i === active ? 'bg-[var(--surface-2)]' : ''} ${
                    dim || r.special === 'nosample' ? 'text-[var(--text-3)]' : 'text-[var(--text)]'
                  } ${selected ? 'font-medium' : ''}`}
                >
                  {r.expandable ? (
                    <span
                      aria-hidden
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(r.id);
                      }}
                      className="inline-flex text-[var(--text-3)] hover:text-[var(--text)]"
                    >
                      <Icon as={expanded.has(r.id) ? ChevronDown : ChevronRight} />
                    </span>
                  ) : (
                    <span aria-hidden className="w-[14px] shrink-0" />
                  )}
                  {r.special === 'new' ? (
                    <Icon as={Plus} className="text-[var(--text-2)]" />
                  ) : r.type ? (
                    <Icon as={TYPE_ICON[r.type]} className={dim ? 'text-[var(--text-3)]' : 'text-[var(--text-2)]'} />
                  ) : (
                    <span aria-hidden className="w-[14px] shrink-0" />
                  )}
                  <span className={`truncate ${r.special ? 'font-sans' : ''}`}>{r.label}</span>
                  <span className="ml-auto truncate pl-3 text-[var(--text-3)]">{r.right ?? ''}</span>
                  {r.flag && <span className="shrink-0 font-sans text-[11px] text-[var(--text-3)]">{r.flag}</span>}
                </div>
              );
            })}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
