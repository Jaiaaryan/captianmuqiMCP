import { z } from 'zod';

/**
 * The arguments a saved script reads, as a JSON Schema object.
 *
 * A script reads its arguments from `args` (`args.days`, `args['as_of']`, or
 * `const { days } = args`). The names found that way become the script's
 * parameters; the author then sets each one's type, whether it is required and a
 * description. A script with parameters is offered on MCP servers as a tool of
 * its own name taking exactly those parameters (see sandbox-tools.ts).
 *
 * Reading the text is a convenience for the author, not a security control:
 * what a script may call is decided by its declared tools at run time, and the
 * arguments reach it as plain data whatever the schema says.
 *
 * The frontend repeats the name inference in
 * packages/frontend/src/app/sandbox/script-parameters.tsx; keep the two in sync.
 */

export const PARAMETER_TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object'] as const;
export type ParameterType = (typeof PARAMETER_TYPES)[number];
type ItemType = 'string' | 'number' | 'integer' | 'boolean';
const ITEM_TYPES: readonly string[] = ['string', 'number', 'integer', 'boolean'];

export const PARAMETER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const PARAMETERS_MAX = 20;
export const PARAMETER_DESCRIPTION_MAX_CHARS = 500;
const ENUM_MAX = 100;
const ENUM_STRING_MAX_CHARS = 200;

export interface ParameterDefinition {
  type: ParameterType;
  description?: string;
  enum?: (string | number | boolean)[];
  items?: { type: ItemType };
  /** Keep this parameter although the code no longer reads it. */
  'x-keep'?: boolean;
}

export interface ParametersSchema {
  type: 'object';
  properties: Record<string, ParameterDefinition>;
  required: string[];
}

// ---- inference -------------------------------------------------------------

/**
 * The same code with comments blanked and the contents of string literals
 * replaced by `s`, so a pattern only ever sees real code. The expressions inside
 * a template literal (`${args.x}`) are code and are kept. Positions and line
 * breaks are preserved.
 */
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

/** Members every object has: `args.toString` is not an argument. */
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

/**
 * The patterns, copied verbatim into script-parameters.tsx (frontend). Keep in sync.
 *  - `args.name` and `args?.name`
 *  - `args['name']` and `args["name"]` (a plain string literal only)
 *  - the start of a destructuring: `const|let|var {`  (its body is read separately)
 */
export const ARGS_DOT = /(?<![\w$.])args\s*\??\.\s*([A-Za-z_$][\w$]*)/g;
export const ARGS_BRACKET = /(?<![\w$.])args\s*\[\s*(["'])(s*)\1\s*\]/g;
export const DESTRUCTURE_START = /(?<![\w$.])(?:const|let|var)\s*\{/g;
/** What must follow the closing brace of a destructuring for it to read `args`. */
export const DESTRUCTURE_FROM_ARGS = /^\s*=\s*args(?![\w$.])/;

const isName = (name: string) => PARAMETER_NAME_PATTERN.test(name) && !NOT_ARGUMENTS.has(name);

/** Index of the brace that closes the one opened at `open`, or -1. */
function closingBrace(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Keys of a destructuring body (`a, b: c, d = 1, ...rest`): `a`, `b`, `d`. */
function destructuredKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let start = 0;
  const take = (end: number) => {
    const part = body.slice(start, end).trim();
    start = end + 1;
    // `...rest` and computed keys are not arguments by name.
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

/** The argument names a script reads, in order of first appearance. */
export function inferParameters(code: string): { names: string[] } {
  const masked = maskNonCode(code);
  const found: { name: string; at: number }[] = [];

  for (const m of masked.matchAll(ARGS_DOT)) {
    found.push({ name: m[1], at: m.index });
  }
  for (const m of masked.matchAll(ARGS_BRACKET)) {
    // The key is read from the original text: masked, its contents are `s` runs.
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
  return { names };
}

// ---- merge -----------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The parameters a script is saved with: what the author set, kept as set, plus
 * each name newly found in the code as a required string. A parameter the code
 * no longer reads is dropped unless the author marked it `"x-keep": true`.
 * Null when nothing is left and nothing was set, which turns the tool off; an
 * author who set an (empty) schema keeps it, and the script is a tool without
 * parameters.
 */
export function mergeParameters(inferred: string[], existing: unknown): ParametersSchema | null {
  const before = isRecord(existing) && isRecord(existing.properties) ? existing.properties : {};
  const wasRequired = new Set(
    isRecord(existing) && Array.isArray(existing.required) ? (existing.required as string[]) : [],
  );
  const referenced = new Set(inferred);

  const properties: Record<string, ParameterDefinition> = {};
  const required: string[] = [];
  for (const [name, def] of Object.entries(before)) {
    if (!isRecord(def)) continue;
    if (!referenced.has(name) && def['x-keep'] !== true) continue;
    properties[name] = def as unknown as ParameterDefinition;
    if (wasRequired.has(name)) required.push(name);
  }
  for (const name of inferred) {
    if (name in properties) continue;
    properties[name] = { type: 'string' };
    required.push(name);
  }
  if (Object.keys(properties).length === 0 && !isRecord(existing)) return null;
  return { type: 'object', properties, required };
}

// ---- validation ------------------------------------------------------------

const isPrimitive = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

const enumItemFits = (type: string, v: unknown) =>
  type === 'string'
    ? typeof v === 'string' && v.length <= ENUM_STRING_MAX_CHARS
    : type === 'boolean'
      ? typeof v === 'boolean'
      : (type === 'number' || type === 'integer') && typeof v === 'number' && Number.isFinite(v);

function unknownKey(obj: Record<string, unknown>, allowed: string[]): string | undefined {
  return Object.keys(obj).find((k) => !allowed.includes(k));
}

/** A reason the schema is not acceptable, or null when it is. */
export function validateParameters(schema: unknown): string | null {
  if (!isRecord(schema) || schema.type !== 'object') {
    return 'parameters must be an object schema: { type: "object", properties, required }';
  }
  const stray = unknownKey(schema, ['type', 'properties', 'required']);
  if (stray) return `parameters has an unknown field '${stray}'`;
  if (!isRecord(schema.properties)) return 'parameters.properties must be an object';
  const names = Object.keys(schema.properties);
  if (names.length > PARAMETERS_MAX) return `A script can have at most ${PARAMETERS_MAX} parameters`;

  for (const name of names) {
    if (!PARAMETER_NAME_PATTERN.test(name)) {
      return `Parameter name '${name.slice(0, 40)}' must be 1-64 characters of letters, digits or "_", not starting with a digit`;
    }
    const def = schema.properties[name];
    if (!isRecord(def)) return `Parameter '${name}' must be an object`;
    const bad = unknownKey(def, ['type', 'description', 'enum', 'items', 'x-keep']);
    if (bad) return `Parameter '${name}' has an unknown field '${bad}'`;
    if (typeof def.type !== 'string' || !(PARAMETER_TYPES as readonly string[]).includes(def.type)) {
      return `Parameter '${name}' needs a type: ${PARAMETER_TYPES.join(', ')}`;
    }
    if (def.description !== undefined) {
      if (typeof def.description !== 'string') return `Parameter '${name}': description must be text`;
      if (def.description.length > PARAMETER_DESCRIPTION_MAX_CHARS) {
        return `Parameter '${name}': description is longer than ${PARAMETER_DESCRIPTION_MAX_CHARS} characters`;
      }
    }
    if (def['x-keep'] !== undefined && typeof def['x-keep'] !== 'boolean') {
      return `Parameter '${name}': x-keep must be true or false`;
    }
    if (def.enum !== undefined) {
      if (!Array.isArray(def.enum) || def.enum.length === 0 || def.enum.length > ENUM_MAX) {
        return `Parameter '${name}': enum must list 1-${ENUM_MAX} values`;
      }
      if (!def.enum.every(isPrimitive) || !def.enum.every((v) => enumItemFits(def.type as string, v))) {
        return `Parameter '${name}': enum values must be ${def.type === 'array' || def.type === 'object' ? 'omitted for this type' : `of type ${def.type}`}`;
      }
    }
    if (def.items !== undefined) {
      if (def.type !== 'array') return `Parameter '${name}': items applies to arrays only`;
      if (!isRecord(def.items) || unknownKey(def.items, ['type']) || !ITEM_TYPES.includes(def.items.type as string)) {
        return `Parameter '${name}': items must be { type: ${ITEM_TYPES.join(' | ')} }`;
      }
    }
  }

  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || !schema.required.every((r) => typeof r === 'string')) {
      return 'parameters.required must be a list of parameter names';
    }
    const unknown = (schema.required as string[]).find((r) => !(r in (schema.properties as object)));
    if (unknown !== undefined) return `parameters.required names '${unknown.slice(0, 40)}', which is not a parameter`;
  }
  return null;
}

// ---- MCP registration --------------------------------------------------------

function primitiveZod(type: string): z.ZodType {
  switch (type) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    default:
      return z.unknown();
  }
}

function propertyZod(def: ParameterDefinition): z.ZodType {
  const values = def.enum;
  if (values && values.length > 0 && def.type !== 'array' && def.type !== 'object') {
    if (def.type === 'string' && values.every((v) => typeof v === 'string')) {
      return z.enum(values as [string, ...string[]]);
    }
    const literals = values.map((v) => z.literal(v));
    return literals.length === 1 ? literals[0] : z.union(literals as [z.ZodLiteral, z.ZodLiteral, ...z.ZodLiteral[]]);
  }
  if (def.type === 'array') return z.array(def.items ? primitiveZod(def.items.type) : z.unknown());
  if (def.type === 'object') return z.record(z.string(), z.unknown());
  return primitiveZod(def.type);
}

/** The Zod raw shape that registers a script's parameters as an MCP tool's input. */
export function toZodShape(schema: unknown): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};
  if (!isRecord(schema) || !isRecord(schema.properties)) return shape;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  for (const [name, raw] of Object.entries(schema.properties)) {
    if (!isRecord(raw)) continue;
    let field = propertyZod(raw as unknown as ParameterDefinition);
    if (typeof raw.description === 'string' && raw.description) field = field.describe(raw.description);
    shape[name] = required.has(name) ? field : field.optional();
  }
  return shape;
}
