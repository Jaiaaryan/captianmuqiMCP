import type { Server } from 'http';
import { demoCredentials } from './demo.config';
import { mockDataset } from './mock-data';
import { createMockSystems, listenMockSystems, MockSystemsService, type MockSystems } from './mock-systems.service';

const creds = demoCredentials({ DEMO_PASSWORD_SEED: 'mock-spec' });

describe('mock systems', () => {
  let systems: MockSystems;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    systems = createMockSystems(creds);
    const started = await listenMockSystems(systems, 0);
    server = started.server;
    base = `http://127.0.0.1:${started.port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
  });

  const get = async (path: string, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { headers });
    return { status: r.status, body: (await r.json()) as any };
  };
  const bearer = (t?: string) => ({ authorization: `Bearer ${t}` });

  it('answers health and lists the systems', async () => {
    const r = await get('/__health');
    expect(r.status).toBe(200);
    expect(r.body.services).toEqual(['erp', 'supplier', 'carrier', 'payroll']);
    expect((await get('/erp/health')).body).toEqual({ ok: true, service: 'erp' });
  });

  it('picks the tenant by the credential, per system', async () => {
    const a = await get('/erp/v1/ping?nonce=n1', bearer(creds.A.erp));
    expect(a.body).toEqual({ ok: true, nonce: 'n1', workspace: 'Alpha Hardware GmbH' });
    const b = await get('/erp/v1/ping?nonce=n2', bearer(creds.B.erp));
    expect(b.body.workspace).toBe('Beta Baustoffe AG');
    // A's supplier key is not an ERP credential.
    expect((await get('/erp/v1/ping', bearer(creds.A.supplier))).status).toBe(401);
    expect((await get('/erp/v1/ping')).body).toEqual({ error: 'missing credential' });
    // B has no payroll: no credential of B opens it.
    expect((await get('/payroll/v1/employees', bearer(creds.B.erp))).status).toBe(401);
    const pay = await get('/payroll/v1/employees', bearer(creds.A.payroll));
    expect(pay.body.employees).toHaveLength(12);
    expect(pay.body.employees[0].employeeId).toBe('A-EMP-001');
  });

  it('pages ERP articles and filters them', async () => {
    const p1 = await get('/erp/v1/articles?status=active&page=1&pageSize=100', bearer(creds.A.erp));
    expect(p1.body).toMatchObject({ page: 1, pageSize: 100, totalItems: 400, totalPages: 4 });
    expect(p1.body.items).toHaveLength(100);
    const p4 = await get('/erp/v1/articles?status=active&page=4&pageSize=500', bearer(creds.A.erp));
    expect(p4.body.pageSize).toBe(100);
    expect(p4.body.items).toHaveLength(100);
    expect((await get('/erp/v1/articles/A-10001', bearer(creds.A.erp))).body.sku).toBe('A-10001');
    expect((await get('/erp/v1/articles/B-10001', bearer(creds.A.erp))).status).toBe(404);
    const orders = await get('/erp/v1/orders?status=shipped', bearer(creds.A.erp));
    expect(orders.body).toMatchObject({ pageSize: 50, totalPages: 2 });
  });

  it('prices SKUs with `unknown` for those the supplier does not carry', async () => {
    const r = await fetch(`${base}/supplier/v1/prices`, {
      method: 'POST',
      headers: { 'x-api-key': creds.A.supplier as string, 'content-type': 'application/json' },
      body: JSON.stringify({ skus: ['A-10018', 'A-10045', 'nope'] }),
    });
    const body = (await r.json()) as any;
    expect(body).toEqual({ currency: 'EUR', prices: { 'A-10018': 202.32 }, unknown: ['A-10045', 'nope'] });
    const tooMany = await fetch(`${base}/supplier/v1/prices`, {
      method: 'POST',
      headers: { 'x-api-key': creds.A.supplier as string },
      body: JSON.stringify({ skus: Array.from({ length: 101 }, (_, i) => `x${i}`) }),
    });
    expect(tooMany.status).toBe(400);
  });

  it('serves the catalogue until it fails from the configured page', async () => {
    const h = { 'x-api-key': creds.A.supplier as string };
    expect((await get('/supplier/v1/catalogue?category=adhesives&page=3', h)).body.items).toHaveLength(37);
    expect((await get('/supplier/v1/catalogue?category=adhesives&page=4', h)).body.items).toHaveLength(0);
    expect((await get('/supplier/v1/catalogue?category=legacy&page=4', h)).status).toBe(200);
    expect((await get('/supplier/v1/catalogue?category=legacy&page=5', h)).status).toBe(503);
    expect((await get('/supplier/v1/catalogue?category=__proto__', h)).status).toBe(404);
  });

  it('serves offers, including the broken category with a price of "n/a"', async () => {
    const h = { 'x-api-key': creds.A.supplier as string };
    const ok = await get('/supplier/v1/offers?category=fasteners', h);
    expect(ok.body.items).toHaveLength(30);
    expect(ok.body.items[0]).toMatchObject({ itemNo: 'A-OFF-FAS-001', price_usd: 54.67, moq: 100 });
    expect(ok.body.items[0].description.trim().replace(/\s+/g, ' ')).toBe('Black Screw 60mm');
    const broken = await get('/supplier/v1/offers?category=broken', h);
    expect(broken.body.items).toHaveLength(5);
    expect(broken.body.items[3].price_usd).toBe('n/a');
    expect((await get('/supplier/v1/account', h)).body).toEqual({
      accountName: 'Alpha Hardware GmbH',
      customerNo: 'A-CUST-4711',
    });
  });

  it('tracks parcels', async () => {
    const r = await get('/carrier/v1/tracking/ATRK000048', bearer(creds.A.carrier));
    expect(r.body).toMatchObject({ status: 'in_transit', lastScanAt: '2026-10-07T21:00:00.000Z' });
    expect((await get('/carrier/v1/tracking/BTRK000001', bearer(creds.A.carrier))).status).toBe(404);
  });

  it('logs every request with service, tenant and status, but never the credential', async () => {
    const since = systems.seq();
    await get('/erp/v1/ping?nonce=logme', bearer(creds.B.erp));
    await get('/payroll/v1/employees', bearer('cbk_payroll_b_forged'));
    await get('/nowhere');
    const log = await get(`/__log?since=${since}`);
    expect(log.body.entries.map((e: any) => [e.service, e.tenant ?? null, e.auth ?? null, e.status])).toEqual([
      ['erp', 'B', 'ok', 200],
      ['payroll', null, 'invalid', 401],
      ['unknown', null, null, 404],
    ]);
    expect(log.body.entries[0].query).toEqual({ nonce: 'logme' });
    expect(JSON.stringify(log.body)).not.toContain(creds.B.erp);
    expect(systems.entries(since)).toHaveLength(3);
  });
  it('clears the request log for the demo reset, keeping the sequence', async () => {
    await get('/erp/v1/ping?nonce=c1', bearer(creds.A.erp));
    expect(systems.requests()).toBeGreaterThan(0);
    const seq = systems.seq();
    const held = systems.entries().length;
    expect(systems.clear()).toBe(held);
    expect(systems.entries()).toEqual([]);
    expect(systems.requests()).toBe(0);
    await get('/erp/v1/ping?nonce=c2', bearer(creds.A.erp));
    expect(systems.requests()).toBe(1);
    expect(systems.entries().map((e) => e.seq)).toEqual([seq + 1]);
  });
});

describe('mock datasets (the kit reference answers)', () => {
  it('reproduces the price drift fixture of workspace A', () => {
    const ds = mockDataset('A');
    const rows = ds.articles
      .filter((a) => a.status === 'active' && ds.supplierPrices[a.sku] !== undefined)
      .map((a) => ({ sku: a.sku, d: Math.round(((ds.supplierPrices[a.sku] - a.purchasePrice) / a.purchasePrice) * 1000) / 10 }))
      .filter((r) => r.d > 5)
      .sort((x, y) => y.d - x.d);
    expect(rows).toEqual([
      { sku: 'A-10234', d: 18 },
      { sku: 'A-10018', d: 12.5 },
      { sku: 'A-10302', d: 7.9 },
      { sku: 'A-10059', d: 6.2 },
    ]);
    expect(ds.articles[233]).toMatchObject({ purchasePrice: 221.41 });
    expect(ds.supplierPrices['A-10234']).toBe(261.26);
  });

  it('keeps the hand-placed fixtures where the kit put them', () => {
    for (const t of ['A', 'B'] as const) {
      const ds = mockDataset(t);
      expect(ds.articles).toHaveLength(450);
      expect(ds.articles.filter((a) => a.status === 'inactive')).toHaveLength(50);
      expect(ds.orders).toHaveLength(120);
    }
  });
});

describe('MockSystemsService', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('does not listen until started', async () => {
    const s = new MockSystemsService();
    expect(s.port()).toBeNull();
    expect(s.requestCount()).toBe(0);
    await s.onModuleDestroy();
  });

  it('listens on loopback when started, once, and stops', async () => {
    process.env.DEMO_PASSWORD_SEED = 'svc-spec';
    process.env.DEMO_MOCK_PORT = '0';
    const s = new MockSystemsService();
    const [port, again] = await Promise.all([s.start(), s.start()]);
    expect(port).toBeGreaterThan(0);
    expect(again).toBe(port);
    expect(s.port()).toBe(port);
    const r = await fetch(`http://127.0.0.1:${port}/__health`);
    expect(r.status).toBe(200);
    await s.stop();
    expect(s.port()).toBeNull();
    await expect(fetch(`http://127.0.0.1:${port}/__health`)).rejects.toThrow();
    // Stopping twice, or destroying after a stop, is harmless.
    await s.stop();
    await s.onModuleDestroy();
  });

  it('can be started again after a stop', async () => {
    process.env.DEMO_PASSWORD_SEED = 'svc-spec';
    process.env.DEMO_MOCK_PORT = '0';
    const s = new MockSystemsService();
    await s.start();
    await s.stop();
    const port = await s.start();
    const r = await fetch(`http://127.0.0.1:${port}/__health`);
    expect(r.status).toBe(200);
    await s.onModuleDestroy();
  });
});
