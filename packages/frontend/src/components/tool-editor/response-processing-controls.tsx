'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Code, X } from 'lucide-react';
import { responseProcessing, type ResponseProcessingBuiltins } from '@/lib/api';
import { AppSelect } from '@/components/ui/select';
import type { ActionMenuGroup } from '@/components/ui/action-menu';
import { Icon } from './icon';
import { MENU, MENU_ITEM, ROW, SELECT, TONE_TEXT } from './response-processing-styles';
import {
  builtinIcon,
  FALLBACK_BUILTINS,
  FALLBACK_MAX_CODE_BYTES,
  FALLBACK_MAX_STEPS,
  SCRIPT_USE,
  newBuiltinStep,
  newScriptStep,
  toBuiltinInfo,
  type BuiltinInfo,
  type ResponseProcessingChain,
  type Step,
} from './response-processing-model';

/**
 * Pieces shared by the page summary and the sheet: the On/Off switch, the
 * chain status, the On error select, the add-step menu and the contract.
 */

/* ------------------------------------------------------------------ */
/*  Contract (built-ins + limits), fetched once per page load          */
/* ------------------------------------------------------------------ */

let contractPromise: Promise<ResponseProcessingBuiltins> | null = null;

export function useContract(token: string | null): ResponseProcessingBuiltins | null {
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

export function useBuiltins(token: string | null): {
  builtins: BuiltinInfo[];
  maxSteps: number;
  maxCodeBytes: number;
} {
  const contract = useContract(token);
  const builtins = useMemo(
    () => (contract ? contract.builtins.map(toBuiltinInfo) : FALLBACK_BUILTINS),
    [contract],
  );
  return {
    builtins,
    maxSteps: contract?.limits?.maxSteps ?? FALLBACK_MAX_STEPS,
    maxCodeBytes: contract?.limits?.script?.maxCodeBytes ?? FALLBACK_MAX_CODE_BYTES,
  };
}

/** The chain with a step appended; the first step switches processing on. */
export function appendStep(chain: ResponseProcessingChain, step: Step): ResponseProcessingChain {
  return { ...chain, ...(chain.steps.length === 0 ? { enabled: true } : {}), steps: [...chain.steps, step] };
}

/** The add-step menu: one item per built-in, then Script. */
export function addStepGroups(
  builtins: BuiltinInfo[],
  steps: Step[],
  onAdd: (step: Step, script: boolean) => void,
  testPrefix = 'rp-add',
): ActionMenuGroup[] {
  return [
    {
      label: 'Built-in',
      items: builtins.map((b) => ({
        label: b.title,
        icon: <Icon as={builtinIcon(b.use)} />,
        testId: `${testPrefix}-${b.use}`,
        onSelect: () => onAdd(newBuiltinStep(b, steps), false),
      })),
    },
    {
      label: 'Script',
      items: [
        {
          label: 'Script',
          icon: <Icon as={Code} />,
          testId: `${testPrefix}-${SCRIPT_USE}`,
          onSelect: () => onAdd(newScriptStep(steps), true),
        },
      ],
    },
  ];
}

/* ------------------------------------------------------------------ */
/*  Status the panel reports to the summary                            */
/* ------------------------------------------------------------------ */

export interface ChainStatus {
  tone: 'ok' | 'error' | 'neutral';
  text: string;
  detail?: string;
}

/** What the page summary needs from the (always mounted) panel. */
export interface ProcessingSummaryInfo {
  status: ChainStatus | null;
  /** Per step: the first field with a problem (`reads`, `code`, …), `''` for a flagged step without one, null when fine. */
  issues: (string | null)[];
  /** A preview request is in flight. */
  previewing: boolean;
}

/* ------------------------------------------------------------------ */
/*  Switch                                                             */
/* ------------------------------------------------------------------ */

export function ProcessingSwitch({
  on,
  onToggle,
  testId,
  labelClassName = '',
}: {
  on: boolean;
  onToggle: () => void;
  testId: string;
  labelClassName?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Response Processing enabled"
      data-testid={testId}
      data-state={on ? 'on' : 'off'}
      onClick={onToggle}
      className={`${ROW} shrink-0 gap-2.5 rounded-full focus-visible:outline-none! focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]`}
    >
      <span
        className={`relative h-[22px] w-10 shrink-0 rounded-full transition-colors ${
          on ? 'bg-[var(--ok-fill)]' : 'bg-[var(--surface-3)]'
        }`}
      >
        <span
          className={`absolute top-[3px] h-4 w-4 rounded-full shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-[left] ${
            on ? 'left-[21px] bg-white' : 'left-[3px] bg-[var(--surface)]'
          }`}
        />
      </span>
      <span className={`text-sm font-medium ${on ? TONE_TEXT.success : 'text-[var(--text-3)]'} ${labelClassName}`}>
        {on ? 'On' : 'Off'}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Status (`✓ 3 steps` / `✗ convert_to_eur`)                           */
/* ------------------------------------------------------------------ */

export function StatusBadge({ status, testId }: { status: ChainStatus; testId: string }) {
  return (
    <span
      role="status"
      data-testid={testId}
      data-tone={status.tone}
      title={status.detail}
      className={`${ROW} h-7 min-w-0 max-w-[320px] gap-1.5 whitespace-nowrap px-1 text-sm ${
        status.tone === 'ok'
          ? TONE_TEXT.success
          : status.tone === 'error'
            ? `font-medium ${TONE_TEXT.danger}`
            : 'text-[var(--text-3)]'
      }`}
    >
      {status.tone === 'ok' && <Icon as={Check} />}
      {status.tone === 'error' && <Icon as={X} />}
      <span className="truncate">{status.text}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  On error                                                           */
/* ------------------------------------------------------------------ */

export function OnErrorSelect({
  value,
  onChange,
  testId,
  className = '',
}: {
  value: ResponseProcessingChain['onError'];
  onChange: (v: ResponseProcessingChain['onError']) => void;
  testId: string;
  className?: string;
}) {
  return (
    <span className={`${ROW} shrink-0 gap-4 whitespace-nowrap ${className}`}>
      <span className="text-sm text-[var(--text-3)]">On error</span>
      <AppSelect
        aria-label="On error"
        testId={testId}
        value={value}
        onValueChange={(v) => onChange(v as ResponseProcessingChain['onError'])}
        options={[
          { value: 'fail', label: 'Fail', testId: `${testId}-fail`, className: TONE_TEXT.danger },
          { value: 'passthrough', label: 'Pass through', testId: `${testId}-passthrough`, className: TONE_TEXT.warn },
        ]}
        className={`${SELECT} whitespace-nowrap ${value === 'fail' ? TONE_TEXT.danger : TONE_TEXT.warn}`}
        chevron={<Icon as={ChevronDown} className="text-[var(--text-3)]" />}
        contentClassName={MENU}
        itemClassName={MENU_ITEM}
      />
    </span>
  );
}
