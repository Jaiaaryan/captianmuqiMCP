import { Coins, Sigma, type LucideIcon } from 'lucide-react';
import type {
  ResponseProcessingBuiltin,
  ResponseProcessingBuiltinUse,
  ResponseProcessingChain,
  ResponseProcessingMode,
  ResponseProcessingParam,
  ResponseProcessingStep,
  ResponseProcessingUse,
} from '@/lib/api';
import { relPath, splitInput } from './path-picker';

export type {
  ResponseProcessingBuiltinUse,
  ResponseProcessingChain,
  ResponseProcessingMode,
  ResponseProcessingParam,
  ResponseProcessingStep,
  ResponseProcessingUse,
};
export type Step = ResponseProcessingStep;

export const FALLBACK_MAX_STEPS = 20;
export const FALLBACK_MAX_CODE_BYTES = 16 * 1024;
export const SCRIPT_USE: ResponseProcessingUse = 'script@1';
export const MODES: ResponseProcessingMode[] = ['add', 'replace', 'upsert'];

/* ------------------------------------------------------------------ */
/*  Built-ins                                                          */
/* ------------------------------------------------------------------ */

export interface BuiltinInfo {
  use: ResponseProcessingUse;
  title: string;
  params: ResponseProcessingParam[];
}

/** Titles only: typed params arrive with the contract from the server. */
export const FALLBACK_BUILTINS: BuiltinInfo[] = [
  { use: 'currency@1', title: 'Currency', params: [] },
  { use: 'scale@1', title: 'Scale', params: [] },
  { use: 'offset@1', title: 'Offset', params: [] },
  { use: 'vat@1', title: 'VAT', params: [] },
  { use: 'round@1', title: 'Round', params: [] },
  { use: 'clean_text@1', title: 'Clean text', params: [] },
  { use: 'truncate@1', title: 'Truncate', params: [] },
  { use: 'map@1', title: 'Map', params: [] },
];

/** The icon of a built-in: Coins for currency, Sigma for the rest. */
export function builtinIcon(use: string): LucideIcon {
  return use === 'currency@1' ? Coins : Sigma;
}

export function toBuiltinInfo(b: ResponseProcessingBuiltin): BuiltinInfo {
  const use = (
    b.name.includes('@') ? b.name : `${b.name}@${b.version ?? 1}`
  ) as ResponseProcessingUse;
  return { use, title: b.title || b.name, params: b.params ?? [] };
}

/* ------------------------------------------------------------------ */
/*  Stable row identity                                                */
/* ------------------------------------------------------------------ */

// A symbol-keyed property survives object spread (so edits keep the row key)
// but is invisible to JSON.stringify (so it never reaches the server).
const ROW_KEY = Symbol('rp-row-key');
let rowSeq = 0;

export function withKey(step: Step): Step {
  return { ...step, [ROW_KEY]: `k${++rowSeq}` } as Step;
}

export function stepKey(step: Step, index: number): string {
  return (step as unknown as Record<symbol, string | undefined>)[ROW_KEY] ?? `i${index}`;
}

/* ------------------------------------------------------------------ */
/*  Processors of a step (one, or a pipe of built-ins)                 */
/* ------------------------------------------------------------------ */

export function isScript(step: Pick<Step, 'use'>): boolean {
  return step.use === SCRIPT_USE;
}

/** The processors a step applies, in order. */
export function usesOf(step: Pick<Step, 'use'>): ResponseProcessingUse[] {
  return Array.isArray(step.use) ? [...step.use] : [step.use];
}

/** Params of the k-th processor. */
export function paramsOf(step: Pick<Step, 'use' | 'params'>, k = 0): Record<string, unknown> | undefined {
  const p = step.params;
  if (Array.isArray(p)) return p[k] ?? undefined;
  return k === 0 ? p : undefined;
}

/**
 * Store a list of built-ins with their params: a single one keeps the plain
 * `use` string and `params` object; two or more become a pipe with `params`
 * aligned by index.
 */
export function withPipe(
  step: Step,
  uses: ResponseProcessingBuiltinUse[],
  params: (Record<string, unknown> | undefined)[],
): Step {
  const { params: _p, code: _c, ...rest } = step;
  if (uses.length === 1) {
    const only = params[0];
    return { ...rest, use: uses[0], ...(only && Object.keys(only).length ? { params: only } : {}) };
  }
  return { ...rest, use: uses, params: uses.map((_, k) => params[k] ?? {}) };
}

/* ------------------------------------------------------------------ */
/*  Chain construction                                                 */
/* ------------------------------------------------------------------ */

export function emptyResponseProcessing(): ResponseProcessingChain {
  return { version: 1, enabled: false, onError: 'fail', steps: [] };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Coerce whatever is stored under responseMapping.responseProcessing. */
export function parseResponseProcessing(raw: unknown): ResponseProcessingChain | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.steps)) return null;
  const steps: ResponseProcessingStep[] = [];
  for (const s of r.steps) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
    const o = s as Record<string, unknown>;
    const use = Array.isArray(o.use)
      ? (o.use.filter((u) => typeof u === 'string') as ResponseProcessingBuiltinUse[])
      : ((str(o.use) || SCRIPT_USE) as ResponseProcessingUse);
    steps.push(withKey({
      ...(o as unknown as ResponseProcessingStep),
      id: str(o.id),
      use,
      reads: str(o.reads),
      writes: str(o.writes),
      mode: (MODES as string[]).includes(str(o.mode))
        ? (o.mode as ResponseProcessingMode)
        : 'add',
    }));
  }
  return {
    ...(r as unknown as ResponseProcessingChain),
    version: 1,
    enabled: r.enabled !== false,
    onError: r.onError === 'passthrough' ? 'passthrough' : 'fail',
    steps,
  };
}

/** An empty `writes` means "= reads": the server always gets the path itself. */
export function normalizeChain(chain: ResponseProcessingChain): ResponseProcessingChain {
  if (!chain.steps.some((s) => !s.writes.trim() && s.reads.trim())) return chain;
  return {
    ...chain,
    steps: chain.steps.map((s) => (!s.writes.trim() && s.reads.trim() ? { ...s, writes: s.reads } : s)),
  };
}

/** What gets stored: nothing at all for a chain without steps. */
export function serializeResponseProcessing(
  state: ResponseProcessingChain | null | undefined,
): ResponseProcessingChain | undefined {
  if (!state || state.steps.length === 0) return undefined;
  return normalizeChain(state);
}

export function nextStepId(steps: ResponseProcessingStep[], base: string): string {
  const taken = new Set(steps.map((s) => s.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A new script works on the same elements as the step before it. */
function inheritedEach(steps: ResponseProcessingStep[]): string | undefined {
  const last = steps[steps.length - 1];
  return last?.each?.trim() ? last.each : undefined;
}

/**
 * A built-in step: an empty Input until a field is picked, `writes` following
 * it, the mode derived from that (see modeFor). `at` sets the Input ("+ step
 * on this field").
 */
export function newBuiltinStep(
  info: BuiltinInfo,
  steps: ResponseProcessingStep[],
  at?: { each?: string; reads: string },
): ResponseProcessingStep {
  const params = defaultParams(info);
  return withKey({
    id: nextStepId(steps, info.use.replace(/@.*$/, '')),
    use: info.use,
    ...(at?.each ? { each: at.each } : {}),
    reads: at?.reads ?? '',
    writes: at?.reads ?? '',
    mode: modeFor(at ? 'existing' : 'unknown'),
    ...(params ? { params } : {}),
  });
}

/**
 * A script step that is valid as added: it reads the element (`$`) and writes it
 * back unchanged. The templates (convert, clean, filter) are editor snippets.
 */
export function newScriptStep(
  steps: ResponseProcessingStep[],
  at?: { each?: string; reads: string },
): ResponseProcessingStep {
  const each = at ? at.each : inheritedEach(steps);
  return withKey({
    id: nextStepId(steps, 'script'),
    use: SCRIPT_USE,
    ...(each ? { each } : {}),
    reads: at?.reads ?? '$',
    writes: at?.reads ?? '$',
    mode: modeFor('existing'),
    code: 'return value;',
  });
}

export function defaultParams(info: BuiltinInfo): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const p of info.params) if (p.default !== undefined) out[p.name] = p.default;
  return Object.keys(out).length ? out : undefined;
}

/* ------------------------------------------------------------------ */
/*  Local validation                                                   */
/* ------------------------------------------------------------------ */

export type ProblemField = 'id' | 'input' | 'writes' | 'code' | 'use';

export interface StepProblem {
  field: ProblemField;
  code: string;
}

export function localProblems(
  chain: ResponseProcessingChain | null | undefined,
  maxCodeBytes = FALLBACK_MAX_CODE_BYTES,
): Map<number, StepProblem[]> {
  const out = new Map<number, StepProblem[]>();
  if (!chain) return out;
  const push = (i: number, p: StepProblem) => out.set(i, [...(out.get(i) ?? []), p]);
  const counts = new Map<string, number>();
  for (const s of chain.steps) counts.set(s.id.trim(), (counts.get(s.id.trim()) ?? 0) + 1);
  chain.steps.forEach((s, i) => {
    if (!s.id.trim()) push(i, { field: 'id', code: 'id empty' });
    else if ((counts.get(s.id.trim()) ?? 0) > 1) push(i, { field: 'id', code: 'id duplicate' });
    // An empty `writes` follows the Input (stored as the same path, see normalizeChain).
    if (!s.reads.trim()) push(i, { field: 'input', code: 'input empty' });
    if (Array.isArray(s.use) && s.use.length === 0) push(i, { field: 'use', code: 'use empty' });
    if (s.use === SCRIPT_USE) {
      if (!s.code || !s.code.trim()) push(i, { field: 'code', code: 'code empty' });
      else if (new TextEncoder().encode(s.code).length > maxCodeBytes)
        push(i, { field: 'code', code: 'code size' });
    }
  });
  return out;
}

export function responseProcessingInvalid(
  state: ResponseProcessingChain | null | undefined,
): boolean {
  return localProblems(state).size > 0;
}

/** `step <id>: …` -> `<id>` */
export function problemStepId(problem: string | undefined): string | null {
  const m = problem ? /^step\s+(\S+?):/.exec(problem) : null;
  return m ? m[1] : null;
}

/** `step <id>: <path> <reason>` -> parts; falls back to the raw fields. */
export function splitFailure(
  error: string | undefined,
  failedStep?: string,
  failedPath?: string,
): { step: string; path: string; reason: string } {
  let rest = error ?? '';
  let step = failedStep ?? '';
  let path = failedPath ?? '';
  const m = /^step\s+(\S+?):\s*([\s\S]*)$/.exec(rest);
  if (m) {
    step = step || m[1];
    rest = m[2];
  }
  if (path && rest.startsWith(path)) rest = rest.slice(path.length).trim();
  else {
    const p = /^(\$\S*)\s+([\s\S]*)$/.exec(rest);
    if (p) {
      path = path || p[1];
      rest = p[2];
    }
  }
  return { step, path, reason: rest };
}

/* ------------------------------------------------------------------ */
/*  Formatting + sample diff                                           */
/* ------------------------------------------------------------------ */

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export interface DiffLine {
  path: string;
  kind: 'added' | 'changed' | 'removed' | 'plain';
  before?: string;
  after?: string;
}

function leaves(value: unknown, prefix: string, out: Map<string, string>, depth = 0) {
  if (value && typeof value === 'object' && depth < 4) {
    const entries = Array.isArray(value)
      ? value.map((v, i) => [`[${i}]`, v] as const)
      : Object.entries(value as Record<string, unknown>).map(([k, v]) => [`.${k}`, v] as const);
    if (entries.length) {
      for (const [k, v] of entries) leaves(v, prefix + k, out, depth + 1);
      return;
    }
  }
  const text = JSON.stringify(value);
  out.set(prefix.replace(/^\./, ''), text.length > 48 ? `${text.slice(0, 47)}…` : text);
}

/** Leaf-level diff between two element samples; `prev` undefined lists plain leaves. */
export function diffSamples(prev: unknown, next: unknown): DiffLine[] {
  const after = new Map<string, string>();
  leaves(next, '', after);
  if (prev === undefined) {
    return [...after].map(([path, v]) => ({ path, kind: 'plain', after: v }));
  }
  const before = new Map<string, string>();
  leaves(prev, '', before);
  const lines: DiffLine[] = [];
  for (const [path, v] of after) {
    if (!before.has(path)) lines.push({ path, kind: 'added', after: v });
    else if (before.get(path) !== v)
      lines.push({ path, kind: 'changed', before: before.get(path), after: v });
  }
  for (const [path, v] of before) {
    if (!after.has(path)) lines.push({ path, kind: 'removed', before: v });
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/*  Collapsed steps, per tool, for the browser session                 */
/* ------------------------------------------------------------------ */

const COLLAPSE_KEY = (toolId: string) => `amcp:rp-collapsed:${toolId}`;

export function loadCollapsed(toolId: string | undefined): Set<string> {
  if (!toolId || typeof window === 'undefined') return new Set();
  try {
    const raw = window.sessionStorage.getItem(COLLAPSE_KEY(toolId));
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsed(toolId: string | undefined, ids: Set<string>): void {
  if (!toolId || typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(COLLAPSE_KEY(toolId), JSON.stringify([...ids]));
  } catch {
    /* storage full or disabled: collapse state is a convenience */
  }
}

/** `2m`, `3h`, `4d` since an ISO time; `now` under a minute. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/* ------------------------------------------------------------------ */
/*  Editing a step's paths                                             */
/* ------------------------------------------------------------------ */

/** `writes` follows the Input while it is empty or the same path (`$.total` = `total`). */
export function writesTied(step: Pick<Step, 'reads' | 'writes'>): boolean {
  const w = step.writes.trim();
  const r = step.reads.trim();
  return !w || (!!r && relPath(w) === relPath(r));
}

/**
 * A new Input, split into `each` + `reads` (see splitInput). A tied `writes`
 * moves with it (a script on `$` keeps its own); `forceTied` (elements that
 * are scalars, nothing can be written under them) ties it in any case.
 */
export function withInput(step: Step, text: string, forceTied = false): Step {
  const { each, reads } = splitInput(text);
  const { each: _each, ...rest } = step;
  const tied = forceTied || (writesTied(step) && !(isScript(step) && step.reads.trim() === '$'));
  return { ...rest, ...(each ? { each } : {}), reads, ...(tied ? { writes: reads } : {}) };
}

export function withWrites(step: Step, writes: string): Step {
  return { ...step, writes };
}

/** What `writes` points at: a field the elements lack, one they have (or the Input), or unknown. */
export type WritesKind = 'new' | 'existing' | 'unknown';

export function writesKind(step: Pick<Step, 'reads' | 'writes'>, fresh: boolean | null): WritesKind {
  if (!step.reads.trim()) return 'unknown';
  if (writesTied(step)) return 'existing';
  return fresh === true ? 'new' : fresh === false ? 'existing' : 'unknown';
}

/** `add` for a new field, `replace` for one that exists (or the Input), `upsert` when unknown. */
export function modeFor(kind: WritesKind): ResponseProcessingMode {
  return kind === 'new' ? 'add' : kind === 'existing' ? 'replace' : 'upsert';
}

/**
 * The mode follows `writes`: re-derived whenever a path change flips what
 * `writes` points at; a mode the user chose stays until then.
 */
export function followMode(prev: Step, next: Step, kindOf: (s: Step) => WritesKind): Step {
  const kind = kindOf(next);
  return kind === kindOf(prev) ? next : { ...next, mode: modeFor(kind) };
}
