import { NotFoundException } from '@nestjs/common';
import { FlowService, FLOW_MAX_TOOLS, type FlowGraph } from './flow.service';

const ORG = 'org-a';
const OTHER_ORG = 'org-b';
const SERVER = 'srv-1';

const CONNECTORS = [
  { id: 'c-erp', name: 'ERP', type: 'REST', authType: 'BEARER_TOKEN', config: null },
  { id: 'c-ship', name: 'Shipping', type: 'REST', authType: 'API_KEY', config: null },
];

const TOOLS = [
  {
    id: 't-list',
    connectorId: 'c-erp',
    name: 'erp_list_orders',
    endpointMapping: { method: 'GET', path: '/orders' },
    responseMapping: {
      responseProcessing: { version: 1, enabled: true, onError: 'fail', steps: [{ id: 'a' }, { id: 'b' }] },
      transform: { select: { id: 'id' } },
    },
    annotations: null,
  },
  {
    id: 't-create',
    connectorId: 'c-erp',
    name: 'erp_create_order',
    endpointMapping: { method: 'POST', path: '/orders' },
    responseMapping: null,
    annotations: null,
  },
  {
    id: 't-track',
    connectorId: 'c-ship',
    name: 'ship_track',
    endpointMapping: { method: 'GET', path: '/track' },
    responseMapping: { transform: { expression: 'items[].id' } },
    annotations: null,
  },
  {
    id: 't-off',
    connectorId: 'c-ship',
    name: 'ship_off',
    endpointMapping: { method: 'GET', path: '/off' },
    responseMapping: {
      responseProcessing: { enabled: false, steps: 'nope' },
      transform: { mode: 'off', select: { x: 'x' } },
    },
    annotations: null,
  },
];

const SCRIPTS = [
  // Uses only ERP: offered on the server.
  { id: 'sc-erp', name: 'price_check', version: 3, uses: [{ connectorId: 'c-erp', toolName: 'erp_list_orders' }] },
  // Uses ERP and Shipping: offered.
  {
    id: 'sc-both',
    name: 'stuck_orders',
    version: 1,
    uses: [
      { connectorId: 'c-erp', toolName: 'erp_list_orders' },
      { connectorId: 'c-ship', toolName: 'ship_track' },
    ],
  },
  // Needs a connector the server does not have: hidden.
  {
    id: 'sc-hidden',
    name: 'payroll_sync',
    version: 1,
    uses: [
      { connectorId: 'c-erp', toolName: 'erp_list_orders' },
      { connectorId: 'c-payroll', toolName: 'payroll_run' },
    ],
  },
];

const T0 = new Date('2026-10-17T10:00:00Z');
const T1 = new Date('2026-10-17T11:00:00Z');

function makePrisma(over: { tools?: any[]; groups?: any[] } = {}) {
  return {
    mcpServerConfig: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === SERVER && where.organizationId === ORG
          ? { id: SERVER, name: 'Main', connectors: CONNECTORS.map((c) => ({ connectorId: c.id })) }
          : null,
      ),
    },
    connector: { findMany: jest.fn().mockResolvedValue(CONNECTORS) },
    mcpTool: { findMany: jest.fn().mockResolvedValue(over.tools ?? TOOLS) },
    toolInvocation: {
      groupBy: jest.fn().mockResolvedValue(
        over.groups ?? [
          // 3 successes of 100 ms, plus one stored failure that stands for 4 calls at 50 ms.
          { toolId: 't-list', status: 'SUCCESS', _count: { _all: 3 }, _sum: { repeatCount: 3 }, _avg: { durationMs: 100 }, _max: { createdAt: T0 } },
          { toolId: 't-list', status: 'ERROR', _count: { _all: 1 }, _sum: { repeatCount: 4 }, _avg: { durationMs: 50 }, _max: { createdAt: T1 } },
          { toolId: 't-track', status: 'SUCCESS', _count: { _all: 2 }, _sum: { repeatCount: 2 }, _avg: { durationMs: 20 }, _max: { createdAt: T0 } },
        ],
      ),
    },
    sandboxScript: { findMany: jest.fn().mockResolvedValue(SCRIPTS) },
    sandboxRun: {
      findMany: jest.fn().mockResolvedValue([
        { scriptId: 'sc-erp', ok: true, createdAt: T1, meta: { ms: 100, bytesFromConnectors: 5000, bytesReturned: 50, toolsCalled: ['erp_list_orders'] } },
        { scriptId: 'sc-erp', ok: false, createdAt: T0, meta: { ms: 300, bytesFromConnectors: 0, bytesReturned: 0, toolsCalled: [] } },
        { scriptId: 'sc-both', ok: true, createdAt: T0, meta: { ms: 10, bytesFromConnectors: 10, bytesReturned: 1, toolsCalled: ['erp_list_orders', 'ship_track'] } },
      ]),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ tool_id: 't-list', bytes: BigInt(2048) }, { tool_id: 't-track', bytes: BigInt(100) }]),
  };
}

/** Every key named `organizationId` anywhere in a where clause. */
function mentionsOrg(where: unknown): boolean {
  return JSON.stringify(where).includes(`"organizationId":"${ORG}"`);
}

const node = (g: FlowGraph, id: string) => g.nodes.find((n) => n.id === id);
const edge = (g: FlowGraph, id: string) => g.edges.find((e) => e.id === id);

describe('FlowService.buildGraph', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: FlowService;
  let graph: FlowGraph;

  beforeEach(async () => {
    prisma = makePrisma();
    service = new FlowService(prisma as any);
    graph = await service.buildGraph(ORG, SERVER, '24h');
  });

  it('draws agent, server, connectors, tools, processing, mapping and visible scripts', () => {
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(
      [
        'agent',
        `server:${SERVER}`,
        'connector:c-erp',
        'connector:c-ship',
        'tool:t-list',
        'tool:t-create',
        'tool:t-track',
        'tool:t-off',
        'processing:t-list',
        'processing:t-off',
        'mapping:t-list',
        'mapping:t-track',
        'mapping:t-off',
        'script:sc-erp',
        'script:sc-both',
      ].sort(),
    );
    expect(graph.serverId).toBe(SERVER);
    expect(Date.parse(graph.generatedAt) - Date.parse(graph.since)).toBe(24 * 60 * 60 * 1000);
  });

  it('wires the edges: mcp, tool, http, processing, mapping', () => {
    const ids = graph.edges.map((e) => `${e.kind} ${e.source}>${e.target}`);
    expect(ids).toEqual(
      expect.arrayContaining([
        `mcp agent>server:${SERVER}`,
        `tool server:${SERVER}>tool:t-list`,
        'http tool:t-list>connector:c-erp',
        'http tool:t-track>connector:c-ship',
        'processing tool:t-list>processing:t-list',
        // With a chain, the mapping follows it; without one, it hangs off the tool.
        'mapping processing:t-list>mapping:t-list',
        'mapping tool:t-track>mapping:t-track',
      ]),
    );
    // No processing or mapping for a tool whose responseMapping lacks the key.
    expect(node(graph, 'processing:t-create')).toBeUndefined();
    expect(node(graph, 'mapping:t-create')).toBeUndefined();
    // Edge ids are unique.
    expect(new Set(graph.edges.map((e) => e.id)).size).toBe(graph.edges.length);
    // Every edge connects existing nodes.
    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    for (const e of graph.edges) {
      expect(nodeIds.has(e.source)).toBe(true);
      expect(nodeIds.has(e.target)).toBe(true);
    }
  });

  it('aggregates call statistics per tool, connector, server and agent', () => {
    // 3 + 4 calls (a repeated failure counts as its repeatCount), 4 errors.
    const list = node(graph, 'tool:t-list')!;
    expect(list.stats).toMatchObject({ calls: 7, errors: 4, bytesOut: 2048, avgMs: 88 });
    expect(list.stats!.lastAt).toBe(T1.toISOString());
    expect(node(graph, 'tool:t-create')!.stats).toEqual({ calls: 0, errors: 0 });

    expect(node(graph, 'connector:c-erp')!.stats).toMatchObject({ calls: 7, errors: 4 });
    expect(node(graph, 'connector:c-ship')!.stats).toMatchObject({ calls: 2, errors: 0 });
    expect(node(graph, `server:${SERVER}`)!.stats).toMatchObject({ calls: 9, errors: 4, bytesOut: 2148 });
    expect(node(graph, 'agent')!.stats).toMatchObject({ calls: 9, errors: 4 });
    expect(edge(graph, `mcp:agent>server:${SERVER}`)!.stats).toMatchObject({ calls: 9 });
  });

  it('reports the raw response size where it enters processing or mapping', () => {
    // The audit log holds the response before processing, so it is bytesIn of the chain.
    expect(node(graph, 'processing:t-list')!.stats).toEqual({ calls: 7, errors: 4, bytesIn: 2048 });
    expect(node(graph, 'mapping:t-list')!.stats).toEqual({ calls: 7, errors: 4 });
    expect(node(graph, 'mapping:t-track')!.stats).toEqual({ calls: 2, errors: 0, bytesIn: 100 });
  });

  it('fills node meta per kind', () => {
    expect(node(graph, `server:${SERVER}`)!.meta).toEqual({ connectors: 2 });
    expect(node(graph, 'connector:c-erp')!.meta).toEqual({ authType: 'BEARER_TOKEN', tools: 2 });
    expect(node(graph, 'tool:t-list')!.meta).toEqual({ readOnly: true, method: 'GET' });
    expect(node(graph, 'tool:t-create')!.meta).toEqual({ readOnly: false, method: 'POST' });
    expect(node(graph, 'processing:t-list')!.meta).toEqual({ steps: 2, enabled: true, valid: true });
    expect(node(graph, 'processing:t-off')!.meta).toEqual({ steps: 0, enabled: false, valid: false });
    expect(node(graph, 'mapping:t-list')!.meta).toEqual({ mode: 'select' });
    expect(node(graph, 'mapping:t-track')!.meta).toEqual({ mode: 'jmespath' });
    expect(node(graph, 'mapping:t-off')!.meta).toEqual({ mode: 'off' });
    expect(node(graph, 'script:sc-erp')!.meta).toEqual({ version: 3, tools: 1 });
  });

  it('shows a script only when the server has every connector it uses', () => {
    expect(node(graph, 'script:sc-erp')).toBeDefined();
    expect(node(graph, 'script:sc-both')).toBeDefined();
    expect(node(graph, 'script:sc-hidden')).toBeUndefined();
    expect(graph.edges.filter((e) => e.source === 'script:sc-hidden')).toEqual([]);
    // Runs are only read for the visible scripts.
    const runWhere = prisma.sandboxRun.findMany.mock.calls[0][0].where;
    expect(runWhere.scriptId).toEqual({ in: ['sc-erp', 'sc-both'] });
  });

  it('draws declared (script-use) and observed (script-call) edges', () => {
    const uses = graph.edges.filter((e) => e.kind === 'script-use').map((e) => `${e.source}>${e.target}`);
    expect(uses.sort()).toEqual(
      ['script:sc-both>tool:t-list', 'script:sc-both>tool:t-track', 'script:sc-erp>tool:t-list'].sort(),
    );
    const calls = graph.edges.filter((e) => e.kind === 'script-call').map((e) => `${e.source}>${e.target}`);
    expect(calls.sort()).toEqual(
      ['script:sc-both>tool:t-list', 'script:sc-both>tool:t-track', 'script:sc-erp>tool:t-list'].sort(),
    );
    // One run of sc-erp called the tool; the run that called nothing adds no edge.
    expect(edge(graph, 'script-call:script:sc-erp>tool:t-list')!.stats).toEqual({
      calls: 1,
      errors: 0,
      lastAt: T1.toISOString(),
    });
    expect(edge(graph, 'script-use:script:sc-erp>tool:t-list')!.stats).toBeUndefined();
  });

  it('aggregates script run statistics', () => {
    expect(node(graph, 'script:sc-erp')!.stats).toEqual({
      calls: 2,
      errors: 1,
      bytesIn: 5000,
      bytesOut: 50,
      avgMs: 200,
      lastAt: T1.toISOString(),
    });
  });

  it('binds every query to the organization', () => {
    expect(mentionsOrg(prisma.mcpServerConfig.findFirst.mock.calls[0][0].where)).toBe(true);
    expect(mentionsOrg(prisma.connector.findMany.mock.calls[0][0].where)).toBe(true);
    expect(mentionsOrg(prisma.mcpTool.findMany.mock.calls[0][0].where)).toBe(true);
    expect(mentionsOrg(prisma.toolInvocation.groupBy.mock.calls[0][0].where)).toBe(true);
    expect(mentionsOrg(prisma.sandboxScript.findMany.mock.calls[0][0].where)).toBe(true);
    expect(mentionsOrg(prisma.sandboxRun.findMany.mock.calls[0][0].where)).toBe(true);
    // The raw byte query is parameterised with the organization, as the first value.
    const [, ...values] = prisma.$queryRaw.mock.calls[0];
    expect(values[0]).toBe(ORG);
    expect(values[1]).toBe(SERVER);
    const sql = (prisma.$queryRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toContain('organization_id = ?');
  });

  it('scopes statistics to the server and the window', () => {
    const where = prisma.toolInvocation.groupBy.mock.calls[0][0].where;
    expect(where.mcpServerId).toBe(SERVER);
    expect(where.createdAt.gte).toEqual(new Date(graph.since));
  });

  it('answers 404 for a server of another organization, reading nothing else', async () => {
    const p = makePrisma();
    await expect(new FlowService(p as any).buildGraph(OTHER_ORG, SERVER, '24h')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(p.connector.findMany).not.toHaveBeenCalled();
    expect(p.toolInvocation.groupBy).not.toHaveBeenCalled();
    expect(p.$queryRaw).not.toHaveBeenCalled();
  });

  it('honours the 1h and 7d windows', async () => {
    const g1 = await service.buildGraph(ORG, SERVER, '1h');
    expect(Date.parse(g1.generatedAt) - Date.parse(g1.since)).toBe(60 * 60 * 1000);
    const g7 = await service.buildGraph(ORG, SERVER, '7d');
    expect(Date.parse(g7.generatedAt) - Date.parse(g7.since)).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('still answers when the byte totals cannot be read', async () => {
    prisma.$queryRaw.mockRejectedValueOnce(new Error('boom'));
    const g = await service.buildGraph(ORG, SERVER, '24h');
    expect(node(g, 'tool:t-list')!.stats).toMatchObject({ calls: 7, errors: 4 });
    expect(node(g, 'tool:t-list')!.stats!.bytesOut).toBeUndefined();
    expect(node(g, 'processing:t-list')!.stats!.bytesIn).toBeUndefined();
  });

  it('keeps the 500 most-called tools and marks the server truncated', async () => {
    const many = Array.from({ length: FLOW_MAX_TOOLS + 1 }, (_, i) => ({
      id: `t${i}`,
      connectorId: 'c-erp',
      name: `erp_tool_${String(i).padStart(3, '0')}`,
      endpointMapping: { method: 'GET', path: '/x' },
      responseMapping: null,
      annotations: null,
    }));
    const p = makePrisma({
      tools: many,
      groups: [
        { toolId: 't500', status: 'SUCCESS', _count: { _all: 9 }, _sum: { repeatCount: 9 }, _avg: { durationMs: 5 }, _max: { createdAt: T0 } },
      ],
    });
    const g = await new FlowService(p as any).buildGraph(ORG, SERVER, '24h');
    const toolNodes = g.nodes.filter((n) => n.kind === 'tool');
    expect(toolNodes).toHaveLength(FLOW_MAX_TOOLS);
    // The only called tool is the last by name, and it is kept.
    expect(node(g, 'tool:t500')).toBeDefined();
    expect(node(g, `server:${SERVER}`)!.meta).toMatchObject({ truncated: true });
    // No edge points at a dropped tool.
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) expect(ids.has(e.target) && ids.has(e.source)).toBe(true);
  });

  it('does not mark a server truncated when everything fits', () => {
    expect(node(graph, `server:${SERVER}`)!.meta).not.toHaveProperty('truncated');
  });
});
