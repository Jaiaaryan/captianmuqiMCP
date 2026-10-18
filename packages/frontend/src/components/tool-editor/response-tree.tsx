'use client';

import { useMemo, useState } from 'react';
import {
  Braces,
  Brackets,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Clipboard,
  Clock,
  Hash,
  Play,
  Plus,
  ToggleLeft,
  Type,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Icon } from './icon';
import { BTN_GHOST, BTN_SECONDARY, ROW, TONE_TEXT, VALUE_INPUT } from './response-processing-styles';
import { joinKey, jsonType, parsePath, relPath, type JsonType, type PathMode } from './path-picker';
import { relativeTime, type Step } from './response-processing-model';

/* ------------------------------------------------------------------ */
/*  The tree model (pure)                                              */
/* ------------------------------------------------------------------ */

export interface TreeNode {
  /** Absolute path, arrays through `[*]`: `$.items[*].price_usd`. Also the row id. */
  id: string;
  /** Row label: the key, `items[*]` for an array. */
  key: string;
  type: JsonType;
  value: unknown;
  /** Arrays: items (uncut when the server sent lengths); objects: keys. */
  count?: number;
  depth: number;
  /** The `each` (stored form) whose elements hold this node: `''` the response itself. */
  scope: string;
  /** Path relative to `scope`, what `reads` / `writes` store. */
  rel: string;
  parent: string | null;
  /** An array (or an object's `[*]`): its children live in the scope `id`. */
  isScope: boolean;
  /** The `[*]` of an object (its values): not a row of its own unless its values are objects. */
  map?: boolean;
  /** An object: its `[*]` scope (`$.prices[*]`), the shape of its values. */
  mapScope?: TreeNode;
  children: TreeNode[];
  /** Written by that step (1-based), not in the sample. */
  step?: number;
  /** What the last preview did here. */
  change?: { kind: 'added' | 'changed'; before?: unknown; after: unknown };
}

export interface Tree {
  /** Top-level rows (a root array is one `[*]` row). */
  roots: TreeNode[];
  byId: Map<string, TreeNode>;
}

const MAX_KEYS = 200;
const MAX_DEPTH = 12;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Keys of the first few elements (or values), first occurrence wins (the sample is cut to 3). */
function mergedElement(arr: unknown[]): Record<string, unknown> | null {
  const objects = arr.slice(0, 3).filter(isObject);
  if (!objects.length) return null;
  const out: Record<string, unknown> = {};
  for (const o of objects) for (const [k, v] of Object.entries(o)) if (!(k in out)) out[k] = v;
  return out;
}

function arrayPathOf(id: string): string {
  return id.replace(/\[\*\]$/, '');
}

interface Ctx {
  lengths: Record<string, number>;
  byId: Map<string, TreeNode>;
  /** Inside an object's `[*]`: no `[*]` scopes for objects below (keeps the tree linear in size). */
  inMap?: boolean;
}

function makeNode(
  ctx: Ctx,
  value: unknown,
  parent: TreeNode | null,
  name: string,
  scope: string,
  parentRel: string,
): TreeNode {
  const type = jsonType(value);
  const base = parent ? parent.id : '$';
  const depth = parent ? parent.depth + 1 : 0;
  const rel = joinKey(parentRel, name);
  const isScope = type === 'array';
  const id = isScope ? `${joinKey(base, name)}[*]` : joinKey(base, name);
  const node: TreeNode = {
    id,
    key: isScope ? `${name}[*]` : name,
    type,
    value,
    depth,
    scope,
    rel,
    parent: parent?.id ?? null,
    isScope,
    children: [],
  };
  ctx.byId.set(id, node);
  if (depth >= MAX_DEPTH) return node;
  if (isScope) {
    const arr = value as unknown[];
    node.count = ctx.lengths[arrayPathOf(id)] ?? arr.length;
    const el = mergedElement(arr);
    if (el) {
      for (const [k, v] of Object.entries(el).slice(0, MAX_KEYS)) node.children.push(makeNode(ctx, v, node, k, id, ''));
    }
  } else if (type === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    node.count = entries.length;
    for (const [k, v] of entries.slice(0, MAX_KEYS)) node.children.push(makeNode(ctx, v, node, k, scope, rel));
    if (!ctx.inMap && entries.length) node.mapScope = makeMapScope(ctx, node);
  }
  return node;
}

/**
 * An object's `[*]`: the scope of a step that walks its values (`$.prices[*]`).
 * Its children are the merged shape of the values when they are objects.
 */
function makeMapScope(ctx: Ctx, obj: TreeNode): TreeNode {
  const values = Object.values(obj.value as Record<string, unknown>);
  const node: TreeNode = {
    id: `${obj.id}[*]`,
    key: '[*]',
    type: 'object',
    value: obj.value,
    count: values.length,
    depth: obj.depth + 1,
    scope: obj.scope,
    rel: `${obj.rel}[*]`,
    parent: obj.id,
    isScope: true,
    map: true,
    children: [],
  };
  ctx.byId.set(node.id, node);
  const el = mergedElement(values);
  if (el && node.depth < MAX_DEPTH) {
    const inner: Ctx = { ...ctx, inMap: true };
    for (const [k, v] of Object.entries(el).slice(0, MAX_KEYS)) node.children.push(makeNode(inner, v, node, k, node.id, ''));
  }
  return node;
}

/** The tree of a sample. `lengths` (from the server) restores array lengths the sample cut. */
export function buildTree(sample: unknown, lengths: Record<string, number> = {}): Tree {
  const byId = new Map<string, TreeNode>();
  const ctx: Ctx = { lengths, byId };
  if (Array.isArray(sample)) {
    const root: TreeNode = {
      id: '$[*]',
      key: '[*]',
      type: 'array',
      value: sample,
      count: lengths.$ ?? sample.length,
      depth: 0,
      scope: '',
      rel: '$',
      parent: null,
      isScope: true,
      children: [],
    };
    byId.set(root.id, root);
    const el = mergedElement(sample);
    if (el) for (const [k, v] of Object.entries(el).slice(0, MAX_KEYS)) root.children.push(makeNode(ctx, v, root, k, '$[*]', ''));
    return { roots: [root], byId };
  }
  if (!isObject(sample)) return { roots: [], byId };
  const roots = Object.entries(sample)
    .slice(0, MAX_KEYS)
    .map(([k, v]) => makeNode(ctx, v, null, k, '', ''));
  return { roots, byId };
}

/**
 * A step's `each` as a tree scope: `''` for the response itself (`$[*]` when it
 * is an array), `$.items` read as `$.items[*]` when that is an array.
 */
export function scopeOf(tree: Tree, each: string | undefined): string {
  const e = (each ?? '').trim();
  if (!e || e === '$') return tree.byId.has('$[*]') ? '$[*]' : '';
  // `$.items` on an array means its elements; on an object it is the object itself.
  const list = e.endsWith('[*]') ? undefined : tree.byId.get(`${e}[*]`);
  if (list && !list.map) return `${e}[*]`;
  return e;
}

/** The value at a tree id inside a document, arrays through their first element. */
function valueAt(doc: unknown, id: string): { found: boolean; value: unknown } {
  const tokens = parsePath(id);
  if (!tokens) return { found: false, value: undefined };
  let v: unknown = doc;
  for (const t of tokens) {
    if (t.kind === 'key') {
      if (!isObject(v) || !(t.name in v)) return { found: false, value: undefined };
      v = v[t.name];
    } else if (t.kind === 'wildcard') {
      if (!Array.isArray(v) || v.length === 0) return { found: false, value: undefined };
      v = v[0];
    } else {
      if (!Array.isArray(v)) return { found: false, value: undefined };
      v = v[t.index];
    }
  }
  return { found: v !== undefined, value: v };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Children of a container node (or of the root when `node` is null) in `doc`. */
function containerIn(doc: unknown, node: TreeNode | null): Record<string, unknown> | null {
  if (!node) return isObject(doc) ? doc : null;
  const at = valueAt(doc, node.id);
  return isObject(at.value) ? at.value : null;
}

/**
 * Lay the result of a preview over the tree: keys the chain added become new
 * rows (`change.kind = 'added'`), leaves it changed carry `before` and `after`.
 */
export function overlayResult(tree: Tree, result: unknown): void {
  const visit = (parent: TreeNode | null, list: TreeNode[]) => {
    const container = containerIn(result, parent);
    for (const node of list) {
      if (node.children.length || node.type === 'object' || node.isScope) visit(node, node.children);
      else {
        const after = valueAt(result, node.id);
        if (after.found && !same(after.value, node.value)) {
          node.change = { kind: 'changed', before: node.value, after: after.value };
        }
      }
    }
    if (!container) return;
    const have = new Set(list.map((n) => (n.isScope ? n.key.slice(0, -3) : n.key)));
    const scope = parent ? (parent.isScope ? parent.id : parent.scope) : '';
    const parentRel = parent && !parent.isScope ? parent.rel : '';
    for (const [k, v] of Object.entries(container).slice(0, MAX_KEYS)) {
      if (have.has(k)) continue;
      const ctx: Ctx = { lengths: {}, byId: tree.byId };
      const added = makeNode(ctx, v, parent, k, scope, parentRel);
      const mark = (n: TreeNode) => {
        n.change = { kind: 'added', after: n.value };
        n.children.forEach(mark);
      };
      mark(added);
      list.push(added);
    }
  };
  visit(null, tree.roots);
}

/**
 * Fields the steps write that the sample does not have: one green row per
 * written path (inside its step's scope), tagged with the step's number. Rows
 * the preview added are tagged the same way when a step writes them.
 */
const NUMBER_OUT = new Set(['currency@1', 'scale@1', 'offset@1', 'vat@1', 'round@1']);
const STRING_OUT = new Set(['clean_text@1', 'truncate@1']);

/** What a step writes, as far as its processors tell: built-ins declare it, else the value it reads. */
function writtenType(tree: Tree, s: Pick<Step, 'use' | 'each' | 'reads'>, scope: string): JsonType {
  const uses = Array.isArray(s.use) ? s.use : [s.use];
  const last = uses[uses.length - 1];
  const r = relPath(s.reads);
  // `$` is the element itself: the type of the scope's first element (or of the response).
  const scopeNode = scope ? tree.byId.get(scope) : undefined;
  const element = scopeNode
    ? Array.isArray(scopeNode.value)
      ? scopeNode.value[0]
      : isObject(scopeNode.value)
        ? Object.values(scopeNode.value)[0]
        : undefined
    : undefined;
  const readType: JsonType | null =
    r === '$'
      ? scopeNode
        ? jsonType(element)
        : null
      : ([...tree.byId.values()].find((n) => n.scope === scope && n.rel === r && !n.map)?.type ?? null);
  // Numeric built-ins map an array or object of numbers and keep its shape.
  if (NUMBER_OUT.has(last)) return readType === 'array' || readType === 'object' ? readType : 'number';
  if (STRING_OUT.has(last)) return 'string';
  return readType ?? 'null';
}

export function addStepWrites(tree: Tree, steps: Pick<Step, 'use' | 'each' | 'reads' | 'writes'>[]): void {
  steps.forEach((s, i) => {
    const w = s.writes.trim();
    if (!w || w === '$') return;
    const tokens = parsePath(w);
    if (!tokens || tokens.some((t) => t.kind !== 'key')) return;
    const scope = scopeOf(tree, s.each);
    const scopeNode = scope ? tree.byId.get(scope) : null;
    if (scope && !scopeNode) return;
    let parent: TreeNode | null = scopeNode ?? null;
    let list = parent ? parent.children : tree.roots;
    let rel = '';
    tokens.forEach((t, k) => {
      const name = (t as { name: string }).name;
      rel = joinKey(rel, name);
      let node = list.find((n) => n.key === name && !n.isScope);
      if (!node) {
        const last = k === tokens.length - 1;
        node = {
          id: joinKey(parent ? parent.id : '$', name),
          key: name,
          type: last ? writtenType(tree, s, scope) : 'object',
          value: undefined,
          depth: parent ? parent.depth + 1 : 0,
          scope,
          rel,
          parent: parent?.id ?? null,
          isScope: false,
          children: [],
          step: i + 1,
        };
        tree.byId.set(node.id, node);
        list.push(node);
      } else if (node.change?.kind === 'added' && node.step === undefined) {
        node.step = i + 1;
      }
      if (node.change?.kind === 'added' && node.type === 'null' && node.change.after !== undefined) {
        node.type = jsonType(node.change.after);
      }
      parent = node;
      list = node.children;
    });
  });
}

/** Ids of every ancestor of `id`, and `id` itself. */
export function lineage(tree: Tree, id: string): Set<string> {
  const out = new Set<string>();
  let cur = tree.byId.get(id);
  while (cur) {
    out.add(cur.id);
    cur = cur.parent ? tree.byId.get(cur.parent) : undefined;
  }
  return out;
}

/** The scope a node sits in, and its path from there: what "+ step on this field" uses. A list: its elements. */
export function placeOf(node: TreeNode): { each?: string; reads: string } {
  if (node.isScope) return { each: node.id, reads: '$' };
  return { each: node.scope || undefined, reads: node.rel };
}

/* ------------------------------------------------------------------ */
/*  Pick mode                                                          */
/* ------------------------------------------------------------------ */

export interface PickContext {
  field: PathMode;
  /** Index of the step whose field is being picked. */
  step: number;
  /** The step's scope in the tree (see scopeOf). */
  scope: string;
  /** Script steps may pick the whole element (`$`) for `writes`. */
  script: boolean;
}

/** A tree id as the Input shows it: `$.items[*].price_usd` -> `items[*].price_usd`. */
export function inputText(id: string): string {
  return id.replace(/^\$\.?/, '');
}

/**
 * What clicking the node writes into the field; null when it cannot be picked.
 * Input: any node; an array or an object gives its elements (`items[*]`,
 * `prices[*]`), a value its path. writes: the fields of the current element.
 */
export function pickValue(node: TreeNode, pick: PickContext): string | null {
  if (node.step !== undefined && node.step - 1 >= pick.step) return null;
  if (node.change?.kind === 'added' && node.step === undefined) return null;
  if (pick.field === 'input') {
    if (node.isScope) return inputText(node.id);
    if (node.mapScope) return inputText(node.mapScope.id);
    return inputText(node.id);
  }
  if (node.id === pick.scope || node.mapScope?.id === pick.scope) return pick.script ? '$' : null;
  if (node.scope !== pick.scope) return null;
  return node.rel;
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

export function shortValue(v: unknown, max = 28): string {
  if (v === undefined) return '';
  const text = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function rightText(node: TreeNode): string {
  if (node.map) return `${node.count ?? 0} ${node.count === 1 ? 'key' : 'keys'}`;
  if (node.isScope) return `${node.count ?? 0} ${node.count === 1 ? 'item' : 'items'}`;
  if (node.type === 'object' && node.value !== undefined) return `${node.count ?? 0} ${node.count === 1 ? 'key' : 'keys'}`;
  if (node.change?.kind === 'added') return shortValue(node.change.after);
  return shortValue(node.value);
}

/** Collapsed by default: arrays inside an element, objects deep down. */
function closedByDefault(node: TreeNode): boolean {
  if (node.isScope) return node.depth >= 2 || node.children.length === 0;
  return node.depth >= 3;
}

export interface RunParam {
  name: string;
  type: string;
  required?: boolean;
}

export type SampleSource =
  | { kind: 'recorded'; capturedAt?: string | null }
  | { kind: 'pasted' };

interface Props {
  sample: unknown;
  source: SampleSource | null;
  lengths?: Record<string, number>;
  steps: Step[];
  /** The last preview's result document, when it succeeded. */
  result?: unknown;
  pick: PickContext | null;
  onPick: (value: string) => void;
  onAddStep: (node: TreeNode) => void;
  /** Preview rows, shown under the header. */
  previewSlot?: React.ReactNode;
  /** Run the tool and record its response; resolves to an error message or null. */
  onRun?: (args: Record<string, unknown>) => Promise<string | null>;
  runParams: RunParam[];
  runDefaults?: Record<string, unknown>;
  onPaste: (value: unknown) => void;
  /** No steps yet: without a sample the tree is a single header row (`no sample` · Run · Paste JSON). */
  compact?: boolean;
  className?: string;
}

export function ResponseTree({
  sample,
  source,
  lengths,
  steps,
  result,
  pick,
  onPick,
  onAddStep,
  previewSlot,
  onRun,
  runParams,
  runDefaults,
  onPaste,
  compact = false,
  className,
}: Props) {
  const tree = useMemo(() => {
    const t = buildTree(sample, lengths);
    if (result !== undefined) overlayResult(t, result);
    addStepWrites(t, steps);
    return t;
  }, [sample, lengths, steps, result]);

  // Scopes the steps walk: an object's `[*]` row shows when a step works on it.
  const stepScopes = useMemo(() => new Set(steps.map((s) => scopeOf(tree, s.each))), [tree, steps]);

  // Rows the user opened or closed, against the default.
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const forced = useMemo(
    () => (pick && pick.scope ? lineage(tree, pick.scope) : new Set<string>()),
    [tree, pick],
  );
  const isOpen = (n: TreeNode) => forced.has(n.id) || closedByDefault(n) === toggled.has(n.id);
  const toggle = (id: string) =>
    setToggled((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const [panel, setPanel] = useState<'run' | 'paste' | null>(null);
  const hasSample = sample !== undefined;
  // One row only: no steps and nothing to show.
  const oneRow = compact && !hasSample;

  // The header stands for the response itself: the Input `$`, or `writes` `$` for a script on it.
  const headerPick =
    pick && (pick.field === 'input' ? '$' : pick.script && pick.scope === '' ? '$' : null);

  /** An object's `[*]` is a row (first under the object) while its values are objects and something uses it. */
  const rowsOf = (n: TreeNode): TreeNode[] => {
    const m = n.mapScope;
    if (!m || !m.children.length) return n.children;
    const show = pick?.field === 'input' || forced.has(m.id) || stepScopes.has(m.id);
    return show ? [m, ...n.children] : n.children;
  };

  const renderRows = (list: TreeNode[]) => (
    <ul className={list[0]?.depth ? 'ml-[9px] border-l border-[var(--border)] pl-4' : undefined}>
      {list.map((n) => {
        const value = pick ? pickValue(n, pick) : null;
        const scopeRow = !!pick && pick.field === 'writes' && (n.id === pick.scope || n.mapScope?.id === pick.scope);
        const dim = !!pick && value === null && !scopeRow;
        const rows = rowsOf(n);
        const open = rows.length > 0 && isOpen(n);
        const added = n.step !== undefined || n.change?.kind === 'added';
        const changed = n.change?.kind === 'changed';
        return (
          <li key={n.id}>
            <div
              role="treeitem"
              aria-selected={false}
              aria-level={n.depth + 1}
              aria-expanded={rows.length ? open : undefined}
              aria-disabled={dim || undefined}
              data-testid={`rp-path-node-${n.id}`}
              data-pickable={value !== null || undefined}
              data-scope={scopeRow || undefined}
              data-added={added || undefined}
              data-changed={changed || undefined}
              data-step={n.step}
              onMouseDown={(e) => {
                // Keep the focus in the path field being picked for.
                if (pick) e.preventDefault();
              }}
              onClick={() => {
                if (pick) {
                  if (value !== null) onPick(value);
                } else if (rows.length) toggle(n.id);
              }}
              className={`group/row flex h-[30px] items-center gap-2 rounded-md px-2 font-mono text-sm leading-none whitespace-nowrap ${
                dim ? 'opacity-45' : ''
              } ${scopeRow ? 'bg-[var(--surface-3)]' : ''} ${
                pick
                  ? value !== null
                    ? 'cursor-pointer hover:bg-[var(--surface-3)]'
                    : 'cursor-default'
                  : 'cursor-default hover:shadow-[inset_0_0_0_1px_var(--brand)]'
              }`}
            >
              <span
                className={`${ROW} w-4 shrink-0 justify-center text-[var(--text-3)]`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  if (!rows.length) return;
                  e.stopPropagation();
                  toggle(n.id);
                }}
              >
                {rows.length > 0 || (n.isScope && !n.map) ? <Icon as={open ? ChevronDown : ChevronRight} /> : null}
              </span>
              <Icon as={TYPE_ICON[n.change?.kind === 'added' ? jsonType(n.change.after) : n.type]} className="text-[var(--text-3)]" />
              <span className={`min-w-0 flex-1 truncate ${added ? TONE_TEXT.success : 'text-[var(--text)]'}`}>{n.key}</span>
              <span
                className={`min-w-0 truncate text-right ${added ? TONE_TEXT.success : 'text-[var(--text-3)]'}`}
                title={changed ? undefined : rightText(n)}
              >
                {changed ? (
                  <>
                    <span className="text-[var(--text-3)]">{shortValue(n.change!.before, 18)}</span>
                    <span className="text-[var(--text-3)]"> → </span>
                    <span className="text-[var(--text)]">{shortValue(n.change!.after, 18)}</span>
                  </>
                ) : (
                  rightText(n)
                )}
                {n.step !== undefined && ` · ${String(n.step).padStart(2, '0')}`}
              </span>
              {!pick && n.id !== '$[*]' && (
                <button
                  type="button"
                  aria-label={`step on ${n.rel}`}
                  data-testid={`rp-tree-add-${n.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onAddStep(n);
                  }}
                  className="hidden shrink-0 items-center leading-none text-[var(--brand)] group-hover/row:inline-flex focus-visible:inline-flex"
                >
                  <Icon as={Plus} />
                </button>
              )}
            </div>
            {open && renderRows(rows)}
          </li>
        );
      })}
    </ul>
  );

  const age = source?.kind === 'recorded' ? relativeTime(source.capturedAt) : '';

  return (
    <aside
      data-testid="rp-tree"
      aria-label="response"
      className={`${compact ? 'w-full' : 'self-start'} rounded-lg bg-[var(--surface-2)] px-4 ${oneRow ? 'py-2' : 'py-3.5'} ${className ?? ''}`}
    >
      {/* One column (sheet body under 1100px): the header stays at the top of the sheet's scroll. */}
      <div
        data-testid="rp-tree-header"
        className={`${oneRow && panel === null ? '' : 'mb-2.5'} flex items-center gap-2.5 whitespace-nowrap text-sm leading-none text-[var(--text-3)] @max-[1100px]/rp:sticky @max-[1100px]/rp:top-0 @max-[1100px]/rp:z-10 @max-[1100px]/rp:-mt-1.5 @max-[1100px]/rp:bg-[var(--surface-2)] @max-[1100px]/rp:py-1.5`}
      >
        <button
          type="button"
          disabled={headerPick === null || !pick}
          data-testid="rp-tree-root"
          onMouseDown={(e) => {
            if (pick) e.preventDefault();
          }}
          onClick={() => headerPick !== null && headerPick !== undefined && onPick(headerPick)}
          className={`${ROW} gap-2 rounded-md ${
            pick && headerPick !== null ? '-mx-1.5 cursor-pointer bg-[var(--surface-3)] px-1.5 py-1 text-[var(--text)]' : ''
          } ${pick && headerPick === null ? 'opacity-45' : ''}`}
        >
          <Icon as={Braces} />
          <span>response</span>
        </button>
        {hasSample && source?.kind === 'pasted' && (
          <span data-testid="rp-tree-source" className={`${ROW} h-6 rounded-md bg-[var(--surface-3)] px-2 text-[var(--text-2)]`}>
            pasted
          </span>
        )}
        {hasSample && age && (
          <span data-testid="rp-tree-source" className={`${ROW} ml-1.5 gap-2`} title={source?.kind === 'recorded' ? source.capturedAt ?? undefined : undefined}>
            <Icon as={Clock} />
            {age}
          </span>
        )}
        {oneRow && (
          <span data-testid="rp-tree-empty" className="ml-1.5 text-[var(--text-3)]">
            no sample
          </span>
        )}
        <span className="flex-1" />
        {oneRow && (
          <>
            {onRun && (
              <button type="button" data-testid="rp-tree-run" onClick={() => setPanel(panel === 'run' ? null : 'run')} className={BTN_GHOST}>
                <Icon as={Play} />
                Run
              </button>
            )}
            <button type="button" data-testid="rp-tree-paste" onClick={() => setPanel(panel === 'paste' ? null : 'paste')} className={BTN_GHOST}>
              <Icon as={Clipboard} />
              Paste JSON
            </button>
          </>
        )}
        {hasSample && (
          <>
            {onRun && (
              <button type="button" data-testid="rp-tree-run" onClick={() => setPanel(panel === 'run' ? null : 'run')} className={BTN_GHOST}>
                <Icon as={Play} />
                Run
              </button>
            )}
            <button type="button" data-testid="rp-tree-paste" onClick={() => setPanel(panel === 'paste' ? null : 'paste')} className={BTN_GHOST}>
              <Icon as={Clipboard} />
              Paste
            </button>
          </>
        )}
      </div>

      {panel === 'run' && onRun && (
        <RunForm
          params={runParams}
          defaults={runDefaults}
          onRun={onRun}
          onDone={() => setPanel(null)}
          onCancel={() => setPanel(null)}
        />
      )}
      {panel === 'paste' && (
        <PasteForm
          onPaste={(v) => {
            onPaste(v);
            setPanel(null);
          }}
          onCancel={() => setPanel(null)}
        />
      )}

      {previewSlot}

      {hasSample ? (
        <div role="tree" aria-label="response" className="-mx-1 max-h-[min(70vh,720px)] min-w-0 overflow-y-auto px-1 @max-[1100px]/rp:max-h-none @max-[1100px]/rp:overflow-visible">
          {tree.roots.length ? renderRows(tree.roots) : (
            <div className={`${ROW} h-[30px] px-2 font-mono text-sm text-[var(--text-3)]`}>{shortValue(sample, 60)}</div>
          )}
        </div>
      ) : (
        panel === null && !oneRow && (
          <div className="flex flex-col items-start gap-3 px-2 pb-1.5 pt-3.5">
            <span data-testid="rp-tree-empty" className="text-sm text-[var(--text-3)]">no sample</span>
            <div className="flex gap-2">
              {onRun && (
                <button type="button" data-testid="rp-tree-run" onClick={() => setPanel('run')} className={BTN_SECONDARY}>
                  <Icon as={Play} />
                  Run
                </button>
              )}
              <button
                type="button"
                data-testid="rp-tree-paste"
                onClick={() => setPanel('paste')}
                className={`${BTN_GHOST} h-9 px-3.5`}
              >
                <Icon as={Clipboard} />
                Paste JSON
              </button>
            </div>
          </div>
        )
      )}
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/*  Sample sources                                                     */
/* ------------------------------------------------------------------ */

function coerce(type: string, text: string): unknown {
  if (text === '') return undefined;
  if (type === 'number' || type === 'integer') {
    const n = Number(text);
    return Number.isFinite(n) ? n : text;
  }
  if (type === 'boolean') return text === 'true' ? true : text === 'false' ? false : text;
  if (type === 'object' || type === 'array') {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function asText(v: unknown): string {
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function RunForm({
  params,
  defaults,
  onRun,
  onDone,
  onCancel,
}: {
  params: RunParam[];
  defaults?: Record<string, unknown>;
  onRun: (args: Record<string, unknown>) => Promise<string | null>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(params.map((p) => [p.name, asText(defaults?.[p.name])])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const args: Record<string, unknown> = {};
    for (const p of params) {
      const v = coerce(p.type, values[p.name] ?? '');
      if (v !== undefined) args[p.name] = v;
    }
    const problem = await onRun(args);
    setBusy(false);
    if (problem) setError(problem);
    else onDone();
  };

  return (
    <form
      data-testid="rp-tree-run-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
      className="mb-3 grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-2 rounded-md bg-[var(--surface)] p-3"
    >
      {params.map((p, i) => (
        <label key={p.name} className="contents">
          <span className="font-mono text-sm text-[var(--text-3)]">
            {p.name}
            {p.required ? '*' : ''}
          </span>
          <input
            type="text"
            autoFocus={i === 0}
            spellCheck={false}
            value={values[p.name] ?? ''}
            data-testid={`rp-tree-run-param-${p.name}`}
            onChange={(e) => setValues({ ...values, [p.name]: e.target.value })}
            className={`${VALUE_INPUT} w-full bg-[var(--surface-2)]`}
          />
        </label>
      ))}
      <div className={`${ROW} col-span-2 gap-2 ${params.length ? 'pt-1' : ''}`}>
        <button type="submit" autoFocus={params.length === 0} disabled={busy} aria-busy={busy || undefined} data-testid="rp-tree-run-submit" className={BTN_SECONDARY}>
          <Icon as={Play} />
          Run
        </button>
        <button type="button" aria-label="close" onClick={onCancel} className={BTN_GHOST}>
          <Icon as={X} />
        </button>
        {error && (
          <span data-testid="rp-tree-run-error" title={error} className={`min-w-0 truncate font-mono text-sm ${TONE_TEXT.danger}`}>
            {error}
          </span>
        )}
      </div>
    </form>
  );
}

function PasteForm({ onPaste, onCancel }: { onPaste: (value: unknown) => void; onCancel: () => void }) {
  const [text, setText] = useState('');
  const parsed = useMemo(() => {
    if (!text.trim()) return { ok: false as const, empty: true };
    try {
      return { ok: true as const, value: JSON.parse(text) as unknown };
    } catch {
      return { ok: false as const, empty: false };
    }
  }, [text]);
  const invalid = !parsed.ok && !parsed.empty;
  return (
    <form
      data-testid="rp-tree-paste-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (parsed.ok) onPaste(parsed.value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
      className="mb-3 flex flex-col gap-2"
    >
      <textarea
        autoFocus
        rows={6}
        spellCheck={false}
        value={text}
        aria-label="response JSON"
        aria-invalid={invalid || undefined}
        data-testid="rp-tree-paste-input"
        onChange={(e) => setText(e.target.value)}
        placeholder="{ }"
        className="w-full resize-y rounded-md bg-[var(--surface)] p-3 font-mono text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-3)] focus:ring-2 focus:ring-[var(--brand)] aria-[invalid=true]:shadow-[inset_0_0_0_1px_var(--t-danger-fg)]"
      />
      <div className={`${ROW} gap-2`}>
        <button type="submit" disabled={!parsed.ok} data-testid="rp-tree-paste-submit" className={BTN_SECONDARY}>
          <Icon as={Clipboard} />
          Paste
        </button>
        <button type="button" aria-label="close" onClick={onCancel} className={BTN_GHOST}>
          <Icon as={X} />
        </button>
      </div>
    </form>
  );
}
