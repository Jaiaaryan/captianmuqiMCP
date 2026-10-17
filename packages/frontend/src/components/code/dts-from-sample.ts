import { eachElement, parsePath } from '@/components/tool-editor/path-picker';

/**
 * TypeScript declarations inferred from a JSON sample, for the editor of a
 * script step: `value` is what `reads` resolves to inside the first element of
 * the step's `each` (the element itself when `reads` is `$`); `response` is always
 * the whole response root, the document as it stands before this step.
 */

const MAX_DEPTH = 8;
const MAX_ELEMENTS = 3;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pascal(s: string): string {
  const out = s
    .replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ''))
    .replace(/^./, (c) => c.toUpperCase());
  return /^[A-Za-z_]/.test(out) ? out : `T${out}`;
}

/** `items` -> `Item`: a crude singular for element interfaces. */
function singular(name: string): string {
  if (/ies$/.test(name) && name.length > 4) return `${name.slice(0, -3)}y`;
  if (/[^s]s$/.test(name) && name.length > 3) return name.slice(0, -1);
  return `${name}Item`;
}

function propKey(k: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
}

function wrap(t: string): string {
  return /[|&]/.test(t) ? `(${t})` : t;
}

class Emitter {
  readonly decls: string[] = [];
  private readonly names = new Set<string>();

  constructor(private readonly prefix: string) {}

  private name(base: string): string {
    const root = `${this.prefix}${pascal(base)}`;
    let name = root;
    for (let i = 2; this.names.has(name); i++) name = `${root}${i}`;
    this.names.add(name);
    return name;
  }

  /** One type for every sample given (they are values found at the same place). */
  type(samples: unknown[], base: string, depth: number): string {
    const parts = new Set<string>();
    const arrays: unknown[][] = [];
    const objects: Record<string, unknown>[] = [];
    for (const s of samples) {
      if (s === null || s === undefined) parts.add('null');
      else if (typeof s === 'string') parts.add('string');
      else if (typeof s === 'number') parts.add('number');
      else if (typeof s === 'boolean') parts.add('boolean');
      else if (Array.isArray(s)) arrays.push(s);
      else if (isObject(s)) objects.push(s);
    }
    if (arrays.length) {
      const elements = arrays.flatMap((a) => a.slice(0, MAX_ELEMENTS));
      const inner =
        elements.length === 0 || depth >= MAX_DEPTH ? 'unknown' : this.type(elements, singular(base), depth + 1);
      parts.add(`${wrap(inner)}[]`);
    }
    if (objects.length) parts.add(depth >= MAX_DEPTH ? 'Record<string, unknown>' : this.object(objects, base, depth));
    const list = [...parts];
    // `null` last reads better: `string | null`.
    list.sort((a, b) => (a === 'null' ? 1 : b === 'null' ? -1 : 0));
    return list.join(' | ') || 'unknown';
  }

  private object(objects: Record<string, unknown>[], base: string, depth: number): string {
    const keys: string[] = [];
    for (const o of objects) for (const k of Object.keys(o)) if (!keys.includes(k)) keys.push(k);
    if (keys.length === 0) return 'Record<string, unknown>';
    const name = this.name(base);
    const lines = keys.slice(0, 200).map((k) => {
      const present = objects.filter((o) => k in o);
      const optional = present.length < objects.length ? '?' : '';
      const t = this.type(
        present.map((o) => o[k]),
        `${base}_${k}`,
        depth + 1,
      );
      return `  ${propKey(k)}${optional}: ${t};`;
    });
    this.decls.push(`interface ${name} {\n${lines.join('\n')}\n}`);
    return name;
  }
}

/** The value `reads` addresses inside `element`; `$` is the element itself. */
export function readValue(element: unknown, reads: string | undefined): { found: boolean; value: unknown } {
  const path = (reads ?? '').trim();
  if (!path) return { found: false, value: undefined };
  if (path === '$') return { found: true, value: element };
  const tokens = parsePath(path);
  if (!tokens) return { found: false, value: undefined };
  let v: unknown = element;
  for (const t of tokens) {
    if (t.kind === 'key' && isObject(v) && t.name in v) v = v[t.name];
    else if (t.kind === 'index' && Array.isArray(v)) v = v[t.index < 0 ? v.length + t.index : t.index];
    else return { found: false, value: undefined };
  }
  return { found: v !== undefined, value: v };
}

export interface SampleDeclOptions {
  /** The step's `each` and `reads`; `value` is unknown without them. */
  each?: string;
  reads?: string;
  valueName?: string;
  responseName?: string;
}

/**
 * `declare const value: …; declare const response: …; declare const params: …;`
 * with interfaces inferred from `sample` (depth ≤ 8, arrays from their first 3
 * elements, keys missing in some elements optional). Without a sample both are
 * `unknown`.
 */
export function declarationsFromSample(sample: unknown, options: SampleDeclOptions = {}): string {
  const { each, reads, valueName = 'value', responseName = 'response' } = options;
  if (sample === undefined) {
    return [
      `declare const ${valueName}: unknown;`,
      `declare const ${responseName}: unknown;`,
      'declare const params: Record<string, unknown>;',
      '',
    ].join('\n');
  }
  const emit = new Emitter('Sample');
  const responseType = emit.type([sample], 'response', 0);
  const element = eachElement(sample, each);
  const read = element.found ? readValue(element.value, reads) : { found: false, value: undefined };
  const valueType = read.found ? emit.type([read.value], 'value', 0) : 'unknown';
  return [
    ...emit.decls,
    `/** What the step reads: \`${(reads ?? '').replace(/\*\//g, '* /')}\` of each element. */`,
    `declare const ${valueName}: ${valueType};`,
    '/** The whole response root, as it stands before this step. */',
    `declare const ${responseName}: ${responseType};`,
    'declare const params: Record<string, unknown>;',
    '',
  ].join('\n');
}
