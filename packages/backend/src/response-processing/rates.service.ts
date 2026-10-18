import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SiteSettingsService } from '../settings/site-settings.service';
import {
  CURRENCY_CODE,
  SNAPSHOT_TABLE,
  currencyCodes,
  parseEcbDaily,
  setRatesProvider,
  type RatesTable,
} from './rates-table';

/** Site-settings key of the last table fetched. */
export const RATES_SETTING_KEY = 'rp.rates';
export const DEFAULT_RATES_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

export const RATES_LIMITS = {
  timeoutMs: 5000,
  maxBytes: 256 * 1024,
  /** A table older than this is fetched again. */
  maxAgeMs: 24 * 60 * 60 * 1000,
  /** After a failed fetch, the next automatic one waits this long. */
  retryMs: 15 * 60 * 1000,
  /** How often the background check looks at the table's age. */
  tickMs: 60 * 60 * 1000,
  /** Same-host redirects followed. */
  maxRedirects: 2,
} as const;

/** `live`: fetched by this process; `cached`: the stored one; `snapshot`: the repo's. */
export type RatesStatus = 'live' | 'cached' | 'snapshot';

export interface RatesView {
  base: string;
  asOf: string;
  source: string;
  currencies: string[];
  rates: Record<string, number>;
  status: RatesStatus;
  /** Whether the backend fetches the feed by itself (`RP_RATES_AUTO`). */
  auto: boolean;
  fetchedAt?: string;
  nextRefreshAt?: string;
  /** Last failure as a short code: `timeout`, `http_503`, `parse`, `network`, `too_large`, `redirect`, `url`, `disabled`. */
  error?: string;
}

class FetchFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function isTable(v: unknown): v is RatesTable {
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  if (t.base !== 'EUR' || typeof t.asOf !== 'string' || typeof t.source !== 'string') return false;
  if (!t.rates || typeof t.rates !== 'object' || Array.isArray(t.rates)) return false;
  const entries = Object.entries(t.rates as Record<string, unknown>);
  return (
    entries.length > 0 &&
    entries.every(([k, r]) => CURRENCY_CODE.test(k) && typeof r === 'number' && Number.isFinite(r) && r > 0)
  );
}

/**
 * Keeps the euro reference rates fresh, out of band of every chain run.
 *
 * Effective table: the last fetch of this process, else the one stored in site
 * settings (`rp.rates`, written after every successful fetch), else the repo
 * snapshot. A chain run reads whichever is effective right now and never
 * waits: when the table is older than 24 h, reading it starts a fetch in the
 * background (one at a time, 5 s timeout, 15 min back-off after a failure),
 * and an hourly tick does the same. `RP_RATES_AUTO=false` turns both off.
 *
 * The source is a fixed, operator-controlled URL (`RP_RATES_URL`, default the
 * ECB daily feed), not user input, so it does not go through the connector
 * SSRF allowlist: a plain HTTPS GET, same-host redirects only, 256 KB cap.
 * Identical on Cloud and self-hosted.
 */
@Injectable()
export class RatesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RatesService.name);
  private table: RatesTable = SNAPSHOT_TABLE;
  private status: RatesStatus = 'snapshot';
  private lastError: string | undefined;
  private lastFailureAt = 0;
  private inflight: Promise<RatesView> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private loaded: Promise<void> | null = null;
  private checking: Promise<void> | null = null;

  constructor(private readonly settings: SiteSettingsService) {}

  get auto(): boolean {
    return (process.env.RP_RATES_AUTO ?? '').trim().toLowerCase() !== 'false';
  }

  get url(): string {
    return process.env.RP_RATES_URL?.trim() || DEFAULT_RATES_URL;
  }

  async onModuleInit(): Promise<void> {
    setRatesProvider(() => this.current());
    this.loaded = this.loadStored();
    await this.loaded;
    if (this.auto) {
      this.timer = setInterval(() => this.refreshIfStale(), RATES_LIMITS.tickMs);
      this.timer.unref?.();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The effective table. Starts a background fetch when it is stale; never waits for it. */
  current(): RatesTable {
    this.refreshIfStale();
    return this.table;
  }

  /** What `GET /api/response-processing/rates` answers. */
  view(): RatesView {
    const table = this.current();
    const next = this.nextRefreshAt();
    const error = this.lastError ?? (!this.auto && this.status === 'snapshot' ? 'disabled' : undefined);
    return {
      base: table.base,
      asOf: table.asOf,
      source: table.source,
      currencies: currencyCodes(table),
      rates: { ...table.rates },
      status: this.status,
      auto: this.auto,
      ...(table.updatedAt ? { fetchedAt: table.updatedAt } : {}),
      ...(next ? { nextRefreshAt: new Date(next).toISOString() } : {}),
      ...(error ? { error } : {}),
    };
  }

  /**
   * Fetch now (an admin's refresh, or the background one). Shares a fetch
   * already in flight. Never throws: a failure is the view with `error`, the
   * effective table unchanged.
   */
  refresh(updatedBy = 'auto'): Promise<RatesView> {
    this.inflight ??= this.fetchAndStore(updatedBy).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /* ---------------------------------------------------------------- */

  private age(): number {
    const at = this.table.updatedAt ? Date.parse(this.table.updatedAt) : NaN;
    return Number.isNaN(at) ? Infinity : Date.now() - at;
  }

  private nextRefreshAt(): number | null {
    if (!this.auto) return null;
    const at = this.table.updatedAt ? Date.parse(this.table.updatedAt) : NaN;
    const due = Number.isNaN(at) ? Date.now() : at + RATES_LIMITS.maxAgeMs;
    const retry = this.lastFailureAt ? this.lastFailureAt + RATES_LIMITS.retryMs : 0;
    return Math.max(due, retry);
  }

  private refreshIfStale(): void {
    if (!this.auto || this.inflight || this.checking) return;
    if (this.age() < RATES_LIMITS.maxAgeMs) return;
    if (this.lastFailureAt && Date.now() - this.lastFailureAt < RATES_LIMITS.retryMs) return;
    this.checking = (async () => {
      // Another instance may have stored a fresher table meanwhile.
      await (this.loaded ?? Promise.resolve());
      if (this.status !== 'live') await this.loadStored();
      if (this.age() >= RATES_LIMITS.maxAgeMs) await this.refresh('auto');
    })()
      .catch(() => undefined)
      .finally(() => {
        this.checking = null;
      });
  }

  /** Test hook: settles once the background check started by `current()` is done. */
  async settled(): Promise<void> {
    await this.checking;
    await this.inflight;
  }

  private async loadStored(): Promise<void> {
    try {
      const stored = await this.settings.getJson<unknown>(RATES_SETTING_KEY);
      if (isTable(stored) && this.status !== 'live') {
        this.table = stored;
        this.status = 'cached';
      }
    } catch (err) {
      this.logger.warn(`Stored exchange rates unreadable: ${err instanceof Error ? err.message : 'error'}`);
    }
  }

  private async fetchAndStore(updatedBy: string): Promise<RatesView> {
    try {
      const xml = await this.download();
      const parsed = parseEcbDaily(xml);
      if (!parsed) throw new FetchFailure('parse');
      const table: RatesTable = {
        base: 'EUR',
        asOf: parsed.asOf,
        source: 'ECB',
        rates: parsed.rates,
        updatedAt: new Date().toISOString(),
        updatedBy,
      };
      this.table = table;
      this.status = 'live';
      this.lastError = undefined;
      this.lastFailureAt = 0;
      this.logger.log(`Exchange rates refreshed: asOf ${table.asOf}, ${Object.keys(table.rates).length} currencies`);
      try {
        await this.settings.setJson(RATES_SETTING_KEY, table);
      } catch (err) {
        this.logger.warn(`Exchange rates not stored: ${err instanceof Error ? err.message : 'error'}`);
      }
    } catch (err) {
      this.lastError = err instanceof FetchFailure ? err.code : 'network';
      this.lastFailureAt = Date.now();
      this.logger.warn(`Exchange rates refresh failed: ${this.lastError}`);
    }
    return this.view();
  }

  /** GET the feed: HTTPS only, same-host redirects, 5 s for everything, 256 KB. */
  private async download(): Promise<string> {
    let url: URL;
    try {
      url = new URL(this.url);
    } catch {
      throw new FetchFailure('url');
    }
    if (url.protocol !== 'https:') throw new FetchFailure('url');
    const host = url.host;
    const signal = AbortSignal.timeout(RATES_LIMITS.timeoutMs);
    try {
      for (let hop = 0; ; hop++) {
        const res = await fetch(url, { redirect: 'manual', signal, headers: { accept: 'application/xml, text/xml' } });
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get('location');
          await res.body?.cancel().catch(() => undefined);
          let next: URL | null = null;
          try {
            next = location ? new URL(location, url) : null;
          } catch {
            next = null;
          }
          if (!next || next.protocol !== 'https:' || next.host !== host || hop >= RATES_LIMITS.maxRedirects) {
            throw new FetchFailure('redirect');
          }
          url = next;
          continue;
        }
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          throw new FetchFailure(`http_${res.status}`);
        }
        return await readCapped(res, RATES_LIMITS.maxBytes);
      }
    } catch (err) {
      if (err instanceof FetchFailure) throw err;
      const name = (err as { name?: string })?.name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new FetchFailure('timeout');
      throw new FetchFailure('network');
    }
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new FetchFailure('too_large');
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new FetchFailure('too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
