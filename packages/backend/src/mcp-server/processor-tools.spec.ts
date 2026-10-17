import { Logger } from '@nestjs/common';
import {
  PROCESSOR_CHAIN_TOOL_NAMES,
  areProcessorChainToolsEnabled,
  buildProcessorToolEntries,
  type ProcessorChainStore,
  type ProcessorChainTarget,
  type ProcessorToolScope,
} from './processor-tools';

type Handler = (input: any) => Promise<any>;

const CHAIN = {
  version: 1,
  steps: [
    {
      id: 'convert_to_eur',
      processor: 'number_scale@1',
      each: '$.items[*]',
      reads: 'price_usd',
      writes: 'price_eur',
      mode: 'add',
      params: { factor: 0.92, round: 2 },
    },
  ],
};

const OFFERS = {
  items: [
    { itemNo: 'A-1', description: '  Black   Screw ', price_usd: 54.67, currency: 'USD' },
    { itemNo: 'A-2', description: 'Steel Plate', price_usd: 75.87, currency: 'USD' },
  ],
};

const target = (over: Partial<ProcessorChainTarget> = {}): ProcessorChainTarget => ({
  toolId: 'tool-1',
  toolName: 'mock_supplier_list_offers',
  connectorId: 'conn-1',
  connectorName: 'Mock Supplier',
  responseMapping: null,
  editable: true,
  ...over,
});

function setup(
  overrides: {
    found?: ProcessorChainTarget | { ambiguous: string[] } | null;
    sample?: { output: unknown; capturedAt: Date } | null;
    visible?: string[];
    userId?: string;
    saveChain?: ProcessorChainStore['saveChain'];
  } = {},
) {
  const store = {
    findTool: jest.fn(
      async (): Promise<any> =>
        overrides.found === undefined ? target() : overrides.found,
    ),
    lastSample: jest.fn(async () =>
      overrides.sample === undefined
        ? { output: OFFERS, capturedAt: new Date('2026-10-17T09:00:00Z') }
        : overrides.sample,
    ),
    saveChain: overrides.saveChain ?? jest.fn(async () => undefined),
  };

  const scope: ProcessorToolScope = {
    userId: overrides.userId ?? 'user-1',
    organizationId: 'org-1',
    connectorIds: ['conn-1'],
    visibleToolNames: new Set(overrides.visible ?? ['mock_supplier_list_offers']),
  };

  const entries = buildProcessorToolEntries(store as unknown as ProcessorChainStore, scope);
  const registered = new Map<string, { config: any; handler: Handler }>();
  const fakeServer = {
    registerTool: jest.fn((name: string, config: any, handler: Handler) => {
      registered.set(name, { config, handler });
      return { remove: jest.fn() };
    }),
  };
  for (const e of entries) e.register(fakeServer as any);

  const call = (name: string, input: any = {}) => registered.get(name)!.handler(input);
  const payload = (res: any) => JSON.parse(res.content[0].text);
  const text = (res: any) => res.content[0].text as string;
  return { entries, registered, call, payload, text, store, scope };
}

describe('buildProcessorToolEntries', () => {
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug']));

  describe('registration', () => {
    it('offers exactly the four response chain tools', () => {
      const { entries, registered } = setup();
      expect(entries.map((e) => e.name)).toEqual([...PROCESSOR_CHAIN_TOOL_NAMES]);
      expect([...registered.keys()]).toEqual([...PROCESSOR_CHAIN_TOOL_NAMES]);
    });

    it('labels only the reading tools read-only, and none of them open-world', () => {
      const { registered } = setup();
      const hints = (n: string) => registered.get(n)!.config.annotations;
      expect(hints('response_chain_processors')).toMatchObject({ readOnlyHint: true });
      expect(hints('response_chain_get')).toMatchObject({ readOnlyHint: true });
      expect(hints('response_chain_preview')).toMatchObject({ readOnlyHint: true });
      // It changes what every client of that tool receives.
      expect(hints('response_chain_set')).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
      for (const name of PROCESSOR_CHAIN_TOOL_NAMES) {
        expect(hints(name).openWorldHint).toBe(false);
      }
    });

    it('teaches the step shape in the descriptions an agent reads', () => {
      const { registered } = setup();
      for (const name of ['response_chain_processors', 'response_chain_set']) {
        const description: string = registered.get(name)!.config.description;
        expect(description).toContain('{ id, processor, each, reads, writes, mode, params }');
        expect(description).toContain('number_scale@1');
      }
      expect(registered.get('response_chain_set')!.config.description).toContain(
        'response_chain_preview',
      );
    });

    it('gives each tool a signature that changes with its description', () => {
      const { entries } = setup();
      const sigs = entries.map((e) => e.sig);
      expect(new Set(sigs).size).toBe(entries.length);
      expect(sigs.every((s) => s.startsWith('processors:v1:'))).toBe(true);
    });
  });

  describe('response_chain_processors', () => {
    it('lists the registry with each processor contract and an example chain', async () => {
      const { call, payload } = setup();
      const out = payload(await call('response_chain_processors'));
      const names = out.processors.map((p: any) => p.name);
      expect(names).toContain('number_scale');
      expect(names).toContain('text_clean');
      const scale = out.processors.find((p: any) => p.name === 'number_scale');
      expect(scale.ref).toBe('number_scale@1');
      expect(scale.parameters.find((p: any) => p.name === 'factor').required).toBe(true);
      expect(out.writeModes).toEqual(['add', 'replace', 'upsert']);
      expect(out.example.steps[0].processor).toBe('number_scale@1');
    });
  });

  describe('response_chain_get', () => {
    it('reports the stored chain, that it is active, and that it can be edited', async () => {
      const { call, payload } = setup({
        found: target({ responseMapping: { processors: CHAIN } }),
      });
      const out = payload(await call('response_chain_get', { toolName: 'mock_supplier_list_offers' }));
      expect(out).toMatchObject({
        tool: 'mock_supplier_list_offers',
        connector: 'Mock Supplier',
        active: true,
        editable: true,
        sampleAvailable: true,
      });
      expect(out.processors.steps[0].id).toBe('convert_to_eur');
    });

    it('reports no chain on a tool that has none', async () => {
      const { call, payload } = setup();
      const out = payload(await call('response_chain_get', { toolName: 'mock_supplier_list_offers' }));
      expect(out.processors).toBeNull();
      expect(out.active).toBe(false);
    });

    it('refuses a tool this session cannot see, without looking it up', async () => {
      const { call, text, store } = setup({ visible: ['something_else'] });
      const res = await call('response_chain_get', { toolName: 'mock_payroll_list_salaries' });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain('not one of the tools on this MCP server');
      expect(store.findTool).not.toHaveBeenCalled();
    });

    it('refuses a tool that is not on this server', async () => {
      const { call, text } = setup({ found: null });
      const res = await call('response_chain_get', { toolName: 'mock_supplier_list_offers' });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain('not found');
    });

    it('refuses a name two connectors of this server share, and says which', async () => {
      const { call, text } = setup({ found: { ambiguous: ['Mock Supplier', 'Supplier EU'] } });
      const res = await call('response_chain_get', { toolName: 'mock_supplier_list_offers' });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain('Mock Supplier, Supplier EU');
      expect(text(res)).toContain('dashboard');
    });

    it('asks for a tool name when none was given', async () => {
      const { call, text } = setup();
      const res = await call('response_chain_get', { toolName: '  ' });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain('Provide the name of a tool');
    });
  });

  describe('response_chain_preview', () => {
    it('runs proposed steps against the tool-s last real response and traces each one', async () => {
      const { call, payload, store } = setup();
      const out = payload(
        await call('response_chain_preview', {
          toolName: 'mock_supplier_list_offers',
          steps: CHAIN.steps,
        }),
      );
      expect(out.ok).toBe(true);
      expect(out.sampleSource).toBe('last-call');
      expect(out.steps).toHaveLength(1);
      expect(out.steps[0]).toMatchObject({
        id: 'convert_to_eur',
        processor: 'number_scale@1',
        targets: 2,
        written: 2,
        skipped: 0,
      });
      expect(out.steps[0].bytesAfter).toBeGreaterThan(0);
      expect(out.result.items[0].price_eur).toBe(50.3);
      expect(store.saveChain).not.toHaveBeenCalled();
    });

    it('runs against a sample passed in instead of a recorded response', async () => {
      const { call, payload, store } = setup();
      const out = payload(
        await call('response_chain_preview', {
          toolName: 'mock_supplier_list_offers',
          steps: CHAIN.steps,
          sample: { items: [{ price_usd: 100 }] },
        }),
      );
      expect(out.sampleSource).toBe('argument');
      expect(out.result.items[0].price_eur).toBe(92);
      expect(store.lastSample).not.toHaveBeenCalled();
    });

    it('previews the stored chain when no steps are given', async () => {
      const { call, payload } = setup({ found: target({ responseMapping: { processors: CHAIN } }) });
      const out = payload(
        await call('response_chain_preview', { toolName: 'mock_supplier_list_offers' }),
      );
      expect(out.chainActive).toBe(true);
      expect(out.result.items[1].price_eur).toBe(69.8);
    });

    it('names the step and the path of a value a step refused, and edits nothing', async () => {
      const { call, payload } = setup();
      const res = await call('response_chain_preview', {
        toolName: 'mock_supplier_list_offers',
        steps: CHAIN.steps,
        sample: { items: [{ itemNo: 'A-1', price_usd: 'n/a' }] },
      });
      expect(res.isError).toBe(true);
      const out = payload(res);
      expect(out.ok).toBe(false);
      expect(out.error).toBe('step convert_to_eur: $.items[0].price_usd is not a number');
      expect(out.failedStep).toBe('convert_to_eur');
      expect(out.failedPath).toBe('$.items[0].price_usd');
      expect(out.hint).toContain('onMissing');
      expect(out.result.items[0].price_eur).toBeUndefined();
    });

    it('rejects an unusable chain with the problem, before running anything', async () => {
      const { call, payload } = setup();
      const res = await call('response_chain_preview', {
        toolName: 'mock_supplier_list_offers',
        steps: [{ id: 'x', processor: 'no_such_processor', reads: 'a', writes: 'b' }],
      });
      expect(res.isError).toBe(true);
      expect(payload(res).error).toContain('not a known processor');
    });

    it('says what to do when the tool has never been called', async () => {
      const { call, text } = setup({ sample: null });
      const res = await call('response_chain_preview', {
        toolName: 'mock_supplier_list_offers',
        steps: CHAIN.steps,
      });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain('No recorded response');
      expect(text(res)).toContain('pass a `sample`');
    });
  });

  describe('response_chain_set', () => {
    it('stores the chain, version-stamped, and says it now applies to every client', async () => {
      const { call, payload, store } = setup();
      const out = payload(
        await call('response_chain_set', {
          toolName: 'mock_supplier_list_offers',
          steps: CHAIN.steps,
        }),
      );
      expect(out).toMatchObject({ ok: true, tool: 'mock_supplier_list_offers', active: true });
      expect(out.note).toContain('Every client');
      expect(store.saveChain).toHaveBeenCalledTimes(1);
      const [, stored] = (store.saveChain as jest.Mock).mock.calls[0];
      expect(stored).toMatchObject({ version: 1, steps: CHAIN.steps });
    });

    it('carries enabled and onError into the stored chain', async () => {
      const { call, store } = setup();
      await call('response_chain_set', {
        toolName: 'mock_supplier_list_offers',
        steps: CHAIN.steps,
        enabled: false,
        onError: 'passthrough',
      });
      const [, stored] = (store.saveChain as jest.Mock).mock.calls[0];
      expect(stored).toMatchObject({ enabled: false, onError: 'passthrough' });
    });

    it('removes the chain on steps: null', async () => {
      const { call, payload, store } = setup({
        found: target({ responseMapping: { processors: CHAIN } }),
      });
      const out = payload(
        await call('response_chain_set', { toolName: 'mock_supplier_list_offers', steps: null }),
      );
      expect(out).toMatchObject({ ok: true, active: false, processors: null });
      expect(out.note).toContain('unedited response');
      expect((store.saveChain as jest.Mock).mock.calls[0][1]).toBeNull();
    });

    it('asks for steps when neither a chain nor null was given', async () => {
      const { call, text, store } = setup();
      const res = await call('response_chain_set', { toolName: 'mock_supplier_list_offers' });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain('Provide `steps`');
      expect(store.saveChain).not.toHaveBeenCalled();
    });

    it('refuses a connector this caller may not configure, and points at the dashboard', async () => {
      const { call, text, store } = setup({ found: target({ editable: false }) });
      const res = await call('response_chain_set', {
        toolName: 'mock_supplier_list_offers',
        steps: CHAIN.steps,
      });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain('may not change the configuration');
      expect(store.saveChain).not.toHaveBeenCalled();
    });

    it('validates before storing: a wrong parameter never reaches the database', async () => {
      const { call, payload, store } = setup();
      const res = await call('response_chain_set', {
        toolName: 'mock_supplier_list_offers',
        steps: [
          {
            id: 'convert',
            processor: 'number_scale@1',
            reads: 'a',
            writes: 'b',
            params: { rate: 0.92 },
          },
        ],
      });
      expect(res.isError).toBe(true);
      expect(payload(res).error).toContain('has no parameter "rate"');
      expect(store.saveChain).not.toHaveBeenCalled();
    });

    it('refuses a write path that would reach Object.prototype', async () => {
      const { call, payload, store } = setup();
      const res = await call('response_chain_set', {
        toolName: 'mock_supplier_list_offers',
        steps: [
          {
            id: 'pollute',
            processor: 'number_round@1',
            reads: 'price',
            writes: '__proto__.polluted',
          },
        ],
      });
      expect(res.isError).toBe(true);
      expect(payload(res).error).toContain('__proto__');
      expect(store.saveChain).not.toHaveBeenCalled();
    });

    it('does not leak internals when the write fails', async () => {
      const { call, text } = setup({
        saveChain: jest.fn(async () => {
          throw new Error('connection terminated: password=hunter2');
        }),
      });
      const res = await call('response_chain_set', {
        toolName: 'mock_supplier_list_offers',
        steps: CHAIN.steps,
      });
      expect(res.isError).toBe(true);
      expect(text(res)).toBe('Could not store the chain. Try again.');
      expect(text(res)).not.toContain('hunter2');
    });
  });

  describe('areProcessorChainToolsEnabled', () => {
    const original = process.env.PROCESSOR_CHAIN_MCP_TOOLS;
    afterEach(() => {
      if (original === undefined) delete process.env.PROCESSOR_CHAIN_MCP_TOOLS;
      else process.env.PROCESSOR_CHAIN_MCP_TOOLS = original;
    });

    it('is on by default and off only for exactly "false"', () => {
      delete process.env.PROCESSOR_CHAIN_MCP_TOOLS;
      expect(areProcessorChainToolsEnabled()).toBe(true);
      process.env.PROCESSOR_CHAIN_MCP_TOOLS = 'true';
      expect(areProcessorChainToolsEnabled()).toBe(true);
      process.env.PROCESSOR_CHAIN_MCP_TOOLS = 'no';
      expect(areProcessorChainToolsEnabled()).toBe(true);
      process.env.PROCESSOR_CHAIN_MCP_TOOLS = 'false';
      expect(areProcessorChainToolsEnabled()).toBe(false);
    });
  });
});
