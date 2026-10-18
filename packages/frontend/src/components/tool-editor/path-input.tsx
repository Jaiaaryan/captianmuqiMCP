'use client';

import { useId, useMemo, useRef, useState } from 'react';
import {
  Braces,
  Brackets,
  CircleSlash,
  Hash,
  ToggleLeft,
  Type,
  type LucideIcon,
} from 'lucide-react';
import { Icon } from './icon';
import { ROW, TONE_TEXT, type FieldTone } from './response-processing-styles';
import type { JsonType, PathMode } from './path-picker';
import { shortValue, type Tree, type TreeNode } from './response-tree';

/* ------------------------------------------------------------------ */
/*  Completions from the tree (pure)                                   */
/* ------------------------------------------------------------------ */

export interface PathOption {
  /** What accepting writes into the field. */
  value: string;
  label: string;
  type: JsonType;
  right: string;
}

const TYPE_ICON: Record<JsonType, LucideIcon> = {
  object: Braces,
  array: Brackets,
  string: Type,
  number: Hash,
  boolean: ToggleLeft,
  null: CircleSlash,
};

/** `items[*].pr` -> base `items[*]`, fragment `pr`; `a['x` -> base `a`, fragment `['x`. */
function split(text: string): { base: string; fragment: string } {
  const dot = text.lastIndexOf('.');
  const br = text.lastIndexOf('[');
  if (br > dot && !text.slice(br).includes(']')) return { base: text.slice(0, br), fragment: text.slice(br) };
  if (dot >= 0) return { base: text.slice(0, dot), fragment: text.slice(dot + 1) };
  return { base: '', fragment: text };
}

function display(id: string): string {
  return id.replace(/^\$\.?/, '');
}

/**
 * Keys at the level the text has reached: the Input from the response root
 * (arrays offered as `key[*]`, `key[*].` after one), `writes` inside the
 * step's element. `.` descends into an object; a raw `['odd.key']`, `[0]` or
 * `prices[*]` is simply typed.
 */
export function pathOptions(
  tree: Tree,
  field: PathMode,
  scope: string,
  text: string,
  stepIndex: number,
): PathOption[] {
  const { base, fragment } = split(text.trim());
  const usable = (n: TreeNode) =>
    (n.step === undefined || n.step - 1 < stepIndex) && !(n.change?.kind === 'added' && n.step === undefined);
  let level: TreeNode[] | null = null;
  if (field === 'input') {
    if (!base) level = tree.roots;
    else {
      const abs = base.startsWith('$') ? base : base.startsWith('[') ? `$${base}` : `$.${base}`;
      level = tree.byId.get(abs)?.children ?? null;
    }
    level = level?.filter(usable) ?? null;
  } else {
    const inScope = (n: TreeNode) => n.scope === scope && usable(n);
    if (!base) level = scope ? tree.byId.get(scope)?.children ?? null : tree.roots;
    else {
      const node = [...tree.byId.values()].find((n) => n.rel === base && n.scope === scope && !n.isScope);
      level = node?.children ?? null;
    }
    level = level?.filter(inScope) ?? null;
  }
  if (!level) return [];
  const frag = fragment.replace(/^\[['"]?/, '').toLowerCase();
  const out: PathOption[] = [];
  for (const n of level) {
    const name = n.isScope ? n.key.slice(0, -3) : n.key;
    if (frag && !name.toLowerCase().startsWith(frag)) continue;
    const descend = n.type === 'object' && n.children.length > 0;
    const right = n.isScope ? `${n.count ?? 0} items` : n.type === 'object' ? `${n.count ?? 0} keys` : shortValue(n.value, 20);
    if (field === 'input') {
      const path = display(n.id);
      out.push({
        value: n.isScope && n.children.length ? `${path}.` : descend ? `${path}.` : path,
        label: n.isScope && n.children.length ? `${n.key}.` : descend ? `${n.key}.` : n.key,
        type: n.isScope ? 'array' : n.type,
        right,
      });
    } else {
      out.push({
        value: descend ? `${n.rel}.` : n.rel,
        label: descend ? `${n.key}.` : name,
        type: n.isScope ? 'array' : n.type,
        right,
      });
    }
    if (out.length >= 50) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  The path field                                                     */
/* ------------------------------------------------------------------ */

interface Props {
  /** The text shown (the Input without `$.`). */
  value: string;
  /** The stored path, for tests and tooltips. */
  stored: string;
  onChange: (text: string) => void;
  placeholder: string;
  tone?: FieldTone;
  /** Shown in --text-3: a `writes` that follows the Input (`= input`). */
  muted?: boolean;
  /** Code that explains the tone (`exists`, `not in sample`), on hover. */
  title?: string;
  picking: boolean;
  onPickStart: () => void;
  onPickEnd: () => void;
  options: (text: string) => PathOption[];
  ariaLabel: string;
  testId: string;
}

/**
 * A path as a monospace pill that is also an input. Focusing it enters pick
 * mode (the response tree fills it); typing offers the keys of the current
 * level. Raw syntax (`['weird.key']`, `[0]`) is accepted as typed.
 */
export function PathInput({
  value,
  stored,
  onChange,
  placeholder,
  tone,
  muted,
  title,
  picking,
  onPickStart,
  onPickEnd,
  options,
  ariaLabel,
  testId,
}: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const list = useMemo(() => (open && picking ? options(value) : []), [open, picking, options, value]);
  const shown = open && picking && list.length > 0;

  const accept = (o: PathOption) => {
    onChange(o.value);
    setActive(0);
    // An object keeps the list open one level down; a leaf closes it.
    if (!o.value.endsWith('.')) setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') return; // Preview
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return; // move step
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
      else setActive((a) => Math.min(a + 1, Math.max(list.length - 1, 0)));
      return;
    }
    if (e.key === 'ArrowUp' && shown) {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
      return;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && shown && list[active]) {
      e.preventDefault();
      accept(list[active]);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      ref.current?.blur();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (shown) setOpen(false);
      else ref.current?.blur();
    }
  };

  const width = Math.max(4, (value || placeholder).length) + 1;

  return (
    <span className="relative inline-flex min-w-0 max-w-full">
      <input
        ref={ref}
        type="text"
        value={value}
        spellCheck={false}
        autoComplete="off"
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={tone === 'danger' || undefined}
        aria-expanded={shown}
        aria-controls={shown ? listId : undefined}
        aria-autocomplete="list"
        role="combobox"
        data-testid={testId}
        data-value={stored}
        data-tone={tone}
        data-picking={picking || undefined}
        title={title ?? (stored || undefined)}
        onFocus={onPickStart}
        onBlur={() => {
          setOpen(false);
          onPickEnd();
        }}
        onChange={(e) => {
          onChange(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        style={{ width: `calc(${width}ch + 24px)` }}
        className={`h-8 min-w-0 max-w-full rounded-md bg-[var(--surface)] px-3 font-mono text-sm outline-none focus-visible:outline-none! ${
          picking ? 'shadow-[0_0_0_2px_var(--brand)]' : tone === 'danger' ? 'shadow-[inset_0_0_0_1px_var(--t-danger-fg)]' : ''
        } ${
          tone === 'danger'
            ? `${TONE_TEXT.danger} italic placeholder:text-[var(--t-danger-fg)]`
            : tone === 'warn'
              ? TONE_TEXT.warn
              : muted
                ? 'text-[var(--text-3)]'
                : 'text-[var(--text)]'
        } ${tone === 'danger' ? '' : 'placeholder:italic placeholder:text-[var(--text-3)]'}`}
      />
      {shown && (
        <div
          id={listId}
          role="listbox"
          data-testid="rp-path-picker"
          onMouseDown={(e) => e.preventDefault()}
          className="absolute left-0 top-[calc(100%+4px)] z-50 max-h-72 min-w-[260px] overflow-auto rounded-md bg-[var(--surface)] p-1 shadow-[var(--shadow)]"
        >
          {list.map((o, i) => (
            <div
              key={o.value}
              role="option"
              aria-selected={i === active}
              data-testid={`rp-path-option-${o.value}`}
              onMouseMove={() => setActive(i)}
              onClick={() => accept(o)}
              className={`${ROW} h-[30px] cursor-pointer gap-2 rounded-[4px] px-2 font-mono text-sm ${
                i === active ? 'bg-[var(--surface-2)]' : ''
              }`}
            >
              <Icon as={TYPE_ICON[o.type]} className="text-[var(--text-3)]" />
              <span className="min-w-0 flex-1 truncate text-[var(--text)]">{o.label}</span>
              <span className="truncate pl-3 text-[var(--text-3)]">{o.right}</span>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
