'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppSelect } from '@/components/ui/select';
import { useAuth } from '@/lib/auth-context';
import {
  processors as processorsApi,
  tools,
  type ProcessorChainConfig,
  type ProcessorDescriptor,
  type ProcessorParameterDescriptor,
  type ProcessorStepConfig,
  type ProcessorsPreview,
  type ProcessorWriteMode,
} from '@/lib/api';

/* ------------------------------------------------------------------ */
/*  Editor state <-> ProcessorChainConfig                              */
/* ------------------------------------------------------------------ */

type ParamType = ProcessorParameterDescriptor['type'];

/**
 * One parameter as the operator typed it. The text is kept raw so a
 * half-typed number or a JSON object being edited survives a re-render; the
 * declared type says how to turn it back into a value on save. Empty text
 * means "omitted — use the processor's default".
 */
export interface ProcessorParamState {
  type: ParamType;
  text: string;
  required?: boolean;
}

export interface ProcessorStepState {
  id: string;
  /** Registry ref, e.g. `number_scale@1`. */
  processor: string;
  each: string;
  reads: string;
  writes: string;
  mode: ProcessorWriteMode;
  onMissing: 'fail' | 'skip';
  params: Record<string, ProcessorParamState>;
}

export interface ProcessorChainState {
  enabled: boolean;
  onError: 'fail' | 'passthrough';
  steps: ProcessorStepState[];
}

export const EMPTY_PROCESSOR_STATE: ProcessorChainState = {
  enabled: true,
  onError: 'fail',
  steps: [],
};

const STEP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

/** The canonical demo: a USD price list turned into gross EUR, descriptions tidied. */
const EXAMPLE_STEPS: ProcessorStepState[] = [
  {
    id: 'convert_to_eur',
    processor: 'number_scale@1',
    each: '$.items[*]',
    reads: 'price_usd',
    writes: 'price_eur',
    mode: 'add',
    onMissing: 'fail',
    params: {
      factor: { type: 'number', text: '0.92', required: true },
      round: { type: 'integer', text: '2' },
    },
  },
  {
    id: 'add_vat',
    processor: 'number_vat@1',
    each: '$.items[*]',
    reads: 'price_eur',
    writes: 'price_eur_gross',
    mode: 'add',
    onMissing: 'fail',
    params: {
      rate: { type: 'number', text: '0.19', required: true },
      round: { type: 'integer', text: '2' },
    },
  },
  {
    id: 'tidy_description',
    processor: 'text_clean@1',
    each: '$.items[*]',
    reads: 'description',
    writes: 'description',
    mode: 'replace',
    onMissing: 'skip',
    params: {
      trim: { type: 'boolean', text: 'true' },
      collapseWhitespace: { type: 'boolean', text: 'true' },
    },
  },
];

function paramStateFromValue(value: unknown): ProcessorParamState {
  if (typeof value === 'number') {
    return { type: Number.isInteger(value) ? 'integer' : 'number', text: String(value) };
  }
  if (typeof value === 'boolean') return { type: 'boolean', text: value ? 'true' : 'false' };
  if (typeof value === 'string') return { type: 'string', text: value };
  return { type: 'object', text: JSON.stringify(value ?? null, null, 2) };
}

export function parseProcessorsToState(
  chain: ProcessorChainConfig | null | undefined,
): ProcessorChainState {
  if (!chain || !Array.isArray(chain.steps)) return EMPTY_PROCESSOR_STATE;
  return {
    enabled: chain.enabled !== false,
    onError: chain.onError === 'passthrough' ? 'passthrough' : 'fail',
    steps: chain.steps.map((step) => {
      const params: Record<string, ProcessorParamState> = {};
      for (const [name, value] of Object.entries(step.params ?? {})) {
        params[name] = paramStateFromValue(value);
      }
      return {
        id: step.id ?? '',
        processor: step.processor ?? '',
        each: step.each ?? '',
        reads: step.reads ?? '',
        writes: step.writes ?? '',
        mode: step.mode ?? 'upsert',
        onMissing: step.onMissing === 'skip' ? 'skip' : 'fail',
        params,
      };
    }),
  };
}

/** `undefined` when the parameter should be left out of the saved step. */
function paramValue(entry: ProcessorParamState): unknown {
  if (entry.type === 'boolean') {
    if (entry.text === 'true') return true;
    if (entry.text === 'false') return false;
    return undefined;
  }
  if (!entry.text.trim()) return undefined;
  if (entry.type === 'number' || entry.type === 'integer') {
    const n = Number(entry.text);
    return Number.isFinite(n) ? n : undefined;
  }
  if (entry.type === 'object') {
    try {
      return JSON.parse(entry.text);
    } catch {
      return undefined;
    }
  }
  return entry.text;
}

function stepToConfig(step: ProcessorStepState): ProcessorStepConfig | null {
  if (!step.id.trim() || !step.processor.trim() || !step.reads.trim() || !step.writes.trim()) {
    return null;
  }
  const params: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(step.params)) {
    const value = paramValue(entry);
    if (value !== undefined) params[name] = value;
  }
  const config: ProcessorStepConfig = {
    id: step.id.trim(),
    processor: step.processor,
    reads: step.reads.trim(),
    writes: step.writes.trim(),
    mode: step.mode,
    onMissing: step.onMissing,
  };
  if (step.each.trim()) config.each = step.each.trim();
  if (Object.keys(params).length > 0) config.params = params;
  return config;
}

/** Returns null when there is no chain to store (⇒ the response is not edited). */
export function stateToProcessors(state: ProcessorChainState): ProcessorChainConfig | null {
  const steps = state.steps
    .map(stepToConfig)
    .filter((step): step is ProcessorStepConfig => step !== null);
  if (steps.length === 0) return null;
  return { version: 1, enabled: state.enabled, onError: state.onError, steps };
}

/**
 * What is still missing or unparseable in one step, as a sentence — or null
 * when the step is ready. `def` adds the checks that need the processor's
 * declared contract (a required parameter left empty); without it only what the
 * step itself says can be checked.
 */
export function processorStepProblem(
  step: ProcessorStepState,
  def?: ProcessorDescriptor | null,
): string | null {
  if (!step.processor.trim()) return 'Pick a processor.';
  if (!step.id.trim()) return 'Give the step an id — it names the step in every error.';
  if (!STEP_ID_PATTERN.test(step.id.trim())) {
    return 'The id can only use letters, digits, "-" and "_", starting with a letter or digit.';
  }
  if (!step.reads.trim()) return 'Name the field this step reads.';
  if (!step.writes.trim()) return 'Name the field this step writes.';

  const declared = def?.parameters ?? [];
  for (const [name, entry] of Object.entries(step.params)) {
    const param = declared.find((p) => p.name === name);
    const required = param?.required ?? entry.required ?? false;
    const empty = entry.type === 'boolean' ? !entry.text : !entry.text.trim();
    if (empty) {
      if (required) return `"${name}" is required.`;
      continue;
    }
    if (paramValue(entry) === undefined) {
      return entry.type === 'object'
        ? `"${name}" is not valid JSON.`
        : `"${name}" is not a number.`;
    }
  }
  for (const param of declared) {
    if (!param.required) continue;
    const entry = step.params[param.name];
    if (!entry || (entry.type === 'boolean' ? !entry.text : !entry.text.trim())) {
      return `"${param.name}" is required.`;
    }
  }
  return null;
}

/** True when the operator left a step incomplete or typed something that doesn't parse. */
export function processorStateInvalid(state: ProcessorChainState): boolean {
  const seen = new Set<string>();
  for (const step of state.steps) {
    if (processorStepProblem(step)) return true;
    const id = step.id.trim();
    if (seen.has(id)) return true;
    seen.add(id);
  }
  return false;
}

function duplicateIds(state: ProcessorChainState): Set<string> {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const step of state.steps) {
    const id = step.id.trim();
    if (!id) continue;
    if (seen.has(id)) twice.add(id);
    seen.add(id);
  }
  return twice;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Percentage the response shrank (positive) or grew (negative). */
function sizeDeltaPct(before: number, after: number): number {
  if (!before) return 0;
  return Math.round(((before - after) / before) * 100);
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

interface Props {
  state: ProcessorChainState;
  onChange: (next: ProcessorChainState) => void;
  /** Needed for the step-by-step preview — absent while creating a brand-new tool. */
  connectorId?: string;
  toolId?: string;
}

const INPUT_CLASS =
  'w-full border border-[var(--input)] rounded px-2 py-1 text-xs bg-[var(--background)] font-mono';
const SELECT_CLASS =
  'w-full border border-[var(--input)] rounded px-2 py-1 text-xs bg-[var(--background)]';

export function ProcessorChainPanel({ state, onChange, connectorId, toolId }: Props) {
  const { token } = useAuth();
  const [registry, setRegistry] = useState<ProcessorDescriptor[]>([]);
  const [maxSteps, setMaxSteps] = useState<number | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ProcessorsPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [check, setCheck] = useState<{ valid: boolean; message: string } | null>(null);
  const [checking, setChecking] = useState(false);

  // The registry is what the picker and every parameter input are built from,
  // so a step is never guessed at: the contract comes from the installation.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    processorsApi
      .list(token)
      .then((res) => {
        if (cancelled) return;
        setRegistry(res.processors ?? []);
        setMaxSteps(res.limits?.maxSteps ?? null);
      })
      .catch((err: any) => {
        if (!cancelled) setRegistryError(err?.message || 'Could not load the processor list');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const definitionFor = useCallback(
    (ref: string): ProcessorDescriptor | null =>
      registry.find((p) => p.ref === ref) ?? registry.find((p) => p.name === ref) ?? null,
    [registry],
  );

  const chain = useMemo(() => stateToProcessors(state), [state]);
  const twice = duplicateIds(state);
  const invalid = processorStateInvalid(state);
  const atCap = maxSteps !== null && state.steps.length >= maxSteps;

  const set = (patch: Partial<ProcessorChainState>) => onChange({ ...state, ...patch });
  const setStep = (index: number, patch: Partial<ProcessorStepState>) =>
    set({ steps: state.steps.map((s, i) => (i === index ? { ...s, ...patch } : s)) });
  const setParam = (index: number, param: ProcessorParameterDescriptor, text: string) => {
    const step = state.steps[index];
    setStep(index, {
      params: {
        ...step.params,
        [param.name]: { type: param.type, required: param.required, text },
      },
    });
  };

  /** Fresh parameter inputs for a processor, keeping anything the names share. */
  const paramsFor = (
    def: ProcessorDescriptor | null,
    previous: Record<string, ProcessorParamState>,
  ): Record<string, ProcessorParamState> => {
    if (!def) return previous;
    const next: Record<string, ProcessorParamState> = {};
    for (const param of def.parameters) {
      const kept = previous[param.name];
      next[param.name] = {
        type: param.type,
        required: param.required,
        text: kept
          ? kept.text
          : param.type === 'boolean'
            ? String(param.default ?? false)
            : '',
      };
    }
    return next;
  };

  const addStep = () => {
    const def = registry[0] ?? null;
    set({
      steps: [
        ...state.steps,
        {
          id: `step_${state.steps.length + 1}`,
          processor: def?.ref ?? '',
          each: '',
          reads: '',
          writes: '',
          mode: 'upsert',
          onMissing: 'fail',
          params: paramsFor(def, {}),
        },
      ],
    });
  };

  const removeStep = (index: number) => set({ steps: state.steps.filter((_, i) => i !== index) });

  const moveStep = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= state.steps.length) return;
    const steps = [...state.steps];
    [steps[index], steps[target]] = [steps[target], steps[index]];
    set({ steps });
  };

  const changeProcessor = (index: number, ref: string) => {
    const step = state.steps[index];
    setStep(index, { processor: ref, params: paramsFor(definitionFor(ref), step.params) });
  };

  const insertExample = () =>
    onChange({
      enabled: true,
      onError: 'fail',
      steps: EXAMPLE_STEPS.map((step) => ({ ...step, params: { ...step.params } })),
    });

  const canPreview = !!(connectorId && toolId && token) && !invalid;

  const runPreview = async () => {
    if (!connectorId || !toolId || !token) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      const res = await tools.previewProcessors(connectorId, toolId, { processors: chain }, token);
      setPreview(res);
      if (!res.ok) setPreviewError(res.error ?? 'Preview failed');
    } catch (err: any) {
      setPreviewError(err?.message || 'Preview failed');
      setPreview(null);
    } finally {
      setPreviewing(false);
    }
  };

  const runCheck = async () => {
    if (!token) return;
    setChecking(true);
    setCheck(null);
    try {
      const res = await processorsApi.validate({ processors: chain }, token);
      setCheck({
        valid: res.valid,
        message: res.valid
          ? chain
            ? 'Every step checks out against the registry.'
            : 'Nothing to check — this tool has no steps.'
          : res.error || 'The chain is not valid.',
      });
    } catch (err: any) {
      setCheck({ valid: false, message: err?.message || 'Could not check the chain' });
    } finally {
      setChecking(false);
    }
  };

  const processorOptions = useMemo(() => {
    const options = registry.map((p) => ({
      value: p.ref,
      label: `${p.title} · ${p.ref}`,
    }));
    // A chain written against a processor this installation does not list must
    // still show what it names instead of silently switching to another one.
    for (const step of state.steps) {
      if (step.processor && !options.some((o) => o.value === step.processor)) {
        options.push({ value: step.processor, label: `${step.processor} (not in this registry)` });
      }
    }
    return options;
  }, [registry, state.steps]);

  return (
    <div className="border border-[var(--border)] rounded-md p-3 space-y-3" data-testid="processor-panel">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <label className="text-xs font-semibold">Response Processors</label>
          <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">
            Edit the response before the mapping selects from it: convert a currency, add
            VAT, clean a description, translate a status code. The fix lives on the tool, so
            it happens once instead of in every prompt that reads this tool. Steps run in
            the order below — a later step can read what an earlier one wrote.
          </p>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={state.enabled}
              onChange={(e) => set({ enabled: e.target.checked })}
            />
            Run this chain
          </label>
          <label className="flex items-center gap-1.5">
            On error
            <AppSelect
              value={state.onError}
              onValueChange={(v) => set({ onError: v as ProcessorChainState['onError'] })}
              aria-label="What to do when a step refuses a value"
              className="w-36 border border-[var(--input)] rounded px-2 py-1 text-xs bg-[var(--background)]"
              options={[
                { value: 'fail', label: 'Fail the call' },
                { value: 'passthrough', label: 'Return unedited' },
              ]}
            />
          </label>
        </div>
      </div>

      <p className="text-[11px] text-[var(--muted-foreground)]">
        <strong>Fail the call</strong> (the default, and the safe one): a step that refuses a
        value fails the tool call, so a half-edited response is never returned.{' '}
        <strong>Return unedited</strong> returns the response as it arrived and logs a
        warning. Unchecking <em>Run this chain</em> keeps the steps on the tool without
        running them.
      </p>

      {registryError && (
        <p className="text-[11px] text-[var(--danger)]">
          Could not load the processor list ({registryError}). Existing steps are still
          editable, but the parameter inputs cannot be built from the contract.
        </p>
      )}

      {state.steps.length === 0 && (
        <p className="text-[11px] text-[var(--muted-foreground)]">
          No steps — the response reaches the mapping exactly as the API returned it.
        </p>
      )}

      <div className="space-y-2">
        {state.steps.map((step, index) => {
          const def = definitionFor(step.processor);
          const problem = processorStepProblem(step, def);
          const duplicate = !!step.id.trim() && twice.has(step.id.trim());
          return (
            <div
              key={index}
              data-testid="processor-step"
              className="border border-[var(--border)] rounded p-2 space-y-2 bg-[var(--background)]"
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] text-[var(--muted-foreground)] w-4">
                  {index + 1}.
                </span>
                <input
                  type="text"
                  value={step.id}
                  onChange={(e) => setStep(index, { id: e.target.value })}
                  placeholder="convert_to_eur"
                  aria-label={`Step ${index + 1} id`}
                  spellCheck={false}
                  className="w-44 border border-[var(--input)] rounded px-2 py-1 text-xs bg-[var(--background)] font-mono"
                />
                <div className="flex-1 min-w-[220px]">
                  <AppSelect
                    value={step.processor}
                    onValueChange={(v) => changeProcessor(index, v)}
                    aria-label={`Step ${index + 1} processor`}
                    className={SELECT_CLASS}
                    options={processorOptions}
                  />
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => moveStep(index, -1)}
                    disabled={index === 0}
                    title="Move this step earlier"
                    aria-label={`Move step ${index + 1} up`}
                    className="border border-[var(--border)] px-2 py-1 rounded text-xs hover:bg-[var(--accent)] disabled:opacity-40"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => moveStep(index, 1)}
                    disabled={index === state.steps.length - 1}
                    title="Move this step later"
                    aria-label={`Move step ${index + 1} down`}
                    className="border border-[var(--border)] px-2 py-1 rounded text-xs hover:bg-[var(--accent)] disabled:opacity-40"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => removeStep(index)}
                    title="Remove this step"
                    className="border border-[var(--border)] px-2 py-1 rounded text-xs text-[var(--danger)] hover:bg-[var(--accent)]"
                  >
                    Remove
                  </button>
                </div>
              </div>

              {def && (
                <p className="text-[10px] text-[var(--muted-foreground)]">
                  {def.description} Reads a {def.input.type}, writes a {def.output.type}.
                </p>
              )}

              <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
                <label className="text-[10px] font-medium block md:col-span-2">
                  Runs over (each)
                  <input
                    type="text"
                    value={step.each}
                    onChange={(e) => setStep(index, { each: e.target.value })}
                    placeholder="$.items[*]"
                    spellCheck={false}
                    className={`${INPUT_CLASS} mt-1`}
                  />
                </label>
                <label className="text-[10px] font-medium block">
                  Reads
                  <input
                    type="text"
                    value={step.reads}
                    onChange={(e) => setStep(index, { reads: e.target.value })}
                    placeholder="price_usd"
                    spellCheck={false}
                    className={`${INPUT_CLASS} mt-1`}
                  />
                </label>
                <label className="text-[10px] font-medium block">
                  Writes
                  <input
                    type="text"
                    value={step.writes}
                    onChange={(e) => setStep(index, { writes: e.target.value })}
                    placeholder="price_eur"
                    spellCheck={false}
                    className={`${INPUT_CLASS} mt-1`}
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-[10px] font-medium block">
                    Write mode
                    <AppSelect
                      value={step.mode}
                      onValueChange={(v) => setStep(index, { mode: v as ProcessorWriteMode })}
                      aria-label={`Step ${index + 1} write mode`}
                      className={`${SELECT_CLASS} mt-1`}
                      options={[
                        { value: 'add', label: 'add' },
                        { value: 'replace', label: 'replace' },
                        { value: 'upsert', label: 'upsert' },
                      ]}
                    />
                  </label>
                  <label className="text-[10px] font-medium block">
                    If missing
                    <AppSelect
                      value={step.onMissing}
                      onValueChange={(v) =>
                        setStep(index, { onMissing: v as ProcessorStepState['onMissing'] })
                      }
                      aria-label={`Step ${index + 1} behaviour when the field is missing`}
                      className={`${SELECT_CLASS} mt-1`}
                      options={[
                        { value: 'fail', label: 'fail' },
                        { value: 'skip', label: 'skip' },
                      ]}
                    />
                  </label>
                </div>
              </div>

              <p className="text-[10px] text-[var(--muted-foreground)]">
                <code>each</code> is the collection every element gets the step
                (<code>$.items[*]</code>); leave it empty to run the step once on the whole
                response. <code>reads</code> and <code>writes</code> are relative to the
                element. <code>add</code> requires the target field not to exist yet,{' '}
                <code>replace</code> requires it to exist, <code>upsert</code> takes either.{' '}
                <code>skip</code> leaves an element alone when the read field is not there.
              </p>

              {def && def.parameters.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {def.parameters.map((param) => {
                    const entry = step.params[param.name] ?? {
                      type: param.type,
                      text: '',
                      required: param.required,
                    };
                    // An unset boolean runs with the processor's default, so that
                    // is what the checkbox has to show.
                    const booleanValue = entry.text ? entry.text === 'true' : param.default === true;
                    const placeholder =
                      param.default !== undefined
                        ? String(
                            typeof param.default === 'object'
                              ? JSON.stringify(param.default)
                              : param.default,
                          )
                        : '';
                    return (
                      <div key={param.name}>
                        <label className="text-[10px] font-medium block">
                          {param.name}
                          {param.required && <span className="text-[var(--danger)]"> *</span>}
                          {param.type === 'boolean' ? (
                            <span className="flex items-center gap-1.5 mt-1 text-[11px] font-normal">
                              <input
                                type="checkbox"
                                checked={booleanValue}
                                onChange={(e) =>
                                  setParam(index, param, e.target.checked ? 'true' : 'false')
                                }
                              />
                              {booleanValue ? 'on' : 'off'}
                            </span>
                          ) : param.type === 'object' ? (
                            <textarea
                              value={entry.text}
                              onChange={(e) => setParam(index, param, e.target.value)}
                              rows={3}
                              spellCheck={false}
                              placeholder={placeholder || '{ "2": "shipped" }'}
                              className={`${INPUT_CLASS} mt-1`}
                            />
                          ) : param.type === 'string' ? (
                            <input
                              type="text"
                              value={entry.text}
                              onChange={(e) => setParam(index, param, e.target.value)}
                              placeholder={placeholder}
                              className={`${INPUT_CLASS} mt-1`}
                            />
                          ) : (
                            <input
                              type="number"
                              value={entry.text}
                              onChange={(e) => setParam(index, param, e.target.value)}
                              placeholder={placeholder}
                              step={param.type === 'integer' ? 1 : 'any'}
                              min={param.min}
                              max={param.max}
                              className={`${INPUT_CLASS} mt-1`}
                            />
                          )}
                        </label>
                        <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">
                          {param.description}
                          {!param.required && param.default !== undefined && (
                            <> Default {String(
                              typeof param.default === 'object'
                                ? JSON.stringify(param.default)
                                : param.default,
                            )}.</>
                          )}
                        </p>
                      </div>
                    );
                  })}
                </div>
              )}

              {(problem || duplicate) && (
                <p className="text-[11px] text-[var(--danger)]">
                  {problem ?? `The id "${step.id.trim()}" is used by another step.`} Saving is
                  disabled until this step is complete.
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={addStep}
          disabled={atCap}
          title={atCap ? `A chain can hold at most ${maxSteps} steps.` : 'Append a step'}
          className="border border-[var(--border)] px-3 py-1 rounded text-xs hover:bg-[var(--accent)] disabled:opacity-50"
        >
          Add step
        </button>
        <button
          type="button"
          onClick={insertExample}
          className="text-[11px] text-[var(--brand)] hover:underline"
        >
          Insert example
        </button>
        {atCap && (
          <span className="text-[10px] text-[var(--muted-foreground)]">
            At the limit of {maxSteps} steps.
          </span>
        )}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={runPreview}
          disabled={!canPreview || previewing}
          title={
            canPreview
              ? 'Runs the chain against the most recent real response for this tool. No API call is made.'
              : 'Save the tool and run it once to get a real response to preview against.'
          }
          className="border border-[var(--border)] px-3 py-1 rounded text-xs hover:bg-[var(--accent)] disabled:opacity-50"
        >
          {previewing ? 'Previewing…' : 'Preview step by step'}
        </button>
        <button
          type="button"
          onClick={runCheck}
          disabled={!token || checking}
          title="Checks every step against the registry — no sample response needed."
          className="border border-[var(--border)] px-3 py-1 rounded text-xs hover:bg-[var(--accent)] disabled:opacity-50"
        >
          {checking ? 'Checking…' : 'Check chain'}
        </button>
        {preview?.ok && preview.chainActive && (
          <span data-testid="processor-size" className="text-[11px] text-[var(--muted-foreground)]">
            {formatBytes(preview.rawBytes ?? 0)} → {formatBytes(preview.resultBytes ?? 0)}{' '}
            <strong
              className={
                sizeDeltaPct(preview.rawBytes ?? 0, preview.resultBytes ?? 0) > 0
                  ? 'text-[var(--ok,#16a34a)]'
                  : undefined
              }
            >
              ({sizeDeltaPct(preview.rawBytes ?? 0, preview.resultBytes ?? 0) > 0 ? '−' : '+'}
              {Math.abs(sizeDeltaPct(preview.rawBytes ?? 0, preview.resultBytes ?? 0))}%)
            </strong>
            {preview.sampleCapturedAt && (
              <> · sample from {new Date(preview.sampleCapturedAt).toLocaleString()}</>
            )}
          </span>
        )}
      </div>

      {check && (
        <p
          className={`text-[11px] ${check.valid ? 'text-[var(--muted-foreground)]' : 'text-[var(--danger)]'}`}
        >
          {check.message}
        </p>
      )}
      {previewError && !preview?.failedStep && (
        <p className="text-[11px] text-[var(--danger)]">{previewError}</p>
      )}

      {preview && !preview.ok && preview.failedStep && (
        <div data-testid="processor-failure" className="border border-[var(--danger)] rounded p-2 space-y-1">
          <p className="text-[11px] font-semibold text-[var(--danger)]">
            The chain stopped at step {preview.failedStep}
          </p>
          <p className="text-[11px] font-mono break-all">{preview.failedPath}</p>
          <p className="text-[11px]">{preview.error}</p>
          <p className="text-[10px] text-[var(--muted-foreground)]">
            That path is the value the step refused. Nothing half-edited is returned: with
            <strong> Fail the call</strong> the tool call fails with this message, with{' '}
            <strong>Return unedited</strong> the client gets the response as it arrived.
          </p>
        </div>
      )}

      {preview?.ok && preview.chainActive === false && (
        <p className="text-[11px] text-[var(--muted-foreground)]">
          No chain ran — there are no steps, or the chain is switched off.
        </p>
      )}

      {preview && (preview.steps?.length ?? 0) > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] font-medium text-[var(--muted-foreground)]">
            After every step
          </p>
          {(preview.steps ?? []).map((trace, i) => (
            <div
              key={`${trace.id}-${i}`}
              data-testid="processor-trace"
              className="border border-[var(--border)] rounded p-2"
            >
              <div className="flex items-baseline justify-between gap-2 flex-wrap">
                <p className="text-[11px] font-medium">
                  {i + 1}. {trace.id}{' '}
                  <span className="font-mono text-[var(--muted-foreground)]">
                    {trace.processor}
                  </span>
                </p>
                <p className="text-[10px] text-[var(--muted-foreground)]">
                  {trace.targets} element{trace.targets === 1 ? '' : 's'} · {trace.written}{' '}
                  written · {trace.skipped} skipped · {trace.mode}
                  {typeof trace.bytesAfter === 'number' && (
                    <> · {formatBytes(trace.bytesAfter)} after</>
                  )}
                </p>
              </div>
              {trace.sample !== undefined && (
                <pre className="mt-1 p-2 bg-[var(--muted)] rounded text-[10px] font-mono overflow-auto max-h-40">
                  {JSON.stringify(trace.sample, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}

      {preview && preview.raw !== undefined && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <div>
            <p className="text-[10px] font-medium text-[var(--muted-foreground)] mb-1">
              Response as it arrived
            </p>
            <pre className="p-2 bg-[var(--muted)] rounded text-[10px] font-mono overflow-auto max-h-56">
              {JSON.stringify(preview.raw, null, 2)}
            </pre>
          </div>
          <div>
            <p className="text-[10px] font-medium text-[var(--muted-foreground)] mb-1">
              {preview.ok
                ? 'After the chain (before the mapping)'
                : 'What the client would get — unedited, the chain stopped'}
            </p>
            <pre className="p-2 bg-[var(--muted)] rounded text-[10px] font-mono overflow-auto max-h-56">
              {JSON.stringify(preview.result, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
