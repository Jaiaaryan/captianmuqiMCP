import { encrypt } from '../common/crypto/encryption.util';
import { Prisma } from '../generated/prisma/client';
import { normalizeCapabilities, SandboxScriptsService } from './sandbox-scripts.service';
import type { ScriptUse } from './script-uses.util';

const ORG = 'org-a';
const ENCRYPTION_KEY = 'test-encryption-key-0123456789abcdef';

const SUPPLIER_KEY = 'cbk_supplier_a_0123456789abcdef';
const ERP_TOKEN = 'cbk_erp_a_fedcba9876543210';
const LITERAL_PASSWORD = 'literal-password-123';

/** Connectors as Prisma returns them (env vars already decrypted by the extension). */
const CONNECTORS = [
  {
    id: 'c-supplier',
    organizationId: ORG,
    name: 'Mock Supplier',
    baseUrl: '{{MOCK_SUPPLIER_URL}}',
    envVars: { MOCK_SUPPLIER_URL: 'http://localhost:4102', MOCK_SUPPLIER_API_KEY: SUPPLIER_KEY },
    authConfig: encrypt(JSON.stringify({ headerName: 'X-Api-Key', apiKey: '{{MOCK_SUPPLIER_API_KEY}}' }), ENCRYPTION_KEY),
    headers: { Accept: 'application/json' },
    config: null,
  },
  {
    id: 'c-erp',
    organizationId: ORG,
    name: 'Mock ERP',
    baseUrl: '{{MOCK_ERP_URL}}/api',
    // A secret whose name does not say so: only authConfig marks it.
    envVars: { MOCK_ERP_URL: 'http://localhost:4101', ERP_CRED: ERP_TOKEN },
    authConfig: encrypt(JSON.stringify({ token: '{{ERP_CRED}}', password: LITERAL_PASSWORD }), ENCRYPTION_KEY),
    headers: null,
    config: null,
  },
  {
    id: 'c-payroll',
    organizationId: ORG,
    name: 'Payroll',
    baseUrl: 'https://payroll.example.com',
    envVars: { MOCK_PAYROLL_TOKEN: 'cbk_payroll_a_secret_value' },
    authConfig: null,
    headers: null,
    config: null,
  },
  {
    id: 'c-foreign',
    organizationId: 'org-b',
    name: 'Other workspace',
    baseUrl: 'https://b.example.com',
    envVars: { B_TOKEN: 'cbk_b_secret_value_xyz' },
    authConfig: null,
    headers: null,
    config: null,
  },
];

function makeService() {
  const prisma = {
    connector: {
      findMany: jest.fn(async ({ where }: any) =>
        CONNECTORS.filter((c) => c.organizationId === where.organizationId && where.id.in.includes(c.id)).sort(
          (a, b) => a.name.localeCompare(b.name),
        ),
      ),
    },
  };
  return { service: new SandboxScriptsService(prisma as any), prisma };
}

const use = (connectorId: string, connectorName: string, tools: string[]): ScriptUse => ({
  connectorId,
  connectorName,
  connectorExists: true,
  tools,
});

const SUPPLIER_USE = use('c-supplier', 'Mock Supplier', ['mock_supplier_get_prices']);
const ERP_USE = use('c-erp', 'Mock ERP', ['mock_erp_ping', 'mock_erp_list_orders']);
const ALL_TOOLS = [
  { connectorId: 'c-supplier', name: 'mock_supplier_get_prices' },
  { connectorId: 'c-erp', name: 'mock_erp_ping' },
  { connectorId: 'c-erp', name: 'mock_erp_list_orders' },
  { connectorId: 'c-payroll', name: 'payroll_list' },
];

describe('SandboxScriptsService Level 3 capabilities', () => {
  const savedKey = process.env.ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  });
  afterAll(() => {
    if (savedKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = savedKey;
  });

  it('normalizes the switches: only true counts, none on is null', () => {
    expect(normalizeCapabilities(null)).toBeNull();
    expect(normalizeCapabilities({})).toBeNull();
    expect(normalizeCapabilities({ env: false, http: 'yes' })).toBeNull();
    expect(normalizeCapabilities({ env: true })).toEqual({ env: true });
    expect(normalizeCapabilities({ env: true, http: true, other: true })).toEqual({ env: true, http: true });
  });

  it('is null for a Level 2 script, without reading any connector', async () => {
    const { service, prisma } = makeService();
    await expect(service.runCapabilities(ORG, { capabilities: null, uses: [SUPPLIER_USE] }, ALL_TOOLS, { allowWrites: false })).resolves.toBeNull();
    expect(prisma.connector.findMany).not.toHaveBeenCalled();
  });

  it('gives env with only the declared connectors\' variables, and their origins (A3)', async () => {
    const { service, prisma } = makeService();
    const caps = await service.runCapabilities(
      ORG,
      { capabilities: { env: true, http: true }, uses: [SUPPLIER_USE] },
      ALL_TOOLS,
      { allowWrites: false },
    );
    expect(caps!.env).toEqual({ MOCK_SUPPLIER_URL: 'http://localhost:4102', MOCK_SUPPLIER_API_KEY: SUPPLIER_KEY });
    expect([...caps!.http!.origins]).toEqual([['http://localhost:4102', 'Mock Supplier']]);
    expect(caps!.http!.allowWrites).toBe(false);
    // The query is scoped to the organization and the declared connectors.
    expect(prisma.connector.findMany.mock.calls[0][0].where).toEqual({ organizationId: ORG, id: { in: ['c-supplier'] } });
  });

  it('never reads a connector of another organization', async () => {
    const { service } = makeService();
    const caps = await service.runCapabilities(
      ORG,
      { capabilities: { env: true, http: true }, uses: [use('c-foreign', 'Other workspace', ['b_tool'])] },
      [{ connectorId: 'c-foreign', name: 'b_tool' }],
      { allowWrites: false },
    );
    expect(caps).toEqual({ env: {}, http: { origins: new Map(), allowWrites: false }, secrets: [] });
  });

  it('collects every secret for masking: by name, by authConfig reference, literal in authConfig; not URLs', async () => {
    const { service } = makeService();
    const caps = await service.runCapabilities(
      ORG,
      { capabilities: { http: true }, uses: [SUPPLIER_USE, ERP_USE] },
      ALL_TOOLS,
      { allowWrites: true },
    );
    expect(caps!.env).toBeUndefined();
    expect(new Set(caps!.secrets)).toEqual(new Set([SUPPLIER_KEY, ERP_TOKEN, LITERAL_PASSWORD]));
    expect(caps!.secrets).not.toContain('http://localhost:4102');
    expect([...caps!.http!.origins.keys()].sort()).toEqual(['http://localhost:4101', 'http://localhost:4102']);
  });

  it('withholds env and http of a connector whose declared tools the caller may not all call, but still masks it', async () => {
    const { service } = makeService();
    const callable = ALL_TOOLS.filter((t) => t.name !== 'mock_erp_list_orders');
    const caps = await service.runCapabilities(
      ORG,
      { capabilities: { env: true, http: true }, uses: [SUPPLIER_USE, ERP_USE] },
      callable,
      { allowWrites: false },
    );
    expect(Object.keys(caps!.env!).sort()).toEqual(['MOCK_SUPPLIER_API_KEY', 'MOCK_SUPPLIER_URL']);
    expect([...caps!.http!.origins.keys()]).toEqual(['http://localhost:4102']);
    expect(caps!.secrets).toContain(ERP_TOKEN);
  });
});

describe('SandboxScriptsService: who may set capabilities', () => {
  function makeWriteService(createdById: string) {
    const row = {
      id: 'sc-1',
      organizationId: ORG,
      createdById,
      name: 'supplier_account',
      code: 'return 1',
      version: 1,
      parameters: null,
      capabilities: null,
      uses: [],
    };
    const prisma = {
      sandboxScript: {
        findFirst: jest.fn(async () => row),
        create: jest.fn(async ({ data }: any) => ({ ...row, ...data, uses: [] })),
        update: jest.fn(async ({ data }: any) => ({ ...row, ...data, uses: [] })),
      },
      connector: { findMany: jest.fn(async () => []) },
      mcpTool: { findMany: jest.fn(async () => []) },
    };
    return { service: new SandboxScriptsService(prisma as any), prisma };
  }

  it('stores only the switches that are on, and SQL NULL for none', async () => {
    const { service, prisma } = makeWriteService('alice');
    await service.create(ORG, 'alice', { name: 'supplier_account', code: 'return 1', capabilities: { env: true, http: false } });
    expect(prisma.sandboxScript.create.mock.calls[0][0].data.capabilities).toEqual({ env: true });
    await service.updateByIdAsAuthor(ORG, 'sc-1', { capabilities: { env: false } }, 'alice');
    expect(prisma.sandboxScript.update.mock.calls[0][0].data.capabilities).toBe(Prisma.DbNull);
  });

  it('lets the author set them', async () => {
    const { service, prisma } = makeWriteService('alice');
    await service.updateByIdAsAuthor(ORG, 'sc-1', { capabilities: { http: true } }, 'alice');
    expect(prisma.sandboxScript.update.mock.calls[0][0].data.capabilities).toEqual({ http: true });
  });

  it('refuses anyone else who is not an administrator', async () => {
    const { service } = makeWriteService('alice');
    await expect(service.updateByIdAsAuthor(ORG, 'sc-1', { capabilities: { env: true } }, 'bob')).rejects.toThrow(
      /created by someone else/,
    );
  });

  it('lets an administrator switch them on anyone\'s script, but change nothing else in that request', async () => {
    const { service, prisma } = makeWriteService('alice');
    await service.updateByIdAsAuthor(ORG, 'sc-1', { capabilities: { env: true } }, 'admin', {}, { isAdmin: true });
    expect(prisma.sandboxScript.update.mock.calls[0][0].data.capabilities).toEqual({ env: true });
    await expect(
      service.updateByIdAsAuthor(ORG, 'sc-1', { capabilities: { env: true }, code: 'return env' }, 'admin', {}, { isAdmin: true }),
    ).rejects.toThrow(/created by someone else/);
  });
});
