import type {
  ResponseProcessingBuiltin,
  ResponseProcessingChain,
  ResponseProcessingMode,
  ResponseProcessingParam,
  ResponseProcessingStep,
  ResponseProcessingUse,
} from '@/lib/api';

export type {
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
  { use: 'scale@1', title: 'Scale', params: [] },
  { use: 'offset@1', title: 'Offset', params: [] },
  { use: 'vat@1', title: 'VAT', params: [] },
  { use: 'round@1', title: 'Round', params: [] },
  { use: 'clean_text@1', title: 'Clean text', params: [] },
  { use: 'truncate@1', title: 'Truncate', params: [] },
  { use: 'map@1', title: 'Map', params: [] },
];

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
    steps.push(withKey({
      ...(o as unknown as ResponseProcessingStep),
      id: str(o.id),
      use: (str(o.use) || SCRIPT_USE) as ResponseProcessingUse,
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

/** What gets stored: nothing at all for a chain without steps. */
export function serializeResponseProcessing(
  state: ResponseProcessingChain | null | undefined,
): ResponseProcessingChain | undefined {
  if (!state || state.steps.length === 0) return undefined;
  return state;
}

export function nextStepId(steps: ResponseProcessingStep[], base: string): string {
  const taken = new Set(steps.map((s) => s.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function newBuiltinStep(
  info: BuiltinInfo,
  steps: ResponseProcessingStep[],
): ResponseProcessingStep {
  const params = defaultParams(info);
  return withKey({
    id: nextStepId(steps, info.use.replace(/@.*$/, '')),
    use: info.use,
    reads: '',
    writes: '',
    mode: 'add',
    ...(params ? { params } : {}),
  });
}

/**
 * A script step that is valid as added: it reads the element (`$`) and writes it
 * back unchanged. The templates (convert, clean, filter) are editor snippets.
 */
export function newScriptStep(steps: ResponseProcessingStep[]): ResponseProcessingStep {
  return withKey({
    id: nextStepId(steps, 'script'),
    use: SCRIPT_USE,
    reads: '$',
    writes: '$',
    mode: 'upsert',
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

export type ProblemField = 'id' | 'reads' | 'writes' | 'code';

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
    if (!s.reads.trim()) push(i, { field: 'reads', code: 'reads empty' });
    if (!s.writes.trim()) push(i, { field: 'writes', code: 'writes empty' });
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
