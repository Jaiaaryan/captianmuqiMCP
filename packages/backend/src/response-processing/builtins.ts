/**
 * Built-in response processors: small, pure, synchronous, versioned.
 *
 * Each one turns a single value into a single value (a price into a price, a
 * string into a string) and declares its contract: the type it accepts, the
 * type it returns and its parameters with their bounds. The chain runner reads
 * the contract to refuse a wrong input BEFORE the processor runs, and the REST
 * registry hands the same contracts to the editor so it can build a form.
 *
 * A processor never touches anything but the value and its own parameters: no
 * clock, no randomness, no I/O. Same input, same output, on every call.
 */

export type BuiltinValueType = 'number' | 'string' | 'any';
export type BuiltinParamType =
  | 'number'
  | 'integer'
  | 'string'
  | 'boolean'
  | 'object'
  | 'any';

export interface BuiltinParam {
  name: string;
  type: BuiltinParamType;
  required?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
}

export interface BuiltinContract {
  name: string;
  version: number;
  title: string;
  input: BuiltinValueType;
  output: BuiltinValueType;
  params: BuiltinParam[];
}

/**
 * Raised by a processor for a value it cannot handle. The message completes the
 * sentence the chain runner builds after the field path:
 * `step <id>: $.items[3].status <message>`.
 */
export class BuiltinError extends Error {}

type Params = Record<string, unknown>;

interface Builtin {
  contract: BuiltinContract;
  run(value: unknown, params: Params): unknown;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Round to `decimals` places, halves away from zero (-0.005 -> -0.01).
 *
 * Math.round alone rounds -0.5 up to -0 and, on binary floats, 1.005 * 100 is
 * 100.49999999999999. Shifting the decimal point in the number's own decimal
 * text avoids both: "1.005e2" is exactly 100.5.
 */
export function roundHalfAwayFromZero(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const abs = Math.abs(value);
  const sign = value < 0 ? -1 : 1;
  let rounded: number;
  const text = String(abs);
  if (text.includes('e')) {
    // Exponent notation (1e-7, 1e21): the text trick does not apply.
    const factor = 10 ** decimals;
    rounded = Math.round(abs * factor) / factor;
  } else {
    rounded = Number(`${Math.round(Number(`${text}e${decimals}`))}e-${decimals}`);
  }
  const out = sign * rounded;
  // -0.001 rounded to 2 places is 0, not -0: JSON would print both as 0, but
  // Object.is-based comparisons would not.
  return out === 0 ? 0 : out;
}

const num = (name: string, extra: Partial<BuiltinParam> = {}): BuiltinParam => ({
  name,
  type: 'number',
  ...extra,
});

const ROUND_PARAM: BuiltinParam = {
  name: 'round',
  type: 'integer',
  min: 0,
  max: 10,
};

function finite(result: number): number {
  if (!Number.isFinite(result)) {
    throw new BuiltinError('produced a number that is not finite');
  }
  return result;
}

function maybeRound(result: number, params: Params): number {
  const places = params.round;
  return typeof places === 'number' ? roundHalfAwayFromZero(result, places) : result;
}

function mapKey(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? String(value);
}

/* ------------------------------------------------------------------ */
/*  The registry                                                       */
/* ------------------------------------------------------------------ */

const BUILTINS: Record<string, Builtin> = {
  'scale@1': {
    contract: {
      name: 'scale',
      version: 1,
      title: 'Multiply by a factor',
      input: 'number',
      output: 'number',
      params: [num('factor', { required: true }), ROUND_PARAM],
    },
    run: (value, p) => maybeRound(finite((value as number) * (p.factor as number)), p),
  },
  'offset@1': {
    contract: {
      name: 'offset',
      version: 1,
      title: 'Add an amount',
      input: 'number',
      output: 'number',
      params: [num('amount', { required: true }), ROUND_PARAM],
    },
    run: (value, p) => maybeRound(finite((value as number) + (p.amount as number)), p),
  },
  'vat@1': {
    contract: {
      name: 'vat',
      version: 1,
      title: 'Add VAT (value x (1 + rate))',
      input: 'number',
      output: 'number',
      params: [num('rate', { required: true, min: 0, max: 1 }), ROUND_PARAM],
    },
    run: (value, p) => maybeRound(finite((value as number) * (1 + (p.rate as number))), p),
  },
  'round@1': {
    contract: {
      name: 'round',
      version: 1,
      title: 'Round half away from zero',
      input: 'number',
      output: 'number',
      params: [{ name: 'decimals', type: 'integer', default: 2, min: 0, max: 10 }],
    },
    run: (value, p) => roundHalfAwayFromZero(value as number, p.decimals as number),
  },
  'clean_text@1': {
    contract: {
      name: 'clean_text',
      version: 1,
      title: 'Trim and collapse whitespace',
      input: 'string',
      output: 'string',
      params: [
        { name: 'trim', type: 'boolean', default: true },
        { name: 'collapseWhitespace', type: 'boolean', default: true },
      ],
    },
    run: (value, p) => {
      let text = value as string;
      // Collapse first: a run of spaces at the edge becomes one space, which
      // the trim then removes.
      if (p.collapseWhitespace) text = text.replace(/\s+/g, ' ');
      if (p.trim) text = text.trim();
      return text;
    },
  },
  'truncate@1': {
    contract: {
      name: 'truncate',
      version: 1,
      title: 'Shorten to a maximum length',
      input: 'string',
      output: 'string',
      params: [
        { name: 'maxLength', type: 'integer', required: true, min: 1, max: 100000 },
        { name: 'ellipsis', type: 'string', default: '…' },
      ],
    },
    run: (value, p) => {
      const text = value as string;
      const max = p.maxLength as number;
      if (text.length <= max) return text;
      const ellipsis = p.ellipsis as string;
      // maxLength includes the ellipsis. An ellipsis longer than the limit
      // cannot fit: cut it too instead of exceeding the limit.
      if (ellipsis.length >= max) return ellipsis.slice(0, max);
      return text.slice(0, max - ellipsis.length) + ellipsis;
    },
  },
  'map@1': {
    contract: {
      name: 'map',
      version: 1,
      title: 'Replace a value using a lookup table',
      input: 'any',
      output: 'any',
      params: [
        { name: 'map', type: 'object', required: true },
        { name: 'fallback', type: 'string' },
      ],
    },
    run: (value, p) => {
      const table = p.map as Record<string, unknown>;
      const key = mapKey(value);
      if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
      if (typeof p.fallback === 'string') return p.fallback;
      const shown = key.length > 40 ? `${key.slice(0, 40)}…` : key;
      throw new BuiltinError(`has no entry in the map (${JSON.stringify(shown)})`);
    },
  },
};

/** Names of every built-in, `scale@1` style. */
export const BUILTIN_IDS = Object.keys(BUILTINS);

export function isBuiltin(use: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILTINS, use);
}

export function getBuiltinContract(use: string): BuiltinContract | null {
  return isBuiltin(use) ? BUILTINS[use].contract : null;
}

/** Contracts for the REST registry, in a stable order. */
export function describeBuiltins(): Array<BuiltinContract & { use: string }> {
  return BUILTIN_IDS.map((use) => ({ use, ...BUILTINS[use].contract }));
}

/* ------------------------------------------------------------------ */
/*  Parameters                                                         */
/* ------------------------------------------------------------------ */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkParamValue(spec: BuiltinParam, value: unknown): string | null {
  const where = `params.${spec.name}`;
  const range =
    spec.min !== undefined && spec.max !== undefined
      ? ` between ${spec.min} and ${spec.max}`
      : '';
  switch (spec.type) {
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `${where} must be a number${range}`;
      }
      if (spec.type === 'integer' && !Number.isInteger(value)) {
        return `${where} must be an integer${range}`;
      }
      if (
        (spec.min !== undefined && value < spec.min) ||
        (spec.max !== undefined && value > spec.max)
      ) {
        return `${where} must be ${spec.type === 'integer' ? 'an integer' : 'a number'}${range}`;
      }
      return null;
    }
    case 'string':
      return typeof value === 'string' ? null : `${where} must be a string`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${where} must be true or false`;
    case 'object':
      return isPlainObject(value) ? null : `${where} must be an object`;
    default:
      return null;
  }
}

/**
 * Check `params` against the contract of `use`: unknown names, missing
 * required ones, types and bounds. Returns the first problem, or null.
 */
export function validateBuiltinParams(use: string, params: unknown): string | null {
  const contract = getBuiltinContract(use);
  if (!contract) return `unknown processor "${use}"`;
  if (params !== undefined && !isPlainObject(params)) return 'params must be an object';
  const given = (params ?? {}) as Record<string, unknown>;

  const known = new Set(contract.params.map((p) => p.name));
  for (const name of Object.keys(given)) {
    if (!known.has(name)) {
      return `unknown param "${name}" (${use} accepts: ${[...known].join(', ')})`;
    }
  }
  for (const spec of contract.params) {
    const value = given[spec.name];
    if (value === undefined) {
      if (spec.required) return `params.${spec.name} is required`;
      continue;
    }
    const problem = checkParamValue(spec, value);
    if (problem) return problem;
  }
  return null;
}

/** Params with the contract's defaults filled in. Call after validation. */
export function withDefaults(use: string, params: unknown): Params {
  const contract = getBuiltinContract(use);
  const out: Params = { ...((params as Params | undefined) ?? {}) };
  for (const spec of contract?.params ?? []) {
    if (out[spec.name] === undefined && spec.default !== undefined) {
      out[spec.name] = spec.default;
    }
  }
  return out;
}

/** Does `value` satisfy the input type a processor declares? */
export function matchesInput(type: BuiltinValueType, value: unknown): boolean {
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'string') return typeof value === 'string';
  return true;
}

/**
 * Run a processor. Parameters must already be validated. Throws BuiltinError
 * for an input of the wrong type or a value the processor cannot handle; the
 * message completes a sentence that starts with the field path.
 */
export function runBuiltin(use: string, value: unknown, params?: unknown): unknown {
  if (!isBuiltin(use)) throw new BuiltinError(`unknown processor "${use}"`);
  const { input } = BUILTINS[use].contract;
  if (!matchesInput(input, value)) throw new BuiltinError(`is not a ${input}`);
  return BUILTINS[use].run(value, withDefaults(use, params));
}
