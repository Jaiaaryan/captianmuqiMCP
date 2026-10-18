'use client';

import { useMemo, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  ArrowDown,
  ArrowUp,
  Ban,
  Braces,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Circle,
  Code,
  Copy,
  LogIn,
  LogOut,
  MoreHorizontal,
  Plus,
  SkipForward,
  Trash2,
  X,
} from 'lucide-react';
import { AppSelect } from '@/components/ui/select';
import { ActionMenu } from '@/components/ui/action-menu';
import { Icon } from './icon';
import { CodeField, checkSyntax } from './code-field';
import { CurrencyParams, currencySummary } from './currency-params';
import { PathInput, pathOptions } from './path-input';
import {
  elementIsScalar,
  inputOf,
  inputType,
  isNewField,
  pathSummary,
  relPath,
  type PathMode,
  type PathProblem,
} from './path-picker';
import type { Tree } from './response-tree';
import {
  GROUP_LABEL,
  MENU,
  MENU_ITEM,
  NO_SPIN,
  ROW,
  SELECT_FLAT,
  SELECT_MODE,
  MENU_TRIGGER,
  TONE_TEXT,
  VALUE_INPUT,
  chWidth,
  type FieldTone,
  ACTION_ITEM,
  ACTION_MENU,
} from './response-processing-styles';
import {
  builtinIcon,
  FALLBACK_BUILTINS,
  MODES,
  SCRIPT_USE,
  defaultParams,
  isScript as isScriptStep,
  paramsOf,
  usesOf,
  followMode,
  withInput,
  withPipe,
  withWrites,
  writesKind,
  writesTied,
  type BuiltinInfo,
  type ProblemField,
  type ResponseProcessingBuiltinUse,
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

/**
 * Plain keys stay in a param field (a menu around it must not typeahead on
 * them); chords (⌘↵ preview, ⌥↑↓ move) still reach the panel.
 */
function keepKeys(e: React.KeyboardEvent) {
  if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key !== 'Escape') e.stopPropagation();
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
}: {
  value: unknown;
  kind: 'object' | 'any';
  onCommit: (value: unknown) => void;
  ariaLabel: string;
  testId?: string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? format(value);
  const invalid = draft !== null && !parseJson(draft, kind).ok;
  return (
    <input
      type="text"
      value={text}
      spellCheck={false}
      autoFocus={autoFocus}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      data-testid={testId}
      placeholder={placeholder}
      onKeyDown={keepKeys}
      onChange={(e) => {
        setDraft(e.target.value);
        const parsed = parseJson(e.target.value, kind);
        if (parsed.ok) onCommit(parsed.value);
      }}
      onBlur={() => setDraft(null)}
      style={chWidth(text, placeholder, 4, 22)}
      className={`${VALUE_INPUT} max-w-[480px]`}
    />
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
          aria-invalid={invalid || (param.required && text === '') || undefined}
          data-testid={testId}
          onKeyDown={keepKeys}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          style={chWidth(text, '', 2, 22)}
          className={`${VALUE_INPUT} ${NO_SPIN}`}
        />
      );
    }
    case 'boolean':
      return (
        <AppSelect
          aria-label={label}
          testId={testId}
          value={value === false ? 'false' : value === true ? 'true' : String(param.default ?? false)}
          onValueChange={(v) => onChange(v === 'true')}
          options={[
            { value: 'true', label: 'true', icon: <Icon as={CircleDot} /> },
            { value: 'false', label: 'false', icon: <Icon as={Circle} /> },
          ]}
          className={`${VALUE_INPUT} ${ROW} gap-1.5`}
          chevron={CHEVRON}
          contentClassName={MENU}
          itemClassName={`${MENU_ITEM} font-mono`}
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
          aria-invalid={invalid || undefined}
          data-testid={testId}
          placeholder={typeof param.default === 'string' ? param.default : ''}
          onKeyDown={keepKeys}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          style={chWidth(text, typeof param.default === 'string' ? param.default : '', 2, 22)}
          className={VALUE_INPUT}
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

function ParamFields({
  info,
  params,
  onChange,
  labelPrefix,
  testPrefix,
  invalid,
}: {
  info: BuiltinInfo;
  params: Record<string, unknown> | undefined;
  onChange: (next: Record<string, unknown> | undefined) => void;
  labelPrefix: string;
  testPrefix: string;
  invalid: boolean;
}) {
  const set = (name: string, value: unknown) => {
    const next = { ...(params ?? {}) };
    if (value === undefined) delete next[name];
    else next[name] = value;
    onChange(Object.keys(next).length ? next : undefined);
  };
  return (
    <>
      {info.params.map((p) => (
        <label key={p.name} className={`${ROW} gap-2`}>
          <span className="text-sm text-[var(--text-3)]">{p.name}</span>
          <ParamInput
            param={p}
            value={params?.[p.name]}
            onChange={(v) => set(p.name, v)}
            label={`${labelPrefix} ${p.name}`}
            invalid={invalid}
            testId={`${testPrefix}-${p.name}`}
          />
        </label>
      ))}
    </>
  );
}

/** `0.92`, `2`: the param values of a pipe stage, in contract order. */
function paramSummary(info: BuiltinInfo | undefined, params: Record<string, unknown> | undefined): string {
  if (!params) return '';
  if (info?.use === 'currency@1') return currencySummary(params);
  const names = info ? info.params.map((p) => p.name) : Object.keys(params);
  return names
    .filter((n) => params[n] !== undefined)
    .map((n) => (typeof params[n] === 'string' ? String(params[n]) : JSON.stringify(params[n])))
    .join(' ');
}

/* ------------------------------------------------------------------ */
/*  The card                                                           */
/* ------------------------------------------------------------------ */

interface Props {
  step: Step;
  index: number;
  count: number;
  builtins: BuiltinInfo[];
  problems: StepProblem[];
  /** What the recorded sample says about the step's paths. */
  pathProblems: PathProblem[];
  /** Keys earlier steps write on the same elements. */
  earlier: { key: string; step: number }[];
  /** Offending step according to the server; detail is its sentence. */
  flagged: boolean;
  flaggedDetail?: string;
  /** Most recent sample (recorded or pasted); undefined without one. */
  sample: unknown;
  /** Uncut array lengths of the sample (`{'$.items': 30}`), for the Input's count. */
  lengths?: Record<string, number>;
  /** The sample's tree with the steps' writes, for completions. */
  tree: Tree;
  /** The step's scope in the tree. */
  scope: string;
  collapsed: boolean;
  onToggle: (all: boolean) => void;
  /** Which of this step's fields is being picked in the tree. */
  picking: PathMode | null;
  onPick: (field: PathMode | null) => void;
  onReplace: (next: Step) => void;
  onDuplicate: () => void;
  onMove: (delta: -1 | 1) => void;
  onDelete: () => void;
}

const FIELD_ICON = { input: LogIn, writes: LogOut } as const;
const FIELD_LABEL = { input: 'Input', writes: 'writes' } as const;

/*
 * Input / writes, by the width of the sheet body (`@container/rp`):
 *   >= 1100px  label | value rows, the type label and the note beside the value;
 *   481-1100px both fields side by side, label above value, the note under it;
 *   <= 480px   stacked: label, then value (the note beside it, wrapping).
 */
// Full class literals (Tailwind only sees whole tokens); `@min-[481px]/rp:@max-[1100px]/rp:` is the middle band.
const FIELDS_GRID = [
  'grid grid-cols-[92px_minmax(0,1fr)] items-center gap-x-4 gap-y-2',
  '@min-[481px]/rp:@max-[1100px]/rp:grid-cols-2 @min-[481px]/rp:@max-[1100px]/rp:items-start @min-[481px]/rp:@max-[1100px]/rp:gap-x-3',
  '@max-[481px]/rp:grid-cols-1 @max-[481px]/rp:gap-y-3',
].join(' ');
const FIELD_CELL = 'contents @max-[1100px]/rp:flex @max-[1100px]/rp:min-w-0 @max-[1100px]/rp:flex-col @max-[1100px]/rp:gap-1.5';
const FIELD_VALUE = [
  `${ROW} min-h-8 min-w-0 gap-2.5`,
  '@min-[481px]/rp:@max-[1100px]/rp:flex-col @min-[481px]/rp:@max-[1100px]/rp:items-start @min-[481px]/rp:@max-[1100px]/rp:gap-1.5',
  '@max-[481px]/rp:flex-wrap @max-[481px]/rp:gap-y-1.5',
].join(' ');

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
  lengths,
  tree,
  scope,
  collapsed,
  onToggle,
  picking,
  onPick,
  onReplace,
  onDuplicate,
  onMove,
  onDelete,
}: Props) {
  const n = index + 1;
  const tid = (suffix: string) => `rp-step-${index}-${suffix}`;
  const script = isScriptStep(step);
  const uses = usesOf(step);
  const pipe = Array.isArray(step.use);
  const info = builtins.find((b) => b.use === uses[0]);
  const bad = (f: ProblemField) => problems.some((p) => p.field === f);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [openStage, setOpenStage] = useState<number | null>(null);

  const toneOf = (f: PathMode): FieldTone | undefined =>
    (f === 'input' && bad('input')) || pathProblems.some((p) => p.field === f && p.tone === 'danger')
      ? 'danger'
      : pathProblems.some((p) => p.field === f && p.tone === 'warn')
        ? 'warn'
        : undefined;
  const codesOf = (f: PathMode) =>
    [...problems.filter((p) => p.field === f).map((p) => p.code), ...pathProblems.filter((p) => p.field === f).map((p) => p.code)].join(' · ') ||
    undefined;
  const syntaxBad = script && checkSyntax(step.code ?? '').state === 'error';
  const invalid =
    problems.length > 0 || flagged || pathProblems.some((p) => p.tone === 'danger') || syntaxBad;

  const patch = (p: Partial<Step>) => onReplace({ ...step, ...p });

  /* ---- paths ---- */

  const fresh = (w: string) => isNewField(sample, step.each, earlier, w);
  // The mode follows what `writes` points at (new field: add, existing or the Input: replace).
  const kindOf = (s: Step) => writesKind(s, isNewField(sample, s.each, earlier, s.writes));
  // What the Input text is while it is being typed (`items[*].` keeps its dot).
  const [inputDraft, setInputDraft] = useState<string | null>(null);
  const setInput = (text: string) => {
    setInputDraft(text);
    const next = withInput(step, text, elementIsScalar(sample, withInput(step, text).each));
    onReplace(followMode(step, next, kindOf));
  };
  const setWrites = (text: string) => onReplace(followMode(step, withWrites(step, text), kindOf));

  const options = useMemo(
    () => ({
      input: (t: string) => pathOptions(tree, 'input', scope, t, index),
      writes: (t: string) => pathOptions(tree, 'writes', scope, t, index),
    }),
    [tree, scope, index],
  );

  const input = inputOf(step.each, step.reads);
  const typeLabel = inputType(sample, step.each, step.reads, lengths);
  const tied = writesTied(step);
  // Elements that are scalars: nothing can be written under them, `writes` is the Input.
  const writesLocked = tied && elementIsScalar(sample, step.each);
  const notes = {
    input: '',
    writes: tied ? (step.reads.trim() ? '= input' : '') : fresh(step.writes) ? 'new field' : '',
  };

  const note = (field: PathMode, text: string) =>
    picking === field ? (
      <span className="whitespace-nowrap text-sm text-[var(--text-3)]">pick in response →</span>
    ) : text ? (
      <span
        data-testid={tid(`${field}-note`)}
        className={`whitespace-nowrap text-sm ${toneOf(field) === 'danger' ? TONE_TEXT.danger : 'text-[var(--text-3)]'}`}
        title={codesOf(field)}
      >
        {text}
      </span>
    ) : null;

  const pathField = (field: PathMode) => {
    const common = {
      picking: picking === field,
      onPickStart: () => onPick(field),
      onPickEnd: () => {
        if (field === 'input') setInputDraft(null);
        onPick(null);
      },
      options: options[field],
      ariaLabel: `step ${n} ${field}`,
      testId: tid(field),
      tone: toneOf(field),
      title: codesOf(field),
    };
    if (field === 'input')
      return (
        <>
          <PathInput
            {...common}
            value={inputDraft ?? input}
            stored={input}
            onChange={setInput}
            placeholder="pick a field"
          />
          {typeLabel && (
            <span data-testid={tid('input-type')} className="whitespace-nowrap font-mono text-sm text-[var(--t-info-fg)]">
              {typeLabel}
            </span>
          )}
        </>
      );
    if (writesLocked) return null;
    return (
      <PathInput
        {...common}
        value={tied ? relPath(step.reads) : step.writes}
        stored={step.writes || step.reads}
        onChange={setWrites}
        placeholder="= input"
        muted={tied}
      />
    );
  };

  /* ---- processor ---- */

  const changeUse = (use: ResponseProcessingUse) => {
    if (!pipe && use === step.use) return;
    const { code: _code, params: _params, ...rest } = step;
    if (use === SCRIPT_USE) {
      onReplace({ ...rest, use, code: step.code ?? 'return value;' });
    } else {
      const target = builtins.find((b) => b.use === use);
      const params = target ? defaultParams(target) : undefined;
      onReplace({ ...rest, use, ...(params ? { params } : {}) });
    }
  };

  const builtinOptions = builtins.map((b) => ({ value: b.use, label: b.title, icon: <Icon as={builtinIcon(b.use)} /> }));
  if (!script && !info) builtinOptions.push({ value: uses[0], label: uses[0], icon: <Icon as={builtinIcon(uses[0])} /> });

  /* ---- pipe ---- */

  const stages = uses as ResponseProcessingBuiltinUse[];
  const stageParams = stages.map((_, k) => paramsOf(step, k));
  const setStages = (nextUses: ResponseProcessingBuiltinUse[], nextParams: (Record<string, unknown> | undefined)[]) =>
    onReplace(withPipe(step, nextUses, nextParams));
  const appendStage = (use: ResponseProcessingBuiltinUse) => {
    const target = builtins.find((b) => b.use === use);
    setStages([...stages, use], [...stageParams, target ? defaultParams(target) : undefined]);
  };
  const addStageMenu = (
    <ActionMenu
      contentClassName={ACTION_MENU}
      itemClassName={ACTION_ITEM}
      variant="flat"
      align="start"
      label="add to pipe"
      testId={`rp-pipe-${index}-add`}
      className={`${ROW} h-8 rounded-md px-2.5 text-[var(--text-3)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]`}
      trigger={<Icon as={Plus} />}
      groups={[
        {
          items: builtins.map((b) => ({
            label: b.title,
            icon: <Icon as={builtinIcon(b.use)} />,
            testId: `rp-pipe-${index}-add-${b.use}`,
            onSelect: () => appendStage(b.use as ResponseProcessingBuiltinUse),
          })),
        },
      ]}
    />
  );

  const summary = (
    <span
      data-testid={tid('summary')}
      className="ml-1 hidden min-w-0 flex-1 basis-0 truncate font-mono text-sm leading-none text-[var(--text-2)] @min-[640px]/rp:inline"
    >
      {pathSummary(step)}
    </span>
  );

  return (
    <div
      role="group"
      aria-label={`step ${n}`}
      data-testid={`rp-step-${index}`}
      data-step-index={index}
      data-invalid={invalid || undefined}
      data-collapsed={collapsed || undefined}
      className={`scroll-mt-2 rounded-lg bg-[var(--surface-2)] ${collapsed ? 'px-[18px] py-2.5' : 'px-[18px] pb-3.5 pt-4'} ${
        invalid ? 'shadow-[inset_0_0_0_1px_var(--sky)]' : ''
      }`}
    >
      {/* title row */}
      <div
        onClick={(e) => {
          const t = e.target as HTMLElement;
          if (t.closest('input,textarea,button,[role=combobox],[role=menu],[data-no-toggle]')) return;
          onToggle(e.altKey);
        }}
        className={`flex min-w-0 cursor-default flex-wrap items-center gap-x-3 gap-y-2.5 leading-none ${collapsed ? '' : 'mb-3'}`}
      >
        <button
          type="button"
          aria-label={collapsed ? `expand step ${n}` : `collapse step ${n}`}
          aria-expanded={!collapsed}
          data-testid={tid('toggle')}
          onClick={(e) => onToggle(e.altKey)}
          className={`${ROW} -ml-1 rounded-md p-0.5 text-[var(--text-3)] hover:text-[var(--text)] focus-visible:outline-none! focus-visible:ring-2 focus-visible:ring-[var(--brand)]`}
        >
          <Icon as={collapsed ? ChevronRight : ChevronDown} />
        </button>
        <span
          className={`w-[22px] shrink-0 font-mono text-sm tabular-nums ${invalid ? TONE_TEXT.danger : 'text-[var(--text-3)]'}`}
          title={flaggedDetail}
        >
          {String(n).padStart(2, '0')}
        </span>
        <span className="inline-grid flex-none">
          {/* The sizer follows the input, which globals.css lifts to 16px below 768px (iOS zoom). */}
          <span aria-hidden className="invisible col-start-1 row-start-1 whitespace-pre text-[15px] font-semibold max-[767px]:text-[16px]">
            {step.id || 'id'}
          </span>
          <input
            type="text"
            size={1}
            value={step.id}
            spellCheck={false}
            placeholder="id"
            aria-label={`step ${n} id`}
            aria-invalid={bad('id') || undefined}
            data-testid={tid('id')}
            onChange={(e) => patch({ id: e.target.value })}
            className={`col-start-1 row-start-1 w-full min-w-0 rounded-sm bg-transparent text-[15px] font-semibold text-[var(--text)] outline-none placeholder:text-[var(--text-3)] focus:shadow-[0_0_0_2px_var(--brand)] focus-visible:outline-none! ${
              bad('id') ? TONE_TEXT.danger : ''
            }`}
          />
        </span>
        {/* Grows on the first line; the controls wrap to a second line (left) only when they do not fit. */}
        {collapsed && summary}
        <span className={`min-w-0 flex-[1_1_0] ${collapsed ? '@min-[640px]/rp:hidden' : ''}`} />

        <span className="flex flex-none items-center gap-2.5 leading-none" data-no-toggle>
          {step.onMissing === 'skip' && (
            <span className={`${ROW} gap-1.5 text-sm ${TONE_TEXT.warn}`} data-testid={tid('skip')}>
              <Icon as={SkipForward} />
              skip
            </span>
          )}
          <AppSelect
            aria-label={`step ${n} use`}
            testId={tid('use')}
            value={uses[0]}
            onValueChange={(v) => changeUse(v as ResponseProcessingUse)}
            valueLabel={
              <span className={`${ROW} min-w-0 gap-1.5`}>
                <Icon as={script ? Code : builtinIcon(uses[0])} />
                <span className="truncate">{script ? 'Script' : shortTitle(uses[0], info)}</span>
                {collapsed && !pipe && uses[0] === 'currency@1' && (
                  <span data-testid={tid('use-summary')} className="font-mono text-[var(--text)]">
                    {currencySummary(paramsOf(step, 0))}
                  </span>
                )}
              </span>
            }
            groups={[
              { label: 'Built-in', options: builtinOptions },
              { label: 'Script', options: [{ value: SCRIPT_USE, label: 'Script', icon: <Icon as={Code} /> }] },
            ]}
            className={SELECT_FLAT}
            chevron={CHEVRON}
            contentClassName={MENU}
            itemClassName={MENU_ITEM}
            groupLabelClassName={GROUP_LABEL}
          />
          <AppSelect
            aria-label={`step ${n} mode`}
            testId={tid('mode')}
            value={step.mode}
            onValueChange={(v) => patch({ mode: v as ResponseProcessingMode })}
            options={MODES.map((m) => ({ value: m, label: m, testId: `${tid('mode')}-${m}` }))}
            className={SELECT_MODE}
            chevron={CHEVRON}
            contentClassName={MENU}
            itemClassName={MENU_ITEM}
          />
          <ActionMenu
            contentClassName={ACTION_MENU}
            itemClassName={ACTION_ITEM}
            variant="flat"
            label={`step ${n} menu`}
            testId={tid('menu')}
            trigger={<Icon as={MoreHorizontal} size={18} />}
            className={MENU_TRIGGER}
            groups={[
              {
                items: [
                  { label: 'Duplicate', icon: <Icon as={Copy} />, onSelect: onDuplicate, testId: tid('menu-duplicate') },
                  { label: 'Move up', icon: <Icon as={ArrowUp} />, onSelect: () => onMove(-1), disabled: index === 0, testId: tid('menu-up') },
                  { label: 'Move down', icon: <Icon as={ArrowDown} />, onSelect: () => onMove(1), disabled: index === count - 1, testId: tid('menu-down') },
                  ...(script
                    ? [{ label: 'Params', icon: <Icon as={Braces} />, onSelect: () => setParamsOpen(true), testId: tid('params-add') }]
                    : []),
                ],
              },
              {
                label: 'On missing',
                items: [
                  { label: 'fail', icon: <Icon as={Ban} />, tone: 'danger', checked: step.onMissing !== 'skip', onSelect: () => patch({ onMissing: undefined }), testId: tid('menu-fail') },
                  { label: 'skip', icon: <Icon as={SkipForward} />, tone: 'warn', checked: step.onMissing === 'skip', onSelect: () => patch({ onMissing: 'skip' }), testId: tid('menu-skip') },
                ],
              },
              {
                items: [{ label: 'Delete', icon: <Icon as={Trash2} />, destructive: true, onSelect: onDelete, testId: tid('menu-delete') }],
              },
            ]}
          />
        </span>
      </div>

      {!collapsed && (
        <>
          {/* Input / writes */}
          <div data-testid={tid('fields')} className={FIELDS_GRID}>
            {(['input', 'writes'] as const).map((field) => (
              <div key={field} data-testid={tid(`${field}-field`)} className={FIELD_CELL}>
                <div className={`${ROW} gap-2 text-sm text-[var(--text-3)]`}>
                  <Icon as={FIELD_ICON[field]} />
                  {FIELD_LABEL[field]}
                </div>
                <div className={FIELD_VALUE}>
                  {pathField(field)}
                  {note(field, notes[field])}
                </div>
              </div>
            ))}
          </div>

          {/* processor body */}
          {script ? (
            <div className="mt-3 space-y-2">
              <CodeField
                value={step.code ?? ''}
                onChange={(code) => patch({ code })}
                ariaLabel={`step ${n} code`}
                testId={`rp-code-${index}`}
                invalid={bad('code') || syntaxBad}
                sample={sample}
                each={step.each}
                reads={step.reads}
              />
              {syntaxBad && (
                <span
                  data-testid={tid('syntax')}
                  title={(checkSyntax(step.code ?? '') as { message?: string }).message}
                  className={`${ROW} gap-1.5 font-mono text-sm ${TONE_TEXT.danger}`}
                >
                  <Icon as={X} />
                  syntax
                </span>
              )}
              {(paramsOpen || (step.params && !Array.isArray(step.params) && Object.keys(step.params).length > 0)) && (
                <label className={`${ROW} gap-2`}>
                  <span className="text-sm text-[var(--text-3)]">params</span>
                  <JsonInput
                    value={step.params}
                    kind="object"
                    onCommit={(v) => patch({ params: v as Record<string, unknown> | undefined })}
                    ariaLabel={`step ${n} params`}
                    testId={tid('params')}
                    placeholder="{}"
                    autoFocus={paramsOpen && !step.params}
                  />
                </label>
              )}
            </div>
          ) : pipe ? (
            <div className="mt-3 flex flex-wrap items-center gap-2" data-testid={`rp-pipe-${index}`}>
              {stages.map((use, k) => {
                const stageInfo = builtins.find((b) => b.use === use);
                return (
                  <span key={`${use}-${k}`} className="contents">
                    {k > 0 && (
                      <span className={`${ROW} text-[var(--text-3)]`}>
                        <Icon as={ChevronRight} />
                      </span>
                    )}
                    <DropdownMenu.Root open={openStage === k} onOpenChange={(o) => setOpenStage(o ? k : null)}>
                      <DropdownMenu.Trigger
                        data-testid={`rp-pipe-${index}-${k}`}
                        aria-label={`step ${n} pipe ${k + 1} ${use}`}
                        className={`${ROW} h-8 gap-2 rounded-md bg-[var(--surface)] pl-2 pr-2.5 text-sm outline-none hover:bg-[var(--surface-3)] data-[state=open]:shadow-[0_0_0_2px_var(--brand)] focus-visible:outline-none! focus-visible:ring-2 focus-visible:ring-[var(--brand)]`}
                      >
                        <Icon as={builtinIcon(use)} className="text-[var(--text-2)]" />
                        <span className="text-[var(--text-2)]">{use.replace(/@.*$/, '')}</span>
                        <span className="font-mono text-[var(--text)]">{paramSummary(stageInfo, stageParams[k])}</span>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content
                          align="start"
                          sideOffset={6}
                          collisionPadding={8}
                          data-testid={`rp-pipe-${index}-${k}-params`}
                          className="z-[90] flex items-center gap-3 rounded-md bg-[var(--surface-2)] p-2.5 shadow-[var(--shadow)] focus-visible:outline-none! [&_*:focus-visible]:outline-none!"
                        >
                          {stageInfo?.use === 'currency@1' ? (
                            <CurrencyParams
                              params={stageParams[k]}
                              onChange={(next) =>
                                setStages(stages, stageParams.map((p, j) => (j === k ? next : p)))
                              }
                              labelPrefix={`step ${n} pipe ${k + 1}`}
                              testPrefix={`rp-pipe-${index}-${k}-param`}
                              invalid={flagged}
                            />
                          ) : stageInfo && (
                            <ParamFields
                              info={stageInfo}
                              params={stageParams[k]}
                              onChange={(next) =>
                                setStages(stages, stageParams.map((p, j) => (j === k ? next : p)))
                              }
                              labelPrefix={`step ${n} pipe ${k + 1}`}
                              testPrefix={`rp-pipe-${index}-${k}-param`}
                              invalid={flagged}
                            />
                          )}
                          <button
                            type="button"
                            data-testid={`rp-pipe-${index}-${k}-remove`}
                            aria-label={`remove ${use}`}
                            onClick={() => {
                              setOpenStage(null);
                              setStages(
                                stages.filter((_, j) => j !== k),
                                stageParams.filter((_, j) => j !== k),
                              );
                            }}
                            className={`${ROW} h-[30px] cursor-pointer rounded-md px-1.5 text-[var(--text-3)] outline-none hover:bg-[var(--surface-3)] hover:text-[var(--t-danger-fg)] focus-visible:ring-2 focus-visible:ring-[var(--brand)]`}
                          >
                            <Icon as={Trash2} />
                          </button>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  </span>
                );
              })}
              {stages.length < 8 && addStageMenu}
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-x-[18px] gap-y-2">
              {info?.use === 'currency@1' ? (
                <CurrencyParams
                  params={paramsOf(step, 0)}
                  onChange={(next) => patch({ params: next })}
                  labelPrefix={`step ${n}`}
                  testPrefix={tid('param')}
                  invalid={flagged}
                />
              ) : info && info.params.length > 0 ? (
                <ParamFields
                  info={info}
                  params={paramsOf(step, 0)}
                  onChange={(next) => patch({ params: next })}
                  labelPrefix={`step ${n}`}
                  testPrefix={tid('param')}
                  invalid={flagged}
                />
              ) : (
                !info && (
                  <label className={`${ROW} gap-2`}>
                    <span className="text-sm text-[var(--text-3)]">params</span>
                    <JsonInput
                      value={step.params}
                      kind="object"
                      onCommit={(v) => patch({ params: v as Record<string, unknown> | undefined })}
                      ariaLabel={`step ${n} params`}
                      testId={tid('params')}
                      placeholder="{}"
                    />
                  </label>
                )
              )}
              {info && <span className="-ml-2.5">{addStageMenu}</span>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
