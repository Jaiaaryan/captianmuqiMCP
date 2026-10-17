import { BadRequestException, ForbiddenException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { ResponseProcessingController } from './response-processing.controller';
import { DryRunDto, PreviewDto, ValidateChainDto } from './response-processing.dto';
import { ResponseProcessingService } from './response-processing.service';

const chain = {
  version: 1,
  enabled: true,
  onError: 'fail',
  steps: [
    {
      id: 'eur',
      use: 'scale@1',
      each: '$.items[*]',
      reads: 'price_usd',
      writes: 'price_eur',
      mode: 'add',
      params: { factor: 0.5, round: 2 },
    },
  ],
};
const sample = { items: [{ price_usd: 10 }] };

const ORG = 'org-a';
const editor = { user: { sub: 'u1', role: 'EDITOR', organizationId: ORG } } as any;
const viewer = { user: { sub: 'u2', role: 'VIEWER', organizationId: ORG } } as any;

function setup(opts: { tool?: any; invocations?: any[] } = {}) {
  const prisma = {
    mcpTool: {
      findFirst: jest.fn(async ({ where }: any) =>
        opts.tool && where.connector.organizationId === opts.tool.org ? opts.tool.row : null,
      ),
    },
    toolInvocation: {
      findMany: jest.fn(async () => opts.invocations ?? []),
    },
  };
  const service = new ResponseProcessingService(prisma as any);
  return { controller: new ResponseProcessingController(service), prisma };
}

const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
const body = (type: any, value: unknown) =>
  pipe.transform(value, { type: 'body', metatype: type });

describe('ResponseProcessingController', () => {
  describe('GET builtins', () => {
    it('lists processors, modes and limits', () => {
      const out = setup().controller.builtins();
      expect(out.builtins).toHaveLength(7);
      expect(out.modes).toEqual(['add', 'replace', 'upsert']);
      expect(out.limits).toEqual({
        maxSteps: 20,
        script: { timeoutMs: 250, memoryMb: 32, maxCodeBytes: 16384, maxResultBytes: 1048576 },
      });
    });
  });

  describe('POST validate', () => {
    it('accepts a good chain', async () => {
      const dto = (await body(ValidateChainDto, { chain })) as ValidateChainDto;
      expect(setup().controller.validate(editor, dto)).toEqual({ valid: true });
    });

    it('names the problem of a bad chain', async () => {
      const bad = { ...chain, steps: [{ ...chain.steps[0], params: { factor: 1, round: 99 } }] };
      const dto = (await body(ValidateChainDto, { chain: bad })) as ValidateChainDto;
      const out = setup().controller.validate(editor, dto) as any;
      expect(out.valid).toBe(false);
      expect(out.problem).toMatch(/^step eur: params\.round/);
    });

    it('is a 400 without a chain object', async () => {
      await expect(body(ValidateChainDto, {})).rejects.toBeInstanceOf(BadRequestException);
      await expect(body(ValidateChainDto, { chain: 'x' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(body(ValidateChainDto, { chain, extra: 1 })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('keeps viewers out', async () => {
      const dto = (await body(ValidateChainDto, { chain })) as ValidateChainDto;
      expect(() => setup().controller.validate(viewer, dto)).toThrow(ForbiddenException);
    });
  });

  describe('POST dry-run', () => {
    it('runs with a trace', async () => {
      const dto = (await body(DryRunDto, { chain, sample })) as DryRunDto;
      const out = setup().controller.dryRun(editor, dto);
      expect(out.ok).toBe(true);
      expect(out.result).toEqual({ items: [{ price_usd: 10, price_eur: 5 }] });
      expect(out.steps).toHaveLength(1);
      expect(out.steps[0]).toMatchObject({ id: 'eur', wrote: 1, skipped: 0 });
    });

    it('reports a failing step with its path', async () => {
      const dto = (await body(DryRunDto, { chain, sample: { items: [{ price_usd: 'n/a' }] } })) as DryRunDto;
      const out = setup().controller.dryRun(editor, dto);
      expect(out).toMatchObject({
        ok: false,
        error: 'step eur: $.items[0].price_usd is not a number',
        failedStep: 'eur',
        failedPath: '$.items[0].price_usd',
      });
    });

    it('reports an invalid chain as ok: false', async () => {
      const dto = (await body(DryRunDto, { chain: { ...chain, version: 3 }, sample })) as DryRunDto;
      expect(setup().controller.dryRun(editor, dto)).toMatchObject({
        ok: false,
        error: 'version must be 1',
        steps: [],
      });
    });

    it('is a 400 without a chain or a sample', async () => {
      await expect(body(DryRunDto, { chain })).rejects.toBeInstanceOf(BadRequestException);
      await expect(body(DryRunDto, { sample })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('GET tools/:toolId', () => {
    const tool = { org: ORG, row: { id: 't1', responseMapping: { responseProcessing: chain } } };

    it('returns the stored chain and sample availability', async () => {
      const when = new Date('2026-01-02T03:04:05.000Z');
      const { controller } = setup({ tool, invocations: [{ output: sample, createdAt: when }] });
      expect(await controller.getForTool(editor, 't1')).toEqual({
        chain,
        sampleAvailable: true,
        sampleCapturedAt: '2026-01-02T03:04:05.000Z',
        sample,
        sampleTruncated: false,
      });
    });

    it('returns the sample cut to three elements', async () => {
      const when = new Date('2026-01-02T03:04:05.000Z');
      const long = { items: [1, 2, 3, 4, 5].map((n) => ({ price_usd: n })) };
      const { controller } = setup({ tool, invocations: [{ output: long, createdAt: when }] });
      const out = (await controller.getForTool(editor, 't1')) as any;
      expect(out.sample).toEqual({ items: [{ price_usd: 1 }, { price_usd: 2 }, { price_usd: 3 }] });
      expect(out.sampleTruncated).toBe(true);
    });

    it('returns a null chain and no sample', async () => {
      const { controller } = setup({ tool: { org: ORG, row: { id: 't1', responseMapping: null } } });
      expect(await controller.getForTool(editor, 't1')).toEqual({ chain: null, sampleAvailable: false });
    });

    it('is a 404 for a tool of another organization', async () => {
      const { controller, prisma } = setup({ tool: { ...tool, org: 'org-b' } });
      await expect(controller.getForTool(editor, 't1')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.mcpTool.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 't1', connector: { organizationId: ORG } } }),
      );
    });

    it('is a 404 for an unknown tool', async () => {
      await expect(setup().controller.getForTool(editor, 'nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('POST tools/:toolId/preview', () => {
    const tool = { org: ORG, row: { id: 't1', responseMapping: { responseProcessing: chain } } };

    it('uses the stored chain and the sample from the request', async () => {
      const { controller } = setup({ tool });
      const out = await controller.preview(editor, 't1', (await body(PreviewDto, { sample })) as PreviewDto);
      expect(out).toMatchObject({ ok: true, sampleSource: 'request' });
      expect((out as any).result.items[0].price_eur).toBe(5);
    });

    it('uses the recorded response without a sample', async () => {
      const when = new Date('2026-01-02T03:04:05.000Z');
      const { controller } = setup({ tool, invocations: [{ output: sample, createdAt: when }] });
      const out = await controller.preview(editor, 't1', (await body(PreviewDto, {})) as PreviewDto);
      expect(out).toMatchObject({
        ok: true,
        sampleSource: 'recorded',
        sampleCapturedAt: '2026-01-02T03:04:05.000Z',
      });
    });

    it('prefers the chain in the body', async () => {
      const { controller } = setup({ tool });
      const other = { ...chain, steps: [{ ...chain.steps[0], params: { factor: 3 } }] };
      const out: any = await controller.preview(
        editor,
        't1',
        (await body(PreviewDto, { chain: other, sample })) as PreviewDto,
      );
      expect(out.result.items[0].price_eur).toBe(30);
    });

    it('reports no sample', async () => {
      const { controller } = setup({ tool });
      const out = await controller.preview(editor, 't1', (await body(PreviewDto, {})) as PreviewDto);
      expect(out).toMatchObject({ ok: false, error: 'no sample' });
    });

    it('reports no chain', async () => {
      const { controller } = setup({ tool: { org: ORG, row: { id: 't1', responseMapping: {} } } });
      const out = await controller.preview(editor, 't1', (await body(PreviewDto, { sample })) as PreviewDto);
      expect(out).toMatchObject({ ok: false, error: 'no chain' });
    });

    it('is a 404 for another organization and a 403 for a viewer', async () => {
      const { controller } = setup({ tool: { ...tool, org: 'org-b' } });
      await expect(controller.preview(editor, 't1', {} as PreviewDto)).rejects.toBeInstanceOf(NotFoundException);
      await expect(setup({ tool }).controller.preview(viewer, 't1', {} as PreviewDto)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });
});
