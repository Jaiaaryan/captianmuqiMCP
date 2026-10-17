/**
 * Response processing: an ordered chain of steps that edits a tool's response
 * BEFORE the response mapping (`transform`) selects from it. Stored at
 * `McpTool.responseMapping.responseProcessing`.
 *
 * A step reads one value from each element of a collection, runs a built-in
 * processor or a `script@1` function on it, and writes the result to another
 * field of the same element:
 *
 *   { id: 'convert_to_eur', use: 'scale@1', each: '$.items[*]',
 *     reads: 'price_usd', writes: 'price_eur', mode: 'add',
 *     params: { factor: 0.92, round: 2 } }
 *
 * Design constraints:
 *   1. All or nothing. The chain works on a deep copy; a failing step returns
 *      an error and no value, never a half-edited response.
 *   2. Refuse, don't guess. A wrong type, a missing field, an existing target
 *      in `add` mode: each fails with a sentence naming the step and the path.
 *   3. No hidden code paths. Paths go through the same parser as the response
 *      mapping (prototype-pollution keys refused); scripts run in an isolate
 *      with no capabilities (script-runner.ts).
 */
import { Logger } from '@nestjs/common';
import { parsePath } from '../connectors/response-transform.util';
import {
  BuiltinError,
  isBuiltin,
  runBuiltin,
  validateBuiltinParams,
} from './builtins';
import {
  SCRIPT_LIMITS,
  ScriptSession,
  checkScriptSyntax,
} from './script-runner';

const logger = new Logger('ResponseProcessing');

/* ------------------------------------------------------------------ */
/*  Public contract                                                    */
/* ------------------------------------------------------------------ */

export type StepUse =
  | 'scale@1'
  | 'offset@1'
  | 'vat@1'
  | 'round@1'
  | 'clean_text@1'
  | 'truncate@1'
  | 'map@1'
  | 'script@1';

export type StepMode = 'add' | 'replace' | 'upsert';

export interface Step {
  id: string;
  use: StepUse;
  each?: string;
  reads: string;
  writes: string;
  mode: StepMode;
  onMissing?: 'fail' | 'skip';
  params?: Record<string, unknown>;
  code?: string;
}

export interface ResponseProcessingChain {
  version: 1;
  enabled: boolean;
  onError: 'fail' | 'passthrough';
  steps: Step[];
}

export interface StepTrace {
  id: string;
  /** Elements this step wrote. */
  wrote: number;
  /** Elements skipped because `reads` was absent (onMissing: skip). */
  skipped: number;
  /** JSON size of the whole response after this step. */
  bytes: number;
  /** The first element of the step's collection after the step. */
  sample?: unknown;
}

export type ChainResult =
  | { ok: true; value: unknown; steps: StepTrace[] }
  | {
      ok: false;
      error: string;
      failedStep: string;
      failedPath: string;
      steps: StepTrace[];
    };

export const CHAIN_LIMITS = {
  maxSteps: 20,
  /** Wall-clock cap on all script runs of one response. */
  scriptBudgetMs: 2000,
} as const;

const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MODES = ['add', 'replace', 'upsert'];
const CHAIN_KEYS = new Set(['version', 'enabled', 'onError', 'steps']);
const STEP_KEYS = new Set([
  'id',
  'use',
  'each',
  'reads',
  'writes',
  'mode',
  'onMissing',
  'params',
  'code',
]);
const SCRIPT_USE = 'script@1';

/* ------------------------------------------------------------------ */
/*  Small helpers                                                      */
/* ------------------------------------------------------------------ */

type Token = ReturnType<typeof parsePath>[number];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** `.name`, or `['weird key']` when the name is not a plain identifier. */
function keySegment(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? `.${name}` : `['${name}']`;
}

function formatTokens(tokens: Token[]): string {
  let out = '';
  for (const t of tokens) {
    if (t.kind === 'key') out += keySegment(t.name);
    else if (t.kind === 'index') out += `[${t.index}]`;
    else out += '[*]';
  }
  return out;
}

function jsonBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : Buffer.byteLength(json, 'utf8');
  } catch {
    return 0;
  }
}

function safeParse(path: string): { tokens?: Token[]; problem?: string } {
  try {
    return { tokens: parsePath(path) };
  } catch (err) {
    return { problem: err instanceof Error ? err.message : 'invalid path' };
  }
}

/* ------------------------------------------------------------------ */
/*  Reading and validating                                             */
/* ------------------------------------------------------------------ */

/**
 * The chain stored in a responseMapping, or null when the tool has none.
 * Returned as stored: a malformed one is a validation error at save time, and
 * a chain failure (not a crash) when it is run anyway.
 */
export function readChain(
  responseMapping: unknown,
): ResponseProcessingChain | null {
  if (!isPlainObject(responseMapping)) return null;
  const raw = responseMapping.responseProcessing;
  if (raw === undefined || raw === null) return null;
  return raw as ResponseProcessingChain;
}

function validateStep(step: unknown, index: number, checkSyntax: boolean): string | null {
  if (!isPlainObject(step)) return `steps[${index}]: must be an object`;
  const id = step.id;
  if (typeof id !== 'string' || !STEP_ID.test(id)) {
    return `steps[${index}]: id must match ${STEP_ID.source}`;
  }
  const at = `step ${id}`;

  for (const key of Object.keys(step)) {
    if (!STEP_KEYS.has(key)) return `${at}: unknown field "${key}"`;
  }

  const use = step.use;
  if (typeof use !== 'string' || (use !== SCRIPT_USE && !isBuiltin(use))) {
    return `${at}: unknown processor ${JSON.stringify(use)}`;
  }
  const isScript = use === SCRIPT_USE;

  if (step.each !== undefined) {
    if (typeof step.each !== 'string' || !step.each.trim()) {
      return `${at}: each must be a path string`;
    }
    if (step.each.trim() !== '$') {
      const parsed = safeParse(step.each);
      if (parsed.problem) return `${at}: each: ${parsed.problem}`;
    }
  }

  for (const field of ['reads', 'writes'] as const) {
    const value = step[field];
    if (typeof value !== 'string' || !value.trim()) {
      return `${at}: ${field} is required`;
    }
    if (value.trim() === '$') {
      if (!isScript) return `${at}: ${field} "$" is only allowed for ${SCRIPT_USE}`;
      continue;
    }
    const parsed = safeParse(value);
    if (parsed.problem) return `${at}: ${field}: ${parsed.problem}`;
    for (const t of parsed.tokens!) {
      if (t.kind === 'wildcard') {
        return `${at}: ${field} must address exactly one value (no [*])`;
      }
      if (field === 'writes' && t.kind === 'index') {
        return `${at}: writes must be an object-key path (no [n])`;
      }
    }
  }

  if (typeof step.mode !== 'string' || !MODES.includes(step.mode)) {
    return `${at}: mode must be one of ${MODES.join(', ')}`;
  }
  if (
    step.onMissing !== undefined &&
    step.onMissing !== 'fail' &&
    step.onMissing !== 'skip'
  ) {
    return `${at}: onMissing must be "fail" or "skip"`;
  }

  if (isScript) {
    if (typeof step.code !== 'string' || !step.code.trim()) {
      return `${at}: code is required for ${SCRIPT_USE}`;
    }
    if (Buffer.byteLength(step.code, 'utf8') > SCRIPT_LIMITS.maxCodeBytes) {
      return `${at}: code too large (limit ${SCRIPT_LIMITS.maxCodeBytes} bytes)`;
    }
    if (step.params !== undefined) {
      try {
        if (JSON.stringify(step.params) === undefined) throw new Error();
      } catch {
        return `${at}: params must be JSON`;
      }
    }
    if (checkSyntax) {
      const syntax = checkScriptSyntax(step.code);
      if (syntax) return `${at}: ${syntax}`;
    }
  } else {
    if (step.code !== undefined) return `${at}: code is only for ${SCRIPT_USE}`;
    const problem = validateBuiltinParams(use, step.params);
    if (problem) return `${at}: ${problem}`;
  }
  return null;
}

function validate(chain: unknown, checkSyntax: boolean): string | null {
  if (!isPlainObject(chain)) return 'chain must be an object';
  for (const key of Object.keys(chain)) {
    if (!CHAIN_KEYS.has(key)) return `unknown field "${key}"`;
  }
  if (chain.version !== 1) return 'version must be 1';
  if (typeof chain.enabled !== 'boolean') return 'enabled must be true or false';
  if (chain.onError !== 'fail' && chain.onError !== 'passthrough') {
    return 'onError must be "fail" or "passthrough"';
  }
  if (!Array.isArray(chain.steps)) return 'steps must be an array';
  if (chain.steps.length > CHAIN_LIMITS.maxSteps) {
    return `steps: at most ${CHAIN_LIMITS.maxSteps}`;
  }
  const seen = new Set<string>();
  for (let i = 0; i < chain.steps.length; i++) {
    const problem = validateStep(chain.steps[i], i, checkSyntax);
    if (problem) return problem;
    const id = (chain.steps[i] as Step).id;
    if (seen.has(id)) return `step ${id}: id is used twice`;
    seen.add(id);
  }
  return null;
}

/**
 * Check a chain without running it: structure, processor names, params against
 * each contract, `$` only for script@1, script syntax. Returns the first
 * problem as `step <id>: <what>` (or a chain-level sentence), null when valid.
 * Used at save time and by the REST validate/dry-run routes.
 */
export function validateChain(chain: unknown): string | null {
  return validate(chain, true);
}

/**
 * Validation at run time skips the script syntax check (compiling happens when
 * the script runs anyway) and is remembered per chain object: the registry
 * hands the same object to every call, so the hot path pays for it once.
 */
const structureCache = new WeakMap<object, string | null>();

function structureProblem(chain: unknown): string | null {
  if (typeof chain !== 'object' || chain === null) return validate(chain, false);
  if (structureCache.has(chain)) return structureCache.get(chain)!;
  const problem = validate(chain, false);
  structureCache.set(chain, problem);
  return problem;
}

/* ------------------------------------------------------------------ */
/*  Running                                                            */
/* ------------------------------------------------------------------ */

/** A place in the document: `parent[key]` is the element. */
interface Slot {
  parent: any;
  key: string | number;
  path: string;
}

/** Thrown inside the run, turned into a ChainResult at the edge. */
class StepFailure extends Error {
  constructor(
    message: string,
    readonly failedPath: string,
  ) {
    super(message);
  }
}

/**
 * The elements a step works on. `each` omitted: the response itself, or each
 * element when the root is an array. `$.items[*]`: the elements. `$.items`: an
 * array there means its elements too. Returns null when the collection path
 * does not exist at all.
 */
function collectSlots(holder: { v: unknown }, each: string | undefined): Slot[] | null {
  const tokens: Token[] =
    each === undefined || each.trim() === '$' ? [] : parsePath(each);
  let slots: Slot[] = [{ parent: holder, key: 'v', path: '$' }];
  let missing = false;

  for (const token of tokens) {
    const next: Slot[] = [];
    for (const slot of slots) {
      const value = slot.parent[slot.key];
      if (token.kind === 'key') {
        if (isPlainObject(value) && hasOwn(value, token.name)) {
          next.push({ parent: value, key: token.name, path: slot.path + keySegment(token.name) });
        } else {
          missing = true;
        }
      } else if (token.kind === 'index') {
        if (Array.isArray(value)) {
          const idx = token.index < 0 ? value.length + token.index : token.index;
          if (idx >= 0 && idx < value.length) {
            next.push({ parent: value, key: idx, path: `${slot.path}[${idx}]` });
            continue;
          }
        }
        missing = true;
      } else if (Array.isArray(value)) {
        value.forEach((_, i) =>
          next.push({ parent: value, key: i, path: `${slot.path}[${i}]` }),
        );
      } else if (isPlainObject(value)) {
        for (const k of Object.keys(value)) {
          next.push({ parent: value, key: k, path: slot.path + keySegment(k) });
        }
      } else {
        missing = true;
      }
    }
    slots = next;
  }

  if (slots.length === 0 && missing) return null;

  // `$.items` (no trailing wildcard) pointing at an array means its elements.
  const last = tokens[tokens.length - 1];
  if (!last || last.kind !== 'wildcard') {
    const expanded: Slot[] = [];
    for (const slot of slots) {
      const value = slot.parent[slot.key];
      if (Array.isArray(value)) {
        value.forEach((_, i) =>
          expanded.push({ parent: value, key: i, path: `${slot.path}[${i}]` }),
        );
      } else {
        expanded.push(slot);
      }
    }
    slots = expanded;
  }
  return slots;
}

function readAt(
  element: unknown,
  tokens: Token[],
): { found: boolean; value?: unknown } {
  let cur: unknown = element;
  for (const t of tokens) {
    if (t.kind === 'key') {
      if (!isPlainObject(cur) || !hasOwn(cur, t.name)) return { found: false };
      cur = cur[t.name];
    } else if (t.kind === 'index') {
      if (!Array.isArray(cur)) return { found: false };
      const idx = t.index < 0 ? cur.length + t.index : t.index;
      if (idx < 0 || idx >= cur.length) return { found: false };
      cur = cur[idx];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: cur };
}

/**
 * Does the write target already exist inside `element`? Intermediate objects
 * that do not exist yet are created at write time, not here. A path that runs
 * into a value that is not an object cannot be written at all.
 */
function targetExists(
  stepId: string,
  element: unknown,
  tokens: Token[],
  elementPath: string,
): boolean {
  let cur: unknown = element;
  for (let i = 0; i < tokens.length; i++) {
    const name = (tokens[i] as { name: string }).name;
    if (!isPlainObject(cur)) {
      const where = elementPath + formatTokens(tokens.slice(0, i));
      throw new StepFailure(
        `step ${stepId}: ${where} is not an object, so nothing can be written under it`,
        where,
      );
    }
    if (!hasOwn(cur, name)) return false;
    cur = cur[name];
  }
  return true;
}

function writeAt(element: Record<string, unknown>, tokens: Token[], value: unknown): void {
  let cur = element;
  for (let i = 0; i < tokens.length - 1; i++) {
    const name = (tokens[i] as { name: string }).name;
    if (!hasOwn(cur, name)) cur[name] = {};
    cur = cur[name] as Record<string, unknown>;
  }
  cur[(tokens[tokens.length - 1] as { name: string }).name] = value;
}

/**
 * Run a chain over a response. Never mutates `raw`. With `trace`, `steps`
 * reports per step how many elements were written/skipped, the response size
 * after it and the first element after it; without, `steps` is empty.
 */
export function runChain(
  raw: unknown,
  chain: ResponseProcessingChain,
  options: { trace?: boolean } = {},
): ChainResult {
  const trace = options.trace === true;
  const traces: StepTrace[] = [];

  const problem = structureProblem(chain);
  if (problem) {
    const m = /^step ([A-Za-z0-9_-]+):/.exec(problem);
    return {
      ok: false,
      error: problem,
      failedStep: m ? m[1] : '',
      failedPath: '',
      steps: traces,
    };
  }
  if (chain.enabled === false) return { ok: true, value: raw, steps: traces };

  let holder: { v: unknown };
  try {
    holder = { v: structuredClone(raw) };
  } catch {
    return {
      ok: false,
      error: 'the response cannot be copied for processing',
      failedStep: '',
      failedPath: '$',
      steps: traces,
    };
  }

  let scriptMs = 0;

  for (const step of chain.steps) {
    let session: ScriptSession | null = null;
    try {
      const slots = collectSlots(holder, step.each);
      const eachPath = step.each?.trim() || '$';
      const onMissing = step.onMissing ?? 'fail';
      let wrote = 0;
      let skipped = 0;

      if (slots === null) {
        if (onMissing !== 'skip') {
          throw new StepFailure(`step ${step.id}: ${eachPath} is missing`, eachPath);
        }
      }

      const readTokens = step.reads.trim() === '$' ? null : parsePath(step.reads);
      const writeTokens = step.writes.trim() === '$' ? null : parsePath(step.writes);

      for (const slot of slots ?? []) {
        const element = slot.parent[slot.key];
        const readPath = slot.path + (readTokens ? formatTokens(readTokens) : '');
        const writePath = slot.path + (writeTokens ? formatTokens(writeTokens) : '');
        const fail = (what: string, path: string) =>
          new StepFailure(`step ${step.id}: ${path} ${what}`, path);

        let input: unknown = element;
        if (readTokens) {
          const read = readAt(element, readTokens);
          if (!read.found) {
            if (onMissing === 'skip') {
              skipped++;
              continue;
            }
            throw fail('is missing', readPath);
          }
          input = read.value;
        }

        // Mode is checked before computing: a refusal must not cost a script run.
        if (writeTokens) {
          if (!isPlainObject(element)) throw fail('is not an object, so nothing can be written under it', slot.path);
          const exists = targetExists(step.id, element, writeTokens, slot.path);
          if (step.mode === 'add' && exists) {
            throw fail('already exists, and the mode is "add"', writePath);
          }
          if (step.mode === 'replace' && !exists) {
            throw fail('does not exist, and the mode is "replace"', writePath);
          }
        } else if (step.mode === 'add') {
          throw fail('already exists, and the mode is "add"', writePath);
        }

        let output: unknown;
        if (step.use === SCRIPT_USE) {
          if (scriptMs >= CHAIN_LIMITS.scriptBudgetMs) {
            throw fail(`script budget exceeded (${CHAIN_LIMITS.scriptBudgetMs} ms per response)`, readPath);
          }
          const started = Date.now();
          try {
            session ??= new ScriptSession(step.code!, step.params);
            output = session.run(input, holder.v);
          } catch (err) {
            throw fail(err instanceof Error ? err.message : 'script failed', readPath);
          } finally {
            scriptMs += Date.now() - started;
          }
        } else {
          try {
            output = runBuiltin(step.use, input, step.params);
          } catch (err) {
            if (err instanceof BuiltinError) throw fail(err.message, readPath);
            throw err;
          }
        }

        if (writeTokens) writeAt(element as Record<string, unknown>, writeTokens, output);
        else slot.parent[slot.key] = output;
        wrote++;
      }

      if (trace) {
        const first = slots && slots.length > 0 ? slots[0] : null;
        let sample: unknown;
        if (first) {
          const el = first.parent[first.key];
          try {
            sample = structuredClone(el);
          } catch {
            sample = undefined;
          }
        }
        traces.push({
          id: step.id,
          wrote,
          skipped,
          bytes: jsonBytes(holder.v),
          ...(sample !== undefined ? { sample } : {}),
        });
      }
    } catch (err) {
      if (err instanceof StepFailure) {
        return {
          ok: false,
          error: err.message,
          failedStep: step.id,
          failedPath: err.failedPath,
          steps: traces,
        };
      }
      // A bug, not a data problem: still fail the step instead of the call.
      logger.error(`step ${step.id} crashed: ${err instanceof Error ? err.stack : String(err)}`);
      return {
        ok: false,
        error: `step ${step.id}: ${err instanceof Error ? err.message : 'failed'}`,
        failedStep: step.id,
        failedPath: '',
        steps: traces,
      };
    } finally {
      session?.dispose();
    }
  }

  return { ok: true, value: holder.v, steps: traces };
}
