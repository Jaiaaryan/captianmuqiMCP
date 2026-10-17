import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { buildSandboxToolEntries, SANDBOX_TOOL_NAMES } from './sandbox-tools';
import { SandboxService } from './sandbox.service';
import type {
  SandboxInvocationContext,
  SandboxRunResult,
  SandboxTool,
  SandboxToolResult,
} from './types';

const SERVER_ORG = 'org-server';
const CALLER_ORG = 'org-caller-active';

const ctx: SandboxInvocationContext = {
  userId: 'user-1',
  organizationId: CALLER_ORG,
  authMethod: 'api-key',
  mcpServerId: 'srv-1',
  mcpServerName: 'koch-demo',
  connectorIds: ['conn-1'],
};

const TOOLS: SandboxTool[] = [
  {
    name: 'erp_orders_list',
    connectorId: 'conn-1',
    description: 'List orders. Paginated.',
    parameters: { type: 'object', properties: { limit: { type: 'number' } } },
    outputSchema: { type: 'array', items: { type: 'object', properties: { id: { type: 'number' } } } },
    readOnly: true,
  },
];

/** What the scripts service returns for a saved script: it declares erp_orders_list of conn-1. */
const savedScript = (over: Record<string, unknown> = {}) => ({
  id: 'sc-7',
  name: 'delayed_orders',
  version: 1,
  code: 'return 1',
  createdById: 'user-1',
  uses: [{ connectorId: 'conn-1', connectorName: 'ERP', connectorExists: true, tools: ['erp_orders_list'] }],
  ...over,
});

const okMeta = { ms: 5, connectorCalls: 1, bytesFromConnectors: 900, bytesReturned: 12, logs: [], toolsCalled: [] };

type Handler = (input: any, handlerContext?: any) => Promise<any>;

function setup(
  overrides: {
    tools?: SandboxTool[];
    runResult?: SandboxRunResult;
    reauthorize?: () => Promise<SandboxTool[]>;
  } = {},
) {
  const sandbox = {
    run: jest.fn(
      async (_request?: any): Promise<SandboxRunResult> =>
        overrides.runResult ?? { ok: true, result: { n: 3 }, meta: okMeta },
    ),
    checkSyntax: jest.fn(async (_code: string) => ({ ok: true }) as any),
  };
  const scripts = {
    getByName: jest.fn(async (): Promise<any> => null),
    create: jest.fn(async (_o: string, _u: any, input: any, _ctx?: any): Promise<any> => ({
      script: { id: 'sc-1', version: 1, name: input.name, code: input.code, uses: [] },
      added: [],
      warnings: [],
    })),
    updateByName: jest.fn(async (_o: string, name: string, patch: any, _u?: any, _ctx?: any): Promise<any> => ({
      script: { id: 'sc-1', name, version: 2, code: patch.code ?? 'return 1', uses: [] },
      added: [],
      warnings: [],
    })),
    list: jest.fn(async (): Promise<any[]> => []),
    recordRun: jest.fn(async () => 'run-1'),
  };
  const executeTool = jest.fn(async (): Promise<SandboxToolResult> => ({ content: [] }));
  const entries = buildSandboxToolEntries(
    { sandbox: sandbox as any, scripts: scripts as any, executeTool },
    { storageOrganizationId: SERVER_ORG, invocationContext: ctx, reauthorize: overrides.reauthorize },
    overrides.tools ?? TOOLS,
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
  const payload = (res: any) => JSON.parse(res.content[0].text);
  return { entries, registered, call, payload, sandbox, scripts, executeTool };
}

describe('buildSandboxToolEntries', () => {
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug']));

  describe('registration', () => {
    it('offers exactly the four sandbox tools', () => {
      const { entries, registered } = setup();
      expect(entries.map((e) => e.name)).toEqual([...SANDBOX_TOOL_NAMES]);
      expect([...registered.keys()]).toEqual([...SANDBOX_TOOL_NAMES]);
    });

    it('describes the callable tools inside the run tool', () => {
      const { registered } = setup();
      const description: string = registered.get('sandbox_run_script')!.config.description;
      expect(description).toContain('no network, filesystem or secrets');
      expect(description).toContain('tools.erp_orders_list({ limit?: number })');
      expect(description).toContain('under 32 KB');
    });

    it('labels only the listing tool read-only', () => {
      const { registered } = setup();
      const hints = (n: string) => registered.get(n)!.config.annotations;
      expect(hints('sandbox_list_scripts').readOnlyHint).toBe(true);
      // Read-only while writes are off (the default), and it reaches external systems.
      expect(hints('sandbox_run_script')).toMatchObject({ readOnlyHint: true, openWorldHint: true });
      // They write to the database: a client must not treat them as probe-safe.
      expect(hints('sandbox_create_script').readOnlyHint).toBe(false);
      expect(hints('sandbox_edit_script').readOnlyHint).toBe(false);
    });

    it('changes the session signature when a visible tool changes, not otherwise', () => {
      const a = setup().entries[0].sig;
      expect(setup().entries[0].sig).toBe(a);
      const renamed = [{ ...TOOLS[0], name: 'erp_orders_export' }];
      expect(setup({ tools: renamed }).entries[0].sig).not.toBe(a);
      const reshaped = [{ ...TOOLS[0], parameters: { type: 'object', properties: { from: { type: 'string' } } } }];
      expect(setup({ tools: reshaped }).entries[0].sig).not.toBe(a);
      expect(a).toMatch(/^sandbox:v1:[0-9a-f]{16}$/);
    });
  });

  describe('sandbox_run_script', () => {
    it('runs inline code with the session\'s tools and context, then stores the run', async () => {
      const { call, payload, sandbox, scripts, executeTool } = setup();
      const res = await call('sandbox_run_script', { code: 'return 1', args: { month: 'previous' } });

      expect(sandbox.run).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'return 1',
          args: { month: 'previous' },
          allowedTools: TOOLS,
          allowWrites: false,
          invocationContext: { ...ctx, sandboxRunId: expect.any(String) },
          executeTool,
        }),
      );
      expect(payload(res)).toEqual({ ok: true, runId: expect.any(String), result: { n: 3 }, meta: okMeta });
      expect(res.structuredContent).toEqual(payload(res));
      expect(res.isError).toBeUndefined();
      expect(scripts.recordRun).toHaveBeenCalledWith(
        expect.objectContaining({
          // The stored run and the context handed to the connectors share one id.
          id: payload(res).runId,
          organizationId: SERVER_ORG,
          mcpServerId: 'srv-1',
          userId: 'user-1',
          code: 'return 1',
          scriptId: undefined,
        }),
      );
      expect(sandbox.run.mock.calls[0][0].invocationContext.sandboxRunId).toBe(payload(res).runId);
    });

    it('passes the request\'s abort signal on, so a cancelled request stops the run', async () => {
      const { call, sandbox } = setup();
      const abort = new AbortController();
      await call('sandbox_run_script', { code: 'return 1' }, { mcpReq: { signal: abort.signal } });
      expect(sandbox.run.mock.calls[0][0].signal).toBe(abort.signal);
    });

    it('never takes the write policy from its input', async () => {
      const { call, sandbox } = setup();
      await call('sandbox_run_script', { code: 'return 1', allowWrites: true, allowWrite: true });
      expect(sandbox.run.mock.calls[0][0].allowWrites).toBe(false);
    });

    describe('authorization is decided again for every run', () => {
      const other: SandboxTool = { ...TOOLS[0], name: 'erp_other_list' };

      it('runs with the tools the caller has now, not the ones the session was planned with', async () => {
        const reauthorize = jest.fn(async () => [other]);
        const { call, sandbox } = setup({ reauthorize });
        await call('sandbox_run_script', { code: 'return 1' });
        await call('sandbox_run_script', { code: 'return 2' });
        expect(reauthorize).toHaveBeenCalledTimes(2);
        expect(sandbox.run.mock.calls[0][0].allowedTools).toEqual([other]);
      });

      it('runs a saved script with the runner\'s current tools, whoever wrote it', async () => {
        const reauthorize = jest.fn(async () => []);
        const { call, sandbox, scripts } = setup({ reauthorize });
        scripts.getByName.mockResolvedValueOnce(savedScript({ id: 'sc-9', name: 'monthly', version: 4, code: 'return 9', createdById: 'someone-else' }));
        await call('sandbox_run_script', { scriptName: 'monthly' });
        expect(sandbox.run.mock.calls[0][0].allowedTools).toEqual([]);
      });

      it('runs nothing, and says so plainly, when access cannot be checked', async () => {
        const reauthorize = jest.fn(async () => {
          throw new Error('connection refused to db.internal:5432');
        });
        const { call, sandbox, scripts } = setup({ reauthorize });
        const res = await call('sandbox_run_script', { code: 'return 1' });
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toBe('Could not verify your access to the tools. Try again.');
        expect(sandbox.run).not.toHaveBeenCalled();
        expect(scripts.recordRun).not.toHaveBeenCalled();
      });
    });

    it('stores under the server\'s organization, not the caller\'s active one', async () => {
      const { call, scripts } = setup();
      await call('sandbox_run_script', { code: 'return 1' });
      const stored = (scripts.recordRun.mock.calls as any[][])[0][0];
      expect(stored.organizationId).toBe(SERVER_ORG);
      expect(stored.organizationId).not.toBe(CALLER_ORG);
    });

    it('tells the caller which saved script ran and whether they wrote it', async () => {
      const { call, payload, scripts } = setup();
      scripts.getByName.mockResolvedValueOnce(savedScript({ version: 4, createdById: 'someone-else' }));
      expect(payload(await call('sandbox_run_script', { scriptName: 'delayed_orders' })).script).toEqual({
        name: 'delayed_orders', version: 4, ownedByYou: false,
      });
      scripts.getByName.mockResolvedValueOnce(savedScript({ version: 5 }));
      expect(payload(await call('sandbox_run_script', { scriptName: 'delayed_orders' })).script.ownedByYou).toBe(true);
      // Inline code has no saved script to report.
      expect(payload(await call('sandbox_run_script', { code: 'return 1' })).script).toBeUndefined();
    });

    it('runs a saved script by name', async () => {
      const { call, sandbox, scripts } = setup();
      scripts.getByName.mockResolvedValueOnce(savedScript({ code: 'return args.x' }));
      await call('sandbox_run_script', { scriptName: 'delayed_orders', args: { x: 1 } });
      expect(scripts.getByName).toHaveBeenCalledWith(SERVER_ORG, 'delayed_orders');
      expect(sandbox.run).toHaveBeenCalledWith(expect.objectContaining({ code: 'return args.x' }));
      expect((scripts.recordRun.mock.calls as any[][])[0][0].scriptId).toBe('sc-7');
    });

    describe('a saved script and the connectors it uses', () => {
      const OTHER_CONNECTOR_TOOL: SandboxTool = { ...TOOLS[0], name: 'shop_orders_list', connectorId: 'conn-2' };

      it('is not found on a server that lacks one of its connectors', async () => {
        const { call, sandbox, scripts } = setup();
        scripts.getByName.mockResolvedValueOnce(
          savedScript({
            uses: [
              { connectorId: 'conn-1', connectorName: 'ERP', connectorExists: true, tools: ['erp_orders_list'] },
              { connectorId: 'conn-2', connectorName: 'Shop', connectorExists: true, tools: ['shop_orders_list'] },
            ],
          }),
        );
        const res = await call('sandbox_run_script', { scriptName: 'delayed_orders' });
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toContain("Script 'delayed_orders' not found");
        expect(sandbox.run).not.toHaveBeenCalled();
        expect(scripts.recordRun).not.toHaveBeenCalled();
      });

      it('is not found when a connector it used has been deleted', async () => {
        const { call, sandbox, scripts } = setup();
        scripts.getByName.mockResolvedValueOnce(
          savedScript({
            uses: [{ connectorId: 'conn-gone', connectorName: 'Old CRM', connectorExists: false, tools: ['crm_list'] }],
          }),
        );
        const res = await call('sandbox_run_script', { scriptName: 'delayed_orders' });
        expect(res.isError).toBe(true);
        expect(sandbox.run).not.toHaveBeenCalled();
      });

      it('runs on a server that has all of its connectors, with only the tools it declared', async () => {
        const both = [TOOLS[0], OTHER_CONNECTOR_TOOL];
        const { call, sandbox, scripts } = setup({ tools: both, reauthorize: async () => both });
        scripts.getByName.mockResolvedValueOnce(savedScript());
        await call('sandbox_run_script', { scriptName: 'delayed_orders' });
        // The caller can call both tools, but the script declared one.
        expect(sandbox.run.mock.calls[0][0].allowedTools).toEqual([TOOLS[0]]);
      });

      it('matches the declared tool by connector, not by name alone', async () => {
        const sameName: SandboxTool = { ...TOOLS[0], connectorId: 'conn-2' };
        const { call, sandbox, scripts } = setup({ reauthorize: async () => [sameName] });
        scripts.getByName.mockResolvedValueOnce(savedScript());
        await call('sandbox_run_script', { scriptName: 'delayed_orders' });
        expect(sandbox.run.mock.calls[0][0].allowedTools).toEqual([]);
      });

      it('gives a script that declares nothing no tools', async () => {
        const { call, sandbox, scripts } = setup();
        scripts.getByName.mockResolvedValueOnce(savedScript({ uses: [] }));
        await call('sandbox_run_script', { scriptName: 'delayed_orders' });
        expect(sandbox.run.mock.calls[0][0].allowedTools).toEqual([]);
      });

      it('leaves inline code with every tool the caller has', async () => {
        const { call, sandbox } = setup();
        await call('sandbox_run_script', { code: 'return 1' });
        expect(sandbox.run.mock.calls[0][0].allowedTools).toEqual(TOOLS);
      });

      it('tells the agent how to declare a tool the saved script tried to call', async () => {
        const { call, payload, scripts } = setup({
          runResult: {
            ok: false,
            error: { code: 'TOOL_NOT_ALLOWED', message: "Tool 'x' is not available", hint: 'Call tools.list().' },
            meta: okMeta,
          },
        });
        scripts.getByName.mockResolvedValueOnce(savedScript());
        const hint = payload(await call('sandbox_run_script', { scriptName: 'delayed_orders' })).error.hint;
        expect(hint).toContain('Call tools.list().');
        expect(hint).toContain('sandbox_edit_script');
        // Inline code gets the plain hint.
        const inline = setup({
          runResult: { ok: false, error: { code: 'TOOL_NOT_ALLOWED', message: 'm', hint: 'Call tools.list().' }, meta: okMeta },
        });
        expect(inline.payload(await inline.call('sandbox_run_script', { code: 'x' })).error.hint).toBe('Call tools.list().');
      });
    });

    it('reports an unknown script name without running anything', async () => {
      const { call, sandbox } = setup();
      const res = await call('sandbox_run_script', { scriptName: 'nope' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("Script 'nope' not found");
      expect(sandbox.run).not.toHaveBeenCalled();
    });

    it.each([
      ['neither', {}],
      ['both', { code: 'return 1', scriptName: 'x' }],
      ['empty code', { code: '' }],
    ])('requires exactly one of code and scriptName (%s)', async (_label, input) => {
      const { call, sandbox } = setup();
      const res = await call('sandbox_run_script', input);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('exactly one');
      expect(sandbox.run).not.toHaveBeenCalled();
    });

    it('returns a failed run as an error with code and hint, and still stores it', async () => {
      const { call, payload, scripts } = setup({
        runResult: {
          ok: false,
          error: { code: 'OUTPUT_TOO_LARGE', message: 'Result is 7667036 bytes; limit is 32768.', hint: 'Return aggregates.' },
          meta: { ...okMeta, bytesReturned: 0 },
        },
      });
      const res = await call('sandbox_run_script', { code: 'return rows' });
      expect(res.isError).toBe(true);
      expect(payload(res)).toMatchObject({
        ok: false,
        error: { code: 'OUTPUT_TOO_LARGE', hint: 'Return aggregates.' },
        meta: { bytesReturned: 0 },
      });
      expect(res.structuredContent.ok).toBe(false);
      expect(scripts.recordRun).toHaveBeenCalledTimes(1);
    });

    it('passes a custom timeout through as a limit', async () => {
      const { call, sandbox } = setup();
      await call('sandbox_run_script', { code: 'return 1', timeoutMs: 20_000 });
      expect(sandbox.run).toHaveBeenCalledWith(expect.objectContaining({ limits: { timeoutMs: 20_000 } }));
    });

    it('bounds the timeout in the advertised schema', () => {
      const { registered } = setup();
      const { timeoutMs } = registered.get('sandbox_run_script')!.config.inputSchema;
      expect(timeoutMs.safeParse(500).success).toBe(false);
      expect(timeoutMs.safeParse(30_001).success).toBe(false);
      expect(timeoutMs.safeParse(10_000).success).toBe(true);
    });

    it('does not hand the model the caller\'s identity or tenant ids to choose', () => {
      const { registered } = setup();
      const inputs = Object.keys(registered.get('sandbox_run_script')!.config.inputSchema);
      expect(inputs.sort()).toEqual(['args', 'code', 'scriptName', 'timeoutMs']);
    });
  });

  describe('sandbox_create_script', () => {
    it('saves under the server\'s organization and reports a clean syntax check', async () => {
      const { call, payload, scripts } = setup();
      const res = await call('sandbox_create_script', { name: 'delayed_orders', code: 'return 1', description: 'd' });
      // Saved for the organization (not the server); the server's connectors settle ambiguous names.
      expect(scripts.create).toHaveBeenCalledWith(
        SERVER_ORG,
        'user-1',
        { name: 'delayed_orders', code: 'return 1', description: 'd', toolNames: undefined },
        { preferConnectorIds: ['conn-1'] },
      );
      expect(payload(res)).toEqual({
        ok: true,
        scriptId: 'sc-1',
        name: 'delayed_orders',
        version: 1,
        syntax: 'ok',
        uses: [],
      });
    });

    it('takes the tools the script calls by name, and reports what it ended up with', async () => {
      const { call, payload, scripts } = setup();
      scripts.create.mockResolvedValueOnce({
        script: {
          id: 'sc-1', version: 1, name: 'abc', code: 'x',
          uses: [{ connectorId: 'conn-1', connectorName: 'ERP', connectorExists: true, tools: ['erp_orders_list'] }],
        },
        added: ['ERP / erp_orders_list'],
        warnings: ['tools.nope is not a tool of any connector in this organization.'],
      });
      const res = await call('sandbox_create_script', { name: 'abc', code: 'x', tools: ['erp_orders_list'] });
      expect(scripts.create.mock.calls[0][2]).toMatchObject({ toolNames: ['erp_orders_list'] });
      expect(payload(res)).toMatchObject({
        uses: [{ connector: 'ERP', tools: ['erp_orders_list'] }],
        addedFromCode: ['ERP / erp_orders_list'],
        warnings: ['tools.nope is not a tool of any connector in this organization.'],
      });
    });

    it('reports an unknown tool name as an error and saves nothing', async () => {
      const { call, scripts } = setup();
      scripts.create.mockRejectedValueOnce(new BadRequestException("Unknown tool 'nope'. Use the names in the tool list."));
      const res = await call('sandbox_create_script', { name: 'abc', code: 'x', tools: ['nope'] });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("Unknown tool 'nope'");
    });

    it('offers the tools field, as a bounded list of names', () => {
      const { registered } = setup();
      const { tools } = registered.get('sandbox_create_script')!.config.inputSchema;
      expect(tools.safeParse(['a', 'b']).success).toBe(true);
      expect(tools.safeParse(Array.from({ length: 101 }, () => 'x')).success).toBe(false);
      expect(registered.get('sandbox_edit_script')!.config.inputSchema.tools).toBeDefined();
    });

    it('still saves a script with a syntax error and says where the error is', async () => {
      const { call, payload, sandbox } = setup();
      sandbox.checkSyntax.mockResolvedValueOnce({ ok: false, line: 2, column: 9, message: "Unexpected token ')'" });
      const res = await call('sandbox_create_script', { name: 'broken', code: 'a\nreturn {' });
      expect(res.isError).toBeUndefined();
      expect(payload(res).syntax).toEqual({ line: 2, column: 9, message: "Unexpected token ')'" });
    });

    it('never executes the code it saves', async () => {
      const { call, sandbox } = setup();
      await call('sandbox_create_script', { name: 'abc', code: 'return 1' });
      expect(sandbox.run).not.toHaveBeenCalled();
    });

    it('points a duplicate name at the edit tool', async () => {
      const { call, scripts } = setup();
      scripts.create.mockRejectedValueOnce(new ConflictException('dup'));
      const res = await call('sandbox_create_script', { name: 'abc', code: 'return 1' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toBe("Script 'abc' exists; use sandbox_edit_script");
    });

    it('hides unexpected storage errors', async () => {
      const { call, scripts } = setup();
      scripts.create.mockRejectedValueOnce(new Error('connection to 10.0.0.5:5432 refused'));
      const res = await call('sandbox_create_script', { name: 'abc', code: 'return 1' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).not.toContain('10.0.0.5');
    });

    it('validates the name in the advertised schema', () => {
      const { registered } = setup();
      const { name } = registered.get('sandbox_create_script')!.config.inputSchema;
      expect(name.safeParse('delayed_orders-1').success).toBe(true);
      for (const bad of ['Delayed', '1abc', 'a', 'has space', '../etc', 'x'.repeat(65)]) {
        expect(name.safeParse(bad).success).toBe(false);
      }
    });
  });

  describe('sandbox_edit_script', () => {
    it('edits by name in the server\'s organization and re-checks the syntax', async () => {
      const { call, payload, scripts, sandbox } = setup();
      const res = await call('sandbox_edit_script', { name: 'abc', code: 'return 2' });
      expect(scripts.updateByName).toHaveBeenCalledWith(
        SERVER_ORG,
        'abc',
        { code: 'return 2', description: undefined, toolNames: undefined },
        'user-1',
        { preferConnectorIds: ['conn-1'] },
      );
      expect(sandbox.checkSyntax).toHaveBeenCalledWith('return 2');
      expect(payload(res)).toEqual({ ok: true, name: 'abc', version: 2, syntax: 'ok', uses: [] });
    });

    it('can replace the tools a script declares', async () => {
      const { call, scripts } = setup();
      await call('sandbox_edit_script', { name: 'abc', tools: ['erp_orders_list'] });
      expect(scripts.updateByName.mock.calls[0][2]).toEqual({
        code: undefined,
        description: undefined,
        toolNames: ['erp_orders_list'],
      });
    });

    it('does not edit a script this server cannot offer, because it lacks one of its connectors', async () => {
      const { call, scripts } = setup();
      scripts.getByName.mockResolvedValueOnce(
        savedScript({ uses: [{ connectorId: 'conn-2', connectorName: 'Shop', connectorExists: true, tools: ['x'] }] }),
      );
      const res = await call('sandbox_edit_script', { name: 'abc', code: 'return 2' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toBe("Script 'abc' not found");
      expect(scripts.updateByName).not.toHaveBeenCalled();
    });

    it('requires code, description and/or tools', async () => {
      const { call, scripts } = setup();
      const res = await call('sandbox_edit_script', { name: 'abc' });
      expect(res.isError).toBe(true);
      expect(scripts.updateByName).not.toHaveBeenCalled();
    });

    it('reports an unknown script', async () => {
      const { call, scripts } = setup();
      scripts.updateByName.mockRejectedValueOnce(new NotFoundException("Script 'zzz' not found"));
      const res = await call('sandbox_edit_script', { name: 'zzz', code: 'return 1' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("Script 'zzz' not found");
    });
  });

  describe("editing someone else's script", () => {
    it('explains that only the author can edit and points at saving a copy', async () => {
      const { call, scripts } = setup();
      scripts.updateByName.mockRejectedValueOnce(
        new ForbiddenException("Script 'monthly_report' was created by someone else, so only they can edit it."),
      );
      const res = await call('sandbox_edit_script', { name: 'monthly_report', code: 'return 1' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('only they can edit it');
    });

    it('tells the agent up front that editing is author-only', () => {
      const { registered } = setup();
      expect(registered.get('sandbox_edit_script')!.config.description).toContain("Only the script's author");
    });
  });

  describe('sandbox_list_scripts', () => {
    it('lists the scripts, what they use, and a compact last-run summary', async () => {
      const { call, payload, scripts } = setup();
      const lastRunAt = new Date('2026-10-17T10:00:00Z');
      scripts.list.mockResolvedValueOnce([
        savedScript({
          createdById: 'user-1',
          name: 'delayed_orders',
          description: 'Delayed orders last month',
          version: 3,
          lastRunAt,
          lastRunOk: true,
          lastRunMeta: { ms: 40, bytesReturned: 80, connectorCalls: 2, bytesFromConnectors: 5_000_000 },
        }),
        savedScript({ createdById: 'someone-else', name: 'new_one', description: null, version: 1, uses: [], lastRunAt: null, lastRunOk: null, lastRunMeta: null }),
      ]);
      const res = await call('sandbox_list_scripts');
      expect(scripts.list).toHaveBeenCalledWith(SERVER_ORG);
      expect(payload(res).scripts).toEqual([
        {
          name: 'delayed_orders',
          description: 'Delayed orders last month',
          version: 3,
          ownedByYou: true,
          uses: [{ connector: 'ERP', tools: ['erp_orders_list'] }],
          lastRunAt: lastRunAt.toISOString(),
          lastRunOk: true,
          lastRunMeta: { ms: 40, bytesReturned: 80 },
        },
        { name: 'new_one', description: null, version: 1, ownedByYou: false, uses: [], lastRunAt: null, lastRunOk: null, lastRunMeta: null },
      ]);
    });

    it('lists only the scripts whose connectors this server has, and every script that needs none', async () => {
      const { call, payload, scripts } = setup();
      scripts.list.mockResolvedValueOnce([
        savedScript({ name: 'uses_erp' }),
        savedScript({
          name: 'needs_shop_too',
          uses: [
            { connectorId: 'conn-1', connectorName: 'ERP', connectorExists: true, tools: ['a'] },
            { connectorId: 'conn-2', connectorName: 'Shop', connectorExists: true, tools: ['b'] },
          ],
        }),
        savedScript({ name: 'needs_deleted', uses: [{ connectorId: 'gone', connectorName: 'Old', connectorExists: false, tools: ['c'] }] }),
        savedScript({ name: 'pure_compute', uses: [] }),
      ]);
      const names = payload(await call('sandbox_list_scripts')).scripts.map((s: any) => s.name);
      expect(names).toEqual(['uses_erp', 'pure_compute']);
    });
  });

  describe('end to end with the real sandbox', () => {
    it('answers through the registered handler without sending the raw rows', async () => {
      const rows = Array.from({ length: 2000 }, (_, i) => ({ id: i, delayed: i % 5 === 0 }));
      const executeTool = jest.fn(async (): Promise<SandboxToolResult> => ({
        content: [{ type: 'text', text: 'ignored' }],
        structured: rows,
      }));
      const scripts = { recordRun: jest.fn(async () => 'run-1'), getByName: jest.fn() };
      const entries = buildSandboxToolEntries(
        { sandbox: new SandboxService(), scripts: scripts as any, executeTool },
        { storageOrganizationId: SERVER_ORG, invocationContext: ctx },
        TOOLS,
      );
      let handler!: Handler;
      entries[0].register({
        registerTool: (_n: string, _c: unknown, h: Handler) => {
          handler = h;
          return { remove() {} };
        },
      } as any);

      const res = await handler({
        code: `const r = await tools.erp_orders_list({}); return { delayed: r.filter(o => o.delayed).length };`,
      });
      const body = JSON.parse(res.content[0].text);
      expect(body.result).toEqual({ delayed: 400 });
      expect(body.meta.bytesFromConnectors).toBeGreaterThan(30_000);
      expect(res.content[0].text.length).toBeLessThan(500);
      expect(executeTool).toHaveBeenCalledWith(
        'erp_orders_list',
        {},
        { ...ctx, sandboxRunId: body.runId, connectorIds: ['conn-1'] },
      );
    });
  });
});
