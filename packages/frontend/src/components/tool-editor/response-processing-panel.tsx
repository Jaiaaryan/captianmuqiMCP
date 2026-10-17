'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import {
  ApiError,
  responseProcessing,
  type ResponseProcessingBuiltins,
  type ResponseProcessingPreview,
} from '@/lib/api';
import {
  ChevronDown,
  Circle,
  CircleDot,
  Code,
  Play,
  Plus,
  Sigma,
  Undo2,
  X,
} from 'lucide-react';
import { AppSelect } from '@/components/ui/select';
import { ActionMenu, type ActionMenuGroup } from '@/components/ui/action-menu';
import { Icon } from './icon';
import { Kbd } from './kbd';
import { StatusChip, type ChipTone } from './status-chip';
import { CONTENT, HEADER_TRIGGER, ITEM, TEXT_BUTTON, TONE_TEXT } from './response-processing-styles';
import { ResponseProcessingStepRow } from './response-processing-step-row';
import { earlierWrites, samplePathProblems } from './path-picker';
import {
  FALLBACK_BUILTINS,
  FALLBACK_MAX_CODE_BYTES,
  FALLBACK_MAX_STEPS,
  SCRIPT_USE,
  diffSamples,
  emptyResponseProcessing,
  formatBytes,
  localProblems,
  newBuiltinStep,
  newScriptStep,
  nextStepId,
  problemStepId,
  splitFailure,
  stepKey,
  toBuiltinInfo,
  withKey,
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
/*  Contract (built-ins + limits), fetched once per page load          */
/* ------------------------------------------------------------------ */

let contractPromise: Promise<ResponseProcessingBuiltins> | null = null;

function useContract(token: string | null): ResponseProcessingBuiltins | null {
  const [contract, setContract] = useState<ResponseProcessingBuiltins | null>(null);
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    contractPromise ??= responseProcessing.builtins(token);
    contractPromise
      .then((c) => {
        if (!cancelled) setContract(c);
      })
      .catch(() => {
        contractPromise = null;
      });
    return () => {
      cancelled = true;
    };
  }, [token]);
  return contract;
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
  /** Preview needs a saved tool; both are absent while creating a new one. */
  connectorId?: string;
  toolId?: string;
}

const MAX_DIFF_LINES = 8;


const CHEVRON = <Icon as={ChevronDown} className="text-[var(--text-3)]" />;

/* ------------------------------------------------------------------ */
/*  Recorded sample for the path pickers                               */
/* ------------------------------------------------------------------ */

/** The tool's latest recorded response (truncated server-side); undefined without one. */
function useSample(toolId: string | undefined, token: string | null, refresh: number): unknown {
  const [sample, setSample] = useState<{ key: string; value: unknown } | null>(null);
  const key = `${toolId ?? ''}:${refresh}`;
  useEffect(() => {
    if (!toolId || !token) return;
    let cancelled = false;
    responseProcessing
      .forTool(toolId, token)
      .then((r) => {
        if (!cancelled) setSample({ key, value: r.sample });
      })
      .catch(() => {
        if (!cancelled) setSample({ key, value: undefined });
      });
    return () => {
      cancelled = true;
    };
  }, [toolId, token, key]);
  // Keep the previous sample while a refresh is in flight.
  return toolId ? sample?.value : undefined;
}

/* ------------------------------------------------------------------ */
/*  Panel                                                              */
/* ------------------------------------------------------------------ */

export function ResponseProcessingPanel({ state, onChange, toolId }: Props) {
  const { token } = useAuth();
  const chain = state ?? emptyResponseProcessing();
  const { steps } = chain;
  const rootRef = useRef<HTMLElement>(null);

  const contract = useContract(token);
  const builtins = useMemo(
    () => (contract ? contract.builtins.map(toBuiltinInfo) : FALLBACK_BUILTINS),
    [contract],
  );
  const maxSteps = contract?.limits?.maxSteps ?? FALLBACK_MAX_STEPS;
  const maxCodeBytes = contract?.limits?.script?.maxCodeBytes ?? FALLBACK_MAX_CODE_BYTES;

  const [sampleRefresh, setSampleRefresh] = useState(0);
  const sample = useSample(toolId, token, sampleRefresh);

  const problems = useMemo(
    () => localProblems(chain, maxCodeBytes),
    [chain, maxCodeBytes],
  );
  const chainKey = useMemo(() => JSON.stringify(chain), [chain]);

  /* ---- editing ---- */

  const set = (next: Partial<ResponseProcessingChain>) => onChange({ ...chain, ...next });
  const setSteps = (next: Step[], extra: Partial<ResponseProcessingChain> = {}) =>
    onChange({ ...chain, ...extra, steps: next });

  const pendingFocus = useRef<{ key: string; suffix: string } | null>(null);
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    const i = steps.findIndex((s, idx) => stepKey(s, idx) === target.key);
    if (i < 0) return;
    rootRef.current
      ?.querySelector<HTMLElement>(`[data-testid="rp-step-${i}-${target.suffix}"]`)
      ?.focus();
  }, [steps]);

  const addStep = (step: Step) => {
    pendingFocus.current = { key: stepKey(step, steps.length), suffix: 'reads' };
    setSteps([...steps, step], steps.length === 0 ? { enabled: true } : {});
  };

  const replaceStep = (i: number, next: Step) =>
    setSteps(steps.map((s, idx) => (idx === i ? next : s)));

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

  /* ---- validation: 400 ms debounce -> /validate ---- */

  const [remote, setRemote] = useState<Remote | null>(null);
  const hasProblems = problems.size > 0;
  // What the recorded sample says about each step's paths: shown, never a reason to refuse a save.
  const pathProblems = useMemo(
    () => steps.map((s, i) => samplePathProblems(steps, i, sample, s.use === SCRIPT_USE)),
    [steps, sample],
  );
  const earlier = useMemo(() => steps.map((_, i) => earlierWrites(steps, i)), [steps]);
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
        { chain: { ...JSON.parse(key), enabled: true } },
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
        setPreview({
          key,
          kind: 'error',
          message: err instanceof Error ? err.message : 'preview failed',
        });
      }
    } finally {
      setPreviewing(false);
      // A preview may follow a fresh call; pick up the newest recorded response.
      setSampleRefresh((n) => n + 1);
    }
  }, [token, previewing, chainKey, toolId]);

  const focusStep = (id: string) => {
    const i = steps.findIndex((s) => s.id === id);
    if (i < 0) return;
    const row = rootRef.current?.querySelector<HTMLElement>(`[data-testid="rp-step-${i}"]`);
    row?.scrollIntoView({ block: 'nearest' });
    rootRef.current?.querySelector<HTMLElement>(`[data-testid="rp-step-${i}-id"]`)?.focus();
  };

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

  /* ---- status chip ---- */

  const chip = ((): { tone: ChipTone; text: string; detail?: string } | null => {
    if (currentPreview?.kind === 'nosample') return { tone: 'neutral', text: 'no sample' };
    if (currentPreview?.kind === 'unavailable') return { tone: 'neutral', text: '—' };
    if (!chain.enabled) return null;
    if (hasProblems) {
      const [i, list] = [...problems][0];
      return {
        tone: 'error',
        text: steps[i].id.trim() || `#${i + 1}`,
        detail: list.map((p) => p.code).join(' · '),
      };
    }
    for (const tone of ['danger', 'warn'] as const) {
      const i = pathProblems.findIndex((list) => list.some((p) => p.tone === tone));
      if (i >= 0)
        return {
          tone: tone === 'danger' ? 'error' : 'warn',
          text: `${steps[i].id.trim() || `#${i + 1}`} · ${pathProblems[i].filter((p) => p.tone === tone).map((p) => p.code).join(' · ')}`,
        };
    }
    if (currentRemote?.status === 'ok')
      return { tone: 'ok', text: `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}` };
    if (currentRemote?.status === 'invalid')
      return {
        tone: 'error',
        text: serverStepId ?? currentRemote.problem,
        detail: currentRemote.problem,
      };
    if (currentRemote?.status === 'unavailable' || !token) return { tone: 'neutral', text: '—' };
    return { tone: 'neutral', text: '…' };
  })();

  /* ---- menus ---- */

  const addGroups: ActionMenuGroup[] = [
    {
      label: 'Built-in',
      items: builtins.map((b) => ({
        label: b.title,
        icon: <Icon as={Sigma} />,
        testId: `rp-add-${b.use}`,
        onSelect: () => addStep(newBuiltinStep(b, steps)),
      })),
    },
    {
      label: 'Script',
      items: [
        {
          label: 'Script',
          icon: <Icon as={Code} />,
          testId: `rp-add-${SCRIPT_USE}`,
          onSelect: () => addStep(newScriptStep(steps)),
        },
      ],
    },
  ];

  const addMenu = (
    <ActionMenu
      variant="flat"
      align="start"
      label="add step"
      testId="rp-add-step"
      className="font-medium text-[var(--brand)] hover:text-[var(--brand)]"
      disabled={steps.length >= maxSteps}
      groups={addGroups}
      trigger={
        <>
          <Icon as={Plus} />
          Step
          {CHEVRON}
        </>
      }
    />
  );

  const toggle = (
    <AppSelect
      aria-label="Response Processing enabled"
      testId="rp-toggle"
      value={chain.enabled ? 'on' : 'off'}
      onValueChange={(v) => set({ enabled: v === 'on' })}
      options={[
        { value: 'on', label: 'On', icon: <Icon as={CircleDot} />, testId: 'rp-toggle-on', className: TONE_TEXT.success },
        { value: 'off', label: 'Off', icon: <Icon as={Circle} />, testId: 'rp-toggle-off', className: TONE_TEXT.muted },
      ]}
      className={`${HEADER_TRIGGER} ${chain.enabled ? `font-medium ${TONE_TEXT.success}` : TONE_TEXT.muted}`}
      chevron={CHEVRON}
      contentClassName={CONTENT}
      itemClassName={ITEM}
    />
  );

  const title = (
    <h4 className="text-[13px] font-medium text-[var(--text)]">Response Processing</h4>
  );

  /* ---- render ---- */

  const collapsed = steps.length === 0;

  return (
    <section
      ref={rootRef}
      role="group"
      aria-label="Response Processing"
      data-testid="rp-root"
      onKeyDown={onKeyDown}
      className="[&_*:focus-visible]:outline-none!"
    >
      {collapsed ? (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
          {title}
          {toggle}
          {addMenu}
          {undo && <UndoChip onUndo={undoDelete} />}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 pb-2">
            {title}
            {toggle}
            {chip && (
              <StatusChip testId="rp-status" tone={chip.tone} detail={chip.detail}>
                {chip.text}
              </StatusChip>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              <span className="text-[12.5px] text-[var(--text-2)]">On error</span>
              <AppSelect
                aria-label="On error"
                testId="rp-on-error"
                value={chain.onError}
                onValueChange={(v) => set({ onError: v as ResponseProcessingChain['onError'] })}
                options={[
                  { value: 'fail', label: 'Fail', testId: 'rp-on-error-fail', className: TONE_TEXT.danger },
                  {
                    value: 'passthrough',
                    label: 'Pass through',
                    testId: 'rp-on-error-passthrough',
                    className: TONE_TEXT.warn,
                  },
                ]}
                className={`${HEADER_TRIGGER} ${chain.onError === 'fail' ? TONE_TEXT.danger : TONE_TEXT.warn}`}
                chevron={CHEVRON}
                contentClassName={CONTENT}
                itemClassName={ITEM}
              />
            </div>
          </div>

          <div className={`space-y-px ${chain.enabled ? '' : 'text-[var(--text-3)]'}`}>
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
                onReplace={(next) => replaceStep(i, next)}
                onDuplicate={() => duplicateStep(i)}
                onMove={(d) => moveStep(i, d)}
                onDelete={() => deleteStep(i)}
              />
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 pt-2">
            {addMenu}
            <button
              type="button"
              data-testid="rp-preview"
              aria-keyshortcuts="Meta+Enter Control+Enter"
              aria-busy={previewing || undefined}
              disabled={!token || previewing}
              onClick={() => void runPreview()}
              className={TEXT_BUTTON}
            >
              <Icon as={Play} />
              Preview
              <Kbd>⌘↵</Kbd>
            </button>
            {undo && <UndoChip onUndo={undoDelete} />}
          </div>

          {currentPreview?.kind === 'result' && (
            <PreviewResult
              data={currentPreview.data}
              onClose={() => setPreview(null)}
              onFocusStep={focusStep}
            />
          )}
          {currentPreview?.kind === 'error' && (
            <p
              data-testid="rp-preview-error"
              className={`mt-2 inline-flex items-center gap-1.5 pt-2 font-mono text-[12px] font-medium ${TONE_TEXT.danger}`}
            >
              <Icon as={X} />
              {currentPreview.message}
            </p>
          )}
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Pieces                                                             */
/* ------------------------------------------------------------------ */

function UndoChip({ onUndo }: { onUndo: () => void }) {
  return (
    <button type="button" data-testid="rp-undo" onClick={onUndo} className={`${TEXT_BUTTON} font-medium`}>
      <Icon as={Undo2} />
      Undo
    </button>
  );
}

const COLS = 'grid grid-cols-[minmax(120px,max-content)_9ch_10ch_9ch] items-center gap-x-4';

function PreviewResult({
  data,
  onClose,
  onFocusStep,
}: {
  data: ResponseProcessingPreview;
  onClose: () => void;
  onFocusStep: (id: string) => void;
}) {
  const reports = data.steps ?? [];
  const failure = !data.ok
    ? splitFailure(data.error, data.failedStep, data.failedPath)
    : null;

  return (
    <div
      data-testid="rp-preview-result"
      className="mt-2 space-y-1 pt-2 font-mono text-[12px]"
    >
      <div className="flex items-center gap-3 px-1">
        <span className="text-[var(--text-3)]">{data.sampleSource ?? ''}</span>
        <button
          type="button"
          aria-label="close preview"
          data-testid="rp-preview-close"
          onClick={onClose}
          className={`${TEXT_BUTTON} ml-auto text-[var(--text-3)]`}
        >
          <Icon as={X} />
          <Kbd>esc</Kbd>
        </button>
      </div>

      {reports.map((r, i) => {
        const failed = failure?.step === r.id;
        const lines =
          r.sample === undefined ? [] : diffSamples(i === 0 ? undefined : reports[i - 1].sample, r.sample);
        const shown = lines.slice(0, MAX_DIFF_LINES);
        return (
          <div key={`${r.id}-${i}`} data-testid={`rp-preview-step-${r.id}`}>
            <button
              type="button"
              onClick={() => onFocusStep(r.id)}
              className={`${COLS} w-full px-1 py-0.5 text-left outline-none hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] ${
                failed ? `bg-[var(--t-danger-bg)] font-medium` : ''
              }`}
            >
              <span className={`inline-flex min-w-0 items-center gap-1.5 ${failed ? TONE_TEXT.danger : 'text-[var(--text)]'}`}>
                {failed && <Icon as={X} />}
                <span className="truncate">{r.id}</span>
              </span>
              <span>
                <span className="text-[var(--text-3)]">wrote </span>
                <span className="text-[var(--text)]">{r.wrote}</span>
              </span>
              <span>
                <span className="text-[var(--text-3)]">skipped </span>
                <span className="text-[var(--text)]">{r.skipped}</span>
              </span>
              <span className="text-[var(--text-2)]">{formatBytes(r.bytes)}</span>
            </button>
            {shown.length > 0 && (
              <ul className="space-y-px pl-6">
                {shown.map((l) => (
                  <li key={`${l.kind}-${l.path}`} data-diff={l.kind} className="truncate px-1">
                    {l.kind === 'added' && (
                      <span className={TONE_TEXT.success}>
                        {l.path}: {l.after}
                      </span>
                    )}
                    {l.kind === 'changed' && (
                      <span className="text-[var(--text)]">
                        {l.path}: <span className="text-[var(--text-3)]">{l.before}</span> → {l.after}
                      </span>
                    )}
                    {l.kind === 'removed' && (
                      <span className="text-[var(--text-3)] line-through">
                        {l.path}: {l.before}
                      </span>
                    )}
                    {l.kind === 'plain' && (
                      <span className="text-[var(--text-3)]">
                        {l.path}: {l.after}
                      </span>
                    )}
                  </li>
                ))}
                {lines.length > shown.length && (
                  <li className="px-1 text-[var(--text-3)]">+{lines.length - shown.length}</li>
                )}
              </ul>
            )}
          </div>
        );
      })}

      {failure && (
        <button
          type="button"
          data-testid="rp-preview-error"
          onClick={() => onFocusStep(failure.step)}
          className={`flex w-full items-center gap-1.5 px-1 py-0.5 text-left font-medium outline-none hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] ${TONE_TEXT.danger}`}
        >
          <Icon as={X} />
          <span>{failure.step}</span>
          {failure.path && (
            <>
              <span className="text-[var(--text-3)]">·</span>
              <span>{failure.path}</span>
            </>
          )}
          <span className="text-[var(--text-3)]">·</span>
          <span className="truncate">{failure.reason}</span>
        </button>
      )}
    </div>
  );
}
