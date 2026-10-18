'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronDown, RefreshCw, X } from 'lucide-react';
import { ApiError, responseProcessing, type ResponseProcessingRates } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { AppSelect } from '@/components/ui/select';
import { Icon } from './icon';
import { BTN_GHOST, MENU, MENU_ITEM, NO_SPIN, ROW, TONE_TEXT, VALUE_INPUT, chWidth } from './response-processing-styles';

/**
 * The params of a Currency step (`currency@1`): `from [USD ▾] to [EUR ▾] rate
 * [0.9200]` and the table's date. Live: only `from`/`to` are stored and the
 * rate field shows the table's value; manual: a typed `rate` is stored and wins.
 */

/* ------------------------------------------------------------------ */
/*  The rates table: one copy per page, shared by every Currency step  */
/* ------------------------------------------------------------------ */

interface RatesState {
  data: ResponseProcessingRates | null;
  busy: boolean;
  /** The last admin refresh failed: its short code. */
  error: string | null;
}

let state: RatesState = { data: null, busy: false, error: null };
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;
let followUp = false;

function setState(next: Partial<RatesState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function load(token: string) {
  loading ??= responseProcessing.rates
    .get(token)
    .then((data) => {
      if (!data?.rates || !Array.isArray(data.currencies)) return;
      setState({ data });
      // The backend fetches a stale table in the background on this very read: look again once.
      if (!followUp && data.auto && data.status !== 'live' && !data.error) {
        followUp = true;
        setTimeout(() => {
          loading = null;
          load(token);
        }, 6000);
      }
    })
    .catch(() => undefined)
    .finally(() => {
      loading = null;
    });
}

export function useRates(token: string | null): RatesState {
  const snap = useSyncExternalStore(subscribe, () => state, () => state);
  useEffect(() => {
    if (token && !state.data) load(token);
  }, [token]);
  return snap;
}

export async function refreshRates(token: string): Promise<void> {
  setState({ busy: true });
  try {
    const data = await responseProcessing.rates.refresh(token);
    if (!data?.rates || !Array.isArray(data.currencies)) throw new Error('parse');
    setState({ data, busy: false, error: data.error ?? null });
  } catch (err) {
    setState({ busy: false, error: err instanceof ApiError ? `http_${err.status}` : 'network' });
  }
}

/* ------------------------------------------------------------------ */
/*  Pure helpers                                                       */
/* ------------------------------------------------------------------ */

/** Units of `to` per `from`, as the backend computes it; null for a code the table lacks. */
export function crossRate(table: Pick<ResponseProcessingRates, 'base' | 'rates'>, from: string, to: string): number | null {
  const of = (c: string) => (c === table.base ? 1 : table.rates[c] > 0 ? table.rates[c] : null);
  const a = of(from);
  const b = of(to);
  return a === null || b === null ? null : b / a;
}

/** `0.9200`, `162.4500`, `0.006156`: four decimals, four significant digits below 1. */
export function formatRate(rate: number): string {
  return rate >= 1 ? rate.toFixed(4) : rate.toPrecision(4);
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The step's summary: `USD→EUR` when it has a pair, else the rate (`0.92`). */
export function currencySummary(params: Record<string, unknown> | undefined): string {
  const from = str(params?.from);
  const to = str(params?.to);
  if (from && to) return `${from}→${to}`;
  return typeof params?.rate === 'number' ? String(params.rate) : '';
}

/* ------------------------------------------------------------------ */
/*  The row                                                            */
/* ------------------------------------------------------------------ */

const CHEVRON = <Icon as={ChevronDown} className="text-[var(--text-3)]" />;
const CODE_SELECT = `${VALUE_INPUT} ${ROW} gap-1.5 [&>span]:inline-flex [&>span]:items-center [&>span]:leading-none hover:bg-[var(--surface-3)] data-[state=open]:ring-2 data-[state=open]:ring-[var(--brand)]`;
const FALLBACK_CODES = ['EUR', 'USD'];

function keepKeys(e: React.KeyboardEvent) {
  if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key !== 'Escape') e.stopPropagation();
}

export function CurrencyParams({
  params,
  onChange,
  labelPrefix,
  testPrefix,
  invalid,
}: {
  params: Record<string, unknown> | undefined;
  onChange: (next: Record<string, unknown> | undefined) => void;
  labelPrefix: string;
  testPrefix: string;
  invalid: boolean;
}) {
  const { token, user } = useAuth();
  const { data, busy, error } = useRates(token);
  const admin = user?.role === 'ADMIN';

  const from = str(params?.from);
  const to = str(params?.to);
  const stored = typeof params?.rate === 'number' ? params.rate : undefined;
  const manual = stored !== undefined;
  const derived = data && from && to ? crossRate(data, from, to) : null;

  // The typed text while the field has focus; `before` is what Esc goes back to.
  const [draft, setDraft] = useState<string | null>(null);
  const before = useRef<Record<string, unknown> | undefined>(undefined);
  const text = draft ?? (manual ? String(stored) : derived !== null ? formatRate(derived) : '');

  const codes = data?.currencies?.length ? data.currencies : FALLBACK_CODES;
  const options = (current: string) =>
    [...new Set([...(current ? [current] : []), ...codes])].map((c) => ({ value: c, label: c, testId: `${testPrefix}-option-${c}` }));

  /** A pair from the selects: live again (the stored rate goes). */
  const choose = (field: 'from' | 'to', code: string) => {
    const pair = { from: from || 'USD', to: to || 'EUR', [field]: code };
    if (pair.from === pair.to) pair[field === 'from' ? 'to' : 'from'] = code === 'EUR' ? 'USD' : 'EUR';
    setDraft(null);
    onChange({ from: pair.from, to: pair.to });
  };

  const typeRate = (value: string) => {
    setDraft(value);
    const n = Number(value.replace(',', '.'));
    const next: Record<string, unknown> = { ...(params ?? {}) };
    if (value.trim() === '' && from && to) delete next.rate;
    else if (Number.isFinite(n) && n > 0 && value.trim() !== '') next.rate = n;
    else return;
    onChange(Object.keys(next).length ? next : undefined);
  };

  const toLive = () => {
    setDraft(null);
    onChange({ from: from || 'USD', to: to || 'EUR' });
  };

  const note = manual ? 'manual' : data && derived !== null ? `${data.source} · ${data.asOf}` : data && from && to ? 'no rate' : '';
  const noRate = !manual && note === 'no rate';
  const draftBad = draft !== null && draft.trim() !== '' && !(Number(draft.replace(',', '.')) > 0);

  return (
    <span className={`${ROW} flex-wrap gap-x-[18px] gap-y-2`} data-testid={`${testPrefix}-currency`}>
      {(['from', 'to'] as const).map((field) => {
        const value = field === 'from' ? from : to;
        return (
          <span key={field} className={`${ROW} gap-2`}>
            <span className="text-sm text-[var(--text-3)]" id={`${testPrefix}-${field}-label`}>
              {field}
            </span>
            <AppSelect
              aria-label={`${labelPrefix} ${field}`}
              testId={`${testPrefix}-${field}`}
              value={value}
              onValueChange={(code) => choose(field, code)}
              valueLabel={<span className="font-mono">{value || '—'}</span>}
              options={options(value)}
              className={CODE_SELECT}
              chevron={CHEVRON}
              contentClassName={`${MENU} max-h-72`}
              itemClassName={`${MENU_ITEM} font-mono`}
            />
          </span>
        );
      })}
      <span className={`${ROW} gap-2`}>
        <label htmlFor={`${testPrefix}-rate-input`} className="text-sm text-[var(--text-3)]">
          rate
        </label>
        <span className={`${ROW} gap-1`}>
          <input
            id={`${testPrefix}-rate-input`}
            type="text"
            inputMode="decimal"
            value={text}
            spellCheck={false}
            aria-label={`${labelPrefix} rate`}
            aria-invalid={invalid || draftBad || noRate || (!manual && !from) || undefined}
            aria-describedby={`${testPrefix}-rate-note`}
            data-testid={`${testPrefix}-rate`}
            data-mode={manual ? 'manual' : 'live'}
            onFocus={() => {
              before.current = params;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                const changed = JSON.stringify(before.current ?? null) !== JSON.stringify(params ?? null) || draft !== null;
                if (changed) {
                  e.preventDefault();
                  e.stopPropagation();
                  setDraft(null);
                  onChange(before.current);
                }
                return;
              }
              keepKeys(e);
            }}
            onChange={(e) => typeRate(e.target.value)}
            onBlur={() => setDraft(null)}
            style={chWidth(text, '', 6, 22)}
            className={`${VALUE_INPUT} ${NO_SPIN} ${manual ? '' : 'text-[var(--text-2)]'}`}
          />
          {manual && (
            <button
              type="button"
              aria-label={`${labelPrefix} rate from table`}
              data-testid={`${testPrefix}-rate-clear`}
              onClick={toLive}
              className={`${BTN_GHOST} h-[30px] px-1.5 text-[var(--text-3)]`}
            >
              <Icon as={X} />
            </button>
          )}
        </span>
        {note && (
          <span
            id={`${testPrefix}-rate-note`}
            data-testid={`${testPrefix}-rate-note`}
            aria-live="polite"
            className={`whitespace-nowrap font-mono text-sm ${noRate ? TONE_TEXT.danger : 'text-[var(--text-3)]'}`}
          >
            {note}
          </span>
        )}
      </span>
      {admin && token && (
        <button
          type="button"
          aria-label="Refresh rates"
          aria-busy={busy || undefined}
          disabled={busy}
          title={error ?? data?.status}
          data-testid={`${testPrefix}-rates-refresh`}
          data-state={busy ? 'busy' : error ? 'error' : 'idle'}
          onClick={() => void refreshRates(token)}
          className={`${BTN_GHOST} h-[30px] px-1.5 ${error ? TONE_TEXT.danger : 'text-[var(--text-3)]'}`}
        >
          <Icon as={RefreshCw} className={busy ? 'motion-safe:animate-spin' : ''} />
        </button>
      )}
    </span>
  );
}
