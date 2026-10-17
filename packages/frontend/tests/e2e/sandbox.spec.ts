import { expect, test, type Page, type Route } from '@playwright/test';

// Code mode (/sandbox): scripts an agent runs next to the data. The API is mocked, as in the
// other smoke tests; the real thing is exercised by scripts/sandbox-e2e and sandbox-demo.

const SERVER = { id: 'srv-1', name: 'Demo ERP', slug: 'demo-erp' };

const ERP = { connectorId: 'c-erp', connectorName: 'KOCH Demo ERP', connectorExists: true };
const SHOP = { connectorId: 'c-shop', connectorName: 'Shop API', connectorExists: true };

type MockScript = { id: string; name: string; uses: unknown[] } & Record<string, unknown>;

const summary = (over: MockScript): MockScript => ({
  description: null,
  version: 1,
  createdById: 'u1',
  ownedByYou: true,
  lastRunAt: null,
  lastRunOk: null,
  lastRunMeta: null,
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-01T10:00:00Z',
  availableOnServer: true,
  missingConnectors: [],
  ...over,
});

const DELAYED = summary({
  id: 'scr-1',
  name: 'delayed_orders',
  description: 'Orders delivered after the promised date.',
  uses: [{ ...ERP, tools: ['erp_orders_export'] }],
});
const REVENUE = summary({
  id: 'scr-2',
  name: 'revenue_by_category',
  uses: [{ ...ERP, tools: ['erp_order_items_list', 'erp_products_list'] }],
});
// Uses two connectors, one of which the selected server does not have.
const CROSS = summary({
  id: 'scr-3',
  name: 'erp_vs_shop',
  uses: [
    { ...ERP, tools: ['erp_products_list'] },
    { ...SHOP, tools: ['shop_list_orders'] },
  ],
  availableOnServer: false,
  missingConnectors: [{ id: 'c-shop', name: 'Shop API' }],
});
const PURE = summary({ id: 'scr-4', name: 'double_it', uses: [] });
const SCRIPTS = [DELAYED, REVENUE, CROSS, PURE];

const CODE: Record<string, string> = {
  'scr-1': "const res = await tools.erp_orders_export({ from: '2026-09-01', to: '2026-10-01' });\nreturn { delayed: res.rows.length };",
  'scr-2': 'return 1;',
  'scr-3': 'return 2;',
  'scr-4': 'return args.n * 2;',
};

const RUN_OK = {
  runId: 'run-1',
  ok: true,
  result: { delayed: 922 },
  meta: { ms: 78, connectorCalls: 1, bytesFromConnectors: 1_220_000, bytesReturned: 17, logs: [], toolsCalled: ['erp_orders_export'] },
  script: { id: 'scr-1', name: 'delayed_orders', version: 1, ownedByYou: true },
};

const ISOLATION = [
  { id: 'a', name: 'No network', claim: '`fetch` does not exist.', specRef: '§9 #2', expectedCode: 'OK', actualCode: 'OK', passed: true, ms: 4 },
  { id: 'b', name: 'Infinite loop is killed', claim: 'Stopped at the wall-clock limit.', specRef: '§9 #4', expectedCode: 'TIMEOUT', actualCode: 'TIMEOUT', passed: true, ms: 1000 },
];

// What GET /api/connectors returns: every connector of the organization, with its tools.
const CONNECTORS = [
  { id: 'c-erp', name: 'KOCH Demo ERP', tools: [{ name: 'erp_orders_export' }, { name: 'erp_products_list' }, { name: 'erp_order_items_list' }] },
  { id: 'c-shop', name: 'Shop API', tools: [{ name: 'shop_list_orders' }, { name: 'shop_create_refund' }] },
];

async function session(
  page: Page,
  role: 'ADMIN' | 'VIEWER',
  options: { off?: boolean; onCreate?: (body: any) => void } = {},
) {
  const user = { id: 'u1', email: 'test@example.com', name: 'Test User', role, organizationId: 'o1', emailVerified: true };
  await page.context().addCookies([{ name: 'amcp_token', value: 'test-token', url: 'http://localhost:3100' }]);
  await page.addInitScript((u) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(u));
  }, user);

  await page.route(/\/(api|health)\//, async (route: Route) => {
    const url = route.request().url();
    const path = new URL(url).pathname;
    const method = route.request().method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.includes('/health/server-info')) {
      return json({ deploymentMode: 'self-hosted', mcpAuthMode: 'both', serverUrl: 'http://localhost:4000', mcpEndpoint: 'http://localhost:4000/mcp', hasUsers: true, registrationEnabled: true, ssoProviders: [] });
    }
    if (url.includes('/api/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (url.includes('/api/users/me')) return json(user);
    if (url.includes('/api/organizations/current')) return json({ id: 'o1', name: 'Acme', createdAt: '2026-01-01' });
    if (url.includes('/api/organizations/mine')) return json([{ id: 'o1', name: 'Acme', role, joinedAt: '2026-01-01' }]);
    if (url.includes('/api/license/status')) return json({ plan: 'community', status: 'active' });
    if (url.includes('/api/mcp-servers')) return json([SERVER]);
    if (path === '/api/connectors') return json(CONNECTORS);

    if (url.includes('/api/sandbox/')) {
      if (options.off) return json({ statusCode: 404, message: 'Code mode is turned off on this instance.' }, 404);
      if (url.endsWith('/isolation-tests')) return json(ISOLATION);
      if (url.endsWith('/run')) return json(RUN_OK);
      if (url.includes('/runs')) return json([]);
      if (path.endsWith('/scripts') && method === 'GET') return json(SCRIPTS);
      if (path.endsWith('/scripts') && method === 'POST') {
        const body = route.request().postDataJSON();
        options.onCreate?.(body);
        return json(
          {
            ...summary({ id: 'scr-9', name: body.name, uses: [{ ...ERP, tools: body.uses[0].tools }] }),
            code: body.code,
            syntax: { ok: true },
            added: ['Shop API / shop_list_orders'],
            warnings: [],
          },
          201,
        );
      }
      const one = /\/scripts\/(scr-\d+)$/.exec(path);
      if (one && method === 'GET') {
        const found = SCRIPTS.find((s) => s.id === one[1])!;
        return json({ ...found, code: CODE[found.id] });
      }
    }
    return json([]);
  });
}

test.describe('code mode', () => {
  test('an administrator reads a saved script and runs it', async ({ page }) => {
    await session(page, 'ADMIN');
    await page.goto('/sandbox');

    await expect(page.getByRole('tablist', { name: 'Code mode' })).toBeVisible();
    await page.getByTestId('script-row').filter({ hasText: 'delayed_orders' }).click();
    await expect(page.locator('pre').first()).toContainText('erp_orders_export');

    await page.getByRole('button', { name: 'Run', exact: true }).click();
    const result = page.getByTestId('run-result');
    await expect(result).toContainText('Succeeded');
    await expect(result).toContainText('"delayed": 922');
    // The point of code mode: much was pulled in next to the data, little went back.
    await expect(result).toContainText('1.16 MB');
    await expect(result).toContainText('17 B');
  });

  test('the isolation tab runs the suite and shows each attempt', async ({ page }) => {
    await session(page, 'ADMIN');
    await page.goto('/sandbox');

    await page.getByRole('tab', { name: 'Isolation tests' }).click();
    await page.getByRole('button', { name: 'Run isolation suite' }).click();
    await expect(page.getByTestId('isolation-results')).toContainText('2 of 2 passed');
    await expect(page.getByTestId('isolation-row')).toHaveCount(2);
    await expect(page.locator('[data-testid="isolation-row"][data-passed="true"]')).toHaveCount(2);
  });

  test('a viewer can read scripts but not write or run them', async ({ page }) => {
    await session(page, 'VIEWER');
    await page.goto('/sandbox');

    await page.getByTestId('script-row').first().click();
    await expect(page.getByText('Viewers can read scripts but not run them.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New script' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeDisabled();
  });

  test('says so when code mode is turned off on the instance', async ({ page }) => {
    await session(page, 'ADMIN', { off: true });
    await page.goto('/sandbox');

    await expect(page.getByText('SANDBOX_ENABLED=false')).toBeVisible();
    await expect(page.getByRole('tablist', { name: 'Code mode' })).toHaveCount(0);
  });

  test.describe('the connectors and tools a script uses', () => {
    test('a card shows a pin with the number of connectors, and the tooltip lists the tools', async ({ page }) => {
      await session(page, 'ADMIN');
      await page.goto('/sandbox');

      const pins = page.getByTestId('script-pin');
      // double_it uses no connector, so it has no pin.
      await expect(pins).toHaveCount(3);
      const cross = page.locator('li', { hasText: 'erp_vs_shop' }).getByTestId('script-pin');
      await expect(cross).toHaveText('2');

      await cross.hover();
      const tip = page.getByTestId('pin-tooltip');
      await expect(tip).toBeVisible();
      await expect(tip).toContainText('KOCH Demo ERP');
      await expect(tip).toContainText('erp_products_list');
      await expect(tip).toContainText('Shop API');
      await expect(tip).toContainText('shop_list_orders');
      // The connector this server lacks is marked.
      await expect(tip).toContainText('not on this server');

      await page.mouse.move(0, 0);
      await expect(tip).toHaveCount(0);
    });

    test('the tooltip also opens from the keyboard', async ({ page }) => {
      await session(page, 'ADMIN');
      await page.goto('/sandbox');
      await page.locator('li', { hasText: 'delayed_orders' }).getByTestId('script-pin').focus();
      await expect(page.getByTestId('pin-tooltip')).toContainText('erp_orders_export');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('pin-tooltip')).toHaveCount(0);
    });

    test('an opened script lists its connectors and tools', async ({ page }) => {
      await session(page, 'ADMIN');
      await page.goto('/sandbox');
      await page.getByTestId('script-row').filter({ hasText: 'revenue_by_category' }).click();

      const section = page.getByTestId('script-uses');
      await expect(section).toContainText('Connectors & tools');
      await expect(section).toContainText('KOCH Demo ERP');
      await expect(section).toContainText('erp_order_items_list');
      await expect(section).toContainText('erp_products_list');
    });

    test('a script that needs a connector the server lacks says so and cannot be run here', async ({ page }) => {
      await session(page, 'ADMIN');
      await page.goto('/sandbox');

      await expect(page.getByTestId('not-on-server')).toHaveText('Not on this server: needs Shop API');
      await page.getByTestId('script-row').filter({ hasText: 'erp_vs_shop' }).click();
      await expect(page.getByTestId('unavailable-notice')).toContainText('does not have “Shop API”');
      await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeDisabled();

      // A script that needs no connector runs anywhere.
      await page.getByTestId('script-row').filter({ hasText: 'double_it' }).click();
      await expect(page.getByTestId('unavailable-notice')).toHaveCount(0);
      await expect(page.getByTestId('script-uses')).toContainText('calls no tool');
      await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
    });

    test('new script: pick connectors and tools, and they are sent with the script', async ({ page }) => {
      let sent: any;
      await session(page, 'ADMIN', { onCreate: (body) => (sent = body) });
      await page.goto('/sandbox');

      await page.getByRole('button', { name: 'New script' }).click();
      await page.locator('#script-name').fill('erp_products');
      await page.getByLabel('Script code').fill('return await tools.erp_products_list({});');

      const picker = page.getByTestId('uses-picker');
      await expect(picker).toContainText('None picked');
      await picker.getByRole('button', { name: /KOCH Demo ERP/ }).click();
      await picker.getByLabel('KOCH Demo ERP: erp_products_list').check();
      await picker.getByLabel('KOCH Demo ERP: erp_orders_export').check();
      await expect(page.getByTestId('uses-count')).toHaveText('1 connector, 2 tools');
      // The connector's own box shows "some of the tools".
      await expect(picker.getByLabel('All tools of KOCH Demo ERP')).not.toBeChecked();

      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByTestId('notice')).toContainText('Saved erp_products');
      // What the host found in the code and added is reported.
      await expect(page.getByTestId('notice')).toContainText('Also added from the code: Shop API / shop_list_orders');
      expect(sent.uses).toEqual([{ connectorId: 'c-erp', tools: ['erp_orders_export', 'erp_products_list'] }]);
    });

    test('ticking a connector ticks all of its tools, and unticking removes them', async ({ page }) => {
      await session(page, 'ADMIN');
      await page.goto('/sandbox');
      await page.getByRole('button', { name: 'New script' }).click();

      const picker = page.getByTestId('uses-picker');
      await picker.getByLabel('All tools of Shop API').check();
      await expect(page.getByTestId('uses-count')).toHaveText('1 connector, 2 tools');
      await picker.getByLabel('All tools of Shop API').uncheck();
      await expect(page.getByTestId('uses-count')).toHaveText('None picked');
    });

    test('the filter pop-up lists the connectors scripts use and filters only when applied', async ({ page }) => {
      await session(page, 'ADMIN');
      await page.goto('/sandbox');
      await expect(page.getByTestId('script-row')).toHaveCount(4);

      await page.getByTestId('filter-button').click();
      const dialog = page.getByTestId('filter-dialog');
      await expect(dialog).toContainText('Filter scripts');
      await expect(dialog).toContainText('KOCH Demo ERP');
      await expect(dialog).toContainText('3 scripts');
      await expect(dialog).toContainText('Shop API');
      await expect(dialog).toContainText('1 script');

      // Ticking changes nothing until Apply.
      await dialog.getByLabel('Shop API').check();
      await expect(page.getByTestId('script-row')).toHaveCount(4);
      await dialog.getByRole('button', { name: 'Apply' }).click();

      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('script-row')).toHaveCount(1);
      await expect(page.getByTestId('script-row')).toContainText('erp_vs_shop');
      await expect(page.getByTestId('filter-count')).toHaveText('1');
      await expect(page.getByTestId('filter-chips')).toContainText('Shop API');
    });

    test('several ticked connectors show the scripts that use any of them', async ({ page }) => {
      await session(page, 'ADMIN');
      await page.goto('/sandbox');
      await page.getByTestId('filter-button').click();
      const dialog = page.getByTestId('filter-dialog');
      await dialog.getByLabel('Shop API').check();
      await dialog.getByLabel('KOCH Demo ERP').check();
      await dialog.getByRole('button', { name: 'Apply' }).click();
      // The three scripts that use the ERP or the shop; not the one that uses no connector.
      await expect(page.getByTestId('script-row')).toHaveCount(3);
      await expect(page.getByTestId('script-row').filter({ hasText: 'double_it' })).toHaveCount(0);
    });

    test('cancelling the pop-up discards what was ticked; Clear shows every script again', async ({ page }) => {
      await session(page, 'ADMIN');
      await page.goto('/sandbox');
      await page.getByTestId('filter-button').click();
      await page.getByTestId('filter-dialog').getByLabel('Shop API').check();
      await page.getByTestId('filter-dialog').getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByTestId('script-row')).toHaveCount(4);
      await expect(page.getByTestId('filter-count')).toHaveCount(0);

      await page.getByTestId('filter-button').click();
      await page.getByTestId('filter-dialog').getByLabel('Shop API').check();
      await page.getByTestId('filter-dialog').getByRole('button', { name: 'Apply' }).click();
      await expect(page.getByTestId('script-row')).toHaveCount(1);
      await page.getByTestId('filter-chips').getByRole('button', { name: 'Clear' }).click();
      await expect(page.getByTestId('script-row')).toHaveCount(4);
    });

    test('a viewer sees the pins and can filter, but has no picker', async ({ page }) => {
      await session(page, 'VIEWER');
      await page.goto('/sandbox');
      await expect(page.getByTestId('script-pin')).toHaveCount(3);
      await page.getByTestId('filter-button').click();
      await page.getByTestId('filter-dialog').getByLabel('Shop API').check();
      await page.getByTestId('filter-dialog').getByRole('button', { name: 'Apply' }).click();
      await expect(page.getByTestId('script-row')).toHaveCount(1);
      await expect(page.getByTestId('uses-picker')).toHaveCount(0);
    });
  });
});
