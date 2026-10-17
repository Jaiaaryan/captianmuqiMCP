/**
 * Processor chains — editing a tool's response before the model sees it.
 *
 * Where this sits: an upstream system answers, the chain runs, then the tool's
 * response mapping (`responseMapping.transform`) shapes what is left, and only
 * that reaches the MCP client. A chain therefore *edits* the response (convert
 * a currency, add VAT, clean a description, translate a status code) where the
 * mapping only *selects* from it.
 *
 * What a chain is: an ordered list of steps. Each step names a processor from
 * the registry (`number_scale@1`), the collection it runs over (`each`), the
 * field it reads, the field it writes, and how it is allowed to write
 * (`add` / `replace` / `upsert`). Nothing else. There is no expression
 * language and no code execution here: the step is data, the processor is a
 * pure function, and everything a step may do is in the processor's declared
 * contract.
 *
 * Design constraints, in priority order:
 *   1. A tool without a chain behaves exactly as before, same object and same
 *      reference. The no-op path is one property check.
 *   2. A chain fails loudly. A half-converted response is worse than none: if
 *      any step refuses a value, the call fails with an error that names the
 *      step and the JSON path of the value, and nothing partially edited is
 *      ever returned. An operator who wants the old "never break a working
 *      tool" behaviour sets `onError: "passthrough"` and gets the untouched
 *      response plus a warning in the log.
 *   3. Validation before activation. A chain is checked against the registry
 *      when it is saved, so a wrong parameter or an unknown processor is a 400
 *      and not a surprise on the next call.
 *   4. Bounded work. Caps on steps, on the elements one step may touch, and on
 *      path length, so neither a pathological response nor a careless chain can
 *      pin a worker.
 *   5. Every step observable. `runProcessorChain(..., { trace: true })` reports
 *      what each step touched and what the document weighed after it, which is
 *      what the dashboard's step-by-step view and the preview endpoint render.
 */
import {
  ProcessorValueError,
  findProcessor,
  resolveProcessorParams,
  type ProcessorDefinition,
} from './processor-registry';

/* ------------------------------------------------------------------ */
/*  Public contract                                                    */
/* ------------------------------------------------------------------ */

/** How a step may write its result. */
export type ProcessorWriteMode = 'add' | 'replace' | 'upsert';

export interface ProcessorStep {
  /** Stable, human-chosen name. It appears in every error and in the trace. */
  id: string;
  /** A registry entry: `number_scale` (newest) or `number_scale@1` (pinned). */
  processor: string;
  /**
   * The collection the step runs over, as a path into the response
   * (`$.items[*]`). Every element gets the step. Omit it to run the step on the
   * response itself — on each of its elements when the response is a top-level
   * array, which is what a bare-array response means.
   */
  each?: string;
  /** Field the processor reads, relative to the element. One value, so no wildcards. */
  reads: string;
  /** Field the result is written to, relative to the element. */
  writes: string;
  /** Default `upsert`. */
  mode?: ProcessorWriteMode;
  /** The processor's parameters, checked against its contract. */
  params?: Record<string, unknown>;
  /** What to do when `reads` is not there: fail the call (default) or leave the element alone. */
  onMissing?: 'fail' | 'skip';
}

export interface ProcessorChain {
  /** Config format version. Only 1 exists. */
  version?: number;
  /** `false` keeps the chain on the tool without running it. Default true. */
  enabled?: boolean;
  /**
   * `fail` (default): a refused value fails the tool call.
   * `passthrough`: return the untouched response and log a warning.
   */
  onError?: 'fail' | 'passthrough';
  steps: ProcessorStep[];
}

/** What one step did, for the step-by-step view. */
export interface ProcessorStepTrace {
  id: string;
  processor: string;
  mode: ProcessorWriteMode;
  /** Elements the step ran over. */
  targets: number;
  /** Elements it wrote to. */
  written: number;
  /** Elements skipped because `reads` was missing and `onMissing` is `skip`. */
  skipped: number;
  /** Serialized size of the whole response after this step (trace only). */
  bytesAfter?: number;
  /** The first element after the step, as a sample (trace only). */
  sample?: unknown;
}

export type ProcessorChainResult =
  | { ok: true; value: unknown; applied: boolean; steps: ProcessorStepTrace[] }
  | {
      ok: false;
      /** The response as it arrived: never a half-edited document. */
      value: unknown;
      applied: false;
      steps: ProcessorStepTrace[];
      /** `step convert_to_eur: $.items[0].price_usd is not a number` */
      error: string;
      /** The step that refused. */
      failedStep: string;
      /** The JSON path of the value it refused. */
      failedPath: string;
    };

/* ------------------------------------------------------------------ */
/*  Limits                                                             */
/* ------------------------------------------------------------------ */

export const PROCESSOR_CHAIN_LIMITS = {
  maxSteps: 20,
  /** Elements one step may run over. */
  maxTargets: 100_000,
  maxPathLength: 200,
  maxPathSegments: 16,
  maxStepIdLength: 64,
} as const;

const STEP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;
const WRITE_MODES: ProcessorWriteMode[] = ['add', 'replace', 'upsert'];

// Upstream keys and operator-written paths both end up as object keys, so
// neither may reach Object.prototype. Same guard as the response transform.
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

class ChainConfigError extends Error {}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/* ------------------------------------------------------------------ */
/*  Paths                                                             */
/* ------------------------------------------------------------------ */

type Segment = { kind: 'key'; name: string } | { kind: 'index'; index: number } | { kind: 'wildcard' };

/**
 * Parse `$.items[*].price`, `items[0].a`, `a['odd.key']`.
 *
 * Hand-written scanner rather than a regex: the inputs are operator-written and
 * there is nothing here that can backtrack.
 */
export function parseFieldPath(raw: string, field: string): Segment[] {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ChainConfigError(`"${field}" must be a non-empty path`);
  }
  if (raw.length > PROCESSOR_CHAIN_LIMITS.maxPathLength) {
    throw new ChainConfigError(
      `"${field}" is too long (max ${PROCESSOR_CHAIN_LIMITS.maxPathLength} characters)`,
    );
  }

  const s = raw.trim();
  const segments: Segment[] = [];
  let i = 0;
  if (s.startsWith('$')) {
    i = 1;
    if (s[i] === '.') i++;
  }

  let buffer = '';
  const flush = () => {
    if (buffer.length === 0) return;
    if (DANGEROUS_KEYS.has(buffer)) {
      throw new ChainConfigError(`"${field}" may not use the segment "${buffer}"`);
    }
    segments.push({ kind: 'key', name: buffer });
    buffer = '';
  };

  while (i < s.length) {
    const c = s[i];
    if (c === '.') {
      flush();
      i++;
    } else if (c === '[') {
      flush();
      const close = s.indexOf(']', i);
      if (close === -1) throw new ChainConfigError(`"${field}" has an unclosed "[" (${raw})`);
      const inner = s.slice(i + 1, close).trim();
      if (inner === '*') {
        segments.push({ kind: 'wildcard' });
      } else if (
        (inner.startsWith("'") && inner.endsWith("'") && inner.length >= 2) ||
        (inner.startsWith('"') && inner.endsWith('"') && inner.length >= 2)
      ) {
        const name = inner.slice(1, -1);
        if (DANGEROUS_KEYS.has(name)) {
          throw new ChainConfigError(`"${field}" may not use the segment "${name}"`);
        }
        segments.push({ kind: 'key', name });
      } else {
        const n = Number(inner);
        if (!Number.isInteger(n) || n < 0) {
          throw new ChainConfigError(`"${field}" has an invalid array index "${inner}" (${raw})`);
        }
        segments.push({ kind: 'index', index: n });
      }
      i = close + 1;
    } else {
      buffer += c;
      i++;
    }
    if (segments.length > PROCESSOR_CHAIN_LIMITS.maxPathSegments) {
      throw new ChainConfigError(
        `"${field}" is too deep (max ${PROCESSOR_CHAIN_LIMITS.maxPathSegments} segments)`,
      );
    }
  }
  flush();

  // Re-checked after the final flush: the scanner's own check runs inside the
  // loop, so a path ending in a dotted key used to slip one segment past the
  // cap while the bracket spelling of the same depth was refused.
  if (segments.length > PROCESSOR_CHAIN_LIMITS.maxPathSegments) {
    throw new ChainConfigError(
      `"${field}" is too deep (max ${PROCESSOR_CHAIN_LIMITS.maxPathSegments} segments)`,
    );
  }
  if (segments.length === 0) {
    throw new ChainConfigError(`"${field}" must be a non-empty path`);
  }
  return segments;
}

/**
 * `reads` must resolve to ONE value, because that is what a processor's
 * contract takes. A wildcard would give it many, so it is refused here rather
 * than at call time, where it could only look like a missing field.
 */
function parseReadPath(raw: string): Segment[] {
  const segments = parseFieldPath(raw, 'reads');
  if (segments.some((seg) => seg.kind === 'wildcard')) {
    throw new ChainConfigError(
      '"reads" must name one value of the element (no wildcards) — point "each" at the collection instead',
    );
  }
  return segments;
}

/** A write target is addressed by object keys only: no wildcards, no indices. */
function parseWritePath(raw: string): string[] {
  const segments = parseFieldPath(raw, 'writes');
  return segments.map((seg) => {
    if (seg.kind !== 'key') {
      throw new ChainConfigError(
        '"writes" must name fields of the element (no wildcards or array indices)',
      );
    }
    return seg.name;
  });
}

/** Render a JSON path the way the error messages and the trace quote it. */
function renderPath(base: string, segments: Array<string | number>): string {
  let out = base;
  for (const seg of segments) {
    out += typeof seg === 'number' ? `[${seg}]` : `.${seg}`;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Reading and writing an element                                     */
/* ------------------------------------------------------------------ */

/** Everything `each` resolves to, with the JSON path of each element. */
function collectTargets(
  root: unknown,
  segments: Segment[],
  expandTrailingArray: boolean,
): Array<{ value: unknown; path: string }> {
  let current: Array<{ value: unknown; path: string }> = [{ value: root, path: '$' }];

  for (const segment of segments) {
    const next: Array<{ value: unknown; path: string }> = [];
    for (const { value, path } of current) {
      if (segment.kind === 'wildcard') {
        if (Array.isArray(value)) {
          value.forEach((el, i) => next.push({ value: el, path: `${path}[${i}]` }));
        } else if (isPlainObject(value)) {
          for (const [k, v] of Object.entries(value)) next.push({ value: v, path: `${path}.${k}` });
        }
      } else if (segment.kind === 'index') {
        if (Array.isArray(value) && segment.index < value.length) {
          next.push({ value: value[segment.index], path: `${path}[${segment.index}]` });
        }
      } else if (isPlainObject(value) && hasOwn(value, segment.name)) {
        next.push({ value: value[segment.name], path: `${path}.${segment.name}` });
      }
    }
    current = next;
    if (current.length > PROCESSOR_CHAIN_LIMITS.maxTargets) break;
  }

  // `each: "$.items"` is read as "every item of items", the same as
  // `$.items[*]`: an operator who points a step at a collection means the
  // elements. A path that already ended in `[*]` or `[0]` picked its elements
  // itself and is left alone.
  if (expandTrailingArray) {
    const expanded: Array<{ value: unknown; path: string }> = [];
    for (const target of current) {
      if (Array.isArray(target.value)) {
        target.value.forEach((el, i) => expanded.push({ value: el, path: `${target.path}[${i}]` }));
      } else {
        expanded.push(target);
      }
    }
    return expanded;
  }
  return current;
}

/** Resolve `reads` against one element. */
function readField(
  element: unknown,
  segments: Segment[],
): { found: true; value: unknown } | { found: false } {
  let current: unknown = element;
  for (const segment of segments) {
    if (segment.kind === 'index') {
      if (!Array.isArray(current) || segment.index >= current.length) return { found: false };
      current = current[segment.index];
    } else if (segment.kind === 'key') {
      if (!isPlainObject(current) || !hasOwn(current, segment.name)) return { found: false };
      current = current[segment.name];
    } else {
      // A wildcard would give a step many values where its contract takes one.
      return { found: false };
    }
  }
  return { found: true, value: current };
}

/**
 * Write `value` into `element` at `keys`, honouring the write mode.
 *
 * Returns the problem as a message completing "<path> …", so the caller can
 * build the same "step <id>: <path> <message>" sentence a refused value gets.
 */
function writeField(
  element: unknown,
  keys: string[],
  mode: ProcessorWriteMode,
  value: unknown,
): { ok: true } | { ok: false; message: string; depth: number } {
  if (!isPlainObject(element)) {
    return { ok: false, message: 'is not an object, so there is nothing to write to', depth: 0 };
  }

  let container: Record<string, unknown> = element;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!hasOwn(container, key) || !isPlainObject(container[key])) {
      if (mode === 'replace') {
        return { ok: false, message: 'does not exist, and the mode is "replace"', depth: i + 1 };
      }
      if (hasOwn(container, key) && container[key] !== undefined && container[key] !== null) {
        return {
          ok: false,
          message: 'is not an object, so the step cannot write inside it',
          depth: i + 1,
        };
      }
      container[key] = {};
    }
    container = container[key] as Record<string, unknown>;
  }

  const last = keys[keys.length - 1];
  const exists = hasOwn(container, last);
  if (mode === 'add' && exists) {
    return {
      ok: false,
      message: 'already exists, and the mode is "add" — use "replace" or "upsert"',
      depth: keys.length,
    };
  }
  if (mode === 'replace' && !exists) {
    return {
      ok: false,
      message: 'does not exist, and the mode is "replace" — use "add" or "upsert"',
      depth: keys.length,
    };
  }
  container[last] = value;
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/*  Reading the config off a tool                                      */
/* ------------------------------------------------------------------ */

/**
 * The chain stored on a tool, or null when there is nothing to run — no
 * `processors` key, `enabled: false`, or no steps. Shape problems are left to
 * `validateProcessorChain` (save time) and to the runner (call time), which
 * reports them as a failure instead of quietly doing nothing.
 */
export function readProcessorChain(
  responseMapping: Record<string, unknown> | null | undefined,
): ProcessorChain | null {
  if (!isPlainObject(responseMapping)) return null;
  const raw = responseMapping.processors;
  if (!isPlainObject(raw)) return null;
  if (raw.enabled === false) return null;
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) return null;
  return raw as unknown as ProcessorChain;
}

/** True when this tool would run a chain on its next call. */
export function hasProcessorChain(
  responseMapping: Record<string, unknown> | null | undefined,
): boolean {
  return readProcessorChain(responseMapping) !== null;
}

/* ------------------------------------------------------------------ */
/*  Validation                                                         */
/* ------------------------------------------------------------------ */

/**
 * Check a chain against the registry without running it: the first problem as a
 * message, or null when the chain is usable. A chain is validated before it can
 * be activated, from the REST endpoint, the MCP tool and the dashboard alike.
 */
export function validateProcessorChain(chain: unknown): string | null {
  if (chain === null || chain === undefined) return null;
  if (!isPlainObject(chain)) return 'processors must be an object';

  const c = chain as Partial<ProcessorChain> & Record<string, unknown>;
  if (c.version !== undefined && c.version !== 1) {
    return `Unknown processors version ${JSON.stringify(c.version)} — expected 1`;
  }
  if (c.enabled !== undefined && typeof c.enabled !== 'boolean') {
    return 'processors.enabled must be true or false';
  }
  if (c.onError !== undefined && c.onError !== 'fail' && c.onError !== 'passthrough') {
    return `Unknown processors.onError ${JSON.stringify(c.onError)} — expected "fail" or "passthrough"`;
  }
  if (!Array.isArray(c.steps)) return 'processors.steps must be an array';
  if (c.steps.length === 0) return null;
  if (c.steps.length > PROCESSOR_CHAIN_LIMITS.maxSteps) {
    return `processors.steps has too many entries (max ${PROCESSOR_CHAIN_LIMITS.maxSteps})`;
  }

  const seen = new Set<string>();
  for (const [index, raw] of c.steps.entries()) {
    const error = validateStep(raw, index, seen);
    if (error) return error;
  }
  return null;
}

function validateStep(raw: unknown, index: number, seen: Set<string>): string | null {
  const where = `processors.steps[${index}]`;
  if (!isPlainObject(raw)) return `${where} must be an object`;
  const step = raw as Partial<ProcessorStep> & Record<string, unknown>;

  if (typeof step.id !== 'string' || !STEP_ID_PATTERN.test(step.id)) {
    return `${where}.id must be a name of letters, digits, "-" and "_" (e.g. "convert_to_eur")`;
  }
  if (step.id.length > PROCESSOR_CHAIN_LIMITS.maxStepIdLength) {
    return `${where}.id is too long (max ${PROCESSOR_CHAIN_LIMITS.maxStepIdLength} characters)`;
  }
  if (seen.has(step.id)) return `${where}.id "${step.id}" is used twice`;
  seen.add(step.id);

  const def = typeof step.processor === 'string' ? findProcessor(step.processor) : null;
  if (!def) {
    return `${where}.processor ${JSON.stringify(step.processor ?? null)} is not a known processor`;
  }
  if (step.mode !== undefined && !WRITE_MODES.includes(step.mode as ProcessorWriteMode)) {
    return `${where}.mode ${JSON.stringify(step.mode)} must be one of ${WRITE_MODES.join(', ')}`;
  }
  if (step.onMissing !== undefined && step.onMissing !== 'fail' && step.onMissing !== 'skip') {
    return `${where}.onMissing ${JSON.stringify(step.onMissing)} must be "fail" or "skip"`;
  }

  try {
    if (step.each !== undefined) parseFieldPath(step.each as string, 'each');
    parseReadPath(step.reads as string);
    parseWritePath(step.writes as string);
  } catch (err) {
    return `${where}: ${(err as Error).message}`;
  }

  const params = resolveProcessorParams(def, step.params);
  if (!params.ok) return `${where}: ${params.error}`;
  return null;
}

/* ------------------------------------------------------------------ */
/*  Running                                                           */
/* ------------------------------------------------------------------ */

/** A step with its config already resolved against the registry. */
interface PreparedStep {
  step: ProcessorStep;
  def: ProcessorDefinition;
  params: Record<string, unknown>;
  each: Segment[] | null;
  expandTrailingArray: boolean;
  reads: Segment[];
  writes: string[];
  mode: ProcessorWriteMode;
  onMissing: 'fail' | 'skip';
}

function prepare(chain: ProcessorChain): PreparedStep[] {
  return chain.steps.map((step, index) => {
    const def = findProcessor(step.processor);
    if (!def) {
      throw new ChainConfigError(
        `step ${step.id ?? index}: ${JSON.stringify(step.processor ?? null)} is not a known processor`,
      );
    }
    const params = resolveProcessorParams(def, step.params);
    if (!params.ok) throw new ChainConfigError(`step ${step.id ?? index}: ${params.error}`);

    const eachSegments = step.each === undefined ? null : parseFieldPath(step.each, 'each');
    const lastSegment = eachSegments?.[eachSegments.length - 1];
    return {
      step,
      def,
      params: params.params,
      each: eachSegments,
      // A path that selected its own elements (`[*]`, `[3]`) is final; one that
      // names a collection (`$.items`, or no path at all) means its elements.
      expandTrailingArray: !lastSegment || lastSegment.kind === 'key',
      reads: parseReadPath(step.reads),
      writes: parseWritePath(step.writes),
      mode: (step.mode ?? 'upsert') as ProcessorWriteMode,
      onMissing: step.onMissing ?? 'fail',
    };
  });
}

/** A private copy to edit, so the caller's response is never mutated. */
function cloneResponse(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    // A response carrying something structuredClone refuses (a function on a
    // prototype, a stream) still round-trips through JSON, which is the shape
    // the chain works on anyway.
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      throw new ChainConfigError('the response could not be copied for editing');
    }
  }
}

/** A detached copy of one element, for the step-by-step view. */
function snapshot(value: unknown): unknown {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return undefined;
    }
  }
}

function byteLength(value: unknown): number | undefined {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : Buffer.byteLength(json, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Run a chain over a response.
 *
 * On success the edited copy comes back. On failure the response as it arrived
 * comes back, untouched, with the error that names the step and the path: a
 * half-converted document is never returned, whatever `onError` says. The
 * caller decides from `onError` whether that failure fails the tool call (the
 * default) or is only logged.
 */
export function runProcessorChain(
  raw: unknown,
  chain: ProcessorChain,
  opts: { trace?: boolean } = {},
): ProcessorChainResult {
  const steps: ProcessorStepTrace[] = [];

  let prepared: PreparedStep[];
  let document: unknown;
  try {
    prepared = prepare(chain);
    document = cloneResponse(raw);
  } catch (err) {
    return {
      ok: false,
      value: raw,
      applied: false,
      steps,
      error: (err as Error).message,
      failedStep: '',
      failedPath: '$',
    };
  }

  for (const item of prepared) {
    const { step, def, params, mode } = item;
    const targets = item.each
      ? collectTargets(document, item.each, item.expandTrailingArray)
      : collectTargets(document, [], true);

    if (targets.length > PROCESSOR_CHAIN_LIMITS.maxTargets) {
      return fail(
        steps,
        raw,
        step.id,
        '$',
        `step ${step.id}: the response has more than ${PROCESSOR_CHAIN_LIMITS.maxTargets} elements to process`,
      );
    }

    let written = 0;
    let skipped = 0;
    for (const target of targets) {
      const read = readField(target.value, item.reads);
      if (!read.found) {
        if (item.onMissing === 'skip') {
          skipped++;
          continue;
        }
        return fail(
          steps,
          raw,
          step.id,
          renderPath(target.path, [step.reads]),
          `step ${step.id}: ${renderPath(target.path, [step.reads])} is missing`,
        );
      }

      let produced: unknown;
      try {
        produced = def.apply(read.value, params);
      } catch (err) {
        const path = renderPath(target.path, [step.reads]);
        const message =
          err instanceof ProcessorValueError
            ? (err as Error).message
            : `could not be processed by ${step.processor}`;
        return fail(steps, raw, step.id, path, `step ${step.id}: ${path} ${message}`);
      }

      const write = writeField(target.value, item.writes, mode, produced);
      if (!write.ok) {
        const path = renderPath(target.path, item.writes.slice(0, write.depth));
        return fail(steps, raw, step.id, path, `step ${step.id}: ${path} ${write.message}`);
      }
      written++;
    }

    steps.push({
      id: step.id,
      processor: `${def.name}@${def.version}`,
      mode,
      targets: targets.length,
      written,
      skipped,
      ...(opts.trace
        ? {
            bytesAfter: byteLength(document),
            // A snapshot, not the element itself: the element stays in the
            // document and the later steps edit it, which would make every
            // step's sample show the finished element instead of its own.
            sample: snapshot(targets[0]?.value),
          }
        : {}),
    });
  }

  return { ok: true, value: document, applied: steps.some((s) => s.written > 0), steps };
}

function fail(
  steps: ProcessorStepTrace[],
  raw: unknown,
  failedStep: string,
  failedPath: string,
  error: string,
): ProcessorChainResult {
  return { ok: false, value: raw, applied: false, steps, error, failedStep, failedPath };
}

/** The chain's error policy: `fail` unless the operator asked otherwise. */
export function chainFailsTheCall(chain: ProcessorChain): boolean {
  return chain.onError !== 'passthrough';
}
