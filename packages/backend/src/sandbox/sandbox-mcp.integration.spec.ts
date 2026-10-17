import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { Logger } from '@nestjs/common';
import { McpEndpointController } from '../mcp-server/mcp-endpoint.controller';
import { SandboxService } from './sandbox.service';
import { SANDBOX_TOOL_NAMES } from './sandbox-tools';

/**
 * Code mode through the real MCP stack: planToolSet registers the tools on a
 * real McpServer and a real MCP Client calls them, so the SDK's own input
 * validation and outputSchema handling are exercised, not mocked.
 */

const SERVER_ORG = 'org-A';

const orderRows = Array.from({ length: 3000 }, (_, i) => ({
  id: i,
  status: i % 4 === 0 ? 'delayed' : 'ok',
  amount: i % 100,
}));

const tool = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  connectorId: `conn-${id}`,
  organizationId: SERVER_ORG,
  name,
  description: `${name}. Longer text that must not appear in the signature comment.`,
  parameters: { type: 'object', properties: { limit: { type: 'number' } } },
  connectorType: 'DATABASE',
  connectorConfig: { envVars: {} },
  endpointMapping: { method: 'query', path: 'SELECT 1' },
  outputSchema: { type: 'array', items: { type: 'object', properties: { id: { type: 'number' } } } },
  ...extra,
});

const ORDERS = tool('t1', 'erp_orders_list');
const CUSTOMERS = tool('t2', 'erp_customers_list');

function makeController(opts: { withSandbox?: boolean } = {}) {
  const withSandbox = opts.withSandbox ?? true;
  const executeTool = jest.fn(async (name: string) => ({
    content: [{ type: 'text' as const, text: 'ignored' }],
    structured: name === 'erp_orders_list' ? orderRows : [{ id: 'c1' }],
  }));
  const scripts = {
    getByName: jest.fn(async (): Promise<any> => null),
    create: jest.fn(async (_o: string, _s: string, _u: any, input: any) => ({ id: 'sc-1', version: 1, ...input })),
    updateByName: jest.fn(),
    list: jest.fn(async () => []),
    recordRun: jest.fn(async () => 'run-1'),
  };
  const controller = new McpEndpointController(
    { findById: jest.fn() } as any,
    { getAllTools: jest.fn().mockReturnValue([]) } as any,
    { executeTool } as any,
    { getAllowedToolIds: jest.fn() } as any,
    { lookup: jest.fn(), isEnabled: jest.fn(), captureIntentEnabled: jest.fn() } as any,
    { get: jest.fn(), add: jest.fn(), remove: jest.fn() } as any,
    { resolve: jest.fn().mockResolvedValue(null) } as any,
    { create: jest.fn() } as any,
    undefined,
    withSandbox ? new SandboxService() : undefined,
    withSandbox ? (scripts as any) : undefined,
  );
  return { controller, executeTool, scripts };
}

const baseParams = (over: Record<string, unknown> = {}) => ({
  serverTools: [ORDERS, CUSTOMERS],
  allowedToolIds: null,
  captureIntent: false,
  kgEnabled: false,
  invocationContext: {
    userId: 'u1',
    organizationId: SERVER_ORG,
    authMethod: 'api-key',
    mcpServerId: 'srv-A',
    mcpServerName: 'koch-demo',
    connectorIds: ['conn-t1', 'conn-t2'],
  },
  sandboxOrganizationId: SERVER_ORG,
  ...over,
});

const names = (entries: Array<{ name: string }>) => entries.map((e) => e.name);

async function connect(entries: Array<{ register: (s: McpServer) => unknown }>) {
  const server = new McpServer({ name: 'spec', version: '1.0.0' });
  for (const e of entries) e.register(server);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'spec', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

describe('code mode through planToolSet', () => {
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug']));

  const originalEnv = process.env.SANDBOX_ENABLED;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.SANDBOX_ENABLED;
    else process.env.SANDBOX_ENABLED = originalEnv;
  });

  describe('when the sandbox tools are offered', () => {
    it('appends the four sandbox tools after the connector tools', () => {
      const { controller } = makeController();
      const entries = (controller as any).planToolSet(baseParams());
      expect(names(entries)).toEqual(['erp_orders_list', 'erp_customers_list', ...SANDBOX_TOOL_NAMES]);
    });

    it('does not offer them on a surface that did not supply the owning organization (the public demo)', () => {
      const { controller } = makeController();
      const entries = (controller as any).planToolSet(
        baseParams({
          sandboxOrganizationId: undefined,
          invocationContext: {
            organizationId: SERVER_ORG,
            authMethod: 'demo',
            mcpServerId: 'srv-demo',
            mcpServerName: 'demo',
            connectorIds: [],
          },
          resultFooter: 'served by the demo',
        }),
      );
      expect(names(entries).filter((n) => n.startsWith('sandbox_'))).toEqual([]);
    });

    it('honours the SANDBOX_ENABLED=false kill switch', () => {
      process.env.SANDBOX_ENABLED = 'false';
      const { controller } = makeController();
      const entries = (controller as any).planToolSet(baseParams());
      expect(names(entries)).toEqual(['erp_orders_list', 'erp_customers_list']);
    });

    it('is off, not broken, when the sandbox module is not wired', () => {
      const { controller } = makeController({ withSandbox: false });
      const entries = (controller as any).planToolSet(baseParams());
      expect(names(entries)).toEqual(['erp_orders_list', 'erp_customers_list']);
    });

    it('does not register a sandbox tool whose name a connector already uses', async () => {
      const { controller } = makeController();
      const clash = tool('t9', 'sandbox_list_scripts');
      const entries = (controller as any).planToolSet(baseParams({ serverTools: [ORDERS, clash] }));
      const count = names(entries).filter((n) => n === 'sandbox_list_scripts').length;
      expect(count).toBe(1);
      // Registering every entry on a real server must not throw on a duplicate.
      const client = await connect(entries);
      const listed = (await client.listTools()).tools.map((t) => t.name);
      expect(listed.filter((n) => n === 'sandbox_list_scripts')).toHaveLength(1);
    });

    it('leaves the whole feature off when a connector owns the run tool\'s name', () => {
      const { controller } = makeController();
      const clash = tool('t9', 'sandbox_run_script');
      const entries = (controller as any).planToolSet(baseParams({ serverTools: [clash] }));
      expect(names(entries)).toEqual(['sandbox_run_script']);
    });

    it('changes the signature of the run tool when the visible tool set changes', () => {
      const { controller } = makeController();
      const sigOf = (serverTools: unknown[]) =>
        (controller as any)
          .planToolSet(baseParams({ serverTools }))
          .find((e: any) => e.name === 'sandbox_run_script').sig;
      expect(sigOf([ORDERS, CUSTOMERS])).toBe(sigOf([ORDERS, CUSTOMERS]));
      expect(sigOf([ORDERS, CUSTOMERS])).not.toBe(sigOf([ORDERS]));
    });
  });

  describe('as an MCP client sees them', () => {
    it('lists the tools with the callable API in the run tool\'s description', async () => {
      const { controller } = makeController();
      const client = await connect((controller as any).planToolSet(baseParams()));
      const listed = (await client.listTools()).tools;

      const run = listed.find((t) => t.name === 'sandbox_run_script')!;
      expect(run.description).toContain('tools.erp_orders_list({ limit?: number })');
      expect(run.description).toContain('tools.erp_customers_list(');
      expect(run.description).not.toContain('Longer text that must not appear');
      expect(run.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
      expect(Object.keys(run.inputSchema.properties ?? {}).sort()).toEqual(['args', 'code', 'scriptName', 'timeoutMs']);
      expect(listed.find((t) => t.name === 'sandbox_list_scripts')!.annotations?.readOnlyHint).toBe(true);
    });

    it('answers a question from 3000 rows with a tiny result and reports what stayed server-side', async () => {
      const { controller, executeTool, scripts } = makeController();
      const client = await connect((controller as any).planToolSet(baseParams()));

      const res: any = await client.callTool({
        name: 'sandbox_run_script',
        arguments: {
          code: `const r = await tools.erp_orders_list({ limit: 5000 });
                 return { delayed: r.filter(o => o.status === 'delayed').length, total: r.length };`,
        },
      });

      expect(res.isError).toBeFalsy();
      expect(res.structuredContent.result).toEqual({
        delayed: orderRows.filter((o) => o.status === 'delayed').length,
        total: 3000,
      });
      expect(res.structuredContent.meta).toMatchObject({ connectorCalls: 1, toolsCalled: ['erp_orders_list'] });
      expect(res.structuredContent.meta.bytesFromConnectors).toBeGreaterThan(100_000);
      expect(res.content[0].text.length).toBeLessThan(600);
      // The connector call carries the session's own scope, set by the server.
      expect(executeTool).toHaveBeenCalledWith(
        'erp_orders_list',
        { limit: 5000 },
        expect.objectContaining({ organizationId: SERVER_ORG, userId: 'u1', connectorIds: ['conn-t1'] }),
      );
      expect(scripts.recordRun).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: SERVER_ORG, mcpServerId: 'srv-A', userId: 'u1' }),
      );
    });

    it('returns a failure with a code and a hint, flagged as an error', async () => {
      const { controller } = makeController();
      const client = await connect((controller as any).planToolSet(baseParams()));
      const res: any = await client.callTool({
        name: 'sandbox_run_script',
        arguments: { code: 'return await tools.erp_orders_list({})' },
      });
      expect(res.isError).toBe(true);
      expect(res.structuredContent.ok).toBe(false);
      expect(res.structuredContent.error.code).toBe('OUTPUT_TOO_LARGE');
      expect(res.structuredContent.error.hint).toMatch(/rows\.slice/);
      expect(res.structuredContent.meta.bytesReturned).toBe(0);
      expect(res.content[0].text.length).toBeLessThan(1500);
    });

    it('shows the isolation to an agent that tries to leave it', async () => {
      const { controller, executeTool } = makeController();
      const client = await connect((controller as any).planToolSet(baseParams()));
      const probe = async (code: string): Promise<any> =>
        client.callTool({ name: 'sandbox_run_script', arguments: { code } });

      const host: any = await probe(`return [typeof require, typeof process, typeof fetch, typeof WebSocket].join()`);
      expect(host.structuredContent.result).toBe('undefined,undefined,undefined,undefined');

      const unknown: any = await probe(`return await tools.other_org_customers_list({})`);
      expect(unknown.structuredContent.error.code).toBe('TOOL_NOT_ALLOWED');

      const spin: any = await client.callTool({
        name: 'sandbox_run_script',
        arguments: { code: 'while(true){}', timeoutMs: 1000 },
      });
      expect(spin.structuredContent.error.code).toBe('TIMEOUT');
      expect(executeTool).not.toHaveBeenCalled();
    });

    it('lets a script call only the tools the role allows', async () => {
      const { controller, executeTool } = makeController();
      const entries = (controller as any).planToolSet(
        baseParams({ allowedToolIds: [ORDERS.id] }), // CUSTOMERS filtered out by role
      );
      expect(names(entries)).not.toContain('erp_customers_list');
      const client = await connect(entries);

      const listed = (await client.listTools()).tools.find((t) => t.name === 'sandbox_run_script')!;
      expect(listed.description).not.toContain('erp_customers_list');

      const res: any = await client.callTool({
        name: 'sandbox_run_script',
        arguments: { code: 'return await tools.erp_customers_list({})' },
      });
      expect(res.structuredContent.error.code).toBe('TOOL_NOT_ALLOWED');
      expect(executeTool).not.toHaveBeenCalled();
    });

    it('rejects out-of-range input before any handler runs', async () => {
      const { controller, scripts } = makeController();
      const client = await connect((controller as any).planToolSet(baseParams()));
      const tooShort: any = await client
        .callTool({ name: 'sandbox_run_script', arguments: { code: 'return 1', timeoutMs: 5 } })
        .catch((e) => ({ isError: true, thrown: String(e) }));
      expect(tooShort.isError).toBe(true);
      const badName: any = await client
        .callTool({ name: 'sandbox_create_script', arguments: { name: 'Bad Name', code: 'return 1' } })
        .catch((e) => ({ isError: true, thrown: String(e) }));
      expect(badName.isError).toBe(true);
      expect(scripts.create).not.toHaveBeenCalled();
    });

    it('creates a script, syntax-checks it, and reruns it by name', async () => {
      const { controller, scripts } = makeController();
      const client = await connect((controller as any).planToolSet(baseParams()));

      const created: any = await client.callTool({
        name: 'sandbox_create_script',
        arguments: { name: 'delayed_orders', code: 'return { n: 1 }', description: 'Delayed orders' },
      });
      expect(JSON.parse(created.content[0].text)).toMatchObject({ ok: true, name: 'delayed_orders', syntax: 'ok' });
      expect(scripts.create).toHaveBeenCalledWith(SERVER_ORG, 'srv-A', 'u1', expect.objectContaining({ name: 'delayed_orders' }));

      const broken: any = await client.callTool({
        name: 'sandbox_create_script',
        arguments: { name: 'broken', code: 'return {' },
      });
      expect(JSON.parse(broken.content[0].text).syntax).toMatchObject({ line: expect.any(Number) });

      scripts.getByName.mockResolvedValueOnce({ id: 'sc-1', code: 'return { rerun: args.month }' });
      const rerun: any = await client.callTool({
        name: 'sandbox_run_script',
        arguments: { scriptName: 'delayed_orders', args: { month: 'previous' } },
      });
      expect(rerun.structuredContent.result).toEqual({ rerun: 'previous' });
    });
  });
});
