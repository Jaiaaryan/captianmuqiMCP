/**
 * The processor registry — the library of versioned, capability-free steps a
 * response processor chain is built from.
 *
 * Why a registry and not expressions: a processor chain is operator (and agent)
 * configuration that runs on every tool call, so the steps have to be auditable
 * and bounded. A processor is therefore *code with no capabilities*: a pure
 * function from one value and a set of declared parameters to one value. It
 * cannot read another field, call a tool, reach the network or the file system,
 * or keep state between items. Everything it may do is in its declared
 * contract below, which is also what the dashboard renders and what an agent
 * reads before it writes a chain.
 *
 * Each definition carries its own `version`, so a chain pins the behaviour it
 * was built against (`number_scale@1`). A changed rounding rule ships as
 * version 2 next to version 1; chains that named version 1 keep their numbers.
 *
 * Errors are thrown as `ProcessorValueError` with a message that completes the
 * sentence "<path> …" — the chain runner prepends the step id and the JSON path
 * of the offending value, so a failure reads
 *   step convert_to_eur: $.items[0].price_usd is not a number
 * and names the field the operator has to look at.
 */

export type ProcessorValueType = 'number' | 'string' | 'boolean' | 'object' | 'array' | 'any';

export interface ProcessorPort {
  /** Name of the port, as the contract documents it (`value`, `text`, …). */
  name: string;
  type: ProcessorValueType;
  description: string;
}

export interface ProcessorParameter {
  name: string;
  /** `any` is checked only for presence: the value may be any JSON. */
  type: 'number' | 'integer' | 'string' | 'boolean' | 'object' | 'any';
  description: string;
  required?: boolean;
  /** Used when the step omits the parameter. */
  default?: unknown;
  /** Inclusive bounds for `number` / `integer`. */
  min?: number;
  max?: number;
}

export interface ProcessorDefinition {
  name: string;
  version: number;
  title: string;
  description: string;
  /** What the step's `reads` path must resolve to. */
  input: ProcessorPort;
  /** What the step's `writes` field receives. */
  output: ProcessorPort;
  parameters: ProcessorParameter[];
  /**
   * The whole of the processor. Pure: same value and params in, same value out,
   * no side effects and no access to anything but its arguments.
   */
  apply(value: unknown, params: Record<string, unknown>): unknown;
}

/** A value a processor refused. The message completes "<path> …". */
export class ProcessorValueError extends Error {}

/* ------------------------------------------------------------------ */
/*  Helpers shared by the built-in processors                          */
/* ------------------------------------------------------------------ */

/** Round half away from zero at `decimals`, the way an invoice does. */
export function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  // Math.round is half-up, which is wrong for negatives on an invoice
  // (-0.005 should be -0.01, not -0.00), so the sign is handled separately.
  const scaled = Math.abs(value) * factor;
  const rounded = Math.round(scaled) / factor;
  return value < 0 ? -rounded : rounded;
}

function requireNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProcessorValueError('is not a number');
  }
  return value;
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ProcessorValueError('is not a string');
  }
  return value;
}

/** Apply the optional `round` parameter shared by the numeric processors. */
function maybeRound(value: number, params: Record<string, unknown>): number {
  const decimals = params.round;
  return typeof decimals === 'number' ? roundTo(value, decimals) : value;
}

const ROUND_PARAM: ProcessorParameter = {
  name: 'round',
  type: 'integer',
  description: 'Decimal places to round the result to. Omit to keep full precision.',
  min: 0,
  max: 10,
};

/* ------------------------------------------------------------------ */
/*  The built-in processors                                            */
/* ------------------------------------------------------------------ */

const NUMBER_SCALE: ProcessorDefinition = {
  name: 'number_scale',
  version: 1,
  title: 'Scale a number',
  description:
    'Multiplies a number by a fixed factor. The usual currency conversion: ' +
    'a USD price times the rate gives the EUR price.',
  input: { name: 'value', type: 'number', description: 'The number to scale.' },
  output: { name: 'value', type: 'number', description: 'value × factor.' },
  parameters: [
    {
      name: 'factor',
      type: 'number',
      description: 'What the value is multiplied by (0.92 for USD → EUR).',
      required: true,
    },
    ROUND_PARAM,
  ],
  apply: (value, params) => maybeRound(requireNumber(value) * (params.factor as number), params),
};

const NUMBER_OFFSET: ProcessorDefinition = {
  name: 'number_offset',
  version: 1,
  title: 'Add to a number',
  description: 'Adds a fixed amount to a number — a flat fee, a handling charge.',
  input: { name: 'value', type: 'number', description: 'The number to shift.' },
  output: { name: 'value', type: 'number', description: 'value + amount.' },
  parameters: [
    { name: 'amount', type: 'number', description: 'Added to the value.', required: true },
    ROUND_PARAM,
  ],
  apply: (value, params) => maybeRound(requireNumber(value) + (params.amount as number), params),
};

const NUMBER_VAT: ProcessorDefinition = {
  name: 'number_vat',
  version: 1,
  title: 'Add VAT',
  description:
    'Adds a tax rate to a net amount: value × (1 + rate). A rate of 0.19 turns ' +
    'a net price into a German gross price.',
  input: { name: 'value', type: 'number', description: 'The net amount.' },
  output: { name: 'value', type: 'number', description: 'The gross amount.' },
  parameters: [
    {
      name: 'rate',
      type: 'number',
      description: 'The tax rate as a fraction (0.19 for 19%), at most 1.',
      required: true,
      // 0..1, so the common typo — 19 for 19% — is refused when the chain is
      // saved instead of multiplying every price by twenty. A markup above
      // 100% is a `number_scale` factor, which is deliberately unbounded.
      min: 0,
      max: 1,
    },
    ROUND_PARAM,
  ],
  apply: (value, params) =>
    maybeRound(requireNumber(value) * (1 + (params.rate as number)), params),
};

const NUMBER_ROUND: ProcessorDefinition = {
  name: 'number_round',
  version: 1,
  title: 'Round a number',
  description: 'Rounds a number to a number of decimal places.',
  input: { name: 'value', type: 'number', description: 'The number to round.' },
  output: { name: 'value', type: 'number', description: 'The rounded number.' },
  parameters: [
    {
      name: 'decimals',
      type: 'integer',
      description: 'Decimal places to keep.',
      default: 2,
      min: 0,
      max: 10,
    },
  ],
  apply: (value, params) => roundTo(requireNumber(value), params.decimals as number),
};

const TEXT_CLEAN: ProcessorDefinition = {
  name: 'text_clean',
  version: 1,
  title: 'Clean up text',
  description:
    'Tidies a string that came out of another system: trims the ends and ' +
    'collapses every run of whitespace (including newlines and tabs) into one ' +
    'space.',
  input: { name: 'text', type: 'string', description: 'The string to clean.' },
  output: { name: 'text', type: 'string', description: 'The cleaned string.' },
  parameters: [
    { name: 'trim', type: 'boolean', description: 'Remove leading and trailing whitespace.', default: true },
    {
      name: 'collapseWhitespace',
      type: 'boolean',
      description: 'Replace every run of whitespace with a single space.',
      default: true,
    },
  ],
  apply: (value, params) => {
    let text = requireString(value);
    // Collapse first, then trim: a value of only whitespace then ends up "",
    // not " ". The character class is a literal run with no alternation, so
    // there is nothing here to backtrack over.
    if (params.collapseWhitespace !== false) text = text.replace(/\s+/g, ' ');
    if (params.trim !== false) text = text.trim();
    return text;
  },
};

const TEXT_TRUNCATE: ProcessorDefinition = {
  name: 'text_truncate',
  version: 1,
  title: 'Shorten text',
  description:
    'Caps a string at a length, appending an ellipsis when it had to cut. The ' +
    'cheapest way to stop one long description field from filling the context ' +
    'window.',
  input: { name: 'text', type: 'string', description: 'The string to shorten.' },
  output: { name: 'text', type: 'string', description: 'The shortened string.' },
  parameters: [
    {
      name: 'maxLength',
      type: 'integer',
      description: 'Longest result, including the ellipsis.',
      required: true,
      min: 1,
      max: 100_000,
    },
    { name: 'ellipsis', type: 'string', description: 'Appended when the text was cut.', default: '…' },
  ],
  apply: (value, params) => {
    const text = requireString(value);
    const maxLength = params.maxLength as number;
    if (text.length <= maxLength) return text;
    const ellipsis = String(params.ellipsis ?? '');
    return ellipsis.length >= maxLength
      ? text.slice(0, maxLength)
      : text.slice(0, maxLength - ellipsis.length) + ellipsis;
  },
};

const VALUE_MAP: ProcessorDefinition = {
  name: 'value_map',
  version: 1,
  title: 'Translate a value',
  description:
    'Looks a value up in a table of replacements — upstream status codes into ' +
    "the words the agent should see ('2' → 'shipped').",
  input: { name: 'value', type: 'any', description: 'The value to look up (compared as a string).' },
  output: { name: 'value', type: 'any', description: 'The replacement.' },
  parameters: [
    {
      name: 'map',
      type: 'object',
      description: 'Lookup table: the key is the incoming value as a string.',
      required: true,
    },
    {
      name: 'fallback',
      // Any JSON, like the table's own values: a status code may map to an
      // object as readily as to a word.
      type: 'any',
      description:
        'Used when the value is not in the table. Without it an unmapped value fails the step.',
    },
  ],
  apply: (value, params) => {
    const map = params.map as Record<string, unknown>;
    const key = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
    if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
    if (Object.prototype.hasOwnProperty.call(params, 'fallback')) return params.fallback;
    throw new ProcessorValueError(`has no entry in the map (${JSON.stringify(key)})`);
  },
};

/** Every processor a chain may name, newest version of each last. */
export const PROCESSORS: readonly ProcessorDefinition[] = Object.freeze([
  NUMBER_SCALE,
  NUMBER_OFFSET,
  NUMBER_VAT,
  NUMBER_ROUND,
  TEXT_CLEAN,
  TEXT_TRUNCATE,
  VALUE_MAP,
]);

/* ------------------------------------------------------------------ */
/*  Lookup and parameter checking                                      */
/* ------------------------------------------------------------------ */

/** `number_scale` (newest version) or `number_scale@1` (that one). */
export function findProcessor(ref: string): ProcessorDefinition | null {
  if (typeof ref !== 'string' || !ref.trim()) return null;
  const [name, rawVersion] = ref.trim().split('@');
  const candidates = PROCESSORS.filter((p) => p.name === name);
  if (candidates.length === 0) return null;
  if (rawVersion === undefined) {
    return candidates.reduce((best, p) => (p.version > best.version ? p : best));
  }
  const version = Number(rawVersion);
  return candidates.find((p) => p.version === version) ?? null;
}

/** How a chain should name this processor so its behaviour stays pinned. */
export function processorRef(def: ProcessorDefinition): string {
  return `${def.name}@${def.version}`;
}

/** The registry as an agent or the dashboard reads it: contracts, no code. */
export function describeProcessors() {
  return PROCESSORS.map((p) => ({
    ref: processorRef(p),
    name: p.name,
    version: p.version,
    title: p.title,
    description: p.description,
    input: p.input,
    output: p.output,
    parameters: p.parameters.map((param) => ({
      name: param.name,
      type: param.type,
      description: param.description,
      required: param.required === true,
      ...(param.default !== undefined ? { default: param.default } : {}),
      ...(param.min !== undefined ? { min: param.min } : {}),
      ...(param.max !== undefined ? { max: param.max } : {}),
    })),
  }));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Check a step's parameters against the processor's contract and fill the
 * defaults in. Returns the resolved parameters, or the first problem as a
 * message — chains are validated before they can be activated, so a typo in a
 * parameter name is a 400 at save time and never a surprise at call time.
 */
export function resolveProcessorParams(
  def: ProcessorDefinition,
  raw: unknown,
): { ok: true; params: Record<string, unknown> } | { ok: false; error: string } {
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
    return { ok: false, error: '"params" must be an object' };
  }
  const given = isPlainObject(raw) ? raw : {};
  const declared = new Set(def.parameters.map((p) => p.name));
  for (const key of Object.keys(given)) {
    if (!declared.has(key)) {
      return {
        ok: false,
        error: `${processorRef(def)} has no parameter "${key}" (it takes ${
          def.parameters.map((p) => p.name).join(', ') || 'none'
        })`,
      };
    }
  }

  const params: Record<string, unknown> = {};
  for (const param of def.parameters) {
    const value = Object.prototype.hasOwnProperty.call(given, param.name)
      ? given[param.name]
      : param.default;
    if (value === undefined) {
      if (param.required) {
        return { ok: false, error: `${processorRef(def)} needs the parameter "${param.name}"` };
      }
      continue;
    }
    const error = checkParamType(def, param, value);
    if (error) return { ok: false, error };
    params[param.name] = value;
  }
  return { ok: true, params };
}

function checkParamType(
  def: ProcessorDefinition,
  param: ProcessorParameter,
  value: unknown,
): string | null {
  const where = `${processorRef(def)} parameter "${param.name}"`;
  switch (param.type) {
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `${where} must be a number`;
      }
      if (param.type === 'integer' && !Number.isInteger(value)) {
        return `${where} must be a whole number`;
      }
      if (param.min !== undefined && value < param.min) {
        return `${where} must be at least ${param.min}`;
      }
      if (param.max !== undefined && value > param.max) {
        return `${where} must be at most ${param.max}`;
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
