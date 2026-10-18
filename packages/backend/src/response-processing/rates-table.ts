/**
 * The exchange-rate table `currency@1` looks up `from → to` in when a step has
 * no `rate` of its own. Pure: no I/O. RatesService (rates.service.ts) keeps the
 * effective table fresh out of band and registers it here; a chain run reads
 * it once per response and never waits for the network.
 */
import { RATES_SNAPSHOT } from './rates-snapshot';

export interface RatesTable {
  /** Always EUR: rates are units of each currency per 1 EUR. */
  base: string;
  /** Reference date of the rates (`2026-10-17`). */
  asOf: string;
  source: string;
  rates: Record<string, number>;
  /** When this table was fetched (ISO), absent for the snapshot. */
  updatedAt?: string;
  /** Who asked for it: a user id for an admin refresh, `auto` for the backend. */
  updatedBy?: string;
}

export const CURRENCY_CODE = /^[A-Z]{3}$/;

export const SNAPSHOT_TABLE: RatesTable = {
  base: RATES_SNAPSHOT.base,
  asOf: RATES_SNAPSHOT.asOf,
  source: RATES_SNAPSHOT.source,
  rates: { ...RATES_SNAPSHOT.rates },
};

/** The table's codes, base first, then alphabetical. */
export function currencyCodes(table: RatesTable): string[] {
  const codes = Object.keys(table.rates).filter((c) => c !== table.base).sort();
  return [table.base, ...codes];
}

/**
 * Units of `to` per unit of `from`: `rates[to] / rates[from]`, the base being
 * 1. Null for a code the table does not have.
 */
export function crossRate(table: RatesTable, from: string, to: string): number | null {
  const of = (code: string): number | null => {
    if (code === table.base) return 1;
    const r = table.rates[code];
    return typeof r === 'number' && Number.isFinite(r) && r > 0 ? r : null;
  };
  const a = of(from);
  const b = of(to);
  if (a === null || b === null) return null;
  return b / a;
}

/* ------------------------------------------------------------------ */
/*  The effective table, registered by RatesService                    */
/* ------------------------------------------------------------------ */

let provider: () => RatesTable = () => SNAPSHOT_TABLE;

/** Called by RatesService at module init. Must be cheap and must not block. */
export function setRatesProvider(next: () => RatesTable): void {
  provider = next;
}

/** The table in effect right now (the snapshot when nothing registered one). */
export function currentRatesTable(): RatesTable {
  return provider();
}

/* ------------------------------------------------------------------ */
/*  The ECB daily feed                                                 */
/* ------------------------------------------------------------------ */

/**
 * Parse `eurofxref-daily.xml`: `<Cube time='2026-10-17'>` and one
 * `<Cube currency='USD' rate='1.0870'/>` per currency. Single or double quotes.
 * Null when there is no date or not a single valid rate.
 */
export function parseEcbDaily(xml: string): Pick<RatesTable, 'asOf' | 'rates'> | null {
  const time = /<Cube\s+time\s*=\s*["'](\d{4}-\d{2}-\d{2})["']/.exec(xml);
  if (!time) return null;
  const rates: Record<string, number> = {};
  const entry = /<Cube\s+currency\s*=\s*["']([A-Z]{3})["']\s+rate\s*=\s*["']([0-9]+(?:\.[0-9]+)?)["']/g;
  for (let m = entry.exec(xml); m; m = entry.exec(xml)) {
    const rate = Number(m[2]);
    if (Number.isFinite(rate) && rate > 0) rates[m[1]] = rate;
  }
  if (Object.keys(rates).length === 0) return null;
  return { asOf: time[1], rates };
}
