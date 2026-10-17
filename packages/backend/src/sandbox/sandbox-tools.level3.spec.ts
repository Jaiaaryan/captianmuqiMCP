import { Logger } from '@nestjs/common';
import { buildSandboxToolEntries } from './sandbox-tools';
import type { ExposedScript } from './sandbox-scripts.service';
import type { SandboxInvocationContext, SandboxRunResult, SandboxTool, SandboxToolResult } from './types';

const KEY = 'cbk_supplier_a_0123456789abcdef';

const ctx: SandboxInvocationContext = {
  userId: 'user-1',
  organizationId: 'org-a',
  authMethod: 'api-key',
  mcpServerId: 'srv-1',
  mcpServerName: 'Alpha',
  connectorIds: ['c-supplier'],
};

const TOOLS: SandboxTool[] = [
  { name: 'mock_supplier_get_prices', connectorId: 'c-supplier', description: 'Prices', parameters: { type: 'object' }, readOnly: true },
];
const USES = [{ connectorId: 'c-supplier', connectorName: 'Mock Supplier', connectorExists: true, tools: ['mock_supplier_get_prices'] }];

const exposed: ExposedScript = {
  id: 'sc-1',
  name: 'supplier_account',
  description: 'Account at the supplier',
  version: 1,
  parameters: { type: 'object', properties: { note: { type: 'string', 'x-keep': true } as any }, required: [] },
  uses: USES,
};

const meta = { ms: 1, connectorCalls: 1, bytesFromConnectors: 10, bytesReturned: 10, logs: [`sent ${KEY}`], toolsCalled: [] };

function setup(saved: Record<string, unknown>, runCapabilities?: jest.Mock) {
  const sandbox = {
    run: jest.fn(async (_req: any): Promise<SandboxRunResult> => ({ ok: true, result: { key: KEY, name: 'Alpha' }, meta })),
    checkSyntax: jest.fn(),
  };
  const capabilities = {
    env: { MOCK_SUPPLIER_API_KEY: KEY },
    http: { origins: new Map([['http://localhost:4102', 'Mock Supplier']]), allowWrites: false },
    secrets: [KEY],
  };
  const scripts = {
    getByName: jest.fn(async () => ({
      id: 'sc-1',
      name: 'supplier_account',
      version: 1,
      code: 'return 1',
      createdById: 'user-1',
      uses: USES,
      ...saved,
    })),
    list: jest.fn(),
    recordRun: jest.fn(async () => 'run-1'),
    runCapabilities: runCapabilities ?? jest.fn(async () => capabilities),
  };
  const executeTool = jest.fn(async (): Promise<SandboxToolResult> => ({ content: [] }));
  const entries = buildSandboxToolEntries(
    { sandbox: sandbox as any, scripts: scripts as any, executeTool },
    { storageOrganizationId: 'org-a', invocationContext: ctx },
    TOOLS,
    [exposed],
  );
  const handlers = new Map<string, { config: any; handler: (input: any) => Promise<any> }>();
  const fakeServer = {
    registerTool: jest.fn((name: string, config: any, handler: any) => {
      handlers.set(name, { config, handler });
      return { remove: jest.fn() };
    }),
  };
  for (const e of entries) e.register(fakeServer as any);
  return { sandbox, scripts, handlers };
}

describe('buildSandboxToolEntries: Level 3 scripts', () => {
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug']));

  it('runs a saved script that has capabilities with env and http, and masks its secrets everywhere', async () => {
    const { sandbox, scripts, handlers } = setup({ capabilities: { env: true, http: true } });
    const out = await handlers.get('supplier_account')!.handler({});

    expect(scripts.runCapabilities).toHaveBeenCalledWith(
      'org-a',
      { capabilities: { env: true, http: true }, uses: USES },
      TOOLS,
      { allowWrites: false },
    );
    const req = sandbox.run.mock.calls[0][0];
    expect(req.env).toEqual({ MOCK_SUPPLIER_API_KEY: KEY });
    expect([...req.http.origins.keys()]).toEqual(['http://localhost:4102']);

    expect(JSON.stringify(out)).not.toContain(KEY);
    expect(out.structuredContent).toEqual({ key: '***', name: 'Alpha' });
    const stored = (scripts.recordRun.mock.calls[0] as any[])[0].result as SandboxRunResult;
    expect(JSON.stringify(stored)).not.toContain(KEY);
    expect(stored.meta.logs).toEqual(['sent ***']);
  });

  it('does not put any secret in the exposed tool\'s description or schema', () => {
    const { handlers } = setup({ capabilities: { env: true, http: true } });
    const { config } = handlers.get('supplier_account')!;
    expect(JSON.stringify({ d: config.description, a: config.annotations })).not.toContain(KEY);
  });

  it('never gives inline code capabilities', async () => {
    const { sandbox, scripts, handlers } = setup({ capabilities: { env: true, http: true } });
    await handlers.get('sandbox_run_script')!.handler({ code: 'return typeof env' });
    expect(scripts.runCapabilities).not.toHaveBeenCalled();
    const req = sandbox.run.mock.calls[0][0];
    expect(req.env).toBeUndefined();
    expect(req.http).toBeUndefined();
  });

  it('runs a Level 2 saved script as before', async () => {
    const { sandbox, scripts, handlers } = setup({ capabilities: null });
    await handlers.get('sandbox_run_script')!.handler({ scriptName: 'supplier_account' });
    expect(scripts.runCapabilities).not.toHaveBeenCalled();
    expect(sandbox.run.mock.calls[0][0].env).toBeUndefined();
  });

  it('fails closed when the capabilities cannot be prepared', async () => {
    const failing = jest.fn(async () => {
      throw new Error('db down');
    });
    const { sandbox, handlers } = setup({ capabilities: { env: true } }, failing);
    const out = await handlers.get('supplier_account')!.handler({});
    expect(out.isError).toBe(true);
    expect(sandbox.run).not.toHaveBeenCalled();
  });
});
