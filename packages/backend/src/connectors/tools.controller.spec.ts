import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { ToolsController } from './tools.controller';

const RAW = {
  pageDetails: { count: 1, totalCount: 812 },
  devices: [{ id: 1, hostname: 'PC-01', deviceType: { category: 'Desktop' }, udf: { u1: 'x' } }],
};

const TRANSFORM = {
  select: {
    total: '$.pageDetails.totalCount',
    devices: { $from: '$.devices[*]', $select: { hostname: 'hostname' } },
  },
};

const MAPPED = { total: 812, devices: [{ hostname: 'PC-01' }] };

function buildController(overrides: { prisma?: any; connectorsService?: any; mcpServer?: any } = {}) {
  const prisma = overrides.prisma ?? {
    mcpTool: {
      create: jest.fn().mockResolvedValue({ id: 't1' }),
      update: jest.fn().mockResolvedValue({ id: 't1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue({ id: 't1', responseMapping: null }),
      findUnique: jest.fn().mockResolvedValue({ id: 't1' }),
    },
    toolInvocation: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const connectorsService = overrides.connectorsService ?? {
    findById: jest.fn().mockResolvedValue({ id: 'c1', organizationId: 'org1', userId: 'u1', type: 'REST' }),
    executeConnectorCall: jest.fn().mockResolvedValue(RAW),
  };
  const mcpServer = overrides.mcpServer ?? {
    reloadConnectorTools: jest.fn().mockResolvedValue(undefined),
  };
  const controller = new ToolsController(prisma as any, mcpServer as any, connectorsService as any);
  return { controller, prisma, connectorsService, mcpServer };
}

const req = (role = 'ADMIN') => ({ user: { sub: 'u1', organizationId: 'org1', role } });

describe('ToolsController — response mapping validation', () => {
  it('rejects a malformed transform on create instead of degrading at call time', async () => {
    const { controller, prisma } = buildController();
    await expect(
      controller.create(req(), 'c1', {
        name: 't',
        description: 'd',
        parameters: {},
        endpointMapping: { method: 'GET', path: '/x' },
        responseMapping: { transform: { select: { a: 'bad[' } } },
      } as any),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.mcpTool.create).not.toHaveBeenCalled();
  });

  it('accepts a well-formed transform', async () => {
    const { controller, prisma } = buildController();
    await controller.create(req(), 'c1', {
      name: 't',
      description: 'd',
      parameters: {},
      endpointMapping: { method: 'GET', path: '/x' },
      responseMapping: { transform: TRANSFORM },
    } as any);
    expect(prisma.mcpTool.create).toHaveBeenCalled();
  });

  it('rejects a malformed transform on update', async () => {
    const { controller, prisma } = buildController();
    await expect(
      controller.update(req(), 't1', 'c1', {
        responseMapping: { transform: { mode: 'jmespath', expression: '((((' } },
      } as any),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.mcpTool.updateMany).not.toHaveBeenCalled();
  });

  it('drops a stale outputSchema when the transform changes', async () => {
    const { controller, prisma } = buildController();
    prisma.mcpTool.findFirst.mockResolvedValue({ responseMapping: { transform: { select: { a: 'a' } } } });
    await controller.update(req(), 't1', 'c1', { responseMapping: { transform: TRANSFORM } } as any);
    expect(prisma.mcpTool.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ outputSchema: null }) }),
    );
  });

  it('keeps the outputSchema when the transform is unchanged', async () => {
    const { controller, prisma } = buildController();
    prisma.mcpTool.findFirst.mockResolvedValue({ responseMapping: { transform: TRANSFORM } });
    await controller.update(req(), 't1', 'c1', {
      responseMapping: { transform: TRANSFORM, cacheTtl: 60 },
    } as any);
    const data = prisma.mcpTool.updateMany.mock.calls[0][0].data;
    expect(data.outputSchema).toBeUndefined();
  });
});

describe('ToolsController — PATCH response-mapping', () => {
  it('stores the transform while preserving cacheTtl and followUp', async () => {
    const { controller, prisma, mcpServer } = buildController();
    prisma.mcpTool.findFirst.mockResolvedValue({
      responseMapping: { cacheTtl: 300, followUp: 'then call X' },
    });

    const res = await controller.setResponseMapping(req(), 't1', 'c1', { transform: TRANSFORM });

    expect(res).toEqual({
      transform: TRANSFORM,
      active: true,
      processors: null,
      processorsActive: false,
    });
    expect(prisma.mcpTool.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          responseMapping: { cacheTtl: 300, followUp: 'then call X', transform: TRANSFORM },
        }),
      }),
    );
    expect(mcpServer.reloadConnectorTools).toHaveBeenCalledWith('c1');
  });

  it('clears the transform on null and keeps the other keys', async () => {
    const { controller, prisma } = buildController();
    prisma.mcpTool.findFirst.mockResolvedValue({
      responseMapping: { cacheTtl: 300, transform: TRANSFORM },
    });

    const res = await controller.setResponseMapping(req(), 't1', 'c1', { transform: null });

    expect(res).toEqual({
      transform: null,
      active: false,
      processors: null,
      processorsActive: false,
    });
    expect(prisma.mcpTool.updateMany.mock.calls[0][0].data.responseMapping).toEqual({ cacheTtl: 300 });
  });

  it('rejects a malformed transform', async () => {
    const { controller } = buildController();
    await expect(
      controller.setResponseMapping(req(), 't1', 'c1', { transform: { select: { a: 'a[' } } }),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses a tool that does not belong to the connector', async () => {
    const { controller, prisma } = buildController();
    prisma.mcpTool.findFirst.mockResolvedValue(null);
    await expect(
      controller.setResponseMapping(req(), 't1', 'c1', { transform: TRANSFORM }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('refuses a VIEWER', async () => {
    const { controller } = buildController();
    await expect(
      controller.setResponseMapping(req('VIEWER'), 't1', 'c1', { transform: TRANSFORM }),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('ToolsController — preview-mapping', () => {
  it('maps an explicit sample without calling the upstream API', async () => {
    const { controller, connectorsService } = buildController();
    const res: any = await controller.previewMapping(req(), 't1', 'c1', {
      transform: TRANSFORM,
      sample: RAW,
    });

    expect(connectorsService.executeConnectorCall).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(res.sampleSource).toBe('body');
    expect(res.mapped).toEqual(MAPPED);
    expect(res.mappingApplied).toBe(true);
    expect(res.rawBytes).toBeGreaterThan(res.mappedBytes);
    expect(res.bytesSavedPct).toBeGreaterThan(0);
  });

  it('falls back to the most recent recorded response', async () => {
    const { controller, prisma } = buildController();
    prisma.toolInvocation.findMany.mockResolvedValue([
      { output: null, createdAt: new Date('2026-07-30') },
      { output: RAW, createdAt: new Date('2026-07-29') },
    ]);

    const res: any = await controller.previewMapping(req(), 't1', 'c1', { transform: TRANSFORM });

    expect(res.ok).toBe(true);
    expect(res.sampleSource).toBe('last-invocation');
    expect(res.raw).toEqual(RAW);
    expect(res.mapped).toEqual(MAPPED);
  });

  it('explains what to do when there is no sample at all', async () => {
    const { controller } = buildController();
    const res: any = await controller.previewMapping(req(), 't1', 'c1', { transform: TRANSFORM });
    expect(res.ok).toBe(false);
    expect(res.sampleSource).toBe('none');
    expect(res.error).toMatch(/Run the tool once/);
  });

  it('previews the stored mapping when no transform is supplied', async () => {
    const { controller, prisma } = buildController();
    prisma.mcpTool.findFirst.mockResolvedValue({ responseMapping: { transform: TRANSFORM } });
    const res: any = await controller.previewMapping(req(), 't1', 'c1', { sample: RAW });
    expect(res.mapped).toEqual(MAPPED);
  });

  it('previews "no mapping" for an explicit null', async () => {
    const { controller, prisma } = buildController();
    prisma.mcpTool.findFirst.mockResolvedValue({ responseMapping: { transform: TRANSFORM } });
    const res: any = await controller.previewMapping(req(), 't1', 'c1', {
      transform: null,
      sample: RAW,
    });
    expect(res.mappingApplied).toBe(false);
    expect(res.mapped).toEqual(RAW);
  });

  it('rejects a malformed transform', async () => {
    const { controller } = buildController();
    await expect(
      controller.previewMapping(req(), 't1', 'c1', { transform: { select: { a: 'a[' } }, sample: RAW }),
    ).rejects.toThrow(BadRequestException);
  });

  it('stores nothing', async () => {
    const { controller, prisma } = buildController();
    await controller.previewMapping(req(), 't1', 'c1', { transform: TRANSFORM, sample: RAW });
    expect(prisma.mcpTool.update).not.toHaveBeenCalled();
    expect(prisma.mcpTool.updateMany).not.toHaveBeenCalled();
  });
});

describe('ToolsController — test endpoint', () => {
  const tool = (responseMapping?: unknown) => ({
    id: 't1',
    connectorId: 'c1',
    outputSchema: { type: 'object', properties: { pageDetails: {} } },
    endpointMapping: { method: 'GET', path: '/devices' },
    responseMapping,
    connector: { id: 'c1', authType: 'NONE', type: 'REST' },
  });

  it('keeps `result` raw and adds the mapped view', async () => {
    const { controller, prisma } = buildController();
    prisma.mcpTool.findUnique.mockResolvedValue(tool({ transform: TRANSFORM }));

    const res: any = await controller.testTool('c1', 't1', req(), {});

    expect(res.ok).toBe(true);
    expect(res.result).toEqual(RAW); // unchanged for existing API consumers
    expect(res.mapped).toEqual(MAPPED);
    expect(res.mappingApplied).toBe(true);
    expect(res.bytesSavedPct).toBeGreaterThan(0);
  });

  it('reports mappingApplied=false and mapped=raw for a tool without a mapping', async () => {
    const { controller, prisma } = buildController();
    prisma.mcpTool.findUnique.mockResolvedValue(tool(undefined));

    const res: any = await controller.testTool('c1', 't1', req(), {});

    expect(res.mappingApplied).toBe(false);
    expect(res.mapped).toEqual(RAW);
    expect(res.rawBytes).toBe(res.mappedBytes);
    expect(res.bytesSavedPct).toBe(0);
  });

  it('previews an unsaved transform passed in the body without persisting it', async () => {
    const { controller, prisma } = buildController();
    prisma.mcpTool.findUnique.mockResolvedValue(tool(undefined));

    const res: any = await controller.testTool('c1', 't1', req(), { transform: TRANSFORM });

    expect(res.mapped).toEqual(MAPPED);
    expect(prisma.mcpTool.update).not.toHaveBeenCalled();
  });

  it('reports a broken mapping instead of hiding it', async () => {
    const { controller, prisma } = buildController();
    prisma.mcpTool.findUnique.mockResolvedValue(tool({ transform: { select: { a: 'a[' } } }));

    const res: any = await controller.testTool('c1', 't1', req(), {});

    expect(res.ok).toBe(true);
    expect(res.mappingApplied).toBe(false);
    expect(res.mappingError).toMatch(/Unclosed/);
  });

  it('infers the output schema from the mapped shape when a mapping is active', async () => {
    const { controller, prisma } = buildController();
    prisma.mcpTool.findUnique.mockResolvedValue({ ...tool({ transform: TRANSFORM }), outputSchema: null });

    await controller.testTool('c1', 't1', req(), {});

    const inferred = prisma.mcpTool.update.mock.calls[0][0].data.outputSchema;
    expect(Object.keys(inferred.properties).sort()).toEqual(['devices', 'total']);
  });
});

describe('ToolsController — duplicate tool names', () => {
  const unique = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
  const dto = { name: 'get_orders', description: 'd', parameters: {}, endpointMapping: { method: 'GET', path: '/orders' } } as any;

  it('answers 409 with the name when a tool of that name already exists', async () => {
    const { controller, prisma, mcpServer } = buildController();
    prisma.mcpTool.create.mockRejectedValueOnce(unique());
    const err = await controller.create(req(), 'c1', dto).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toContain('"get_orders" already exists');
    expect(mcpServer.reloadConnectorTools).not.toHaveBeenCalled();
  });

  it('answers 409 when a rename collides with another tool', async () => {
    const { controller, prisma } = buildController();
    prisma.mcpTool.updateMany.mockRejectedValueOnce(unique());
    await expect(controller.update(req(), 't1', 'c1', { name: 'get_orders' } as any)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('still lets any other database error through', async () => {
    const { controller, prisma } = buildController();
    prisma.mcpTool.create.mockRejectedValueOnce(new Error('connection lost'));
    await expect(controller.create(req(), 'c1', dto)).rejects.toThrow('connection lost');
  });
});

/* ------------------------------------------------------------------ */
/*  Response processor chains                                          */
/* ------------------------------------------------------------------ */

const OFFERS = {
  category: 'fasteners',
  items: [
    { itemNo: 'A-OFF-FAS-001', description: '  Black   Screw\n60mm ', price_usd: 54.67, moq: 100 },
    { itemNo: 'A-OFF-FAS-002', description: 'Steel Plate 19mm', price_usd: 75.87, moq: 10 },
  ],
};

/** The three steps of the currency example: convert, add VAT, clean the text. */
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
    {
      id: 'add_vat',
      processor: 'number_vat@1',
      each: '$.items[*]',
      reads: 'price_eur',
      writes: 'price_eur_gross',
      mode: 'add',
      params: { rate: 0.19, round: 2 },
    },
    {
      id: 'clean_description',
      processor: 'text_clean@1',
      each: '$.items[*]',
      reads: 'description',
      writes: 'description',
      mode: 'replace',
    },
  ],
};

describe('ToolsController — processor chain validation', () => {
  it('rejects an unknown processor on create instead of failing every later call', async () => {
    const { controller, prisma } = buildController();
    await expect(
      controller.create(req(), 'c1', {
        name: 't',
        description: 'd',
        parameters: {},
        endpointMapping: { method: 'GET', path: '/x' },
        responseMapping: {
          processors: { steps: [{ id: 'a', processor: 'nope', reads: 'a', writes: 'b' }] },
        },
      } as any),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.mcpTool.create).not.toHaveBeenCalled();
  });

  it('accepts a well-formed chain on create', async () => {
    const { controller, prisma } = buildController();
    await controller.create(req(), 'c1', {
      name: 't',
      description: 'd',
      parameters: {},
      endpointMapping: { method: 'GET', path: '/x' },
      responseMapping: { processors: CHAIN },
    } as any);
    expect(prisma.mcpTool.create).toHaveBeenCalled();
  });

  it('rejects a chain whose step parameter does not exist', async () => {
    const { controller } = buildController();
    await expect(
      controller.setResponseMapping(req(), 't1', 'c1', {
        processors: {
          steps: [
            {
              id: 'a',
              processor: 'number_scale@1',
              reads: 'a',
              writes: 'b',
              params: { rate: 1 },
            },
          ],
        },
      } as any),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('ToolsController — PATCH response-mapping with a chain', () => {
  it('stores the chain and reports it active', async () => {
    const { controller, prisma, mcpServer } = buildController();
    const res: any = await controller.setResponseMapping(req(), 't1', 'c1', {
      processors: CHAIN,
    } as any);
    expect(res.processorsActive).toBe(true);
    const data = prisma.mcpTool.updateMany.mock.calls[0][0].data;
    expect(data.responseMapping.processors).toEqual(CHAIN);
    // A chain adds fields, so the advertised shape is no longer current.
    expect(data.outputSchema).toBeNull();
    expect(mcpServer.reloadConnectorTools).toHaveBeenCalledWith('c1');
  });

  it('leaves a stored chain alone when only the transform is sent', async () => {
    const prisma = {
      mcpTool: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue({
          id: 't1',
          responseMapping: { processors: CHAIN, cacheTtl: 60 },
        }),
      },
      toolInvocation: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const { controller } = buildController({ prisma });
    const res: any = await controller.setResponseMapping(req(), 't1', 'c1', {
      transform: TRANSFORM,
    } as any);
    const data = prisma.mcpTool.updateMany.mock.calls[0][0].data;
    expect(data.responseMapping.processors).toEqual(CHAIN);
    expect(data.responseMapping.cacheTtl).toBe(60);
    expect(res.processorsActive).toBe(true);
  });

  it('removes the chain on processors: null, keeping the transform', async () => {
    const prisma = {
      mcpTool: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 't1', responseMapping: { processors: CHAIN } }),
      },
      toolInvocation: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const { controller } = buildController({ prisma });
    const res: any = await controller.setResponseMapping(req(), 't1', 'c1', {
      transform: TRANSFORM,
      processors: null,
    } as any);
    const data = prisma.mcpTool.updateMany.mock.calls[0][0].data;
    expect(data.responseMapping.processors).toBeUndefined();
    expect(data.responseMapping.transform).toEqual(TRANSFORM);
    expect(res.processorsActive).toBe(false);
  });

  it('reports the stored chain on GET', async () => {
    const prisma = {
      mcpTool: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 't1', responseMapping: { processors: CHAIN } }),
      },
      toolInvocation: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const { controller } = buildController({ prisma });
    const res: any = await controller.getResponseMapping(req(), 't1', 'c1');
    expect(res.processors).toEqual(CHAIN);
    expect(res.processorsActive).toBe(true);
  });
});

describe('ToolsController — preview-processors', () => {
  const withSample = (responseMapping: any = null) => ({
    mcpTool: { findFirst: jest.fn().mockResolvedValue({ id: 't1', responseMapping }) },
    toolInvocation: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ output: OFFERS, createdAt: new Date('2026-10-17T09:00:00Z') }]),
    },
  });

  it('runs the chain against the last real response and traces every step', async () => {
    const { controller } = buildController({ prisma: withSample() });
    const res: any = await controller.previewProcessors(req(), 't1', 'c1', {
      processors: CHAIN,
    } as any);
    expect(res.ok).toBe(true);
    expect(res.sampleSource).toBe('last-invocation');
    expect(res.steps.map((s: any) => s.id)).toEqual([
      'convert_to_eur',
      'add_vat',
      'clean_description',
    ]);
    expect(res.steps[0]).toMatchObject({ targets: 2, written: 2, skipped: 0 });
    expect(res.steps[0].bytesAfter).toBeGreaterThan(0);
    expect(res.result.items[0]).toMatchObject({
      price_eur: 50.3,
      price_eur_gross: 59.86,
      description: 'Black Screw 60mm',
      // Everything the chain was not pointed at is untouched.
      itemNo: 'A-OFF-FAS-001',
      price_usd: 54.67,
      moq: 100,
    });
    expect(res.resultBytes).toBeGreaterThan(res.rawBytes);
  });

  it('reports the step and the JSON path of a refused value, and edits nothing', async () => {
    const broken = {
      mcpTool: { findFirst: jest.fn().mockResolvedValue({ id: 't1', responseMapping: null }) },
      toolInvocation: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const { controller } = buildController({ prisma: broken });
    const res: any = await controller.previewProcessors(req(), 't1', 'c1', {
      processors: CHAIN,
      sample: { items: [{ itemNo: 'A-1', description: 'x', price_usd: 'n/a' }] },
    } as any);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('step convert_to_eur: $.items[0].price_usd is not a number');
    expect(res.failedStep).toBe('convert_to_eur');
    expect(res.failedPath).toBe('$.items[0].price_usd');
    expect(res.result.items[0].price_eur).toBeUndefined();
  });

  it('previews the chain stored on the tool when none is sent', async () => {
    const { controller } = buildController({ prisma: withSample({ processors: CHAIN }) });
    const res: any = await controller.previewProcessors(req(), 't1', 'c1', {} as any);
    expect(res.chainActive).toBe(true);
    expect(res.result.items[1].price_eur).toBe(69.8);
  });

  it('says there is nothing to run when the tool has no chain', async () => {
    const { controller } = buildController({ prisma: withSample() });
    const res: any = await controller.previewProcessors(req(), 't1', 'c1', {} as any);
    expect(res.chainActive).toBe(false);
    expect(res.steps).toEqual([]);
  });

  it('rejects an unusable chain instead of previewing it', async () => {
    const { controller } = buildController({ prisma: withSample() });
    await expect(
      controller.previewProcessors(req(), 't1', 'c1', {
        processors: { steps: [{ id: 'a', processor: 'number_scale@1', reads: 'a', writes: 'b' }] },
      } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('asks for a sample when the tool has never been called', async () => {
    const empty = {
      mcpTool: { findFirst: jest.fn().mockResolvedValue({ id: 't1', responseMapping: null }) },
      toolInvocation: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const { controller } = buildController({ prisma: empty });
    const res: any = await controller.previewProcessors(req(), 't1', 'c1', {
      processors: CHAIN,
    } as any);
    expect(res.ok).toBe(false);
    expect(res.sampleSource).toBe('none');
    expect(res.error).toContain('No sample available');
  });

  it('refuses a caller who may not write the connector', async () => {
    const connectorsService = {
      findById: jest
        .fn()
        .mockResolvedValue({ id: 'c1', organizationId: 'org1', userId: 'someone-else' }),
    };
    const { controller } = buildController({ prisma: withSample(), connectorsService });
    await expect(
      controller.previewProcessors(req('EDITOR'), 't1', 'c1', { processors: CHAIN } as any),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('ToolsController — preview-mapping with a chain', () => {
  it('shows what the client receives after the chain and then the transform', async () => {
    const prisma = {
      mcpTool: { findFirst: jest.fn().mockResolvedValue({ id: 't1', responseMapping: null }) },
      toolInvocation: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const { controller } = buildController({ prisma });
    const res: any = await controller.previewMapping(req(), 't1', 'c1', {
      processors: CHAIN,
      // The transform can select a field the chain has just written.
      transform: { select: { gross: { $from: '$.items[*]', $select: { g: 'price_eur_gross' } } } },
      sample: OFFERS,
    } as any);
    expect(res.ok).toBe(true);
    expect(res.mapped.gross).toEqual([{ g: 59.86 }, { g: 83.06 }]);
    expect(res.processorSteps).toHaveLength(3);
    expect(res.mappedBytes).toBeLessThan(res.rawBytes);
  });

  it('reports a chain failure as a processor error, not a mapping error', async () => {
    const prisma = {
      mcpTool: { findFirst: jest.fn().mockResolvedValue({ id: 't1', responseMapping: null }) },
      toolInvocation: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const { controller } = buildController({ prisma });
    const res: any = await controller.previewMapping(req(), 't1', 'c1', {
      processors: CHAIN,
      sample: { items: [{ description: 'x', price_usd: null }] },
    } as any);
    expect(res.processorError).toContain('$.items[0].price_usd is not a number');
    expect(res.mappingError).toBeUndefined();
  });
});
