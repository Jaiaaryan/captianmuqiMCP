import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * The demo control: a resident pill every signed-in user sees (never on
 * /login), whether demo mode is on or off: it holds the demo-mode switch. Its
 * panel lists the demo accounts, the MCP endpoints, reset and hide. The API is
 * mocked, as in the other smoke tests.
 */

const ACCOUNTS = [
  { email: 'alice@alpha.codebound.test', password: 'Cb-0a1b2c3d4e-A!', name: 'Alice (Alpha admin)', role: 'ADMIN', mcpRoles: [], workspace: 'A', workspaceName: 'Alpha (CODEBOUND workspace A)' },
  { email: 'carol@alpha.codebound.test', password: 'Cb-1a1b2c3d4e-C!', name: 'Carol (Alpha staff)', role: 'VIEWER', mcpRoles: ['Staff'], workspace: 'A', workspaceName: 'Alpha (CODEBOUND workspace A)' },
  { email: 'bob@beta.codebound.test', password: 'Cb-2a1b2c3d4e-B!', name: 'Bob (Beta admin)', role: 'ADMIN', mcpRoles: [], workspace: 'B', workspaceName: 'Beta (CODEBOUND workspace B)' },
];

const STATUS = {
  enabled: true,
  lastResetAt: null,
  mock: { port: 4191, requests: 1234 },
  workspaces: [
    { id: 'o1', name: 'Alpha (CODEBOUND workspace A)', letter: 'A', serverId: 'cmgx1a2b3c4d5e6f7g8h' },
    { id: 'o2', name: 'Beta (CODEBOUND workspace B)', letter: 'B', serverId: 'cmgx9z8y7x6w5v4u3t2s' },
  ],
  accounts: ACCOUNTS,
  currentWorkspace: 'A',
};

const RESET = {
  ok: true,
  reset: { runs: 14, invocations: 212, refusals: 3, securityEvents: 9, scriptsRemoved: 1, scriptsRestored: 4, chainsRestored: 2 },
  at: '2026-10-18T12:00:00.000Z',
};

interface Setup {
  available?: boolean;
  enabled?: boolean;
  canToggle?: boolean;
  /** Status code the PUT answers with (200 flips the state). */
  putStatus?: number;
}

async function session(page: Page, setup: Setup = {}) {
  const user = { id: 'u1', email: 'alice@alpha.codebound.test', name: 'Alice', role: 'ADMIN', organizationId: 'o1', emailVerified: true };
  const state = { enabled: setup.enabled ?? true };
  const calls = { reset: 0, controlGets: 0, puts: [] as unknown[] };
  const control = () =>
    setup.available === false
      ? { available: false, enabled: false, canToggle: false, canReset: false }
      : {
          available: true,
          enabled: state.enabled,
          canToggle: setup.canToggle ?? true,
          canReset: state.enabled,
          ...(state.enabled ? { status: STATUS } : {}),
        };
  const origin = new URL(test.info().project.use.baseURL ?? 'http://localhost:3100').origin;
  await page.context().addCookies([{ name: 'amcp_token', value: 'test-token', url: origin }]);
  await page.addInitScript((u) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(u));
  }, user);

  await page.route(/\/(api|health)\//, async (route: Route) => {
    const req = route.request();
    const url = req.url();
    const path = new URL(url).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,PUT,POST', 'access-control-allow-headers': '*' },
        body: JSON.stringify(body),
      });
    if (req.method() === 'OPTIONS') return json({});

    if (path === '/health/server-info') {
      return json({ deploymentMode: 'self-hosted', mcpAuthMode: 'both', serverUrl: 'http://localhost:4000', mcpEndpoint: 'http://localhost:4000/mcp', hasUsers: true, registrationEnabled: true, ssoProviders: [] });
    }
    if (path === '/api/demo/control') {
      if (req.method() === 'PUT') {
        const body = req.postDataJSON();
        calls.puts.push(body);
        const status = setup.putStatus ?? 200;
        if (status !== 200) return json({ message: 'Only a workspace administrator can switch demo mode' }, status);
        state.enabled = !!body.enabled;
        return json(control());
      }
      calls.controlGets++;
      return json(control());
    }
    if (path === '/api/public/demo') {
      return json(state.enabled && setup.available !== false ? { enabled: true, accounts: ACCOUNTS, mcp: { A: '/mcp/a', B: '/mcp/b' } } : { enabled: false });
    }
    if (path === '/api/demo/reset') {
      calls.reset++;
      return json(RESET);
    }
    if (url.includes('/api/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (url.includes('/api/users/me')) return json(user);
    if (url.includes('/api/organizations/current')) return json({ id: 'o1', name: 'Alpha (CODEBOUND workspace A)', createdAt: '2026-01-01' });
    if (url.includes('/api/organizations/mine')) return json([{ id: 'o1', name: 'Alpha (CODEBOUND workspace A)', role: 'ADMIN', joinedAt: '2026-01-01' }]);
    if (url.includes('/api/license/status')) return json({ plan: 'community', status: 'active' });
    if (url.includes('/api/mcp-servers')) return json([{ id: 'cmgx1a2b3c4d5e6f7g8h', name: 'CODEBOUND', slug: 'codebound' }]);
    return json([]);
  });
  return { calls, state };
}

test.describe('demo control', () => {
  test('demo mode on: the pill opens the panel; reset asks once and shows the counts', async ({ page }) => {
    const { calls } = await session(page);
    await page.goto('/sandbox');

    const pill = page.getByTestId('demo-pill');
    await expect(pill).toBeVisible({ timeout: 20_000 });
    await expect(pill).toHaveAttribute('data-enabled', 'true');
    await expect(pill).toHaveCSS('height', '38px');
    await expect(page.getByTestId('demo-pill-dot')).toBeVisible();
    await pill.click();

    const panel = page.getByTestId('demo-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveCSS('width', '280px');
    await expect(page.getByTestId('demo-current')).toHaveText('A · Alpha');
    await expect(page.getByTestId('demo-mode-switch')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('demo-mode-switch')).toBeEnabled();
    await expect(panel).toContainText('carolVIEWER · Staff · A');
    await expect(panel).toContainText('bobADMIN · B');
    // The signed-in account has no Switch; the others do.
    await expect(page.getByTestId('demo-switch-alice@alpha.codebound.test')).toHaveCount(0);
    await expect(page.getByTestId('demo-switch-bob@beta.codebound.test')).toBeEnabled();
    await expect(page.getByTestId('demo-mcp-A')).toContainText('/mcp/cmgx1a2b…7g8h');
    await expect(page.getByTestId('demo-mcp-B')).toContainText('/mcp/cmgx9z8y…3t2s');
    await expect(page.getByTestId('demo-mock-count')).toHaveText('mock · 1.2k');

    await page.getByTestId('demo-reset').click();
    expect(calls.reset).toBe(0);
    await page.getByTestId('demo-reset-confirm').click();
    await expect(page.getByTestId('demo-reset-result')).toHaveText('runs 14 · invocations 212 · scripts 4');
    expect(calls.reset).toBe(1);

    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    // Keyboard: Enter and Space on the focused pill open it again.
    await pill.focus();
    await page.keyboard.press('Enter');
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await pill.focus();
    await page.keyboard.press('Space');
    await expect(panel).toBeVisible();
  });

  test('demo mode off: grey dot, only the switch is live, and it sends the PUT', async ({ page }) => {
    const { calls, state } = await session(page, { enabled: false });
    await page.goto('/sandbox');

    const pill = page.getByTestId('demo-pill');
    await expect(pill).toBeVisible({ timeout: 20_000 });
    await expect(pill).toHaveAttribute('data-enabled', 'false');
    await pill.click();

    const panel = page.getByTestId('demo-panel');
    await expect(panel).toHaveAttribute('data-enabled', 'false');
    await expect(page.getByTestId('demo-current')).toHaveCount(0);
    const sw = page.getByTestId('demo-mode-switch');
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(sw).toContainText('Off');
    // Every other row is there, dimmed and disabled.
    for (const email of ['carol@alpha.codebound.test', 'bob@beta.codebound.test']) {
      await expect(page.getByTestId(`demo-switch-${email}`)).toBeDisabled();
    }
    await expect(page.getByTestId('demo-switch-alice@alpha.codebound.test')).toBeDisabled();
    await expect(page.getByTestId('demo-reset')).toBeDisabled();
    await expect(page.getByTestId('demo-mcp-A').getByRole('button')).toBeDisabled();
    await expect(page.getByTestId('demo-mock-count')).toHaveText('mock · off');

    const getsBefore = calls.controlGets;
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(calls.puts).toEqual([{ enabled: true }]);
    expect(state.enabled).toBe(true);
    // Re-read after the action.
    expect(calls.controlGets).toBeGreaterThan(getsBefore);
    await expect(pill).toHaveAttribute('data-enabled', 'true');
    await expect(page.getByTestId('demo-switch-bob@beta.codebound.test')).toBeEnabled();

    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(calls.puts).toEqual([{ enabled: true }, { enabled: false }]);
  });

  test('a 403 on the switch leaves it disabled', async ({ page }) => {
    const { calls } = await session(page, { enabled: false, putStatus: 403 });
    await page.goto('/sandbox');
    await page.getByTestId('demo-pill').click({ timeout: 20_000 });
    const sw = page.getByTestId('demo-mode-switch');
    await sw.click();
    await expect(sw).toBeDisabled();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(calls.puts).toHaveLength(1);
  });

  test('a non-admin sees the switch disabled', async ({ page }) => {
    await session(page, { enabled: true, canToggle: false });
    await page.goto('/sandbox');
    await page.getByTestId('demo-pill').click({ timeout: 20_000 });
    await expect(page.getByTestId('demo-mode-switch')).toBeDisabled();
  });

  test('dragging snaps the pill to the nearest edge and remembers it', async ({ page }) => {
    await session(page);
    await page.goto('/sandbox');
    const pill = page.getByTestId('demo-pill');
    await expect(pill).toBeVisible({ timeout: 20_000 });
    await expect(pill).toHaveAttribute('data-side', 'right');

    const box = (await pill.boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + 19);
    await page.mouse.down();
    await page.mouse.move(200, 300, { steps: 8 });
    await page.mouse.up();
    await expect(pill).toHaveAttribute('data-side', 'left');
    // A drag is not a click.
    await expect(page.getByTestId('demo-panel')).toHaveCount(0);
    await expect.poll(async () => (await pill.boundingBox())!.x).toBe(24);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('amcp.demo.pill') ?? 'null'));
    expect(saved.side).toBe('left');

    await page.reload();
    await expect(page.getByTestId('demo-pill')).toHaveAttribute('data-side', 'left', { timeout: 20_000 });
  });

  test('Hide 1h removes the pill, also across a reload', async ({ page }) => {
    await session(page);
    await page.goto('/sandbox');
    await page.getByTestId('demo-pill').click({ timeout: 20_000 });
    await page.getByTestId('demo-hide').click();
    await expect(page.getByTestId('demo-pill')).toHaveCount(0);
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('demo-pill')).toHaveCount(0);
  });

  test('no pill where demo mode is unavailable (Cloud)', async ({ page }) => {
    const { calls } = await session(page, { available: false });
    await page.goto('/sandbox');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('tablist', { name: 'Code mode' })).toBeVisible({ timeout: 20_000 });
    expect(calls.controlGets).toBeGreaterThan(0);
    await expect(page.getByTestId('demo-pill')).toHaveCount(0);
  });

  test('no pill on /login', async ({ page }) => {
    await session(page, { enabled: true });
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByTestId('demo-pill')).toHaveCount(0);
  });
});
