import {
  DEFAULT_DEMO_MOCK_PORT,
  demoAccounts,
  demoCredential,
  demoCredentials,
  demoMockPort,
  demoModeRequested,
  demoPassword,
  demoSeed,
  demoModeEnvDefault,
  mockServiceUrl,
} from './demo.config';

const JWT = 'a-jwt-secret-that-is-long-enough-for-the-demo-spec-0123456789';
const PASSWORD_POLICY = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z0-9]).{8,}$/;

describe('demo.config', () => {
  it('is off unless DEMO_MODE is exactly "true"', () => {
    expect(demoModeEnvDefault({})).toBe(false);
    expect(demoModeEnvDefault({ DEMO_MODE: 'TRUE' })).toBe(false);
    expect(demoModeEnvDefault({ DEMO_MODE: '1' })).toBe(false);
    expect(demoModeEnvDefault({ DEMO_MODE: 'true' })).toBe(true);
    expect(demoModeEnvDefault({ DEMO_MODE: 'true', DEPLOYMENT_MODE: 'self-hosted' })).toBe(true);
  });

  it('is always off on Cloud, even when asked for', () => {
    const env = { DEMO_MODE: 'true', DEPLOYMENT_MODE: 'cloud' };
    expect(demoModeRequested(env)).toBe(true);
    expect(demoModeEnvDefault(env)).toBe(false);
  });

  it('reads the mock port, defaulting to 4191 and refusing nonsense', () => {
    expect(demoMockPort({})).toBe(DEFAULT_DEMO_MOCK_PORT);
    expect(demoMockPort({ DEMO_MOCK_PORT: '' })).toBe(4191);
    expect(demoMockPort({ DEMO_MOCK_PORT: '5001' })).toBe(5001);
    expect(() => demoMockPort({ DEMO_MOCK_PORT: 'abc' })).toThrow(/DEMO_MOCK_PORT/);
    expect(() => demoMockPort({ DEMO_MOCK_PORT: '70000' })).toThrow(/DEMO_MOCK_PORT/);
    expect(mockServiceUrl(4191, 'erp')).toBe('http://127.0.0.1:4191/erp');
  });

  it('derives the seed from DEMO_PASSWORD_SEED, else from JWT_SECRET (never the secret itself)', () => {
    expect(demoSeed({ DEMO_PASSWORD_SEED: 'my-seed', JWT_SECRET: JWT })).toBe('my-seed');
    const derived = demoSeed({ JWT_SECRET: JWT });
    expect(derived).toMatch(/^[0-9a-f]{64}$/);
    expect(derived).not.toContain(JWT);
    expect(demoSeed({ JWT_SECRET: JWT })).toBe(derived);
    expect(demoSeed({ JWT_SECRET: `${JWT}x` })).not.toBe(derived);
    expect(() => demoSeed({})).toThrow(/DEMO_PASSWORD_SEED or JWT_SECRET/);
  });

  it('gives stable, per-account passwords in the kit format that meet the password policy', () => {
    const env = { JWT_SECRET: JWT };
    const a = demoAccounts(env);
    expect(demoAccounts(env)).toEqual(a);
    expect(a.map((x) => [x.email, x.role, x.mcpRoles, x.workspace])).toEqual([
      ['alice@alpha.codebound.test', 'ADMIN', [], 'A'],
      ['carol@alpha.codebound.test', 'VIEWER', ['Staff'], 'A'],
      ['bob@beta.codebound.test', 'ADMIN', [], 'B'],
    ]);
    expect(a[0].password).toMatch(/^Cb-[0-9a-f]{10}-A!$/);
    expect(a[1].password).toMatch(/^Cb-[0-9a-f]{10}-C!$/);
    expect(a[2].password).toMatch(/^Cb-[0-9a-f]{10}-B!$/);
    for (const x of a) expect(x.password).toMatch(PASSWORD_POLICY);
    expect(new Set(a.map((x) => x.password)).size).toBe(3);
    // Another seed, other passwords.
    expect(demoAccounts({ DEMO_PASSWORD_SEED: 'other' })[0].password).not.toBe(a[0].password);
  });

  it('always puts a digit in the password', () => {
    for (let i = 0; i < 2000; i++) {
      expect(demoPassword(`seed-${i}`, 'alice@alpha.codebound.test', 'A')).toMatch(PASSWORD_POLICY);
    }
  });

  it('derives one canary credential per workspace and system; payroll only in A', () => {
    const creds = demoCredentials({ DEMO_PASSWORD_SEED: 's' });
    expect(Object.keys(creds.A).sort()).toEqual(['carrier', 'erp', 'payroll', 'supplier']);
    expect(Object.keys(creds.B).sort()).toEqual(['carrier', 'erp', 'supplier']);
    expect(creds.A.erp).toMatch(/^cbk_erp_a_[0-9a-f]{24}$/);
    expect(creds.B.supplier).toMatch(/^cbk_supplier_b_[0-9a-f]{24}$/);
    expect(creds.A.erp).not.toBe(creds.B.erp);
    expect(demoCredential('s', 'erp', 'A')).toBe(creds.A.erp);
  });
});
