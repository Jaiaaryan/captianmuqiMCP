import { createHmac } from 'crypto';

/**
 * Demo mode: a self-hosted instance that runs the CODEBOUND test bed (two
 * workspaces, three users, four mock business systems) and publishes the demo
 * sign-ins so the login page can offer them. A runtime switch (DemoStateService,
 * persisted as the site setting `demo.enabled`); DEMO_MODE=true is only its
 * initial default. Never on Cloud: there the flag is ignored (and logged as
 * refused).
 *
 * Everything secret here (passwords, mock credentials) is derived from one
 * seed, so it is stable across restarts of the same instance without being
 * stored anywhere, and cannot be guessed from the code. The seed is
 * DEMO_PASSWORD_SEED, or else an HMAC of JWT_SECRET.
 */

export type DemoWorkspace = 'A' | 'B';
export type MockService = 'erp' | 'supplier' | 'carrier' | 'payroll';

/**
 * Not 4190: that is ManageSieve, on the WHATWG fetch "bad ports" list, so
 * Node's own fetch() (and any browser) refuses to connect to it.
 */
export const DEFAULT_DEMO_MOCK_PORT = 4191;
/** The mock systems listen on loopback only; connectors reach them here. */
export const DEMO_MOCK_HOST = '127.0.0.1';

export const DEMO_WORKSPACES: Record<DemoWorkspace, { name: string; services: MockService[] }> = {
  A: { name: 'Alpha (CODEBOUND workspace A)', services: ['erp', 'supplier', 'carrier', 'payroll'] },
  B: { name: 'Beta (CODEBOUND workspace B)', services: ['erp', 'supplier', 'carrier'] },
};

export type DemoUserKey = 'alice' | 'carol' | 'bob';

export interface DemoAccountSpec {
  key: DemoUserKey;
  email: string;
  name: string;
  /** Membership role in the home workspace. */
  memberRole: 'ADMIN' | 'VIEWER';
  workspace: DemoWorkspace;
  /** MCP roles (by name) assigned in the home workspace. */
  mcpRoles: string[];
  /** The kit's password suffix letter. */
  letter: string;
}

export const DEMO_ACCOUNT_SPECS: DemoAccountSpec[] = [
  {
    key: 'alice',
    email: 'alice@alpha.codebound.test',
    name: 'Alice (Alpha admin)',
    memberRole: 'ADMIN',
    workspace: 'A',
    mcpRoles: [],
    letter: 'A',
  },
  {
    key: 'carol',
    email: 'carol@alpha.codebound.test',
    name: 'Carol (Alpha staff)',
    memberRole: 'VIEWER',
    workspace: 'A',
    mcpRoles: ['Staff'],
    letter: 'C',
  },
  {
    key: 'bob',
    email: 'bob@beta.codebound.test',
    name: 'Bob (Beta admin)',
    memberRole: 'ADMIN',
    workspace: 'B',
    mcpRoles: [],
    letter: 'B',
  },
];

export interface DemoAccount {
  email: string;
  password: string;
  name: string;
  /** Membership role in the home workspace. */
  role: 'ADMIN' | 'VIEWER';
  /** MCP roles in the home workspace (which tools the user may call). */
  mcpRoles: string[];
  workspace: DemoWorkspace;
  workspaceName: string;
}

/** DEMO_MODE=true was asked for, whatever the deployment. */
export function demoModeRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DEMO_MODE === 'true';
}

/**
 * The environment's default for the demo switch: asked for, on a self-hosted
 * deployment. Read once, when the `demo.enabled` setting does not exist yet;
 * the live state is DemoStateService.isEnabled().
 */
export function demoModeEnvDefault(env: NodeJS.ProcessEnv = process.env): boolean {
  return demoModeRequested(env) && env.DEPLOYMENT_MODE !== 'cloud';
}

export function demoMockPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DEMO_MOCK_PORT;
  if (raw === undefined || raw.trim() === '') return DEFAULT_DEMO_MOCK_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`DEMO_MOCK_PORT must be a port number (0-65535), got '${raw}'`);
  }
  return n;
}

/**
 * The secret everything else is derived from. DEMO_PASSWORD_SEED when set;
 * otherwise an HMAC of JWT_SECRET under a fixed label, so the JWT secret itself
 * never feeds a password directly.
 */
export function demoSeed(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.DEMO_PASSWORD_SEED?.trim();
  if (explicit) return explicit;
  const jwt = env.JWT_SECRET;
  if (!jwt) {
    throw new Error('Demo mode needs DEMO_PASSWORD_SEED or JWT_SECRET to derive its passwords');
  }
  return createHmac('sha256', jwt).update('anythingmcp-demo-mode/v1/seed').digest('hex');
}

function derive(seed: string, label: string): string {
  return createHmac('sha256', seed).update(label).digest('hex');
}

/**
 * `Cb-<10 hex>-<letter>!`, the kit's format. Ten hex characters can, rarely,
 * be all letters; the first is then replaced by a digit so the password still
 * meets the sign-up policy (upper, lower, digit, symbol, 8+ characters).
 */
export function demoPassword(seed: string, email: string, letter: string): string {
  const hex = derive(seed, `password:${email.toLowerCase()}`);
  let ten = hex.slice(0, 10);
  if (!/\d/.test(ten)) ten = `${parseInt(hex.slice(10, 12), 16) % 10}${ten.slice(1)}`;
  return `Cb-${ten}-${letter}!`;
}

export function demoAccounts(env: NodeJS.ProcessEnv = process.env): DemoAccount[] {
  const seed = demoSeed(env);
  return DEMO_ACCOUNT_SPECS.map((s) => ({
    email: s.email,
    password: demoPassword(seed, s.email, s.letter),
    name: s.name,
    role: s.memberRole,
    mcpRoles: [...s.mcpRoles],
    workspace: s.workspace,
    workspaceName: DEMO_WORKSPACES[s.workspace].name,
  }));
}

/**
 * The credential each workspace's connector sends to a mock system, in the
 * kit's canary format `cbk_<service>_<workspace>_<hex>`: easy to grep for in a
 * log or a script result, and impossible to confuse with anything else. The
 * mock systems pick the tenant by it.
 */
export function demoCredential(seed: string, service: MockService, workspace: DemoWorkspace): string {
  return `cbk_${service}_${workspace.toLowerCase()}_${derive(seed, `credential:${workspace}:${service}`).slice(0, 24)}`;
}

export type DemoCredentials = Record<DemoWorkspace, Partial<Record<MockService, string>>>;

export function demoCredentials(env: NodeJS.ProcessEnv = process.env): DemoCredentials {
  const seed = demoSeed(env);
  const out: DemoCredentials = { A: {}, B: {} };
  for (const ws of Object.keys(DEMO_WORKSPACES) as DemoWorkspace[]) {
    for (const svc of DEMO_WORKSPACES[ws].services) out[ws][svc] = demoCredential(seed, svc, ws);
  }
  return out;
}

/** Base URL of one mock system as the connectors call it. */
export function mockServiceUrl(port: number, service: MockService): string {
  return `http://${DEMO_MOCK_HOST}:${port}/${service}`;
}
