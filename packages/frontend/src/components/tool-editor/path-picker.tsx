import type { FieldTone } from './response-processing-styles';

/**
 * Paths over a recorded sample: parsing, resolving, and what a sample says
 * about a step's paths. Pure; the response tree (response-tree.tsx) and the
 * path fields (path-input.tsx) are built on it.
 */

/* ------------------------------------------------------------------ */
/*  Paths over a sample (pure)                                         */
/* ------------------------------------------------------------------ */

export type PathMode = 'input' | 'writes';
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
/*  Stored form <-> what the field shows                               */
/* ------------------------------------------------------------------ */

/** `$.items[*]` -> `items[*]`; `$` / empty -> empty (the whole response). */
export function eachLabel(each: string | undefined): string {
  const p = (each ?? '').trim();
  if (!p || p === '$') return '';
  return p.replace(/^\$\.?/, '');
}

/** What the user typed into `each`, stored as an absolute path. */
export function eachFromInput(text: string): string | undefined {
  const t = text.trim();
  if (!t || t === '$') return undefined;
  if (t.startsWith('$')) return t;
  return t.startsWith('[') ? `$${t}` : `$.${t}`;
}

/** `$.a.b` -> `a.b`, `$['x']` -> `['x']`; `$` stays `$`. */
export function relPath(path: string): string {
  const p = path.trim();
  return p === '$' ? '$' : p.replace(/^\$\.?/, '');
}

/**
 * The Input field: `each` without `$.` joined with `reads`.
 * `$.items[*]` + `price_usd` -> `items[*].price_usd`; `$.items[*]` + `$` -> `items[*]`;
 * no each + `$.total` -> `total`; no each + `$` -> `$`.
 */
export function inputOf(each: string | undefined, reads: string): string {
  const e = eachLabel(each);
  const r = reads.trim();
  const rel = r === '$' ? '' : relPath(r);
  if (!e) return r === '$' ? '$' : rel;
  if (!rel) return e;
  return rel.startsWith('[') ? `${e}${rel}` : `${e}.${rel}`;
}

/**
 * The stored form of an Input: split at the last `[*]`. Up to and including it
 * is `each` (`$.items[*]`), the rest `reads` relative to the element (`$` when
 * nothing is left). Without `[*]`: no `each`, `reads` the absolute path.
 */
export function splitInput(text: string): { each?: string; reads: string } {
  const t = text.trim();
  if (!t) return { reads: '' };
  if (t === '$') return { reads: '$' };
  const at = t.lastIndexOf('[*]');
  if (at < 0) return { reads: t.startsWith('$') ? t : t.startsWith('[') ? `$${t}` : `$.${t}` };
  const each = eachFromInput(t.slice(0, at + 3));
  const rest = t.slice(at + 3).replace(/^\./, '');
  return { ...(each ? { each } : {}), reads: rest || '$' };
}

/** `items[*].price_usd -> price_eur`; the Input alone when the step writes where it reads. */
export function pathSummary(step: { each?: string; reads: string; writes: string }): string {
  const input = step.reads.trim() ? inputOf(step.each, step.reads) : '?';
  const w = step.writes.trim();
  return w && relPath(w) !== relPath(step.reads) ? `${input} → ${w}` : input;
}

/* ------------------------------------------------------------------ */
/*  What a step receives per run                                       */
/* ------------------------------------------------------------------ */

/**
 * The elements `each` stands for in a sample, as the server walks them: `[*]`
 * through array elements and object values, a path ending on an array (or no
 * `each` on an array response) means its elements. `many` when that iterates;
 * `count` uses the uncut length when the sample cut the array. Null when the
 * path is not there.
 */
export function elementsOf(
  sample: unknown,
  each: string | undefined,
  lengths: Record<string, number> = {},
): { values: unknown[]; many: boolean; count: number } | null {
  const e = (each ?? '').trim();
  const tokens = e && e !== '$' ? parsePath(e) : [];
  if (!tokens) return null;
  let values: unknown[] = [sample];
  let many = false;
  let arrayPath: string | null = null;
  let path = '$';
  const iterate = (v: unknown): unknown[] | null =>
    Array.isArray(v) ? v : isObject(v) ? Object.values(v) : null;
  for (const t of tokens) {
    const next: unknown[] = [];
    for (const v of values) {
      if (t.kind === 'key') {
        if (isObject(v) && t.name in v) next.push(v[t.name]);
      } else if (t.kind === 'index') {
        if (Array.isArray(v)) {
          const x = v[t.index < 0 ? v.length + t.index : t.index];
          if (x !== undefined) next.push(x);
        }
      } else {
        const list = iterate(v);
        if (list) next.push(...list);
      }
    }
    if (t.kind === 'wildcard') {
      arrayPath = many ? null : Array.isArray(values[0]) ? path : null;
      many = true;
      path = `${path}[*]`;
    } else {
      path = t.kind === 'key' ? joinKey(path, t.name) : `${path}[${t.index}]`;
    }
    values = next;
    if (!values.length && !many) return null;
  }
  const last = tokens[tokens.length - 1];
  if ((!last || last.kind !== 'wildcard') && values.length === 1 && Array.isArray(values[0])) {
    arrayPath = many ? null : path;
    values = values[0] as unknown[];
    many = true;
  }
  const count = arrayPath !== null && lengths[arrayPath] !== undefined ? lengths[arrayPath] : values.length;
  return { values, many, count };
}

/**
 * The type label of an Input, TypeScript-style. Walking elements (`[*]`):
 * `number[30]`, `object[30]`, `mixed[30]` when they differ. A single value:
 * `number`, `string`, `boolean`, `null`, a whole array `array[30]`, a whole
 * object `object{99}`. Null when the sample cannot tell.
 */
export function inputType(
  sample: unknown,
  each: string | undefined,
  reads: string,
  lengths: Record<string, number> = {},
): string | null {
  const r = reads.trim();
  if (sample === undefined || !r || (r !== '$' && !parsePath(r))) return null;
  const el = elementsOf(sample, each, lengths);
  if (!el) return null;
  const read = r === '$' ? el.values : el.values.map((v) => resolvePath(v, r)).filter((x) => x.found).map((x) => x.value);
  if (!read.length) return null;
  if (el.many) {
    const types = new Set(read.map(jsonType));
    return `${types.size === 1 ? [...types][0] : 'mixed'}[${el.count}]`;
  }
  const v = read[0];
  if (Array.isArray(v)) {
    // The uncut length, when the sample cut the array (no `each`: `reads` is the absolute path).
    const tokens = !(each ?? '').trim() || (each ?? '').trim() === '$' ? parsePath(r === '$' ? '' : r) : null;
    let key = '$';
    for (const t of tokens ?? []) key = t.kind === 'key' ? joinKey(key, t.name) : t.kind === 'index' ? `${key}[${t.index}]` : `${key}[*]`;
    return `array[${tokens && lengths[key] !== undefined ? lengths[key] : v.length}]`;
  }
  if (isObject(v)) return `object{${Object.keys(v).length}}`;
  return jsonType(v);
}

/** The elements of `each` are scalars: nothing can be written under them, `writes` is the Input itself. */
export function elementIsScalar(sample: unknown, each: string | undefined): boolean {
  if (sample === undefined) return false;
  const el = eachElement(sample, each);
  return el.found && !Array.isArray(el.value) && !isObject(el.value);
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
  use: unknown;
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
  const step = steps[index];
  const out: PathProblem[] = [];
  const writes = step.writes.trim();
  // `$` (the Input itself) always exists: `add` is refused at run time.
  const tiedWhole = writes === '$' || (!writes && step.reads.trim() === '$');
  if (tiedWhole && step.mode === 'add') out.push({ field: 'writes', code: 'exists', tone: 'danger' });
  if (sample === undefined) return out;
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
        else if (t.kind === 'wildcard' && isObject(v)) v = Object.values(v)[0];
        else if (t.kind === 'index' && Array.isArray(v)) v = v[t.index];
        else {
          found = false;
          break;
        }
      }
      const iterates = tokens[tokens.length - 1]?.kind === 'wildcard';
      if (!found || v === undefined) out.push({ field: 'input', code: 'not in sample', tone: 'warn' });
      // `[*]` walks array elements and object values; nothing else.
      else if (iterates && !Array.isArray(v) && !isObject(v)) out.push({ field: 'input', code: 'not a list', tone: 'danger' });
      else if (!iterates && !Array.isArray(v) && !script && !isObject(v)) out.push({ field: 'input', code: 'not a list', tone: 'danger' });
    }
  }
  const root = eachElement(sample, step.each);
  if (!root.found) return out;
  const earlier = new Set(earlierWrites(steps, index).map((e) => relPath(e.key)));
  const has = (p: string) => earlier.has(relPath(p)) || resolvePath(root.value, p).found;
  const reads = step.reads.trim();
  if (reads && reads !== '$' && !reads.includes('*') && parsePath(reads) && !has(reads)) {
    out.push({ field: 'input', code: 'not in sample', tone: 'warn' });
  }
  if (writes && writes !== '$' && !writes.includes('*') && parsePath(writes)) {
    const exists = has(writes);
    if (step.mode === 'add' && exists) out.push({ field: 'writes', code: 'exists', tone: 'danger' });
    if (step.mode === 'replace' && !exists) out.push({ field: 'writes', code: 'missing', tone: 'danger' });
  }
  return out;
}


/**
 * Is `path` a field the step's elements do not have yet (not in the sample,
 * not written by an earlier step)? Null when the sample cannot tell.
 */
export function isNewField(
  sample: unknown,
  each: string | undefined,
  earlier: { key: string }[],
  path: string,
): boolean | null {
  const p = path.trim();
  if (!p || p === '$' || sample === undefined) return null;
  if (earlier.some((e) => relPath(e.key) === relPath(p))) return false;
  const el = eachElement(sample, each);
  if (!el.found) return null;
  return !resolvePath(el.value, p).found;
}
