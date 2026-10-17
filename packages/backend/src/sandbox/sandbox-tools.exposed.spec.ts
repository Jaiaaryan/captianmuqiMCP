import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { buildSandboxToolEntries, SANDBOX_TOOL_NAMES } from './sandbox-tools';
import type { ExposedScript } from './sandbox-scripts.service';
import type {
  SandboxInvocationContext,
  SandboxRunResult,
  SandboxTool,
  SandboxToolResult,
} from './types';

const SERVER_ORG = 'org-server';

const ctx: SandboxInvocationContext = {
  userId: 'user-1',
  organizationId: 'org-caller',
  authMethod: 'api-key',
  mcpServerId: 'srv-1',
  mcpServerName: 'shop',
  connectorIds: ['conn-1'],
};

const TOOLS: SandboxTool[] = [
  { name: 'orders_list', connectorId: 'conn-1', description: 'List', parameters: { type: 'object' }, readOnly: true },
  { name: 'items_list', connectorId: 'conn-1', description: 'List', parameters: { type: 'object' }, readOnly: true },
];

const USES = [{ connectorId: 'conn-1', connectorName: 'ERP', connectorExists: true, tools: ['orders_list'] }];

const exposed = (over: Partial<ExposedScript> = {}): ExposedScript => ({
  id: 'sc-1',
  name: 'stuck_orders',
  description: 'Orders stuck for N days',
  version: 4,
  parameters: {
    type: 'object',
    properties: {
      days: { type: 'number', description: 'Look-back window' },
      as_of: { type: 'string' },
    },
    required: ['days'],
  },
  uses: USES,
  ...over,
});

const okMeta = { ms: 5, connectorCalls: 1, bytesFromConnectors: 900, bytesReturned: 12, logs: [], toolsCalled: [] };

type Handler = (input: any, handlerContext?: any) => Promise<any>;

function setup(
  scriptsToExpose: ExposedScript[] = [exposed()],
  overrides: {
    runResult?: SandboxRunResult;
    reauthorize?: () => Promise<SandboxTool[]>;
    saved?: any;
  } = {},
) {
  const sandbox = {
    run: jest.fn(
      async (_request?: any): Promise<SandboxRunResult> =>
        overrides.runResult ?? { ok: true, result: [{ id: 1 }], meta: okMeta },
    ),
    checkSyntax: jest.fn(),
  };
  const scripts = {
    getByName: jest.fn(async (_org: string, name: string): Promise<any> =>
      overrides.saved === undefined
        ? { id: 'sc-1', name, version: 4, code: 'return args.days', createdById: 'user-1', uses: USES }
        : overrides.saved,
    ),
    list: jest.fn(),
    recordRun: jest.fn(async () => 'run-1'),
  };
  const executeTool = jest.fn(async (): Promise<SandboxToolResult> => ({ content: [] }));
  const entries = buildSandboxToolEntries(
    { sandbox: sandbox as any, scripts: scripts as any, executeTool },
    { storageOrganizationId: SERVER_ORG, invocationContext: ctx, reauthorize: overrides.reauthorize },
    TOOLS,
    scriptsToExpose,
  );
  const registered = new Map<string, { config: any; handler: Handler }>();
  const fakeServer = {
    registerTool: jest.fn((name: string, config: any, handler: Handler) => {
      registered.set(name, { config, handler });
      return { remove: jest.fn() };
    }),
  };
  for (const e of entries) e.register(fakeServer as any);
  const call = (name: string, input: any = {}, handlerContext?: any) =>
    registered.get(name)!.handler(input, handlerContext);
  return { entries, registered, call, sandbox, scripts };
}

describe('buildSandboxToolEntries: saved scripts as tools', () => {
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug']));

  describe('registration', () => {
    it('adds one tool per exposed script after the four sandbox tools', () => {
      const { entries } = setup([exposed(), exposed({ name: 'catalogue_total', id: 'sc-2' })]);
      expect(entries.map((e) => e.name)).toEqual([
        ...SANDBOX_TOOL_NAMES,
        'stuck_orders',
        'catalogue_total',
      ]);
    });

    it('adds nothing when no script is exposed', () => {
      expect(setup([]).entries.map((e) => e.name)).toEqual([...SANDBOX_TOOL_NAMES]);
    });

    it('takes the script\'s description, or says which script and version it is', () => {
      const { registered } = setup([exposed(), exposed({ name: 'no_text', id: 'sc-2', description: null, version: 7 })]);
      expect(registered.get('stuck_orders')!.config.description).toBe('Orders stuck for N days');
      expect(registered.get('no_text')!.config.description).toBe('Saved script no_text v7');
    });

    it('turns the parameters into the tool\'s input schema', () => {
      const { registered } = setup();
      const schema = z.object(registered.get('stuck_orders')!.config.inputSchema);
      expect(schema.safeParse({ days: 7 }).success).toBe(true);
      expect(schema.safeParse({ days: 7, as_of: '2026-10-01' }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ days: '7' }).success).toBe(false);
      expect(registered.get('stuck_orders')!.config.inputSchema.days.description).toBe('Look-back window');
    });

    it('labels the tool like the run tool: read-only while writes are off, and open-world', () => {
      const { registered } = setup();
      expect(registered.get('stuck_orders')!.config.annotations).toEqual({
        title: 'stuck_orders',
        readOnlyHint: true,
        openWorldHint: true,
      });
      expect(registered.get('sandbox_run_script')!.config.annotations.readOnlyHint).toBe(true);
    });

    it('is not read-only when the operator allows writes', () => {
      process.env.SANDBOX_ALLOW_WRITES = 'true';
      try {
        expect(setup().registered.get('stuck_orders')!.config.annotations.readOnlyHint).toBe(false);
      } finally {
        delete process.env.SANDBOX_ALLOW_WRITES;
      }
    });

    it('never replaces a sandbox tool of the same name', () => {
      const { entries } = setup([exposed({ name: 'sandbox_run_script' })]);
      expect(entries.map((e) => e.name)).toEqual([...SANDBOX_TOOL_NAMES]);
    });

    it('changes the signature when the description or the parameters change, not on a code-only version bump', () => {
      const sigOf = (s: ExposedScript) => setup([s]).entries.find((e) => e.name === s.name)!.sig;
      const base = sigOf(exposed());
      expect(sigOf(exposed())).toBe(base);
      expect(sigOf(exposed({ version: 5 }))).toBe(base);
      expect(sigOf(exposed({ description: 'Other' }))).not.toBe(base);
      expect(
        sigOf(exposed({ parameters: { type: 'object', properties: { days: { type: 'integer' } }, required: [] } })),
      ).not.toBe(base);
    });
  });

  describe('calling it', () => {
    it('runs the saved script with the arguments as `args`, as sandbox_run_script would', async () => {
      const { call, sandbox, scripts } = setup();
      await call('stuck_orders', { days: 7, as_of: '2026-10-01' });
      expect(scripts.getByName).toHaveBeenCalledWith(SERVER_ORG, 'stuck_orders');
      const request = sandbox.run.mock.calls[0][0];
      expect(request.code).toBe('return args.days');
      expect(request.args).toEqual({ days: 7, as_of: '2026-10-01' });
      expect(request.allowWrites).toBe(false);
      expect(request.invocationContext).toMatchObject({ userId: 'user-1', mcpServerId: 'srv-1' });
    });

    it('returns the script\'s JSON result as it is, with structured content for an object', async () => {
      const bare = await setup().call('stuck_orders', { days: 7 });
      expect(JSON.parse(bare.content[0].text)).toEqual([{ id: 1 }]);
      expect(bare.isError).toBeUndefined();
      expect(bare.structuredContent).toBeUndefined();

      const object = await setup([exposed()], { runResult: { ok: true, result: { total: 3 }, meta: okMeta } }).call(
        'stuck_orders',
        { days: 7 },
      );
      expect(JSON.parse(object.content[0].text)).toEqual({ total: 3 });
      expect(object.structuredContent).toEqual({ total: 3 });

      const nothing = await setup([exposed()], { runResult: { ok: true, meta: okMeta } }).call('stuck_orders', { days: 1 });
      expect(nothing.content[0].text).toBe('null');
    });

    it('can call only the tools the script declares, whatever the caller may use', async () => {
      const { call, sandbox } = setup();
      await call('stuck_orders', { days: 7 });
      expect(sandbox.run.mock.calls[0][0].allowedTools.map((t: SandboxTool) => t.name)).toEqual(['orders_list']);
    });

    it('checks the caller\'s access again for the call', async () => {
      const reauthorize = jest.fn(async () => [TOOLS[1]]);
      const { call, sandbox } = setup([exposed()], { reauthorize });
      await call('stuck_orders', { days: 7 });
      expect(reauthorize).toHaveBeenCalledTimes(1);
      // The role changed since the session was planned: orders_list is no longer theirs.
      expect(sandbox.run.mock.calls[0][0].allowedTools).toEqual([]);
    });

    it('runs nothing when the access check fails', async () => {
      const { call, sandbox } = setup([exposed()], {
        reauthorize: async () => {
          throw new Error('db down');
        },
      });
      const res = await call('stuck_orders', { days: 7 });
      expect(res.isError).toBe(true);
      expect(sandbox.run).not.toHaveBeenCalled();
    });

    it('records the run under the script, with the run id the audit rows carry', async () => {
      const { call, sandbox, scripts } = setup();
      await call('stuck_orders', { days: 7 });
      const recorded = (scripts.recordRun.mock.calls as any[][])[0][0];
      expect(recorded).toMatchObject({
        organizationId: SERVER_ORG,
        mcpServerId: 'srv-1',
        scriptId: 'sc-1',
        userId: 'user-1',
        args: { days: 7 },
      });
      expect(sandbox.run.mock.calls[0][0].invocationContext.sandboxRunId).toBe(recorded.id);
    });

    it('does not run a script that has since been deleted or moved off this server', async () => {
      const gone = setup([exposed()], { saved: null });
      const res = await gone.call('stuck_orders', { days: 7 });
      expect(res.isError).toBe(true);
      expect(gone.sandbox.run).not.toHaveBeenCalled();

      const moved = setup([exposed()], {
        saved: {
          id: 'sc-1',
          name: 'stuck_orders',
          version: 4,
          code: 'return 1',
          uses: [{ connectorId: 'conn-2', connectorName: 'Shop', connectorExists: true, tools: ['x'] }],
        },
      });
      expect((await moved.call('stuck_orders', { days: 7 })).isError).toBe(true);
      expect(moved.sandbox.run).not.toHaveBeenCalled();
    });

    it('reports a failed script as a tool error with its code and hint', async () => {
      const { call } = setup([exposed()], {
        runResult: {
          ok: false,
          error: { code: 'RUNTIME_ERROR', message: 'boom', hint: 'fix it', line: 2, column: 3 },
          meta: okMeta,
        },
      });
      const res = await call('stuck_orders', { days: 7 });
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text)).toMatchObject({
        ok: false,
        error: { code: 'RUNTIME_ERROR', message: 'boom', hint: 'fix it' },
      });
    });
  });
});
