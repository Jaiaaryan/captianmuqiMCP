import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as http from 'http';
import type { AddressInfo } from 'net';
import {
  DEMO_MOCK_HOST,
  demoCredentials,
  demoMockPort,
  type DemoCredentials,
  type MockService,
} from './demo.config';
import { CATALOGUE_PAGE_SIZE, MOCK_TENANTS, mockDataset, type MockDataset, type MockTenant } from './mock-data';

/**
 * The demo's four mock business systems, in-process, on ONE loopback port:
 *
 *   http://127.0.0.1:<DEMO_MOCK_PORT>/erp/...       Bearer credential
 *   http://127.0.0.1:<DEMO_MOCK_PORT>/supplier/...  X-Api-Key credential
 *   http://127.0.0.1:<DEMO_MOCK_PORT>/carrier/...   Bearer credential
 *   http://127.0.0.1:<DEMO_MOCK_PORT>/payroll/...   Bearer credential
 *   GET /__health, GET /__log?since=<seq>           request log (loopback only)
 *
 * Ported from the CODEBOUND kit's mocks/server.mjs, which runs one port per
 * system; here a path prefix picks the system instead. The tenant (workspace A
 * or B) is picked by the credential, exactly as in the kit, so a request made
 * with workspace A's credential is answered with A's data wherever it came from,
 * and the request log shows it.
 *
 * Note: the four systems share one origin. Level 3 `http.fetch` binds a script
 * to the origins of the connectors it declares, so here that boundary is the
 * port, not the system; the per-system credential is what still separates them.
 */

const LOG_LIMIT = 5_000;
const BODY_LIMIT = 1_000_000;

export interface MockLogEntry {
  seq: number;
  ts: string;
  service: MockService | 'unknown';
  method: string;
  path: string;
  query: Record<string, string>;
  remote: string | undefined;
  auth?: 'ok' | 'invalid' | 'missing';
  tenant?: MockTenant | null;
  status: number;
}

type RouteResult = [number, unknown];
type Route = [
  string,
  RegExp,
  (ds: MockDataset, q: URLSearchParams, m: RegExpMatchArray, body: any) => RouteResult,
];

interface ServiceDef {
  credential: (req: http.IncomingMessage) => string | null;
  routes: Route[];
}

const bearer = (req: http.IncomingMessage) =>
  (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;

const intParam = (v: string | null, def: number, min: number, max: number) => {
  const n = Number.parseInt(v ?? '', 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
};

const SERVICES: Record<MockService, ServiceDef> = {
  erp: {
    credential: bearer,
    routes: [
      ['GET', /^\/v1\/articles$/, (ds, q) => {
        let items = ds.articles;
        if (q.get('status')) items = items.filter((a) => a.status === q.get('status'));
        if (q.get('category')) items = items.filter((a) => a.category === q.get('category'));
        const pageSize = intParam(q.get('pageSize'), 100, 1, 100);
        const page = intParam(q.get('page'), 1, 1, 10_000);
        return [200, {
          page,
          pageSize,
          totalItems: items.length,
          totalPages: Math.ceil(items.length / pageSize),
          items: items.slice((page - 1) * pageSize, page * pageSize),
        }];
      }],
      ['GET', /^\/v1\/articles\/([^/]+)$/, (ds, q, m) => {
        const a = ds.articles.find((x) => x.sku === decodeURIComponent(m[1]));
        return a ? [200, a] : [404, { error: 'article not found' }];
      }],
      ['GET', /^\/v1\/orders$/, (ds, q) => {
        let items = ds.orders;
        if (q.get('status')) items = items.filter((o) => o.status === q.get('status'));
        const pageSize = intParam(q.get('pageSize'), 50, 1, 50);
        const page = intParam(q.get('page'), 1, 1, 10_000);
        return [200, {
          page,
          pageSize,
          totalPages: Math.ceil(items.length / pageSize),
          items: items.slice((page - 1) * pageSize, page * pageSize),
        }];
      }],
      ['GET', /^\/v1\/ping$/, (ds, q) => [200, { ok: true, nonce: q.get('nonce') || null, workspace: ds.company }]],
    ],
  },
  supplier: {
    credential: (req) => {
      const v = req.headers['x-api-key'];
      return (Array.isArray(v) ? v[0] : v) || null;
    },
    routes: [
      ['POST', /^\/v1\/prices$/, (ds, q, m, body) => {
        const skus = Array.isArray(body?.skus) ? body.skus : null;
        if (!skus) return [400, { error: 'body must be {"skus": [...]}' }];
        if (skus.length > 100) return [400, { error: `at most 100 skus per request, got ${skus.length}` }];
        const prices: Record<string, number> = {};
        const unknown: unknown[] = [];
        for (const s of skus) {
          if (typeof s === 'string' && ds.supplierPrices[s] !== undefined) prices[s] = ds.supplierPrices[s];
          else unknown.push(s);
        }
        return [200, { currency: 'EUR', prices, unknown }];
      }],
      // The catalogue never says how many pages there are. A script has to walk
      // until it gets an empty page, and notice when the source fails.
      ['GET', /^\/v1\/catalogue$/, (ds, q) => {
        const category = q.get('category') || '';
        const cat = Object.prototype.hasOwnProperty.call(ds.catalogue, category) ? ds.catalogue[category] : undefined;
        if (!cat) return [404, { error: `unknown category "${category}"`, categories: Object.keys(ds.catalogue) }];
        const page = intParam(q.get('page'), 1, 1, 10_000);
        if (cat.failsFromPage && page >= cat.failsFromPage) return [503, { error: 'upstream timeout, try again later' }];
        return [200, {
          category,
          page,
          items: cat.items.slice((page - 1) * CATALOGUE_PAGE_SIZE, page * CATALOGUE_PAGE_SIZE),
        }];
      }],
      // Offers from a US supplier, prices in USD. Raw on purpose: converting,
      // adding VAT and cleaning the descriptions is Response Processing's job.
      ['GET', /^\/v1\/offers$/, (ds, q) => {
        const category = q.get('category') || '';
        const items = Object.prototype.hasOwnProperty.call(ds.offers, category) ? ds.offers[category] : undefined;
        if (!items) return [404, { error: `unknown category "${category}"`, categories: Object.keys(ds.offers) }];
        return [200, { category, items }];
      }],
      // Deliberately NOT a tool of the connector. Reaching it needs the injected
      // MOCK_SUPPLIER_API_KEY and a direct call (a Level 3 script).
      ['GET', /^\/v1\/account$/, (ds) => [200, { accountName: ds.company, customerNo: ds.customerNo }]],
    ],
  },
  carrier: {
    credential: bearer,
    routes: [
      ['GET', /^\/v1\/tracking\/([^/]+)$/, (ds, q, m) => {
        const no = decodeURIComponent(m[1]);
        const p = Object.prototype.hasOwnProperty.call(ds.parcels, no) ? ds.parcels[no] : undefined;
        return p ? [200, p] : [404, { error: 'unknown tracking number' }];
      }],
      ['GET', /^\/v1\/probe$/, (ds, q) => [200, { ok: true, nonce: q.get('nonce') || null }]],
    ],
  },
  payroll: {
    credential: bearer,
    routes: [['GET', /^\/v1\/employees$/, (ds) => [200, { employees: ds.employees }]]],
  },
};

const SERVICE_NAMES = Object.keys(SERVICES) as MockService[];

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
  res.end(json);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= BODY_LIMIT) chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({ __invalid: raw.slice(0, 200) });
      }
    });
    req.on('error', () => resolve({}));
  });
}

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

export interface MockSystems {
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  /** Entries after `since`, oldest first. */
  entries(since?: number): MockLogEntry[];
  seq(): number;
  /** Requests answered since the start or the last clear(), log routes excluded. */
  requests(): number;
  /** Empties the request log (the demo reset). `seq` keeps counting, so a `since` cursor stays valid. */
  clear(): number;
}

/**
 * The request handler for all four systems plus the log routes. Pure apart from
 * its own log, so the spec can drive it on a random port.
 */
export function createMockSystems(credentials: DemoCredentials): MockSystems {
  const byCredential = new Map<string, { tenant: MockTenant; service: MockService }>();
  for (const tenant of MOCK_TENANTS) {
    for (const [service, value] of Object.entries(credentials[tenant] ?? {})) {
      if (value) byCredential.set(`${service}\u0000${value}`, { tenant, service: service as MockService });
    }
  }
  const tenantFor = (service: MockService, credential: string | null): MockTenant | null | undefined => {
    if (!credential) return null;
    return byCredential.get(`${service}\u0000${credential}`)?.tenant;
  };

  let seq = 0;
  let requests = 0;
  const log: MockLogEntry[] = [];
  const record = (entry: Omit<MockLogEntry, 'seq' | 'ts'>) => {
    requests++;
    log.push({ ...entry, seq: ++seq, ts: new Date().toISOString() });
    if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    // Bound to 127.0.0.1 already; this refuses anything that still is not local.
    if (!isLoopback(req.socket.remoteAddress)) return send(res, 403, { error: 'loopback only' });
    const url = new URL(req.url || '/', 'http://mock');

    if (url.pathname === '/__health') return send(res, 200, { ok: true, services: SERVICE_NAMES, seq });
    if (url.pathname === '/__log' && req.method === 'GET') {
      const since = intParam(url.searchParams.get('since'), 0, 0, Number.MAX_SAFE_INTEGER);
      return send(res, 200, { seq, entries: log.filter((e) => e.seq > since) });
    }

    const m = url.pathname.match(/^\/([a-z]+)(\/.*)?$/);
    const service = m && (SERVICE_NAMES as string[]).includes(m[1]) ? (m[1] as MockService) : null;
    const path = m?.[2] || '/';
    const base = {
      method: req.method || 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      remote: req.socket.remoteAddress,
    };
    if (!service) {
      record({ ...base, service: 'unknown', status: 404 });
      return send(res, 404, { error: `no mock system at ${url.pathname}`, systems: SERVICE_NAMES.map((s) => `/${s}`) });
    }
    if (path === '/health') return send(res, 200, { ok: true, service });

    const svc = SERVICES[service];
    const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : undefined;
    const credential = svc.credential(req);
    const tenant = tenantFor(service, credential);
    const auth = credential ? (tenant ? 'ok' : 'invalid') : 'missing';
    if (!tenant) {
      record({ ...base, service, auth, tenant: null, status: 401 });
      return send(res, 401, { error: credential ? 'invalid credential' : 'missing credential' });
    }
    const ds = mockDataset(tenant);
    for (const [method, re, fn] of svc.routes) {
      const hit = path.match(re);
      if (hit && req.method === method) {
        const [status, payload] = fn(ds, url.searchParams, hit, body);
        record({ ...base, service, auth, tenant, status });
        return send(res, status, payload);
      }
    }
    record({ ...base, service, auth, tenant, status: 404 });
    return send(res, 404, { error: `no route ${req.method} ${path}` });
  };

  return {
    handler: async (req, res) => {
      // A mock must never go down mid-run: that would read as a gateway failure.
      try {
        await handle(req, res);
      } catch {
        if (!res.headersSent) send(res, 500, { error: 'mock internal error' });
      }
    },
    entries: (since = 0) => log.filter((e) => e.seq > since),
    seq: () => seq,
    requests: () => requests,
    clear: () => {
      const n = log.length;
      log.length = 0;
      requests = 0;
      return n;
    },
  };
}

/** Starts the mock systems on 127.0.0.1:<port>; resolves with the bound port. */
export function listenMockSystems(
  systems: MockSystems,
  port: number,
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => void systems.handler(req, res));
    server.once('error', reject);
    server.listen(port, DEMO_MOCK_HOST, () => {
      server.off('error', reject);
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

/**
 * Runs the mock systems while demo mode is on (self-hosted only). Nothing
 * listens otherwise: DemoControlService starts them when demo mode is turned
 * on (at boot or by the switch) and stops them when it is turned off.
 */
@Injectable()
export class MockSystemsService implements OnModuleDestroy {
  private readonly logger = new Logger(MockSystemsService.name);
  private server: http.Server | null = null;
  private systems: MockSystems | null = null;
  private boundPort: number | null = null;
  private starting: Promise<number> | null = null;

  /** Starts listening (idempotent); resolves with the bound port. */
  start(): Promise<number> {
    if (this.boundPort !== null) return Promise.resolve(this.boundPort);
    this.starting ??= (async () => {
      try {
        const systems = createMockSystems(demoCredentials());
        const { server, port } = await listenMockSystems(systems, demoMockPort());
        this.systems = systems;
        this.server = server;
        this.boundPort = port;
        this.logger.log(
          `Demo mock systems listening on http://${DEMO_MOCK_HOST}:${port} (erp, supplier, carrier, payroll)`,
        );
        return port;
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  /** Stops listening and drops the request log (idempotent). */
  async stop(): Promise<void> {
    const server = this.server;
    const port = this.boundPort;
    this.server = null;
    this.systems = null;
    this.boundPort = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    this.logger.log(`Demo mock systems on port ${port} stopped`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /** The port the mocks are bound to, or null when they are not running. */
  port(): number | null {
    return this.boundPort;
  }

  entries(since = 0): MockLogEntry[] {
    return this.systems?.entries(since) ?? [];
  }

  /** Requests the mocks answered since boot or the last reset. */
  requestCount(): number {
    return this.systems?.requests() ?? 0;
  }

  /** Empties the request log; returns how many entries it held. */
  clearLog(): number {
    return this.systems?.clear() ?? 0;
  }
}
