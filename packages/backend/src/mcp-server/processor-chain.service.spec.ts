import { ProcessorChainService } from './processor-chain.service';

const CHAIN = {
  version: 1,
  steps: [
    {
      id: 'convert_to_eur',
      processor: 'number_scale@1',
      each: '$.items[*]',
      reads: 'price_usd',
      writes: 'price_eur',
      params: { factor: 0.92, round: 2 },
    },
  ],
};

const scope = (over: Record<string, unknown> = {}) => ({
  userId: 'alice',
  organizationId: 'org-A',
  connectorIds: ['conn-supplier', 'conn-erp'],
  visibleToolNames: new Set(['mock_supplier_list_offers']),
  ...over,
});

function build(
  overrides: {
    user?: { role: string; organizationId: string | null } | null;
    connectors?: Array<{ id: string; userId: string }>;
    tools?: any[];
    invocations?: any[];
  } = {},
) {
  const prisma = {
    user: {
      // `in`, not `??`: a test passes `user: null` to mean "the row is gone".
      findUnique: jest.fn(async () =>
        'user' in overrides ? overrides.user : { role: 'ADMIN', organizationId: 'org-A' },
      ),
    },
    connector: {
      findMany: jest.fn(async () =>
        overrides.connectors ?? [
          { id: 'conn-supplier', userId: 'alice' },
          { id: 'conn-erp', userId: 'bob' },
        ],
      ),
    },
    mcpTool: {
      findMany: jest.fn(async () =>
        overrides.tools ?? [
          {
            id: 'tool-1',
            name: 'mock_supplier_list_offers',
            connectorId: 'conn-supplier',
            responseMapping: null,
            connector: { name: 'Mock Supplier' },
          },
        ],
      ),
      updateMany: jest.fn(async (_args?: any) => ({ count: 1 })),
    },
    toolInvocation: { findMany: jest.fn(async () => overrides.invocations ?? []) },
  };
  const mcpServer = { reloadConnectorTools: jest.fn(async () => undefined) };
  const service = new ProcessorChainService(prisma as any, mcpServer as any);
  return { service, prisma, mcpServer };
}

describe('ProcessorChainService — who may edit a tool-s response', () => {
  it('lets an admin of the owning organization edit every connector of the server', async () => {
    const { service } = build();
    await expect(service.editableConnectorIds(scope())).resolves.toEqual([
      'conn-supplier',
      'conn-erp',
    ]);
    await expect(service.canEdit(scope())).resolves.toBe(true);
  });

  it('lets an editor edit only the connectors they own', async () => {
    const { service } = build({ user: { role: 'EDITOR', organizationId: 'org-A' } });
    await expect(service.editableConnectorIds(scope())).resolves.toEqual(['conn-supplier']);
  });

  it('lets a viewer who owns nothing edit nothing', async () => {
    const { service } = build({
      user: { role: 'VIEWER', organizationId: 'org-A' },
      connectors: [{ id: 'conn-supplier', userId: 'bob' }],
    });
    await expect(service.canEdit(scope())).resolves.toBe(false);
  });

  it('edits nothing on a server of another workspace, even as an admin there', async () => {
    const { service } = build({ user: { role: 'ADMIN', organizationId: 'org-B' } });
    await expect(service.editableConnectorIds(scope())).resolves.toEqual([]);
  });

  it('edits nothing without a user: an API-key session is never offered the tools', async () => {
    const { service, prisma } = build();
    await expect(service.editableConnectorIds(scope({ userId: undefined }))).resolves.toEqual([]);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('edits nothing on a server with no connectors', async () => {
    const { service } = build();
    await expect(service.editableConnectorIds(scope({ connectorIds: [] }))).resolves.toEqual([]);
  });

  it('edits nothing for a user that no longer exists', async () => {
    const { service } = build({ user: null });
    await expect(service.canEdit(scope())).resolves.toBe(false);
  });

  it('asks only for connectors of the owning organization', async () => {
    const { service, prisma } = build();
    await service.editableConnectorIds(scope());
    expect(prisma.connector.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['conn-supplier', 'conn-erp'] }, organizationId: 'org-A' },
      }),
    );
  });
});

describe('ProcessorChainService — finding a tool', () => {
  it('returns the tool with its chain and whether this caller may change it', async () => {
    const { service, prisma } = build({
      tools: [
        {
          id: 'tool-1',
          name: 'mock_supplier_list_offers',
          connectorId: 'conn-supplier',
          responseMapping: { processors: CHAIN },
          connector: { name: 'Mock Supplier' },
        },
      ],
    });
    const found: any = await service.findTool('mock_supplier_list_offers', scope() as any);
    expect(found).toMatchObject({
      toolId: 'tool-1',
      connectorName: 'Mock Supplier',
      editable: true,
    });
    expect(found.responseMapping.processors).toEqual(CHAIN);
    // Scoped to the server's own connectors and the owning organization.
    expect(prisma.mcpTool.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          name: 'mock_supplier_list_offers',
          connectorId: { in: ['conn-supplier', 'conn-erp'] },
          connector: { organizationId: 'org-A' },
        },
      }),
    );
  });

  it('returns null for a tool that is not on this server', async () => {
    const { service } = build({ tools: [] });
    await expect(service.findTool('mock_payroll_list_salaries', scope() as any)).resolves.toBeNull();
  });

  it('reports the connectors by name when two of them share the tool name', async () => {
    const { service } = build({
      tools: [
        { id: 't1', name: 'x', connectorId: 'conn-supplier', responseMapping: null, connector: { name: 'Mock Supplier' } },
        { id: 't2', name: 'x', connectorId: 'conn-erp', responseMapping: null, connector: { name: 'Mock ERP' } },
      ],
    });
    await expect(service.findTool('x', scope() as any)).resolves.toEqual({
      ambiguous: ['Mock Supplier', 'Mock ERP'],
    });
  });

  it('marks a tool on a connector this caller does not own as not editable', async () => {
    const { service } = build({
      user: { role: 'EDITOR', organizationId: 'org-A' },
      tools: [
        {
          id: 'tool-2',
          name: 'mock_erp_list_orders',
          connectorId: 'conn-erp',
          responseMapping: null,
          connector: { name: 'Mock ERP' },
        },
      ],
    });
    const found: any = await service.findTool('mock_erp_list_orders', scope() as any);
    expect(found.editable).toBe(false);
  });
});

describe('ProcessorChainService — storing a chain', () => {
  const target = (responseMapping: any = null) => ({
    toolId: 'tool-1',
    toolName: 'mock_supplier_list_offers',
    connectorId: 'conn-supplier',
    connectorName: 'Mock Supplier',
    responseMapping,
    editable: true,
  });

  it('stores the chain, keeps the rest of the mapping, and reloads the connector', async () => {
    const { service, prisma, mcpServer } = build();
    await service.saveChain(target({ cacheTtl: 60, transform: { select: { a: 'a' } } }), CHAIN);
    const data = (prisma.mcpTool.updateMany.mock.calls[0] as any[])[0].data;
    expect(data.responseMapping).toEqual({
      cacheTtl: 60,
      transform: { select: { a: 'a' } },
      processors: CHAIN,
    });
    // The chain adds fields, so the advertised shape is stale.
    expect(data.outputSchema).toBeNull();
    expect(mcpServer.reloadConnectorTools).toHaveBeenCalledWith('conn-supplier');
  });

  it('removes only the chain, leaving the mapping in place', async () => {
    const { service, prisma } = build();
    await service.saveChain(target({ cacheTtl: 60, processors: CHAIN }), null);
    const data = (prisma.mcpTool.updateMany.mock.calls[0] as any[])[0].data;
    expect(data.responseMapping).toEqual({ cacheTtl: 60 });
  });

  it('clears the mapping entirely when the chain was all it held', async () => {
    const { service, prisma } = build();
    await service.saveChain(target({ processors: CHAIN }), null);
    expect((prisma.mcpTool.updateMany.mock.calls[0] as any[])[0].data.responseMapping).toBeNull();
  });

  it('writes only to the tool of that connector', async () => {
    const { service, prisma } = build();
    await service.saveChain(target(), CHAIN);
    expect((prisma.mcpTool.updateMany.mock.calls[0] as any[])[0].where).toEqual({
      id: 'tool-1',
      connectorId: 'conn-supplier',
    });
  });
});

describe('ProcessorChainService — the sample a preview runs on', () => {
  it('returns the most recent recorded response', async () => {
    const captured = new Date('2026-10-17T09:00:00Z');
    const { service } = build({
      invocations: [{ output: { items: [] }, createdAt: captured }],
    });
    await expect(service.lastSample('tool-1')).resolves.toEqual({
      output: { items: [] },
      capturedAt: captured,
    });
  });

  it('skips older rows that recorded no output', async () => {
    const { service } = build({
      invocations: [
        { output: null, createdAt: new Date('2026-10-17T10:00:00Z') },
        { output: { items: [1] }, createdAt: new Date('2026-10-17T09:00:00Z') },
      ],
    });
    const sample: any = await service.lastSample('tool-1');
    expect(sample.output).toEqual({ items: [1] });
  });

  it('returns null when the tool has never answered', async () => {
    const { service } = build({ invocations: [] });
    await expect(service.lastSample('tool-1')).resolves.toBeNull();
  });
});
