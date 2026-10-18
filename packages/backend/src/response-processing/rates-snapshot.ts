/**
 * The euro foreign exchange reference rates shipped with the code: the table
 * `currency@1` falls back to when the backend has never fetched the ECB feed
 * (air-gapped installs with `RP_RATES_AUTO=false`, a first boot offline) and
 * nothing is stored in site settings yet. Units of each currency per 1 EUR.
 *
 * Refresh it by hand from https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml
 * when cutting a release; the running backend keeps its own copy fresh.
 */
export const RATES_SNAPSHOT = {
  base: 'EUR',
  asOf: '2026-10-17',
  source: 'ECB',
  rates: {
    USD: 1.087,
    JPY: 162.45,
    CZK: 25.12,
    DKK: 7.4605,
    GBP: 0.8412,
    HUF: 395.8,
    PLN: 4.265,
    RON: 4.977,
    SEK: 11.235,
    CHF: 0.9385,
    ISK: 146.9,
    NOK: 11.64,
    TRY: 38.95,
    AUD: 1.642,
    BRL: 6.015,
    CAD: 1.493,
    CNY: 7.785,
    HKD: 8.465,
    IDR: 17520.5,
    ILS: 4.085,
    INR: 91.25,
    KRW: 1505.3,
    MXN: 20.45,
    MYR: 4.715,
    NZD: 1.812,
    PHP: 62.15,
    SGD: 1.432,
    THB: 36.42,
    ZAR: 19.85,
  } as Record<string, number>,
} as const;
