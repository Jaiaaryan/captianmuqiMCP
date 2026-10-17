import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { SandboxScriptsService } from './sandbox-scripts.service';
import type { SandboxRunResult } from './types';

const ORG = 'org-a';
const SERVER = 'srv-1';

/** The organization's connectors and their tools, as the database would hold them. */
const CONNECTORS = [
  { id: 'c-erp', name: 'ERP', organizationId: ORG },
  { id: 'c-shop', name: 'Shop', organizationId: ORG },
  { id: 'c-other', name: 'Other customer', organizationId: 'org-b' },
];
const TOOLS = [
  { connectorId: 'c-erp', name: 'erp_orders_list' },
  { connectorId: 'c-erp', name: 'erp_items_list' },
  { connectorId: 'c-erp', name: 'orders_list' },
  { connectorId: 'c-shop', name: 'shop_orders_list' },
  { connectorId: 'c-shop', name: 'orders_list' },
  { connectorId: 'c-other', name: 'secret_tool' },
];

function makePrisma() {
  const connectorOf = (id: string) => CONNECTORS.find((c) => c.id === id)!;
  return {
    sandboxScript: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => ({
        id: 'sc-1',
        version: 1,
        ...data,
        uses: data.uses?.create ?? [],
      })),
      update: jest.fn(async ({ data }: any) => ({
        id: 'sc-1',
        name: 'abc',
        code: data.code ?? 'return 1',
        version: 1,
        uses: data.uses?.create ?? [],
      })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    sandboxRun: {
      create: jest.fn().mockResolvedValue({ id: 'run-1' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    connector: {
      findMany: jest.fn(async ({ where }: any) =>
        CONNECTORS.filter(
          (c) => c.organizationId === where.organizationId && where.id.in.includes(c.id),
        ).map((c) => ({ id: c.id, name: c.name })),
      ),
    },
    mcpTool: {
      findMany: jest.fn(async ({ where }: any) => {
        let rows = TOOLS;
        if (where.connectorId?.in) rows = rows.filter((t) => where.connectorId.in.includes(t.connectorId));
        if (where.name?.in) rows = rows.filter((t) => where.name.in.includes(t.name));
        if (where.connector?.organizationId) {
          rows = rows.filter((t) => connectorOf(t.connectorId).organizationId === where.connector.organizationId);
        }
        return rows.map((t) => ({
          name: t.name,
          connectorId: t.connectorId,
          connector: { name: connectorOf(t.connectorId).name },
        }));
      }),
    },
  };
}

/** A stored script row with what the service reads from it. */
const stored = (over: Record<string, unknown> = {}) => ({
  id: 'sc-1',
  name: 'abc',
  code: 'return 1',
  version: 1,
  createdById: 'u1',
  uses: [] as { connectorId: string; connectorName: string; toolName: string }[],
  ...over,
});
const row = (connectorId: string, connectorName: string, toolName: string) => ({
  connectorId,
  connectorName,
  toolName,
});

const okResult = (result: unknown): SandboxRunResult => ({
  ok: true,
  result,
  meta: {
    ms: 12,
    connectorCalls: 2,
    bytesFromConnectors: 5000,
    bytesReturned: 20,
    logs: [],
    toolsCalled: ['erp_orders_list'],
  },
});

describe('SandboxScriptsService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: SandboxScriptsService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new SandboxScriptsService(prisma as any);
  });

  describe('tenant scoping', () => {
    it('filters every read by organization', async () => {
      await service.list(ORG);
      await service.get(ORG, 'sc-1').catch(() => undefined);
      await service.getByName(ORG, 'x');
      await service.listRuns(ORG, SERVER);
      expect(prisma.sandboxScript.findMany.mock.calls[0][0].where).toEqual({ organizationId: ORG });
      expect(prisma.sandboxScript.findFirst.mock.calls[0][0].where).toEqual({
        id: 'sc-1',
        organizationId: ORG,
      });
      expect(prisma.sandboxScript.findFirst.mock.calls[1][0].where).toEqual({
        organizationId: ORG,
        name: 'x',
      });
      expect(prisma.sandboxRun.findMany.mock.calls[0][0].where).toEqual({
        organizationId: ORG,
        mcpServerId: SERVER,
      });
    });

    it('scopes update and delete by organization, so another org\'s id is not found', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValueOnce(stored());
      await service.update(ORG, 'sc-1', { code: 'return 1' });
      expect(prisma.sandboxScript.update.mock.calls[0][0].where).toEqual({
        id: 'sc-1',
        organizationId: ORG,
      });
      prisma.sandboxScript.deleteMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.remove('org-b', 'sc-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.sandboxScript.deleteMany).toHaveBeenCalledWith({
        where: { id: 'sc-1', organizationId: 'org-b' },
      });
    });

    it('does not update a script of another organization', async () => {
      await expect(service.update('org-b', 'sc-1', { code: 'x' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.sandboxScript.findFirst.mock.calls[0][0].where).toEqual({
        id: 'sc-1',
        organizationId: 'org-b',
      });
      expect(prisma.sandboxScript.update).not.toHaveBeenCalled();
    });

    it('maps a record that disappears during an update to NotFound', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValueOnce(stored());
      prisma.sandboxScript.update.mockRejectedValueOnce(
        Object.assign(new Error('missing'), { code: 'P2025' }),
      );
      await expect(service.update(ORG, 'sc-1', { code: 'x' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('list', () => {
    it('leaves the code out unless asked', async () => {
      prisma.sandboxScript.findMany.mockResolvedValue([stored({ code: 'return args.days' })]);
      const [plain] = await service.list(ORG);
      const [withCode] = await service.list(ORG, { includeCode: true });
      expect(plain).not.toHaveProperty('code');
      expect(withCode).toHaveProperty('code', 'return args.days');
      // The code is read either way, to tell which arguments it reads.
      expect(plain.inferredParameters).toEqual(['days']);
      expect(withCode.inferredParameters).toEqual(['days']);
    });

    it('groups what a script uses by connector, with the connectors\' current names', async () => {
      prisma.sandboxScript.findMany.mockResolvedValueOnce([
        stored({
          uses: [
            row('c-erp', 'ERP (old name)', 'erp_orders_list'),
            row('c-erp', 'ERP (old name)', 'erp_items_list'),
            row('c-shop', 'Shop', 'shop_orders_list'),
          ],
        }),
      ]);
      const [script] = await service.list(ORG);
      expect(script.uses).toEqual([
        { connectorId: 'c-erp', connectorName: 'ERP', connectorExists: true, tools: ['erp_items_list', 'erp_orders_list'] },
        { connectorId: 'c-shop', connectorName: 'Shop', connectorExists: true, tools: ['shop_orders_list'] },
      ]);
      // The names come from the organization's own connectors only.
      expect(prisma.connector.findMany.mock.calls[0][0].where.organizationId).toBe(ORG);
    });

    it('keeps a deleted connector in the list, under the name it had', async () => {
      prisma.sandboxScript.findMany.mockResolvedValueOnce([
        stored({ uses: [row('c-gone', 'Old CRM', 'crm_list')] }),
      ]);
      const [script] = await service.list(ORG);
      expect(script.uses).toEqual([
        { connectorId: 'c-gone', connectorName: 'Old CRM', connectorExists: false, tools: ['crm_list'] },
      ]);
    });
  });

  describe('create', () => {
    it.each(['A', 'a', '1abc', 'has space', 'UPPER', 'a'.repeat(65), '../x', ''])(
      'rejects the name %j',
      async (name) => {
        await expect(
          service.create(ORG, 'u1', { name, code: 'return 1' }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(prisma.sandboxScript.create).not.toHaveBeenCalled();
      },
    );

    it('stores the script for the caller\'s organization, not for a server', async () => {
      await service.create(ORG, 'u1', {
        name: 'delayed_orders-1',
        code: 'return 1',
        description: 'd',
      });
      const data = prisma.sandboxScript.create.mock.calls[0][0].data;
      expect(data).toMatchObject({ organizationId: ORG, createdById: 'u1', name: 'delayed_orders-1' });
      expect(data).not.toHaveProperty('mcpServerId');
    });

    it('reports a duplicate name as a conflict', async () => {
      prisma.sandboxScript.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
      );
      await expect(
        service.create(ORG, undefined, { name: 'abc', code: 'return 1' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    describe('the connectors and tools it declares', () => {
      it('stores what a person picked, with the connector names from the database', async () => {
        const { script } = await service.create(ORG, 'u1', {
          name: 'abc',
          code: 'return 1',
          uses: [
            { connectorId: 'c-erp', tools: ['erp_orders_list', 'erp_items_list'] },
            { connectorId: 'c-shop', tools: ['shop_orders_list'] },
          ],
        });
        const rows = prisma.sandboxScript.create.mock.calls[0][0].data.uses.create;
        expect(rows).toEqual(
          expect.arrayContaining([
            { organizationId: ORG, connectorId: 'c-erp', connectorName: 'ERP', toolName: 'erp_orders_list' },
            { organizationId: ORG, connectorId: 'c-erp', connectorName: 'ERP', toolName: 'erp_items_list' },
            { organizationId: ORG, connectorId: 'c-shop', connectorName: 'Shop', toolName: 'shop_orders_list' },
          ]),
        );
        expect(rows).toHaveLength(3);
        expect(script.uses.map((u) => u.connectorName)).toEqual(['ERP', 'Shop']);
      });

      it('refuses a connector of another organization', async () => {
        await expect(
          service.create(ORG, 'u1', {
            name: 'abc',
            code: 'return 1',
            uses: [{ connectorId: 'c-other', tools: ['secret_tool'] }],
          }),
        ).rejects.toThrow("Unknown connector 'c-other'");
        expect(prisma.sandboxScript.create).not.toHaveBeenCalled();
      });

      it('refuses a tool the connector does not have', async () => {
        await expect(
          service.create(ORG, 'u1', {
            name: 'abc',
            code: 'return 1',
            uses: [{ connectorId: 'c-erp', tools: ['shop_orders_list'] }],
          }),
        ).rejects.toThrow("Connector 'ERP' has no tool 'shop_orders_list'");
      });

      it('refuses a connector with no tool picked', async () => {
        await expect(
          service.create(ORG, 'u1', { name: 'abc', code: 'return 1', uses: [{ connectorId: 'c-erp', tools: [] }] }),
        ).rejects.toThrow("Pick at least one tool of 'ERP'");
      });

      it('resolves tool names an agent gives to their connectors', async () => {
        await service.create(ORG, 'u1', {
          name: 'abc',
          code: 'return 1',
          toolNames: ['erp_orders_list', 'shop_orders_list'],
        });
        const rows = prisma.sandboxScript.create.mock.calls[0][0].data.uses.create;
        expect(rows.map((r: any) => `${r.connectorId}/${r.toolName}`).sort()).toEqual([
          'c-erp/erp_orders_list',
          'c-shop/shop_orders_list',
        ]);
      });

      it('refuses a tool name that no connector of the organization has', async () => {
        await expect(
          service.create(ORG, 'u1', { name: 'abc', code: 'return 1', toolNames: ['secret_tool'] }),
        ).rejects.toThrow("Unknown tool 'secret_tool'");
      });

      it('refuses an ambiguous tool name, unless the server\'s connector settles it', async () => {
        const input = { name: 'abc', code: 'return 1', toolNames: ['orders_list'] };
        await expect(service.create(ORG, 'u1', input)).rejects.toThrow(/exists on several connectors \(ERP, Shop\)/);
        await service.create(ORG, 'u1', input, { preferConnectorIds: ['c-shop'] });
        expect(prisma.sandboxScript.create.mock.calls[0][0].data.uses.create).toEqual([
          { organizationId: ORG, connectorId: 'c-shop', connectorName: 'Shop', toolName: 'orders_list' },
        ]);
      });

      it('adds the tools the code calls that were not declared, and says so', async () => {
        const { script, added, warnings } = await service.create(ORG, 'u1', {
          name: 'abc',
          code: 'const a = await tools.erp_orders_list({}); const b = await tools.shop_orders_list({});',
          uses: [{ connectorId: 'c-erp', tools: ['erp_orders_list'] }],
        });
        expect(added).toEqual(['Shop / shop_orders_list']);
        expect(warnings).toEqual([]);
        expect(script.uses.map((u) => u.connectorName)).toEqual(['ERP', 'Shop']);
      });

      it('does not re-add a tool whose name was declared', async () => {
        // `orders_list` is on two connectors; the person picked the ERP one.
        const { added, warnings } = await service.create(ORG, 'u1', {
          name: 'abc',
          code: 'await tools.orders_list({});',
          uses: [{ connectorId: 'c-erp', tools: ['orders_list'] }],
        });
        expect(added).toEqual([]);
        expect(warnings).toEqual([]);
        expect(prisma.sandboxScript.create.mock.calls[0][0].data.uses.create).toHaveLength(1);
      });

      it('warns about a call it cannot match, and about a computed name, without failing', async () => {
        const { script, warnings } = await service.create(ORG, 'u1', {
          name: 'abc',
          code: 'await tools.no_such_tool({}); await tools.orders_list({}); await tools[pick]({});',
        });
        expect(script.uses).toEqual([]);
        expect(warnings).toEqual([
          'tools.no_such_tool is not a tool of any connector in this organization.',
          expect.stringMatching(/tools\.orders_list exists on several connectors \(ERP, Shop\)/),
          expect.stringMatching(/computed name/),
        ]);
      });

      it('limits how many tools a script can declare', async () => {
        const names = Array.from({ length: 101 }, (_, i) => `t${i}`);
        prisma.mcpTool.findMany.mockResolvedValueOnce(
          names.map((n) => ({ name: n, connectorId: 'c-erp', connector: { name: 'ERP' } })),
        );
        await expect(
          service.create(ORG, 'u1', { name: 'abc', code: 'return 1', toolNames: names }),
        ).rejects.toThrow(/at most 100 tools/);
        expect(prisma.sandboxScript.create).not.toHaveBeenCalled();
      });
    });
  });

  describe('update', () => {
    it('bumps the version only when the code changes', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValue(stored());
      await service.update(ORG, 'sc-1', { code: 'return 2' });
      await service.update(ORG, 'sc-1', { description: 'only text' });
      expect(prisma.sandboxScript.update.mock.calls[0][0].data).toMatchObject({
        code: 'return 2',
        version: { increment: 1 },
      });
      expect(prisma.sandboxScript.update.mock.calls[1][0].data).toEqual({ description: 'only text' });
    });

    it('leaves what the script declares alone when only the description changes', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValueOnce(
        stored({ uses: [row('c-erp', 'ERP', 'erp_orders_list')] }),
      );
      await service.update(ORG, 'sc-1', { description: 'text' });
      expect(prisma.sandboxScript.update.mock.calls[0][0].data).not.toHaveProperty('uses');
    });

    it('keeps the declared tools and adds the ones new code calls', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValueOnce(
        stored({ uses: [row('c-erp', 'ERP', 'erp_orders_list')] }),
      );
      const { added } = await service.update(ORG, 'sc-1', {
        code: 'await tools.erp_orders_list({}); await tools.shop_orders_list({});',
      });
      expect(added).toEqual(['Shop / shop_orders_list']);
      const { deleteMany, create } = prisma.sandboxScript.update.mock.calls[0][0].data.uses;
      expect(deleteMany).toEqual({});
      expect(create.map((r: any) => r.toolName).sort()).toEqual(['erp_orders_list', 'shop_orders_list']);
    });

    it('replaces the declared tools when a new list is sent', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValueOnce(
        stored({ uses: [row('c-erp', 'ERP', 'erp_orders_list'), row('c-shop', 'Shop', 'shop_orders_list')] }),
      );
      await service.update(ORG, 'sc-1', { uses: [{ connectorId: 'c-erp', tools: ['erp_items_list'] }] });
      const { create } = prisma.sandboxScript.update.mock.calls[0][0].data.uses;
      expect(create.map((r: any) => r.toolName)).toEqual(['erp_items_list']);
    });

    it('can clear the declared tools with an empty list of tool names', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValueOnce(
        stored({ uses: [row('c-erp', 'ERP', 'erp_orders_list')] }),
      );
      await service.update(ORG, 'sc-1', { toolNames: [] });
      expect(prisma.sandboxScript.update.mock.calls[0][0].data.uses.create).toEqual([]);
    });

    it('requires something to change', async () => {
      await expect(service.update(ORG, 'sc-1', {})).rejects.toBeInstanceOf(BadRequestException);
    });

    it('lets the author edit by name', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValue(stored({ id: 'sc-9' }));
      await service.updateByName(ORG, 'abc', { code: 'return 3' }, 'u1');
      expect(prisma.sandboxScript.findFirst.mock.calls[0][0].where).toEqual({
        organizationId: ORG,
        name: 'abc',
      });
      expect(prisma.sandboxScript.update.mock.calls[0][0].where.id).toBe('sc-9');
    });

    it('refuses an edit by anyone but the author, so planted code cannot run with someone else\'s authority', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValueOnce(stored({ id: 'sc-9', createdById: 'u-admin' }));
      await expect(
        service.updateByName(ORG, 'monthly_report', { code: 'await tools.delete_all({})' }, 'u-low'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.sandboxScript.update).not.toHaveBeenCalled();
    });

    it('refuses a change of the declared tools by anyone but the author', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValueOnce(stored({ id: 'sc-9', createdById: 'u-admin' }));
      await expect(
        service.updateByName(ORG, 'abc', { toolNames: ['erp_orders_list'] }, 'u-low'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.sandboxScript.update).not.toHaveBeenCalled();
    });

    it('treats an unidentified editor as a different person from an identified author', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValueOnce(stored({ id: 'sc-9', createdById: 'u1' }));
      await expect(
        service.updateByName(ORG, 'abc', { code: 'x' }, undefined),
      ).rejects.toBeInstanceOf(ForbiddenException);
      prisma.sandboxScript.findFirst.mockResolvedValueOnce(stored({ id: 'sc-9', createdById: null }));
      await expect(
        service.updateByName(ORG, 'abc', { code: 'x' }, 'u1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.sandboxScript.update).not.toHaveBeenCalled();
    });

    it('lets scripts made without a user (auth disabled) be edited without one', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValue(stored({ id: 'sc-9', createdById: null }));
      await service.updateByName(ORG, 'abc', { code: 'return 3' }, undefined);
      expect(prisma.sandboxScript.update).toHaveBeenCalledTimes(1);
    });

    it('reports an unknown name as not found', async () => {
      await expect(
        service.updateByName(ORG, 'nope', { code: 'x' }, 'u1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('recordRun', () => {
    it('stores the run and refreshes the saved script\'s last-run summary', async () => {
      const id = await service.recordRun({
        organizationId: ORG,
        mcpServerId: SERVER,
        scriptId: 'sc-1',
        userId: 'u1',
        code: 'return 1',
        args: { month: 'previous' },
        result: okResult({ delayed: 3 }),
      });
      expect(id).toBe('run-1');
      const data = prisma.sandboxRun.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        organizationId: ORG,
        mcpServerId: SERVER,
        scriptId: 'sc-1',
        ok: true,
        errorCode: null,
        resultPreview: { delayed: 3 },
        args: { month: 'previous' },
      });
      expect(prisma.sandboxScript.updateMany).toHaveBeenCalledWith({
        where: { id: 'sc-1', organizationId: ORG },
        data: expect.objectContaining({
          lastRunOk: true,
          lastRunMeta: { ms: 12, connectorCalls: 2, bytesFromConnectors: 5000, bytesReturned: 20 },
        }),
      });
    });

    it('stores inline runs without touching any script', async () => {
      await service.recordRun({
        organizationId: ORG,
        mcpServerId: SERVER,
        code: 'return 1',
        result: okResult(1),
      });
      expect(prisma.sandboxScript.updateMany).not.toHaveBeenCalled();
    });

    it('keeps a failed run\'s error code and no result preview', async () => {
      await service.recordRun({
        organizationId: ORG,
        mcpServerId: SERVER,
        code: 'while(true){}',
        result: {
          ok: false,
          error: { code: 'TIMEOUT', message: 'Script did not finish within 10000 ms.' },
          meta: okResult(null).meta,
        },
      });
      const data = prisma.sandboxRun.create.mock.calls[0][0].data;
      expect(data.ok).toBe(false);
      expect(data.errorCode).toBe('TIMEOUT');
      expect(data.resultPreview).toBe(Prisma.JsonNull);
    });

    it('stores a null result as JSON null, not a missing value', async () => {
      await service.recordRun({
        organizationId: ORG,
        mcpServerId: SERVER,
        code: 'return null',
        result: okResult(null),
      });
      expect(prisma.sandboxRun.create.mock.calls[0][0].data.resultPreview).toBe(Prisma.JsonNull);
    });

    it('bounds a large result preview', async () => {
      const big = Array.from({ length: 5000 }, (_, i) => ({ id: i, text: 'x'.repeat(100) }));
      await service.recordRun({
        organizationId: ORG,
        mcpServerId: SERVER,
        code: 'return big',
        result: okResult(big),
      });
      const preview = prisma.sandboxRun.create.mock.calls[0][0].data.resultPreview;
      expect(JSON.stringify(preview).length).toBeLessThan(20 * 1024);
    });

    it('never throws when storage fails', async () => {
      prisma.sandboxRun.create.mockRejectedValueOnce(new Error('db down'));
      await expect(
        service.recordRun({
          organizationId: ORG,
          mcpServerId: SERVER,
          code: 'return 1',
          result: okResult(1),
        }),
      ).resolves.toBeNull();
    });
  });

  describe('listRuns', () => {
    it('clamps the page size', async () => {
      await service.listRuns(ORG, SERVER, 100000);
      await service.listRuns(ORG, SERVER, -5);
      await service.listRuns(ORG, SERVER, Number.NaN);
      expect(prisma.sandboxRun.findMany.mock.calls.map((c) => c[0].take)).toEqual([200, 1, 50]);
    });

    it('lists every run of the server unless narrowed to one user', async () => {
      await service.listRuns(ORG, SERVER);
      await service.listRuns(ORG, SERVER, 10, 'u1');
      expect(prisma.sandboxRun.findMany.mock.calls[0][0].where).toEqual({
        organizationId: ORG,
        mcpServerId: SERVER,
      });
      expect(prisma.sandboxRun.findMany.mock.calls[1][0].where).toEqual({
        organizationId: ORG,
        mcpServerId: SERVER,
        userId: 'u1',
      });
    });
  });

  describe('dashboard access (by id)', () => {
    it('lets the author edit by id', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValue(stored());
      await service.updateByIdAsAuthor(ORG, 'sc-1', { code: 'return 2' }, 'u1');
      expect(prisma.sandboxScript.findFirst.mock.calls[0][0].where).toEqual({
        id: 'sc-1',
        organizationId: ORG,
      });
      expect(prisma.sandboxScript.update.mock.calls[0][0]).toMatchObject({
        where: { id: 'sc-1', organizationId: ORG },
        data: { code: 'return 2', version: { increment: 1 } },
      });
    });

    it('refuses an edit by anyone but the author, administrators included', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValueOnce(stored({ createdById: 'u-low' }));
      await expect(
        service.updateByIdAsAuthor(ORG, 'sc-1', { code: 'await tools.x({})' }, 'u-admin'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.sandboxScript.update).not.toHaveBeenCalled();
    });

    it('does not edit a script of another organization', async () => {
      await expect(
        service.updateByIdAsAuthor('org-b', 'sc-1', { code: 'x' }, 'u1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.sandboxScript.update).not.toHaveBeenCalled();
    });

    it('lets the author delete their script', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValueOnce(stored());
      await service.removeAsUser(ORG, 'sc-1', { userId: 'u1', isAdmin: false });
      expect(prisma.sandboxScript.deleteMany).toHaveBeenCalledWith({
        where: { id: 'sc-1', organizationId: ORG },
      });
    });

    it('lets an administrator delete anyone\'s script', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValueOnce(stored({ createdById: 'u-low' }));
      await service.removeAsUser(ORG, 'sc-1', { userId: 'u-admin', isAdmin: true });
      expect(prisma.sandboxScript.deleteMany).toHaveBeenCalledTimes(1);
    });

    it('refuses a delete by someone who is neither the author nor an administrator', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValueOnce(stored());
      await expect(
        service.removeAsUser(ORG, 'sc-1', { userId: 'u2', isAdmin: false }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.sandboxScript.deleteMany).not.toHaveBeenCalled();
    });

    it('does not delete a script of another organization, even for an administrator', async () => {
      await expect(
        service.removeAsUser('org-b', 'sc-1', { userId: 'u-admin', isAdmin: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.sandboxScript.deleteMany).not.toHaveBeenCalled();
    });
  });
});

describe('SandboxScriptsService parameters', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: SandboxScriptsService;

  const schema = (properties: Record<string, any>, required: string[]) => ({
    type: 'object',
    properties,
    required,
  });
  const savedParameters = (call = 0, kind: 'create' | 'update' = 'create') =>
    prisma.sandboxScript[kind].mock.calls[call][0].data.parameters;

  beforeEach(() => {
    prisma = makePrisma();
    service = new SandboxScriptsService(prisma as any);
  });

  describe('create', () => {
    it('stores each argument the code reads as a required string, and reports what it found', async () => {
      const { script } = await service.create(ORG, 'u1', {
        name: 'stuck_orders',
        code: 'const { days } = args; return args.as_of;',
      });
      expect(savedParameters()).toEqual(
        schema({ days: { type: 'string' }, as_of: { type: 'string' } }, ['days', 'as_of']),
      );
      expect(script.inferredParameters).toEqual(['days', 'as_of']);
    });

    it('stores SQL NULL, not a JSON null, when the code reads no arguments', async () => {
      await service.create(ORG, 'u1', { name: 'plain', code: 'return 1' });
      expect(savedParameters()).toBe(Prisma.DbNull);
    });

    it('keeps the types, requirements and descriptions the author sends', async () => {
      await service.create(ORG, 'u1', {
        name: 'stuck_orders',
        code: 'return [args.days, args.as_of]',
        parameters: schema(
          { days: { type: 'number', description: 'Look-back window' }, as_of: { type: 'string' } },
          ['days'],
        ),
      });
      expect(savedParameters()).toEqual(
        schema({ days: { type: 'number', description: 'Look-back window' }, as_of: { type: 'string' } }, ['days']),
      );
    });

    it('merges the author\'s parameters with names the code reads that they left out', async () => {
      await service.create(ORG, 'u1', {
        name: 'abc',
        code: 'return [args.days, args.extra]',
        parameters: schema({ days: { type: 'number' } }, []),
      });
      expect(savedParameters()).toEqual(
        schema({ days: { type: 'number' }, extra: { type: 'string' } }, ['extra']),
      );
    });

    it('refuses a bad schema with the problem, and stores nothing', async () => {
      await expect(
        service.create(ORG, 'u1', {
          name: 'abc',
          code: 'return args.a',
          parameters: schema({ a: { type: 'date' } }, []),
        }),
      ).rejects.toThrow(/needs a type/);
      expect(prisma.sandboxScript.create).not.toHaveBeenCalled();
    });

    it('saves the script without parameters, and says so, when the code reads too many names', async () => {
      const code = Array.from({ length: 21 }, (_, i) => `args.p${i}`).join(';');
      const { warnings } = await service.create(ORG, 'u1', { name: 'abc', code });
      expect(savedParameters()).toBe(Prisma.DbNull);
      expect(warnings.join(' ')).toMatch(/not offered as a tool.*at most 20/);
    });
  });

  describe('update', () => {
    const current = (parameters: unknown, code = 'return [args.days, args.as_of]') =>
      stored({ code, parameters });

    it('keeps what the author set when only the code changes', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValueOnce(
        current(schema({ days: { type: 'number', description: 'D' }, as_of: { type: 'string' } }, ['days'])),
      );
      await service.update(ORG, 'sc-1', { code: 'return [args.days, args.as_of, args.limit]' });
      expect(savedParameters(0, 'update')).toEqual(
        schema(
          { days: { type: 'number', description: 'D' }, as_of: { type: 'string' }, limit: { type: 'string' } },
          ['days', 'limit'],
        ),
      );
    });

    it('drops a parameter the new code no longer reads, unless it is marked x-keep', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValueOnce(
        current(
          schema(
            { days: { type: 'number' }, as_of: { type: 'string' }, legacy: { type: 'string', 'x-keep': true } },
            ['days', 'as_of', 'legacy'],
          ),
        ),
      );
      await service.update(ORG, 'sc-1', { code: 'return args.days' });
      expect(savedParameters(0, 'update')).toEqual(
        schema({ days: { type: 'number' }, legacy: { type: 'string', 'x-keep': true } }, ['days', 'legacy']),
      );
    });

    it('replaces the parameters when the author sends them, without touching the code', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValueOnce(
        current(schema({ days: { type: 'string' }, as_of: { type: 'string' } }, ['days', 'as_of'])),
      );
      await service.update(ORG, 'sc-1', {
        parameters: schema({ days: { type: 'integer' }, as_of: { type: 'string' } }, ['days']),
      });
      const data = prisma.sandboxScript.update.mock.calls[0][0].data;
      expect(data.parameters).toEqual(
        schema({ days: { type: 'integer' }, as_of: { type: 'string' } }, ['days']),
      );
      expect(data).not.toHaveProperty('code');
      expect(data).not.toHaveProperty('version');
    });

    it('starts over from the code when the author sends null', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValueOnce(
        current(schema({ days: { type: 'number' }, as_of: { type: 'string' } }, [])),
      );
      await service.update(ORG, 'sc-1', { parameters: null });
      expect(savedParameters(0, 'update')).toEqual(
        schema({ days: { type: 'string' }, as_of: { type: 'string' } }, ['days', 'as_of']),
      );
    });

    it('leaves the parameters alone on a description edit', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValueOnce(current(schema({ days: { type: 'number' } }, [])));
      await service.update(ORG, 'sc-1', { description: 'new text' });
      expect(prisma.sandboxScript.update.mock.calls[0][0].data).not.toHaveProperty('parameters');
    });

    it('refuses a bad schema without writing', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValueOnce(current(null));
      await expect(
        service.update(ORG, 'sc-1', { parameters: schema({ 'bad name': { type: 'string' } }, []) }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.sandboxScript.update).not.toHaveBeenCalled();
    });
  });

  describe('listExposed', () => {
    const exposedRow = (name: string, uses: ReturnType<typeof row>[], parameters: unknown = schema({ a: { type: 'string' } }, ['a'])) => ({
      id: `id-${name}`,
      name,
      description: null,
      version: 2,
      parameters,
      uses,
    });

    it('asks for the organization\'s scripts that have parameters, and nobody else\'s', async () => {
      await service.listExposed(ORG, ['c-erp']);
      expect(prisma.sandboxScript.findMany.mock.calls[0][0].where).toEqual({
        organizationId: ORG,
        parameters: { not: Prisma.DbNull },
      });
    });

    it('offers a script only on a server that has every connector it uses', async () => {
      prisma.sandboxScript.findMany.mockResolvedValueOnce([
        exposedRow('only_erp', [row('c-erp', 'ERP', 'erp_orders_list')]),
        exposedRow('erp_and_shop', [
          row('c-erp', 'ERP', 'erp_orders_list'),
          row('c-shop', 'Shop', 'shop_orders_list'),
        ]),
        exposedRow('pure_compute', []),
      ]);
      const offered = await service.listExposed(ORG, ['c-erp']);
      expect(offered.map((s) => s.name)).toEqual(['only_erp', 'pure_compute']);
      expect(offered[0]).toMatchObject({ id: 'id-only_erp', version: 2, parameters: schema({ a: { type: 'string' } }, ['a']) });
    });

    it('skips a script whose stored parameters are a JSON null', async () => {
      prisma.sandboxScript.findMany.mockResolvedValueOnce([exposedRow('legacy', [], null)]);
      expect(await service.listExposed(ORG, [])).toEqual([]);
    });
  });
});
