'use client';

import { useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Ban,
  Braces,
  ChevronDown,
  CircleDot,
  Circle,
  Code,
  Copy,
  GripVertical,
  MoreHorizontal,
  Sigma,
  SkipForward,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { AppSelect } from '@/components/ui/select';
import { ActionMenu } from '@/components/ui/action-menu';
import { Icon } from './icon';
import { CodeField, SyntaxMark } from './code-field';
import { PathField, chWidth, pickerCanShow, type PathProblem } from './path-picker';
import {
  CELL,
  CONTENT,
  GROUP_LABEL,
  ITEM,
  NO_SPIN,
  TEXT_BUTTON,
  TONE_TEXT,
  TRIGGER,
  type FieldTone,
} from './response-processing-styles';
import {
  FALLBACK_BUILTINS,
  MODES,
  SCRIPT_USE,
  defaultParams,
  type BuiltinInfo,
  type ProblemField,
  type ResponseProcessingMode,
  type ResponseProcessingParam,
  type ResponseProcessingUse,
  type Step,
  type StepProblem,
} from './response-processing-model';

const CHEVRON = <Icon as={ChevronDown} className="text-[var(--text-3)]" />;

/** Trigger label: the short built-in name (`Scale`, `VAT`), the full title lives in the list. */
function shortTitle(use: string, info: BuiltinInfo | undefined): string {
  const known = FALLBACK_BUILTINS.find((b) => b.use === use);
  if (known) return known.title;
  return info && info.title.length <= 14 ? info.title : use.replace(/@.*$/, '');
}

/* ------------------------------------------------------------------ */
/*  JSON one-liner (object / any params, script params)                */
/* ------------------------------------------------------------------ */

function format(value: unknown): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function parseJson(text: string, kind: 'object' | 'any'): { ok: true; value: unknown } | { ok: false } {
  if (!text.trim()) return { ok: true, value: undefined };
  try {
    const value = JSON.parse(text);
    if (kind === 'object' && (value === null || typeof value !== 'object' || Array.isArray(value)))
      return { ok: false };
    return { ok: true, value };
  } catch {
    return kind === 'any' ? { ok: true, value: text } : { ok: false };
  }
}

function JsonInput({
  value,
  kind,
  onCommit,
  ariaLabel,
  testId,
  placeholder,
  autoFocus,
  minCh = 4,
}: {
  value: unknown;
  kind: 'object' | 'any';
  onCommit: (value: unknown) => void;
  ariaLabel: string;
  testId?: string;
  placeholder?: string;
  autoFocus?: boolean;
  minCh?: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? format(value);
  const invalid = draft !== null && !parseJson(draft, kind).ok;
  return (
    <span className="inline-flex items-center gap-1.5">
      <input
        type="text"
        value={text}
        spellCheck={false}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        data-testid={testId}
        placeholder={placeholder}
        onChange={(e) => {
          setDraft(e.target.value);
          const parsed = parseJson(e.target.value, kind);
          if (parsed.ok) onCommit(parsed.value);
        }}
        onBlur={() => setDraft(null)}
        style={chWidth(text, placeholder, minCh)}
        className={`${CELL} max-w-[480px]`}
      />
      {invalid && <Icon as={X} className={TONE_TEXT.danger} />}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Typed built-in param input                                         */
/* ------------------------------------------------------------------ */

function ParamInput({
  param,
  value,
  onChange,
  label,
  invalid,
  testId,
}: {
  param: ResponseProcessingParam;
  value: unknown;
  onChange: (value: unknown) => void;
  label: string;
  invalid: boolean;
  testId: string;
}) {
  const weight = invalid ? 'border-[var(--t-danger-fg)]!' : '';
  switch (param.type) {
    case 'number':
    case 'integer': {
      const text = typeof value === 'number' ? String(value) : '';
      return (
        <input
          type="number"
          value={text}
          min={param.min}
          max={param.max}
          step={param.type === 'integer' ? 1 : 'any'}
          aria-label={label}
          aria-required={param.required || undefined}
          data-testid={testId}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          style={chWidth(text, '', 2)}
          className={`${CELL} ${NO_SPIN} ${weight}`}
        />
      );
    }
    case 'boolean':
      return (
        <AppSelect
          aria-label={label}
          testId={testId}
          value={value === true ? 'true' : 'false'}
          onValueChange={(v) => onChange(v === 'true')}
          options={[
            { value: 'true', label: 'true', icon: <Icon as={CircleDot} /> },
            { value: 'false', label: 'false', icon: <Icon as={Circle} /> },
          ]}
          className={`${TRIGGER} font-mono`}
          chevron={CHEVRON}
          contentClassName={CONTENT}
          itemClassName={`${ITEM} font-mono`}
        />
      );
    case 'string': {
      const text = typeof value === 'string' ? value : '';
      return (
        <input
          type="text"
          value={text}
          aria-label={label}
          aria-required={param.required || undefined}
          data-testid={testId}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          style={chWidth(text, '', 2)}
          className={`${CELL} ${weight}`}
        />
      );
    }
    default:
      return (
        <JsonInput
          value={value}
          kind={param.type === 'object' ? 'object' : 'any'}
          onCommit={onChange}
          ariaLabel={label}
          testId={testId}
          placeholder="{}"
        />
      );
  }
}

/* ------------------------------------------------------------------ */
/*  Row                                                                */
/* ------------------------------------------------------------------ */

/**
 * Line 1 as a fixed grid: index · grip · id · processor · each · reads · → · writes ·
 * mode · (skip) · menu. Long values truncate (the full path is the title).
 */
const LINE1 =
  'grid grid-cols-[28px_14px_fit-content(180px)_minmax(0,max-content)_minmax(0,max-content)_minmax(0,max-content)_14px_minmax(0,max-content)_minmax(0,max-content)_1fr_28px] items-center gap-x-1.5';

interface Props {
  step: Step;
  index: number;
  count: number;
  builtins: BuiltinInfo[];
  problems: StepProblem[];
  /** What the recorded sample says about the step's paths. */
  pathProblems: PathProblem[];
  /** Keys earlier steps write on the same elements (offered by the reads and writes pickers). */
  earlier: { key: string; step: number }[];
  /** Offending step according to the server; detail is its sentence. */
  flagged: boolean;
  flaggedDetail?: string;
  /** Most recent recorded response, for the path pickers; undefined without one. */
  sample: unknown;
  onReplace: (next: Step) => void;
  onDuplicate: () => void;
  onMove: (delta: -1 | 1) => void;
  onDelete: () => void;
}

export function ResponseProcessingStepRow({
  step,
  index,
  count,
  builtins,
  problems,
  pathProblems,
  earlier,
  flagged,
  flaggedDetail,
  sample,
  onReplace,
  onDuplicate,
  onMove,
  onDelete,
}: Props) {
  const n = index + 1;
  const tid = (suffix: string) => `rp-step-${index}-${suffix}`;
  const isScript = step.use === SCRIPT_USE;
  const info = builtins.find((b) => b.use === step.use);
  const bad = (f: ProblemField) => problems.some((p) => p.field === f);
  const toneOf = (f: 'each' | 'reads' | 'writes'): FieldTone | undefined =>
    (f !== 'each' && bad(f)) || pathProblems.some((p) => p.field === f && p.tone === 'danger')
      ? 'danger'
      : pathProblems.some((p) => p.field === f && p.tone === 'warn')
        ? 'warn'
        : undefined;
  const codes: { text: string; tone: FieldTone }[] = [
    ...problems.map((p) => ({ text: p.code, tone: 'danger' as const })),
    ...(flaggedDetail ? [{ text: flaggedDetail, tone: 'danger' as const }] : []),
    ...pathProblems.map((p) => ({ text: p.code, tone: p.tone })),
  ];
  const marked = problems.length > 0 || flagged || pathProblems.some((p) => p.tone === 'danger');
  const [paramsOpen, setParamsOpen] = useState(false);

  // Raw paths: on when the user asks, or when a stored path is one the picker cannot write.
  const [advancedChoice, setAdvanced] = useState<boolean | null>(null);
  const representable =
    pickerCanShow('each', step.each) && pickerCanShow('reads', step.reads) && pickerCanShow('writes', step.writes);
  const advanced = advancedChoice ?? !representable;

  const patch = (p: Partial<Step>) => onReplace({ ...step, ...p });
  const setParam = (name: string, value: unknown) => {
    const params = { ...(step.params ?? {}) };
    if (value === undefined) delete params[name];
    else params[name] = value;
    patch({ params: Object.keys(params).length ? params : undefined });
  };

  const changeUse = (use: ResponseProcessingUse) => {
    if (use === step.use) return;
    const { code: _code, ...rest } = step;
    if (use === SCRIPT_USE) {
      onReplace({ ...rest, use, code: step.code ?? '', params: undefined });
    } else {
      const target = builtins.find((b) => b.use === use);
      onReplace({ ...rest, use, params: target ? defaultParams(target) : undefined });
    }
  };

  const builtinOptions = builtins.map((b) => ({
    value: b.use,
    label: b.title,
    icon: <Icon as={Sigma} />,
  }));
  if (!isScript && !info) builtinOptions.push({ value: step.use, label: step.use, icon: <Icon as={Sigma} /> });

  const scriptParams = step.params && Object.keys(step.params).length > 0;
  const showScriptParams = isScript && (scriptParams || paramsOpen);
  const pathProps = useMemo(() => ({ sample, earlier }), [sample, earlier]);

  return (
    <div
      role="group"
      aria-label={`step ${n}`}
      data-testid={`rp-step-${index}`}
      data-step-index={index}
      data-invalid={marked || undefined}
      className="group/row space-y-1 px-1.5 py-1.5 hover:bg-[var(--surface-2)] focus-within:bg-[var(--surface-2)] data-[invalid]:bg-[var(--t-danger-bg)]"
    >
      {/* line 1 */}
      <div className={LINE1}>
        <span
          className={`flex h-6 items-center font-mono text-[12px] tabular-nums ${
            marked ? `font-medium ${TONE_TEXT.danger}` : 'text-[var(--text-3)]'
          }`}
          title={codes.length ? codes.map((c) => c.text).join(' · ') : undefined}
        >
          {String(n).padStart(2, '0')}
        </span>
        <Icon as={GripVertical} className="text-[var(--text-3)]" />
        <input
          type="text"
          value={step.id}
          spellCheck={false}
          placeholder="id"
          aria-label={`step ${n} id`}
          aria-invalid={bad('id') || undefined}
          data-testid={tid('id')}
          title={step.id || undefined}
          onChange={(e) => patch({ id: e.target.value })}
          style={chWidth(step.id, 'id', 8)}
          className={`${CELL} min-w-[120px] max-w-[180px] truncate text-[13px] font-medium`}
        />

        <AppSelect
          aria-label={`step ${n} use`}
          testId={tid('use')}
          value={step.use}
          onValueChange={(v) => changeUse(v as ResponseProcessingUse)}
          valueLabel={
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Icon as={isScript ? Code : Sigma} />
              <span className="truncate">{isScript ? 'Script' : shortTitle(step.use, info)}</span>
            </span>
          }
          groups={[
            { label: 'Built-in', options: builtinOptions },
            {
              label: 'Script',
              options: [{ value: SCRIPT_USE, label: 'Script', icon: <Icon as={Code} /> }],
            },
          ]}
          className={TRIGGER}
          chevron={CHEVRON}
          contentClassName={CONTENT}
          itemClassName={ITEM}
          groupLabelClassName={GROUP_LABEL}
        />

        <PathField
          advanced={advanced}
          mode="each"
          value={step.each ?? ''}
          onChange={(v) => patch({ each: v.trim() || undefined })}
          {...pathProps}
          prefix="on"
          placeholder="any"
          ariaLabel={`step ${n} each`}
          testId={tid('each')}
          tone={toneOf('each')}
        />
        <PathField
          advanced={advanced}
          mode="reads"
          value={step.reads}
          onChange={(v) => patch({ reads: v })}
          {...pathProps}
          each={step.each}
          allowWhole={isScript}
          placeholder="reads"
          ariaLabel={`step ${n} reads`}
          testId={tid('reads')}
          tone={toneOf('reads')}
        />
        <Icon as={ArrowRight} className="text-[var(--text-3)]" />
        <PathField
          advanced={advanced}
          mode="writes"
          value={step.writes}
          onChange={(v) => patch({ writes: v })}
          {...pathProps}
          each={step.each}
          allowWhole={isScript}
          placeholder="writes"
          ariaLabel={`step ${n} writes`}
          testId={tid('writes')}
          tone={toneOf('writes')}
        />

        <AppSelect
          aria-label={`step ${n} mode`}
          testId={tid('mode')}
          value={step.mode}
          onValueChange={(v) => patch({ mode: v as ResponseProcessingMode })}
          options={MODES.map((m) => ({ value: m, label: m, testId: `${tid('mode')}-${m}` }))}
          className={TRIGGER}
          chevron={CHEVRON}
          contentClassName={CONTENT}
          itemClassName={ITEM}
        />

        <span className="flex min-w-0 justify-end">
          {step.onMissing === 'skip' && (
            <span className={`inline-flex items-center gap-1.5 text-[12.5px] ${TONE_TEXT.warn}`} data-testid={tid('skip')}>
              <Icon as={SkipForward} />
              skip
            </span>
          )}
        </span>
        <ActionMenu
          variant="flat"
          label={`step ${n} menu`}
          testId={tid('menu')}
          trigger={<Icon as={MoreHorizontal} />}
          className="justify-self-end text-[var(--text-2)]"
          groups={[
            {
              items: [
                { label: 'Duplicate', icon: <Icon as={Copy} />, onSelect: onDuplicate, testId: tid('menu-duplicate') },
                {
                  label: 'Move up',
                  icon: <Icon as={ArrowUp} />,
                  onSelect: () => onMove(-1),
                  disabled: index === 0,
                  testId: tid('menu-up'),
                },
                {
                  label: 'Move down',
                  icon: <Icon as={ArrowDown} />,
                  onSelect: () => onMove(1),
                  disabled: index === count - 1,
                  testId: tid('menu-down'),
                },
                {
                  label: 'Advanced paths',
                  icon: <Icon as={SquareTerminal} />,
                  checked: advanced,
                  onSelect: () => setAdvanced(!advanced),
                  testId: tid('advanced'),
                },
              ],
            },
            {
              label: 'On missing',
              items: [
                {
                  label: 'fail',
                  icon: <Icon as={Ban} />,
                  tone: 'danger',
                  checked: step.onMissing !== 'skip',
                  onSelect: () => patch({ onMissing: undefined }),
                  testId: tid('menu-fail'),
                },
                {
                  label: 'skip',
                  icon: <Icon as={SkipForward} />,
                  tone: 'warn',
                  checked: step.onMissing === 'skip',
                  onSelect: () => patch({ onMissing: 'skip' }),
                  testId: tid('menu-skip'),
                },
              ],
            },
            {
              items: [
                {
                  label: 'Delete',
                  icon: <Icon as={Trash2} />,
                  destructive: true,
                  onSelect: onDelete,
                  testId: tid('menu-delete'),
                },
              ],
            },
          ]}
        />
      </div>

      {/* line 2 */}
      <div className="pl-[54px]">
        {isScript ? (
          <div>
            <CodeField
              value={step.code ?? ''}
              onChange={(code) => patch({ code })}
              ariaLabel={`step ${n} code`}
              testId={`rp-code-${index}`}
              invalid={bad('code')}
              sample={sample}
              each={step.each}
              reads={step.reads}
            />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <SyntaxMark code={step.code ?? ''} />
              {showScriptParams ? (
                <label className="inline-flex items-center gap-1.5">
                  <span className="font-mono text-[12px] text-[var(--text-2)]">params</span>
                  <JsonInput
                    value={step.params}
                    kind="object"
                    onCommit={(v) => patch({ params: v as Record<string, unknown> | undefined })}
                    ariaLabel={`step ${n} params`}
                    testId={tid('params')}
                    placeholder="{}"
                    autoFocus={paramsOpen && !scriptParams}
                  />
                </label>
              ) : (
                <button
                  type="button"
                  data-testid={tid('params-add')}
                  onClick={() => setParamsOpen(true)}
                  className={`${TEXT_BUTTON} text-[var(--text-2)]`}
                >
                  <Icon as={Braces} />
                  params
                </button>
              )}
              <Problems codes={codes} />
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {info && info.params.length > 0
              ? info.params.map((p) => (
                  <label key={p.name} className="inline-flex items-center gap-1">
                    <span className="font-mono text-[12px] text-[var(--text-2)]">{p.name}</span>
                    <ParamInput
                      param={p}
                      value={step.params?.[p.name]}
                      onChange={(v) => setParam(p.name, v)}
                      label={`step ${n} ${p.name}`}
                      invalid={flagged}
                      testId={tid(`param-${p.name}`)}
                    />
                  </label>
                ))
              : !info && (
                  <label className="inline-flex items-center gap-1">
                    <span className="font-mono text-[12px] text-[var(--text-2)]">params</span>
                    <JsonInput
                      value={step.params}
                      kind="object"
                      onCommit={(v) => patch({ params: v as Record<string, unknown> | undefined })}
                      ariaLabel={`step ${n} params`}
                      testId={tid('params')}
                      placeholder="{}"
                    />
                  </label>
                )}
            <Problems codes={codes} />
          </div>
        )}
      </div>
    </div>
  );
}

/** `✗ reads empty · ⚠ not in sample`: codes only, coloured by state. */
function Problems({ codes }: { codes: { text: string; tone: FieldTone }[] }) {
  if (codes.length === 0) return null;
  return (
    <span
      data-testid="rp-step-problems"
      className="ml-auto inline-flex min-w-0 items-center gap-1.5 font-mono text-[12px] font-medium"
    >
      {codes.map((c, i) => (
        <span key={`${i}-${c.text}`} className={`inline-flex min-w-0 items-center gap-1.5 ${TONE_TEXT[c.tone]}`}>
          {i > 0 && <span className="text-[var(--text-3)]">·</span>}
          {(i === 0 || c.tone !== codes[i - 1].tone) && <Icon as={c.tone === 'warn' ? TriangleAlert : X} />}
          <span className="truncate">{c.text}</span>
        </span>
      ))}
    </span>
  );
}
