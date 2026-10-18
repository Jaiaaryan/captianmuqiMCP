import { Logger } from '@nestjs/common';
import { RATES_LIMITS, RATES_SETTING_KEY, RatesService } from './rates.service';
import { currentRatesTable, parseEcbDaily, setRatesProvider, SNAPSHOT_TABLE, crossRate } from './rates-table';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <Cube>
    <Cube time='2026-10-16'>
      <Cube currency='USD' rate='1.0900'/>
      <Cube currency='JPY' rate='163.10'/>
      <Cube currency='GBP' rate='0.8420'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

function settingsStub(stored: unknown = null) {
  return {
    getJson: jest.fn(async () => stored),
    setJson: jest.fn(async () => undefined),
  };
}

const okResponse = (body = XML, init: ResponseInit = { status: 200 }) => new Response(body, init);

describe('parseEcbDaily', () => {
  it('reads the date and every currency, single or double quotes', () => {
    expect(parseEcbDaily(XML)).toEqual({ asOf: '2026-10-16', rates: { USD: 1.09, JPY: 163.1, GBP: 0.842 } });
    expect(parseEcbDaily('<Cube time="2026-01-02"><Cube currency="CHF" rate="0.93"/></Cube>')).toEqual({
      asOf: '2026-01-02',
      rates: { CHF: 0.93 },
    });
  });
  it('is null without a date or without rates', () => {
    expect(parseEcbDaily('<html>maintenance</html>')).toBeNull();
    expect(parseEcbDaily("<Cube time='2026-10-16'></Cube>")).toBeNull();
  });
});

describe('crossRate', () => {
  const t = { base: 'EUR', asOf: 'x', source: 'ECB', rates: { USD: 1.25, GBP: 0.8 } };
  it('is rates[to] / rates[from] with the base at 1', () => {
    expect(crossRate(t, 'USD', 'EUR')).toBe(0.8);
    expect(crossRate(t, 'EUR', 'USD')).toBe(1.25);
    expect(crossRate(t, 'USD', 'GBP')).toBeCloseTo(0.64);
    expect(crossRate(t, 'EUR', 'EUR')).toBe(1);
  });
  it('is null for an unknown code', () => {
    expect(crossRate(t, 'USD', 'XAU')).toBeNull();
    expect(crossRate(t, 'XAU', 'EUR')).toBeNull();
  });
  it('gives USD→EUR about 0.92 on the snapshot', () => {
    expect(crossRate(SNAPSHOT_TABLE, 'USD', 'EUR')).toBeCloseTo(0.92, 2);
  });
});

describe('RatesService', () => {
  const env = { ...process.env };
  let fetchSpy: jest.SpyInstance;
  let services: RatesService[] = [];

  const make = async (stored: unknown = null, envOver: Record<string, string> = {}) => {
    Object.assign(process.env, envOver);
    const settings = settingsStub(stored);
    const service = new RatesService(settings as any);
    services.push(service);
    await service.onModuleInit();
    return { service, settings };
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => okResponse());
    delete process.env.RP_RATES_AUTO;
    delete process.env.RP_RATES_URL;
  });

  afterEach(() => {
    for (const s of services) s.onModuleDestroy();
    services = [];
    process.env = { ...env };
    setRatesProvider(() => SNAPSHOT_TABLE);
    jest.restoreAllMocks();
  });

  it('serves the snapshot first and fetches the ECB feed lazily, out of band', async () => {
    const { service, settings } = await make();
    expect(fetchSpy).not.toHaveBeenCalled();
    // The first need returns the snapshot right away and starts the fetch.
    expect(currentRatesTable().asOf).toBe('2026-10-17');
    await service.settled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml');
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
    const view = service.view();
    expect(view).toMatchObject({ status: 'live', asOf: '2026-10-16', source: 'ECB', currencies: ['EUR', 'GBP', 'JPY', 'USD'] });
    expect(view.fetchedAt).toBeDefined();
    expect(Date.parse(view.nextRefreshAt!) - Date.parse(view.fetchedAt!)).toBe(RATES_LIMITS.maxAgeMs);
    expect(settings.setJson).toHaveBeenCalledWith(
      RATES_SETTING_KEY,
      expect.objectContaining({ base: 'EUR', asOf: '2026-10-16', source: 'ECB', updatedBy: 'auto', rates: { USD: 1.09, JPY: 163.1, GBP: 0.842 } }),
    );
    // Fresh now: no second fetch.
    service.current();
    await service.settled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('uses a stored table younger than 24 h without fetching', async () => {
    const stored = { base: 'EUR', asOf: '2026-10-15', source: 'ECB', rates: { USD: 1.2 }, updatedAt: new Date().toISOString(), updatedBy: 'auto' };
    const { service } = await make(stored);
    expect(service.current().asOf).toBe('2026-10-15');
    await service.settled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(service.view().status).toBe('cached');
  });

  it('refetches a stored table older than 24 h', async () => {
    const old = new Date(Date.now() - RATES_LIMITS.maxAgeMs - 1000).toISOString();
    const stored = { base: 'EUR', asOf: '2026-10-10', source: 'ECB', rates: { USD: 1.2 }, updatedAt: old };
    const { service } = await make(stored);
    expect(service.current().asOf).toBe('2026-10-10');
    await service.settled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(service.view()).toMatchObject({ status: 'live', asOf: '2026-10-16' });
  });

  it('ignores a malformed stored table', async () => {
    const { service } = await make({ base: 'EUR', asOf: 'x', source: 'ECB', rates: { usd: 'one' } }, { RP_RATES_AUTO: 'false' });
    expect(service.view()).toMatchObject({ status: 'snapshot', asOf: '2026-10-17' });
  });

  it('shares one fetch in flight', async () => {
    const { service } = await make(null, { RP_RATES_AUTO: 'false' });
    const [a, b] = await Promise.all([service.refresh('u1'), service.refresh('u2')]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it('keeps the table and reports a short code on failure, then backs off', async () => {
    fetchSpy.mockImplementation(async () => okResponse('down', { status: 503 }));
    const { service, settings } = await make();
    service.current();
    await service.settled();
    expect(service.view()).toMatchObject({ status: 'snapshot', asOf: '2026-10-17', error: 'http_503' });
    expect(settings.setJson).not.toHaveBeenCalled();
    // Within the back-off, a chain run does not fetch again.
    service.current();
    await service.settled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // An admin refresh still does.
    expect((await service.refresh('admin')).error).toBe('http_503');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['parse', async () => okResponse('<html/>')],
    ['timeout', async () => Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' }))],
    ['network', async () => Promise.reject(new TypeError('fetch failed'))],
    ['too_large', async () => okResponse('x'.repeat(RATES_LIMITS.maxBytes + 1))],
    ['redirect', async () => okResponse('', { status: 302, headers: { location: 'https://elsewhere.example/x.xml' } })],
  ])('reports %s', async (code, impl) => {
    fetchSpy.mockImplementation(impl as any);
    const { service } = await make(null, { RP_RATES_AUTO: 'false' });
    expect((await service.refresh('admin')).error).toBe(code);
    expect(service.view().status).toBe('snapshot');
  });

  it('follows a same-host redirect', async () => {
    fetchSpy
      .mockImplementationOnce(async () => okResponse('', { status: 301, headers: { location: '/stats/x.xml' } }))
      .mockImplementationOnce(async () => okResponse());
    const { service } = await make(null, { RP_RATES_AUTO: 'false' });
    expect((await service.refresh('admin')).status).toBe('live');
    expect(String(fetchSpy.mock.calls[1][0])).toBe('https://www.ecb.europa.eu/stats/x.xml');
  });

  it('honours RP_RATES_URL, https only', async () => {
    const { service } = await make(null, { RP_RATES_AUTO: 'false', RP_RATES_URL: 'https://rates.internal.example/daily.xml' });
    await service.refresh('admin');
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://rates.internal.example/daily.xml');
    process.env.RP_RATES_URL = 'http://rates.internal.example/daily.xml';
    expect((await service.refresh('admin')).error).toBe('url');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('never fetches by itself with RP_RATES_AUTO=false', async () => {
    const { service } = await make(null, { RP_RATES_AUTO: 'false' });
    service.current();
    await service.settled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(service.view()).toMatchObject({ status: 'snapshot', auto: false, error: 'disabled' });
    expect(service.view().nextRefreshAt).toBeUndefined();
  });

  it('logs asOf and the count, never the body', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { service } = await make(null, { RP_RATES_AUTO: 'false' });
    await service.refresh('admin');
    expect(log).toHaveBeenCalledWith('Exchange rates refreshed: asOf 2026-10-16, 3 currencies');
    expect(JSON.stringify(log.mock.calls)).not.toContain('1.0900');
  });
});
