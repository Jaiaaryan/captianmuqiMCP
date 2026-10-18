'use client';

import { ChevronRight, Code, Maximize2, Play, Plus, X } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { ActionMenu } from '@/components/ui/action-menu';
import { Icon } from './icon';
import { Kbd } from './kbd';
import {
  ACTION_ITEM,
  ACTION_MENU,
  BTN_GHOST,
  BTN_PRIMARY,
  BTN_SECONDARY,
  ROW,
  TONE_TEXT,
} from './response-processing-styles';
import {
  OnErrorSelect,
  ProcessingSwitch,
  StatusBadge,
  addStepGroups,
  appendStep,
  useBuiltins,
  type ProcessingSummaryInfo,
} from './response-processing-controls';
import { pathSummary } from './path-picker';
import { currencySummary } from './currency-params';
import {
  builtinIcon,
  FALLBACK_BUILTINS,
  emptyResponseProcessing,
  isScript,
  paramsOf,
  usesOf,
  type BuiltinInfo,
  type ResponseProcessingChain,
} from './response-processing-model';
import type { SheetRequest } from './use-sheet-state';

interface Props {
  /** The editor state (the tool editor's `responseProcessing`), shared with the sheet. */
  state: ResponseProcessingChain | null | undefined;
  onChange: (next: ResponseProcessingChain) => void;
  /** Status and per-step problems, reported by the panel in the sheet. */
  info: ProcessingSummaryInfo | null;
  /** Opens the sheet, optionally on a step or with a preview. */
  onOpen: (req?: Omit<SheetRequest, 'nonce'>) => void;
}

function title(use: string, builtins: BuiltinInfo[]): string {
  return (
    FALLBACK_BUILTINS.find((b) => b.use === use)?.title ??
    builtins.find((b) => b.use === use)?.title ??
    use.replace(/@.*$/, '')
  );
}

/**
 * Response Processing on the connector page: a header row and one 40px row per
 * step. Editing happens in the sheet; every row opens it on its step.
 */
export function ResponseProcessingSummary({ state, onChange, info, onOpen }: Props) {
  const { token } = useAuth();
  const { builtins, maxSteps } = useBuiltins(token);
  const chain = state ?? emptyResponseProcessing();
  const { steps } = chain;
  const empty = steps.length === 0;
  const on = chain.enabled;
  const status = info?.status ?? null;
  const set = (next: Partial<ResponseProcessingChain>) => onChange({ ...chain, ...next });

  const addGroups = addStepGroups(
    builtins,
    steps,
    (step, script) => {
      onChange(appendStep(chain, step));
      onOpen({ stepId: step.id, ...(script ? {} : { focus: 'reads' as const }) });
    },
    'rp-summary-add',
  );

  const addMenu = (
    <ActionMenu
      contentClassName={ACTION_MENU}
      itemClassName={ACTION_ITEM}
      variant="flat"
      align={empty ? 'end' : 'start'}
      label="add step"
      testId="rp-summary-add-step"
      className={`${BTN_SECONDARY} text-sm focus-visible:bg-[var(--surface-2)] data-[state=open]:bg-[var(--surface-3)]`}
      disabled={steps.length >= maxSteps}
      groups={addGroups}
      trigger={
        <>
          <Icon as={Plus} />
          Step
        </>
      }
    />
  );

  return (
    <section
      aria-label="Response Processing"
      data-testid="rp-summary"
      className="@container/rps text-sm text-[var(--text)]"
    >
      {/* header */}
      <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 leading-none ${empty ? '' : 'mb-3'}`}>
        <h4 className="whitespace-nowrap text-[17px] font-semibold tracking-[-0.01em]">Response Processing</h4>
        <ProcessingSwitch on={on} onToggle={() => set({ enabled: !on })} testId="rp-summary-toggle" />
        {status && <StatusBadge status={status} testId="rp-summary-status" />}
        <span className="flex-1" />
        {empty ? (
          addMenu
        ) : (
          <>
            <OnErrorSelect value={chain.onError} onChange={(onError) => set({ onError })} testId="rp-summary-on-error" />
            <button
              type="button"
              data-testid="rp-open"
              aria-keyshortcuts="Meta+Period Control+Period"
              onClick={() => onOpen()}
              className={`${BTN_PRIMARY} whitespace-nowrap`}
            >
              <Icon as={Maximize2} />
              Open
              <Kbd className="text-sm text-inherit opacity-60">⌘.</Kbd>
            </button>
          </>
        )}
      </div>

      {!empty && (
        <>
          <ol className="flex flex-col gap-1.5">
            {steps.map((step, i) => {
              const issue = info?.issues[i] ?? null;
              const invalid = issue !== null;
              const script = isScript(step);
              const uses = usesOf(step);
              return (
                <li key={`${step.id}-${i}`}>
                  <button
                    type="button"
                    data-testid={`rp-summary-step-${i}`}
                    data-invalid={invalid || undefined}
                    aria-label={`open step ${i + 1} ${step.id}`}
                    onClick={() => onOpen({ stepId: step.id })}
                    className={`flex h-10 w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg bg-[var(--surface-2)] px-3.5 text-left leading-none hover:bg-[var(--surface-3)] focus-visible:outline-none! focus-visible:ring-2 focus-visible:ring-[var(--brand)] ${
                      invalid ? 'shadow-[inset_0_0_0_1px_var(--sky)]' : ''
                    }`}
                  >
                    <span className={`w-[22px] shrink-0 font-mono text-sm tabular-nums ${invalid ? TONE_TEXT.danger : 'text-[var(--text-3)]'}`}>
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span className="max-w-[40%] shrink-0 truncate font-semibold">{step.id || <span className="text-[var(--text-3)]">id</span>}</span>
                    <span
                      data-testid={`rp-summary-step-${i}-paths`}
                      className="min-w-0 flex-1 truncate font-mono text-sm text-[var(--text-2)] @max-[640px]/rps:hidden"
                    >
                      {pathSummary(step)}
                    </span>
                    <span className="flex-1 @min-[640px]/rps:hidden" />
                    {invalid && (
                      <span data-testid={`rp-summary-step-${i}-issue`} className={`${ROW} shrink-0 gap-1.5 whitespace-nowrap ${TONE_TEXT.danger}`}>
                        <Icon as={X} />
                        {issue}
                      </span>
                    )}
                    <span className={`${ROW} min-w-0 shrink-0 gap-1.5 whitespace-nowrap text-[var(--text-2)]`}>
                      <Icon as={script ? Code : builtinIcon(uses[0])} />
                      {script
                        ? 'Script'
                        : uses.map((u, k) => (
                            <span key={`${u}-${k}`} className={`${ROW} gap-1.5`}>
                              {k > 0 && <Icon as={ChevronRight} className="text-[var(--text-3)]" />}
                              {title(u, builtins)}
                              {u === 'currency@1' && currencySummary(paramsOf(step, k)) && (
                                <span data-testid={`rp-summary-step-${i}-currency`} className="font-mono text-[var(--text)]">
                                  {currencySummary(paramsOf(step, k))}
                                </span>
                              )}
                            </span>
                          ))}
                    </span>
                    <span className="w-[52px] shrink-0 whitespace-nowrap text-right text-[var(--text-3)]">{step.mode}</span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="mt-3 flex items-center gap-2.5">
            {addMenu}
            <button
              type="button"
              data-testid="rp-summary-preview"
              onClick={() => onOpen({ preview: true })}
              className={`${BTN_GHOST} h-9 px-3`}
            >
              <Icon as={Play} />
              Preview
            </button>
          </div>
        </>
      )}
    </section>
  );
}
