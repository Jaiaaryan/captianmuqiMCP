import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SandboxService } from './sandbox.service';
import { runWithCapabilities, type ScriptRunCapabilities } from './script-http';
import type {
  SandboxHttpRequest,
  SandboxHttpResponse,
  SandboxInvocationContext,
  SandboxRunRequest,
} from './types';

jest.setTimeout(30_000);

const SUPPLIER = 'http://supplier.test:4102';
const KEY = 'cbk_supplier_a_0123456789abcdef';

const context: SandboxInvocationContext = {
  userId: 'user-1',
  organizationId: 'org-a',
  authMethod: 'jwt',
  mcpServerId: 'server-1',
  mcpServerName: 'Alpha',
  connectorIds: ['c-supplier'],
};

function request(code: string, extra: Partial<SandboxRunRequest> = {}): SandboxRunRequest {
  return {
    code,
    allowedTools: [],
    invocationContext: context,
    executeTool: async () => ({ content: [{ type: 'text', text: 'null' }] }),
    ...extra,
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): SandboxHttpResponse => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: Buffer.from(JSON.stringify(body)),
});

function capabilities(
  send: jest.Mock,
  over: Partial<ScriptRunCapabilities> = {},
  origins: [string, string][] = [[SUPPLIER, 'Mock Supplier']],
): ScriptRunCapabilities {
  return {
    env: { MOCK_SUPPLIER_URL: SUPPLIER, MOCK_SUPPLIER_API_KEY: KEY },
    http: { origins: new Map(origins), allowWrites: false, send },
    secrets: [KEY],
    ...over,
  };
}

describe('Level 3: env and http.fetch', () => {
  let sandbox: SandboxService;
  const savedGuard = process.env.SSRF_GUARD;

  beforeEach(() => {
    sandbox = new SandboxService();
  });
  afterEach(() => {
    if (savedGuard === undefined) delete process.env.SSRF_GUARD;
    else process.env.SSRF_GUARD = savedGuard;
  });

  describe('env', () => {
    it('does not exist without the capability (inline code, Level 2)', async () => {
      const r = await runWithCapabilities(sandbox, request("return [typeof env, typeof http].join('/');"), null);
      expect(r).toMatchObject({ ok: true, result: 'undefined/undefined' });
    });

    it('holds exactly the variables the host passed in, frozen', async () => {
      const send = jest.fn();
      const r = await runWithCapabilities(
        sandbox,
        request(
          "'use strict';\n" +
            'let threw = false; try { env.MOCK_SUPPLIER_URL = "x"; } catch (e) { threw = true; }\n' +
            'return { keys: Object.keys(env).sort(), other: typeof env.MOCK_ERP_TOKEN, url: env.MOCK_SUPPLIER_URL, threw, frozen: Object.isFrozen(env) };',
        ),
        capabilities(send, { http: undefined }),
      );
      expect(r.result).toEqual({
        keys: ['MOCK_SUPPLIER_API_KEY', 'MOCK_SUPPLIER_URL'],
        other: 'undefined',
        url: SUPPLIER,
        threw: true,
        frozen: true,
      });
    });

    it('gives http without env when only http is on', async () => {
      const send = jest.fn();
      const r = await runWithCapabilities(
        sandbox,
        request("return [typeof env, typeof http.fetch, typeof fetch].join('/');"),
        capabilities(send, { env: undefined }),
      );
      expect(r.result).toBe('undefined/function/undefined');
    });
  });

  describe('http.fetch', () => {
    it('reaches a declared origin and returns status, headers, text and json', async () => {
      const send = jest.fn(async (_req: SandboxHttpRequest) =>
        json(200, { accountName: 'Alpha Hardware GmbH', customerNo: 'A-CUST-4711' }, { 'set-cookie': 'sid=1', 'X-Trace': 't' }),
      );
      const r = await runWithCapabilities(
        sandbox,
        request(
          'const r = await http.fetch(`${env.MOCK_SUPPLIER_URL}/v1/account?page=1`, { headers: { "X-Api-Key": env.MOCK_SUPPLIER_API_KEY } });\n' +
            'return { status: r.status, name: r.json.accountName, headers: r.headers, isText: typeof r.text };',
        ),
        capabilities(send),
      );
      expect(r.ok).toBe(true);
      expect(r.result).toEqual({
        status: 200,
        name: 'Alpha Hardware GmbH',
        headers: { 'content-type': 'application/json', 'x-trace': 't' },
        isText: 'string',
      });
      expect(send).toHaveBeenCalledTimes(1);
      const sent = send.mock.calls[0][0];
      expect(sent).toMatchObject({ url: `${SUPPLIER}/v1/account?page=1`, method: 'GET', headers: { 'X-Api-Key': KEY } });
      // Counted as a connector call; recorded without the query string or headers.
      expect(r.meta.connectorCalls).toBe(1);
      expect(r.meta.httpCalls).toEqual([{ origin: SUPPLIER, path: '/v1/account', status: 200, bytes: expect.any(Number) }]);
      expect(r.meta.bytesFromConnectors).toBeGreaterThan(0);
    });

    it('refuses an origin no declared connector has, before any connection (A5)', async () => {
      const send = jest.fn();
      for (const url of ['http://localhost:4199/', 'http://127.0.0.1:4199/x', 'https://supplier.test:4102/v1', 'http://supplier.test:4103/']) {
        const r = await runWithCapabilities(sandbox, request(`return await http.fetch(${JSON.stringify(url)});`), capabilities(send));
        expect(r.ok).toBe(false);
        expect(r.error?.code).toBe('HTTP_NOT_ALLOWED');
        expect(r.error?.message).toContain(new URL(url).origin);
      }
      expect(send).not.toHaveBeenCalled();
    });

    it('refuses the cloud metadata address, as an undeclared origin and through the SSRF guard (A4)', async () => {
      const send = jest.fn();
      const undeclared = await runWithCapabilities(
        sandbox,
        request('return await http.fetch("http://169.254.169.254/latest/meta-data/");'),
        capabilities(send),
      );
      expect(undeclared.error?.code).toBe('HTTP_NOT_ALLOWED');

      // A connector whose base URL points there passes the origin check; the
      // SSRF guard on the host still refuses it.
      process.env.SSRF_GUARD = 'enabled';
      const declared = await runWithCapabilities(
        sandbox,
        request('return await http.fetch("http://169.254.169.254/latest/meta-data/");'),
        capabilities(send, {}, [['http://169.254.169.254', 'Metadata']]),
      );
      expect(declared.error?.code).toBe('HTTP_NOT_ALLOWED');
      expect(declared.error?.message).toMatch(/SSRF guard/);
      expect(declared.meta.httpCalls).toEqual([
        { origin: 'http://169.254.169.254', path: '/latest/meta-data/', status: 0, bytes: 0 },
      ]);
      expect(send).not.toHaveBeenCalled();
    });

    it('refuses URLs that are not absolute http(s) or that carry user info', async () => {
      const send = jest.fn();
      for (const url of ['/v1/account', 'file:///etc/passwd', `http://u:p@supplier.test:4102/`]) {
        const r = await runWithCapabilities(sandbox, request(`return await http.fetch(${JSON.stringify(url)});`), capabilities(send));
        expect(r.error?.code).toBe('HTTP_NOT_ALLOWED');
      }
      expect(send).not.toHaveBeenCalled();
    });

    it('is read-only unless writes are allowed', async () => {
      const send = jest.fn(async (_req: SandboxHttpRequest) => json(201, { ok: true }));
      const code = `const r = await http.fetch("${SUPPLIER}/v1/prices", { method: "POST", body: { skus: ["A"] } }); return r.status;`;
      const refused = await runWithCapabilities(sandbox, request(code), capabilities(send));
      expect(refused.error?.code).toBe('WRITE_NOT_ALLOWED');
      expect(send).not.toHaveBeenCalled();

      const caps = capabilities(send);
      caps.http!.allowWrites = true;
      const allowed = await runWithCapabilities(sandbox, request(code), caps);
      expect(allowed.result).toBe(201);
      expect(send.mock.calls[0][0]).toMatchObject({
        method: 'POST',
        body: '{"skus":["A"]}',
        headers: { 'content-type': 'application/json' },
      });
    });

    it('counts against the connector call limit', async () => {
      const send = jest.fn(async () => json(200, {}));
      const r = await runWithCapabilities(
        sandbox,
        request(`for (let i = 0; i < 5; i++) await http.fetch("${SUPPLIER}/v1/ping"); return 'done';`, {
          limits: { maxConnectorCalls: 3 },
        }),
        capabilities(send),
      );
      expect(r.error?.code).toBe('CONNECTOR_CALL_LIMIT');
      expect(send).toHaveBeenCalledTimes(3);
    });

    it('enforces the per-response byte cap', async () => {
      const send = jest.fn(async () => ({ status: 200, headers: {}, body: Buffer.alloc(2048, 'a') }));
      const r = await runWithCapabilities(
        sandbox,
        request(`return (await http.fetch("${SUPPLIER}/big")).text.length;`, { limits: { maxConnectorResponseBytes: 1024 } }),
        capabilities(send),
      );
      expect(r.error?.code).toBe('CONNECTOR_BYTES_LIMIT');
    });
  });

  describe('the real outbound client', () => {
    let server: http.Server;
    let origin: string;
    const hits: string[] = [];

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        hits.push(req.url ?? '');
        if (req.url === '/redirect') {
          res.writeHead(302, { location: '/target', 'set-cookie': 'sid=secret' });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=secret' });
        res.end(JSON.stringify({ path: req.url, key: req.headers['x-api-key'] ?? null }));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      // The outbound client keeps connections alive; close them with the server.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    beforeEach(() => {
      hits.length = 0;
    });

    const realCaps = (): ScriptRunCapabilities => ({
      env: { BASE: origin, KEY },
      http: { origins: new Map([[origin, 'Local']]), allowWrites: false },
      secrets: [KEY],
    });

    it('does not follow redirects: the 3xx comes back to the script', async () => {
      const r = await runWithCapabilities(
        sandbox,
        request('const r = await http.fetch(env.BASE + "/redirect"); return { status: r.status, location: r.headers.location, cookie: r.headers["set-cookie"] };'),
        realCaps(),
      );
      expect(r.result).toEqual({ status: 302, location: '/target' });
      expect(hits).toEqual(['/redirect']);
    });

    it('sends the request and masks the key the server echoes back', async () => {
      const r = await runWithCapabilities(
        sandbox,
        request('const r = await http.fetch(env.BASE + "/v1/account", { headers: { "X-Api-Key": env.KEY } }); return r.json;'),
        realCaps(),
      );
      expect(r.result).toEqual({ path: '/v1/account', key: '***' });
      expect(hits).toEqual(['/v1/account']);
    });
  });

  describe('masking (A13)', () => {
    const send = jest.fn();

    it('masks a secret in the result', async () => {
      const r = await runWithCapabilities(sandbox, request('return { k: env.MOCK_SUPPLIER_API_KEY, list: [env.MOCK_SUPPLIER_API_KEY] };'), capabilities(send));
      expect(r.result).toEqual({ k: '***', list: ['***'] });
      expect(JSON.stringify(r)).not.toContain(KEY);
    });

    it('masks a secret in console.log output', async () => {
      const r = await runWithCapabilities(
        sandbox,
        request('console.log("key", env.MOCK_SUPPLIER_API_KEY); console.log({ k: env.MOCK_SUPPLIER_API_KEY }); return 1;'),
        capabilities(send),
      );
      expect(r.meta.logs).toEqual(['key ***', '{"k":"***"}']);
    });

    it('masks a secret in a thrown error', async () => {
      const r = await runWithCapabilities(sandbox, request('throw new Error("bad key " + env.MOCK_SUPPLIER_API_KEY);'), capabilities(send));
      expect(r.ok).toBe(false);
      expect(r.error?.message).toContain('bad key ***');
      expect(JSON.stringify(r)).not.toContain(KEY);
    });

    it('masks encoded forms', async () => {
      const r = await runWithCapabilities(
        sandbox,
        request('return [encodeURIComponent(env.MOCK_SUPPLIER_API_KEY), JSON.stringify({ k: env.MOCK_SUPPLIER_API_KEY })];'),
        capabilities(send),
      );
      expect(r.result).toEqual(['***', '{"k":"***"}']);
    });

    it('masks secrets of declared connectors even when they were not injected', async () => {
      const r = await runWithCapabilities(
        sandbox,
        request(`return "token ${KEY}";`),
        { secrets: [KEY] },
      );
      expect(r.result).toBe('token ***');
    });
  });
});
