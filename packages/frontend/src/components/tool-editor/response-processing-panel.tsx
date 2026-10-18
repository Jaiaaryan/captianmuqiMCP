'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import {
  ApiError,
  responseProcessing,
  tools as toolsApi,
  type ResponseProcessingPreview,
} from '@/lib/api';
import { HardDrive, PenLine, SkipForward, Undo2, X } from 'lucide-react';
import { Icon } from './icon';
import { Kbd } from './kbd';
import { BTN_GHOST, ROW, TONE_TEXT } from './response-processing-styles';
import { checkSyntax } from './code-field';
import { useBuiltins, type ChainStatus, type ProcessingSummaryInfo } from './response-processing-controls';
import type { SheetRequest } from './use-sheet-state';
import { ResponseProcessingStepRow } from './response-processing-step-row';
import { earlierWrites, elementIsScalar, isNewField, samplePathProblems, splitInput, type PathMode } from './path-picker';
import {
  ResponseTree,
  addStepWrites,
  buildTree,
  placeOf,
  scopeOf,
  type PickContext,
  type RunParam,
  type SampleSource,
  type TreeNode,
} from './response-tree';
import {
  emptyResponseProcessing,
  formatBytes,
  isScript,
  loadCollapsed,
  localProblems,
  newBuiltinStep,
  newScriptStep,
  nextStepId,
  normalizeChain,
  problemStepId,
  saveCollapsed,
  splitFailure,
  stepKey,
  followMode,
  withInput,
  withKey,
  withWrites,
  writesKind,
  type ResponseProcessingChain,
  type Step,
} from './response-processing-model';

export {
  emptyResponseProcessing,
  parseResponseProcessing,
  responseProcessingInvalid,
  serializeResponseProcessing,
} from './response-processing-model';
export type { ResponseProcessingChain, Step } from './response-processing-model';

/* ------------------------------------------------------------------ */
/*  Recorded sample                                                    */
/* ------------------------------------------------------------------ */

interface Recorded {
  sample: unknown;
  capturedAt?: string | null;
  lengths?: Record<string, number>;
  input?: Record<string, unknown>;
}

/** The tool's latest recorded response (cut server-side); `sample` undefined without one. */
function useRecorded(toolId: string | undefined, token: string | null, refresh: number): Recorded {
  const [state, setState] = useState<{ key: string; value: Recorded } | null>(null);
  const key = `${toolId ?? ''}:${refresh}`;
  useEffect(() => {
    if (!toolId || !token) return;
    let cancelled = false;
    responseProcessing
      .forTool(toolId, token)
      .then((r) => {
        if (cancelled) return;
        setState({
          key,
          value: {
            sample: r.sampleAvailable ? r.sample : undefined,
            capturedAt: r.sampleCapturedAt,
            lengths: r.sampleLengths,
            input: r.sampleInput,
          },
        });
      })
      .catch(() => {
        if (!cancelled) setState({ key, value: { sample: undefined } });
      });
    return () => {
      cancelled = true;
    };
  }, [toolId, token, key]);
  // Keep the previous sample while a refresh is in flight.
  return toolId && state ? state.value : { sample: undefined };
}

/* ------------------------------------------------------------------ */
/*  State shapes                                                       */
/* ------------------------------------------------------------------ */

type Remote =
  | { key: string; status: 'checking' }
  | { key: string; status: 'ok' }
  | { key: string; status: 'invalid'; problem: string }
  | { key: string; status: 'unavailable' };

type PreviewState =
  | { key: string; kind: 'result'; data: ResponseProcessingPreview }
  | { key: string; kind: 'nosample' }
  | { key: string; kind: 'unavailable' }
  | { key: string; kind: 'error'; message: string };

interface Props {
  state: ResponseProcessingChain | null | undefined;
  onChange: (next: ResponseProcessingChain) => void;
  /** Preview and Run need a saved tool; both are absent while creating a new one. */
  connectorId?: string;
  toolId?: string;
  /** The tool's parameters: the fields of the tree's Run form. */
  toolParams?: RunParam[];
  /** Where to land when the sheet opens: a step to expand and scroll to, a field to focus, a preview to run. */
  request?: SheetRequest | null;
  /** Status and per-step problems, for the page summary and the sheet header. */
  onSummary?: (info: ProcessingSummaryInfo) => void;
}

/* ------------------------------------------------------------------ */
/*  Panel                                                              */
/* ------------------------------------------------------------------ */

/**
 * The Response Processing editor body: steps and the response tree. It lives in
 * the sheet (which hosts its header) and stays mounted while the sheet is
 * closed, so it keeps reporting status to the page summary.
 */
export function ResponseProcessingPanel({
  state,
  onChange,
  connectorId,
  toolId,
  toolParams = [],
  request,
  onSummary,
}: Props) {
  const { token } = useAuth();
  const chain = state ?? emptyResponseProcessing();
  const { steps } = chain;
  const rootRef = useRef<HTMLElement>(null);

  const { builtins, maxSteps, maxCodeBytes } = useBuiltins(token);

  /* ---- sample: recorded, or pasted (client only, never stored) ---- */

  const [sampleRefresh, setSampleRefresh] = useState(0);
  const recorded = useRecorded(toolId, token, sampleRefresh);
  const [pasted, setPasted] = useState<{ value: unknown } | null>(null);
  const sample = pasted ? pasted.value : recorded.sample;
  const lengths = pasted ? undefined : recorded.lengths;
  const source: SampleSource | null = pasted
    ? { kind: 'pasted' }
    : recorded.sample !== undefined
      ? { kind: 'recorded', capturedAt: recorded.capturedAt }
      : null;

  const tree = useMemo(() => {
    const t = buildTree(sample, lengths);
    addStepWrites(t, steps);
    return t;
  }, [sample, lengths, steps]);
  const scopes = useMemo(() => steps.map((s) => scopeOf(tree, s.each)), [tree, steps]);

  const problems = useMemo(() => localProblems(chain, maxCodeBytes), [chain, maxCodeBytes]);
  const chainKey = useMemo(() => JSON.stringify(normalizeChain(chain)), [chain]);

  /* ---- collapsed steps (by id, per tool, for the session) ---- */

  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(toolId));
  const updateCollapsed = (next: Set<string>) => {
    setCollapsed(next);
    saveCollapsed(toolId, next);
  };
  const toggleStep = (i: number, all: boolean) => {
    const id = steps[i].id;
    if (all) {
      const anyOpen = steps.some((s) => !collapsed.has(s.id));
      updateCollapsed(anyOpen ? new Set(steps.map((s) => s.id)) : new Set());
      return;
    }
    const next = new Set(collapsed);
    if (!next.delete(id)) next.add(id);
    updateCollapsed(next);
  };

  /* ---- editing ---- */

  const setSteps = (next: Step[], extra: Partial<ResponseProcessingChain> = {}) =>
    onChange({ ...chain, ...extra, steps: next });

  const pendingFocus = useRef<{ key: string; suffix: string } | null>(null);
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    const i = steps.findIndex((s, idx) => stepKey(s, idx) === target.key);
    if (i < 0) return;
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-testid="rp-step-${i}-${target.suffix}"]`);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: 'nearest' });
  }, [steps]);

  const addStep = (step: Step, focus: string | null = 'input') => {
    if (steps.length >= maxSteps) return;
    if (focus) pendingFocus.current = { key: stepKey(step, steps.length), suffix: focus };
    if (collapsed.has(step.id)) {
      const next = new Set(collapsed);
      next.delete(step.id);
      updateCollapsed(next);
    }
    setSteps([...steps, step], steps.length === 0 ? { enabled: true } : {});
  };

  const replaceStep = (i: number, next: Step) => {
    const prevId = steps[i].id;
    if (next.id !== prevId && collapsed.has(prevId)) {
      const c = new Set(collapsed);
      c.delete(prevId);
      c.add(next.id);
      updateCollapsed(c);
    }
    setSteps(steps.map((s, idx) => (idx === i ? next : s)));
  };

  const duplicateStep = (i: number) => {
    const src = steps[i];
    const copy = withKey({ ...src, id: nextStepId(steps, src.id || 'step') });
    pendingFocus.current = { key: stepKey(copy, i + 1), suffix: 'id' };
    setSteps([...steps.slice(0, i + 1), copy, ...steps.slice(i + 1)]);
  };

  const moveStep = (i: number, delta: -1 | 1, suffix = 'menu') => {
    const j = i + delta;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    pendingFocus.current = { key: stepKey(steps[i], i), suffix };
    setSteps(next);
  };

  /* ---- delete + 5 s undo ---- */

  const [undo, setUndo] = useState<{ step: Step; index: number } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (undoTimer.current) clearTimeout(undoTimer.current);
    },
    [],
  );

  const deleteStep = (i: number) => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo({ step: steps[i], index: i });
    undoTimer.current = setTimeout(() => setUndo(null), 5000);
    setSteps(steps.filter((_, idx) => idx !== i));
  };

  const undoDelete = () => {
    if (!undo) return;
    if (undoTimer.current) clearTimeout(undoTimer.current);
    const at = Math.min(undo.index, steps.length);
    const restored = steps.some((s) => s.id === undo.step.id)
      ? { ...undo.step, id: nextStepId(steps, undo.step.id) }
      : undo.step;
    setUndo(null);
    setSteps([...steps.slice(0, at), restored, ...steps.slice(at)], steps.length === 0 ? { enabled: true } : {});
  };

  /* ---- pick mode: one step's path field, filled from the tree ---- */

  const [picking, setPicking] = useState<{ key: string; field: PathMode } | null>(null);
  const pickIndex = picking ? steps.findIndex((s, i) => stepKey(s, i) === picking.key) : -1;
  const pick: PickContext | null =
    picking && pickIndex >= 0
      ? { field: picking.field, step: pickIndex, scope: scopes[pickIndex], script: isScript(steps[pickIndex]) }
      : null;

  const earlier = useMemo(() => steps.map((_, i) => earlierWrites(steps, i)), [steps]);

  const fillFromTree = (value: string) => {
    if (!pick) return;
    const i = pick.step;
    const step = steps[i];
    // The mode follows what `writes` points at (see followMode).
    const kindOf = (s: Step) => writesKind(s, isNewField(sample, s.each, earlier[i], s.writes));
    const next =
      pick.field === 'input'
        ? withInput(step, value, elementIsScalar(sample, splitInput(value).each))
        : withWrites(step, value);
    replaceStep(i, followMode(step, next, kindOf));
    // Picked: leave pick mode (the field's blur ends it).
    (document.activeElement as HTMLElement | null)?.blur();
    setPicking(null);
  };

  /** "+" on a tree row: a step on that field, processor by the value's type. */
  const addStepOn = (node: TreeNode) => {
    const at = placeOf(node);
    const type = node.change?.kind === 'added' ? typeof node.change.after : typeof node.value;
    const use = type === 'number' ? 'scale@1' : type === 'string' ? 'clean_text@1' : null;
    const info = use ? builtins.find((b) => b.use === use) : undefined;
    addStep(info ? newBuiltinStep(info, steps, at) : newScriptStep(steps, at), null);
  };

  /* ---- validation: 400 ms debounce -> /validate ---- */

  const [remote, setRemote] = useState<Remote | null>(null);
  const hasProblems = problems.size > 0;
  // What the sample says about each step's paths: shown, never a reason to refuse a save.
  const pathProblems = useMemo(
    () => steps.map((s, i) => samplePathProblems(steps, i, sample, isScript(s))),
    [steps, sample],
  );
  useEffect(() => {
    if (!token || steps.length === 0 || !chain.enabled || hasProblems) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setRemote({ key: chainKey, status: 'checking' });
      try {
        const res = await responseProcessing.validate(JSON.parse(chainKey), token);
        if (cancelled) return;
        setRemote(
          res.valid
            ? { key: chainKey, status: 'ok' }
            : { key: chainKey, status: 'invalid', problem: res.problem },
        );
      } catch {
        if (!cancelled) setRemote({ key: chainKey, status: 'unavailable' });
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [chainKey, token, steps.length, chain.enabled, hasProblems]);

  const currentRemote = remote && remote.key === chainKey ? remote : null;
  const serverProblem = currentRemote?.status === 'invalid' ? currentRemote.problem : undefined;
  const serverStepId = problemStepId(serverProblem);

  /* ---- preview ---- */

  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const currentPreview = preview && preview.key === chainKey ? preview : null;
  const pastedValue = pasted?.value;

  const runPreview = useCallback(async () => {
    if (!token || previewing) return;
    const key = chainKey;
    if (!toolId) {
      setPreview({ key, kind: 'nosample' });
      return;
    }
    setPreviewing(true);
    try {
      const res = await responseProcessing.preview(
        toolId,
        {
          chain: { ...JSON.parse(key), enabled: true },
          ...(pastedValue !== undefined ? { sample: pastedValue } : {}),
        },
        token,
      );
      setPreview(
        !res.ok && res.error === 'no sample'
          ? { key, kind: 'nosample' }
          : { key, kind: 'result', data: res },
      );
    } catch (err) {
      if (err instanceof ApiError && err.body?.error === 'no sample') {
        setPreview({ key, kind: 'nosample' });
      } else if (err instanceof ApiError && err.status === 404) {
        setPreview({ key, kind: 'unavailable' });
      } else {
        setPreview({ key, kind: 'error', message: err instanceof Error ? err.message : 'preview failed' });
      }
    } finally {
      setPreviewing(false);
      // A preview may follow a fresh call; pick up the newest recorded response.
      if (pastedValue === undefined) setSampleRefresh((n) => n + 1);
    }
  }, [token, previewing, chainKey, toolId, pastedValue]);

  const focusStep = (id: string) => {
    const i = steps.findIndex((s) => s.id === id);
    if (i < 0) return;
    if (collapsed.has(id)) {
      const next = new Set(collapsed);
      next.delete(id);
      updateCollapsed(next);
    }
    const row = rootRef.current?.querySelector<HTMLElement>(`[data-testid="rp-step-${i}"]`);
    row?.scrollIntoView({ block: 'nearest' });
    rootRef.current?.querySelector<HTMLElement>(`[data-testid="rp-step-${i}-id"]`)?.focus({ preventScroll: true });
  };

  /* ---- Run (records the response as the sample) ---- */

  const runTool = useCallback(
    async (args: Record<string, unknown>): Promise<string | null> => {
      if (!token || !connectorId || !toolId) return 'no tool';
      try {
        const res = await toolsApi.test(connectorId, toolId, args, token, undefined, { recordSample: true });
        if (!res.ok) return res.error ?? res.kind ?? 'failed';
        setPasted(null);
        setSampleRefresh((n) => n + 1);
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : 'failed';
      }
    },
    [token, connectorId, toolId],
  );

  /* ---- keyboard ---- */

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && steps.length > 0) {
      e.preventDefault();
      void runPreview();
      return;
    }
    if (e.key === 'Escape' && preview) {
      e.preventDefault();
      e.stopPropagation();
      setPreview(null);
      return;
    }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const target = e.target as HTMLElement;
      const row = target.closest<HTMLElement>('[data-step-index]');
      if (!row) return;
      e.preventDefault();
      const i = Number(row.dataset.stepIndex);
      const suffix = (target.dataset.testid ?? '').replace(`rp-step-${i}-`, '') || 'id';
      moveStep(i, e.key === 'ArrowUp' ? -1 : 1, suffix);
    }
  };

  /* ---- status ---- */

  const status = ((): ChainStatus | null => {
    if (!chain.enabled || steps.length === 0) return null;
    if (hasProblems) {
      const [i, list] = [...problems][0];
      return { tone: 'error', text: steps[i].id.trim() || `#${i + 1}`, detail: list.map((p) => p.code).join(' · ') };
    }
    const danger = pathProblems.findIndex((list) => list.some((p) => p.tone === 'danger'));
    if (danger >= 0)
      return {
        tone: 'error',
        text: steps[danger].id.trim() || `#${danger + 1}`,
        detail: pathProblems[danger].filter((p) => p.tone === 'danger').map((p) => `${p.field} ${p.code}`).join(' · '),
      };
    if (currentRemote?.status === 'ok')
      return { tone: 'ok', text: `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}` };
    if (currentRemote?.status === 'invalid')
      return { tone: 'error', text: serverStepId ?? currentRemote.problem, detail: currentRemote.problem };
    if (currentRemote?.status === 'unavailable' || !token) return { tone: 'neutral', text: '—' };
    return { tone: 'neutral', text: '…' };
  })();

  /* ---- report to the summary and the sheet header ---- */

  const issues = steps.map((s, i): string | null => {
    const local = problems.get(i)?.[0];
    if (local) return local.field;
    const path = pathProblems[i]?.find((p) => p.tone === 'danger');
    if (path) return path.field;
    if (isScript(s) && checkSyntax(s.code ?? '').state === 'error') return 'code';
    if (serverStepId && s.id === serverStepId) {
      const field = /^step\s+\S+?:\s*(each|reads|writes|code|use|params|id)\b/.exec(serverProblem ?? '');
      // `each` and `reads` are one field in the editor: the Input.
      return field ? (field[1] === 'each' || field[1] === 'reads' ? 'input' : field[1]) : '';
    }
    return null;
  });
  const summaryKey = JSON.stringify({ status, issues, previewing });
  useEffect(() => {
    onSummary?.(JSON.parse(summaryKey) as ProcessingSummaryInfo);
  }, [summaryKey, onSummary]);

  /* ---- requests from the sheet: land on a step, run a preview ---- */

  const handled = useRef(0);
  const runPreviewRef = useRef(runPreview);
  useEffect(() => {
    runPreviewRef.current = runPreview;
  }, [runPreview]);
  useEffect(() => {
    if (!request || request.nonce === handled.current) return;
    handled.current = request.nonce;
    if (request.preview) void runPreviewRef.current();
    if (request.stepId === undefined) return;
    const i = steps.findIndex((s) => s.id === request.stepId);
    if (i < 0) return;
    const id = steps[i].id;
    if (collapsed.has(id)) {
      const next = new Set(collapsed);
      next.delete(id);
      setCollapsed(next);
      saveCollapsed(toolId, next);
    }
    const root = rootRef.current;
    // After the expansion has rendered.
    requestAnimationFrame(() => {
      root?.querySelector<HTMLElement>(`[data-testid="rp-step-${i}"]`)?.scrollIntoView({ block: 'start' });
      root
        ?.querySelector<HTMLElement>(`[data-testid="rp-step-${i}-${request.focus === 'reads' ? 'input' : request.focus ?? 'id'}"]`)
        ?.focus({ preventScroll: true });
    });
  }, [request, steps, collapsed, toolId]);

  const empty = steps.length === 0;

  /* ---- preview rows (rendered in the tree) ---- */

  const previewSlot = currentPreview && (
    <PreviewRows
      preview={currentPreview}
      steps={steps}
      onClose={() => setPreview(null)}
      onFocusStep={focusStep}
    />
  );

  const undoButton = undo && (
    <button type="button" data-testid="rp-undo" onClick={undoDelete} className={`${BTN_GHOST} self-start`}>
      <Icon as={Undo2} />
      Undo
    </button>
  );

  // Layout bands by the width of the sheet body (`@container/rp`, set by the sheet):
  // two columns from 1100px; below, one column with the tree under the steps.
  return (
    <section
      ref={rootRef}
      role="group"
      aria-label="Response Processing"
      data-testid="rp-root"
      onKeyDown={onKeyDown}
      className={`text-sm [&_*:focus-visible]:outline-none! ${
        empty
          ? 'flex flex-col gap-3'
          : 'grid grid-cols-1 gap-x-8 gap-y-4 @min-[1100px]/rp:grid-cols-[minmax(0,1fr)_minmax(400px,460px)]'
      }`}
    >
      {/* steps (no column at all while there are none) */}
      {!empty && (
        <div className="flex min-w-0 flex-col gap-3">
          {steps.map((step, i) => (
            <ResponseProcessingStepRow
              key={stepKey(step, i)}
              step={step}
              index={i}
              count={steps.length}
              builtins={builtins}
              problems={problems.get(i) ?? []}
              pathProblems={pathProblems[i] ?? []}
              earlier={earlier[i] ?? []}
              flagged={!!serverStepId && step.id === serverStepId}
              flaggedDetail={serverStepId && step.id === serverStepId ? serverProblem : undefined}
              sample={sample}
              lengths={lengths}
              tree={tree}
              scope={scopes[i]}
              collapsed={collapsed.has(step.id)}
              onToggle={(all) => toggleStep(i, all)}
              picking={picking && picking.key === stepKey(step, i) ? picking.field : null}
              onPick={(field) =>
                setPicking((cur) =>
                  field
                    ? { key: stepKey(step, i), field }
                    : cur && cur.key === stepKey(step, i)
                      ? null
                      : cur,
                )
              }
              onReplace={(next) => replaceStep(i, next)}
              onDuplicate={() => duplicateStep(i)}
              onMove={(d) => moveStep(i, d)}
              onDelete={() => deleteStep(i)}
            />
          ))}
          {undoButton}
        </div>
      )}
      {empty && undoButton}

      {/* response tree */}
      <ResponseTree
        className={empty ? '' : '@min-[1100px]/rp:sticky @min-[1100px]/rp:top-2'}
        compact={empty}
        sample={sample}
        source={source}
        lengths={lengths}
        steps={steps}
        result={currentPreview?.kind === 'result' && currentPreview.data.ok ? currentPreview.data.result : undefined}
        pick={pick}
        onPick={fillFromTree}
        onAddStep={addStepOn}
        previewSlot={previewSlot}
        onRun={connectorId && toolId ? runTool : undefined}
        runParams={toolParams}
        runDefaults={recorded.input}
        onPaste={(value) => setPasted({ value })}
      />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Preview rows (in the tree, under its header)                       */
/* ------------------------------------------------------------------ */

function PreviewRows({
  preview,
  steps,
  onClose,
  onFocusStep,
}: {
  preview: PreviewState;
  steps: Step[];
  onClose: () => void;
  onFocusStep: (id: string) => void;
}) {
  if (preview.kind === 'nosample' || preview.kind === 'unavailable' || preview.kind === 'error') {
    const text = preview.kind === 'error' ? preview.message : preview.kind === 'nosample' ? 'no sample' : '—';
    return (
      <div className="mb-2 flex items-center gap-2 px-2 leading-none">
        <span data-testid="rp-preview-error" className={`${ROW} min-w-0 gap-1.5 font-mono text-sm ${TONE_TEXT.danger}`}>
          <Icon as={X} />
          <span className="truncate">{text}</span>
        </span>
        <CloseButton onClose={onClose} />
      </div>
    );
  }
  const { data } = preview;
  const reports = data.steps ?? [];
  const failure = !data.ok ? splitFailure(data.error, data.failedStep, data.failedPath) : null;
  const number = (id: string) => {
    const i = steps.findIndex((s) => s.id === id);
    return i < 0 ? '··' : String(i + 1).padStart(2, '0');
  };
  return (
    <div data-testid="rp-preview-result" className="mb-3 flex flex-col gap-0.5 rounded-md bg-[var(--surface)] p-1.5">
      {reports.map((r, i) => (
        <button
          key={`${r.id}-${i}`}
          type="button"
          data-testid={`rp-preview-step-${r.id}`}
          onClick={() => onFocusStep(r.id)}
          className={`${ROW} h-[30px] gap-3 rounded-[4px] px-2 text-left font-mono text-sm hover:bg-[var(--surface-2)]`}
        >
          <span className="w-[22px] text-[var(--text-3)]">{number(r.id)}</span>
          <span className="min-w-0 flex-1 truncate text-[var(--text)]">{r.id}</span>
          <span className={`${ROW} gap-1.5 text-[var(--text-2)]`} title="wrote">
            <Icon as={PenLine} className="text-[var(--text-3)]" />
            {r.wrote}
          </span>
          {r.skipped > 0 && (
            <span className={`${ROW} gap-1.5 ${TONE_TEXT.warn}`} title="skipped">
              <Icon as={SkipForward} />
              {r.skipped}
            </span>
          )}
          <span className={`${ROW} gap-1.5 text-[var(--text-3)]`} title="size">
            <Icon as={HardDrive} />
            {formatBytes(r.bytes)}
          </span>
        </button>
      ))}
      {failure && (
        <button
          type="button"
          data-testid={`rp-preview-step-${failure.step}`}
          onClick={() => onFocusStep(failure.step)}
          className={`${ROW} min-h-[30px] gap-3 rounded-[4px] bg-[var(--t-danger-bg)] px-2 py-1.5 text-left font-mono text-sm ${TONE_TEXT.danger}`}
        >
          <span className="w-[22px]">{number(failure.step)}</span>
          <span data-testid="rp-preview-error" className={`${ROW} min-w-0 flex-1 flex-wrap gap-x-1.5 gap-y-1 leading-snug`}>
            <span className="font-medium">{failure.step}</span>
            {failure.path && (
              <>
                <span className="opacity-60">·</span>
                <span>{failure.path}</span>
              </>
            )}
            <span className="opacity-60">·</span>
            <span>{failure.reason}</span>
          </span>
        </button>
      )}
      <div className="flex justify-end">
        <CloseButton onClose={onClose} />
      </div>
    </div>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      aria-label="close preview"
      data-testid="rp-preview-close"
      onClick={onClose}
      className={`${BTN_GHOST} ml-auto h-7 text-[var(--text-3)]`}
    >
      <Icon as={X} />
      <Kbd className="text-sm">esc</Kbd>
    </button>
  );
}
