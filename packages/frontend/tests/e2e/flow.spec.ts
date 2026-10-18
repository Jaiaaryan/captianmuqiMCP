import { expect, test, type Page, type Route } from '@playwright/test';

// Flow (/flow): the data-flow graph, in-place edits in the drawer, the replay
// timeline and the Ask bar. The API is mocked, as in the other smoke tests.

const S1 = { id: 'srv-1', name: 'Main' };
const S2 = { id: 'srv-2', name: 'Ship' };

const stats = (calls: number, errors = 0) => ({ calls, errors });

/** Every server: one agent, two servers, one connector, two tools, a chain, a script. */
const GRAPH_ALL = {
  serverId: null,
  since: '2026-10-16T12:00:00.000Z',
  generatedAt: '2026-10-17T12:00:00.000Z',
  nodes: [
    { id: 'agent', kind: 'agent', label: 'Agent', stats: stats(12, 3) },
    { id: 'server:srv-1', kind: 'server', label: 'Main', ref: { serverId: 'srv-1' }, stats: stats(10, 3), meta: { connectors: 1 } },
    { id: 'server:srv-2', kind: 'server', label: 'Ship', ref: { serverId: 'srv-2' }, stats: stats(2), meta: { connectors: 1 } },
    { id: 'connector:c1', kind: 'connector', label: 'Supplier', ref: { connectorId: 'c1' }, stats: stats(12, 3), meta: { authType: 'API_KEY', tools: 2 } },
    { id: 'tool:t1', kind: 'tool', label: 'mock_supplier_list_offers', ref: { toolId: 't1', connectorId: 'c1' }, stats: stats(10, 3), meta: { readOnly: true, method: 'GET' } },
    { id: 'tool:t2', kind: 'tool', label: 'mock_supplier_get_prices', ref: { toolId: 't2', connectorId: 'c1' }, stats: stats(2), meta: { readOnly: true, method: 'GET' } },
    { id: 'processing:t1', kind: 'processing', label: 'mock_supplier_list_offers processing', ref: { toolId: 't1', connectorId: 'c1' }, stats: stats(10, 3), meta: { steps: 2, enabled: true, valid: true } },
    { id: 'script:sc1', kind: 'script', label: 'price_drift_check', ref: { scriptId: 'sc1' }, stats: stats(1), meta: { version: 2, tools: 1 } },
  ],
  edges: [
    { id: 'mcp:agent>server:srv-1', source: 'agent', target: 'server:srv-1', kind: 'mcp', stats: stats(10, 3) },
    { id: 'mcp:agent>server:srv-2', source: 'agent', target: 'server:srv-2', kind: 'mcp', stats: stats(2) },
    { id: 'tool:server:srv-1>tool:t1', source: 'server:srv-1', target: 'tool:t1', kind: 'tool', stats: stats(10, 3) },
    { id: 'tool:server:srv-1>tool:t2', source: 'server:srv-1', target: 'tool:t2', kind: 'tool', stats: stats(0) },
    { id: 'tool:server:srv-2>tool:t2', source: 'server:srv-2', target: 'tool:t2', kind: 'tool', stats: stats(2) },
    { id: 'http:tool:t1>connector:c1', source: 'tool:t1', target: 'connector:c1', kind: 'http', stats: stats(10, 3) },
    { id: 'http:tool:t2>connector:c1', source: 'tool:t2', target: 'connector:c1', kind: 'http', stats: stats(2) },
    { id: 'processing:tool:t1>processing:t1', source: 'tool:t1', target: 'processing:t1', kind: 'processing', stats: stats(10, 3) },
    { id: 'script-use:script:sc1>tool:t1', source: 'script:sc1', target: 'tool:t1', kind: 'script-use' },
    { id: 'script-call:script:sc1>tool:t1', source: 'script:sc1', target: 'tool:t1', kind: 'script-call', stats: stats(1) },
  ],
};

const EVENTS = {
  from: '2026-10-16T12:00:00.000Z',
  until: '2026-10-17T12:00:00.000Z',
  truncated: false,
  events: [
    { ts: '2026-10-17T10:00:00.000Z', kind: 'tool', serverId: 'srv-1', connectorId: 'c1', toolId: 't1', status: 'ok', durationMs: 12 },
    { ts: '2026-10-17T10:00:00.500Z', kind: 'tool', serverId: 'srv-2', connectorId: 'c1', toolId: 't2', status: 'ok', durationMs: 9 },
    { ts: '2026-10-17T10:00:01.000Z', kind: 'tool', serverId: 'srv-1', connectorId: 'c1', toolId: 't1', status: 'error', durationMs: 30 },
  ],
};

const TOOLS_C1 = [
  {
    id: 't1',
    name: 'mock_supplier_list_offers',
    responseMapping: {
      responseProcessing: { version: 1, enabled: true, onError: 'fail', steps: [{ id: 'a' }, { id: 'b' }] },
      transform: { select: { id: 'id' } },
    },
  },
  { id: 't2', name: 'mock_supplier_get_prices', responseMapping: null },
];

interface Options {
  role?: 'ADMIN' | 'VIEWER';
  events?: typeof EVENTS;
  llm?: boolean;
  calls?: { method: string; path: string; search: string; body: any }[];
}

async function session(page: Page, baseURL: string | undefined, options: Options = {}) {
  const role = options.role ?? 'ADMIN';
  const user = { id: 'u1', email: 'test@example.com', name: 'Test User', role, organizationId: 'o1', emailVerified: true };
  const origin = baseURL ?? 'http://localhost:3100';
  await page.context().addCookies([{ name: 'amcp_token', value: 'test-token', url: origin }]);
  await page.addInitScript((u) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(u));
  }, user);

  let connectorName = 'Supplier';
  await page.route(/\/(api|health)\//, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const body = method === 'GET' ? null : req.postDataJSON();
    if (path.startsWith('/api/flow') || method !== 'GET') options.calls?.push({ method, path, search: url.search, body });

    if (path.includes('/health/server-info')) {
      return json({ deploymentMode: 'self-hosted', mcpAuthMode: 'both', serverUrl: 'http://localhost:4000', mcpEndpoint: 'http://localhost:4000/mcp', hasUsers: true, registrationEnabled: true, ssoProviders: [] });
    }
    if (path === '/api/users/me/onboarding-state') return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (path === '/api/users/me') return json(user);
    if (path === '/api/organizations/current') return json({ id: 'o1', name: 'Acme', createdAt: '2026-01-01' });
    if (path === '/api/organizations/mine') return json([{ id: 'o1', name: 'Acme', role, joinedAt: '2026-01-01' }]);
    if (path === '/api/license/status') return json({ plan: 'community', status: 'active' });

    if (path === '/api/flow') return json(GRAPH_ALL);
    if (path === '/api/flow/events') return json(options.events ?? EVENTS);
    if (path === '/api/flow/ask' && method === 'GET') return json({ enabled: !!options.llm, model: options.llm ? 'stub-1' : undefined });
    if (path === '/api/flow/ask' && method === 'POST') {
      if (!options.llm) return json({ statusCode: 409, code: 'LLM_OFF', message: 'LLM off' }, 409);
      return json({ answer: 'tool:t1 failed 3 of 10 calls.', model: 'stub-1' });
    }

    if (path === '/api/mcp-servers') return json([S1, S2]);
    if (path === '/api/mcp-servers/srv-1') return json({ ...S1, connectors: [{ connectorId: 'c1', connector: { id: 'c1', name: connectorName } }] });
    if (path === '/api/connectors') return json([{ id: 'c1', name: connectorName }, { id: 'c2', name: 'Payroll' }]);
    if (path === '/api/connectors/c1' && method === 'GET') {
      return json({ id: 'c1', name: connectorName, isActive: true, baseUrl: 'https://supplier.example/api' });
    }
    if (path === '/api/connectors/c1' && method === 'PUT') {
      if (body?.name) connectorName = body.name;
      return json({});
    }
    if (path === '/api/connectors/c1/tools' && method === 'GET') return json(TOOLS_C1);
    if (/^\/api\/connectors\/c1\/tools\/t1$/.test(path) && method === 'PUT') return json({ id: 't1' });
    if (path.startsWith('/api/')) return json(method === 'GET' ? {} : { ok: true });
    return json({});
  });
}

const flowCalls = (calls: NonNullable<Options['calls']>, path: string) => calls.filter((c) => c.path === path);

test.describe('flow', () => {
  test('draws every server by default, edge to edge', async ({ page, baseURL }) => {
    const calls: NonNullable<Options['calls']> = [];
    await session(page, baseURL, { calls });
    await page.goto('/flow');

    await expect(page.getByTestId('flow-root')).toHaveAttribute('data-scope', 'all');
    await expect(page.getByTestId('flow-node-server:srv-1')).toBeVisible();
    await expect(page.getByTestId('flow-node-server:srv-2')).toBeVisible();
    await expect(page.getByTestId('flow-server')).toContainText('All servers · 2');
    // No serverId: the backend draws every server of the organization.
    const graphCall = flowCalls(calls, '/api/flow')[0];
    expect(graphCall.search).not.toContain('serverId');

    // Flush: the canvas fills the content area, no padding around it.
    const canvas = await page.getByTestId('flow-canvas').boundingBox();
    const main = await page.locator('main').boundingBox();
    expect(canvas && main).toBeTruthy();
    expect(Math.abs(canvas!.x - main!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(canvas!.x + canvas!.width - (main!.x + main!.width))).toBeLessThanOrEqual(1);
    expect(Math.abs(canvas!.y + canvas!.height - (main!.y + main!.height))).toBeLessThanOrEqual(1);
  });

  test('colours edges by state and animates them unless motion is reduced', async ({ page, baseURL }) => {
    await session(page, baseURL);
    await page.goto('/flow');
    await expect(page.getByTestId('flow-node-tool:t1')).toBeVisible();

    await expect(page.getByTestId('flow-edge-tool:server:srv-1>tool:t1')).toHaveAttribute('data-state', 'warn');
    await expect(page.getByTestId('flow-edge-tool:server:srv-2>tool:t2')).toHaveAttribute('data-state', 'ok');
    await expect(page.getByTestId('flow-edge-tool:server:srv-1>tool:t2')).toHaveAttribute('data-state', 'idle');
    await expect(page.getByTestId('flow-canvas')).toHaveAttribute('data-motion', 'full');
    expect(await page.locator('.amcp-flow-anim').count()).toBeGreaterThan(0);
    // Idle edges never animate.
    expect(await page.getByTestId('flow-edge-tool:server:srv-1>tool:t2').locator('.amcp-flow-flow').count()).toBe(0);
  });

  test('reduced motion: static colour, no animation', async ({ page, baseURL }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await session(page, baseURL);
    await page.goto('/flow');
    await expect(page.getByTestId('flow-node-tool:t1')).toBeVisible();

    await expect(page.getByTestId('flow-canvas')).toHaveAttribute('data-motion', 'reduced');
    await expect(page.locator('.amcp-flow-anim')).toHaveCount(0);
    const flow = page.getByTestId('flow-edge-tool:server:srv-1>tool:t1').locator('.amcp-flow-flow');
    await expect(flow).toHaveClass(/amcp-flow-static/);
    expect(await flow.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  });

  test('the timeline replays the window to the end and stops with the final counts', async ({ page, baseURL }) => {
    await session(page, baseURL);
    await page.goto('/flow');
    const timeline = page.getByTestId('flow-timeline');
    await expect(timeline).toBeVisible();
    await expect(page.getByTestId('flow-timeline-label')).toHaveText('3 events');
    const slider = page.getByRole('slider', { name: 'Replay position' });
    await expect(slider).toHaveAttribute('max', '3');

    await page.getByTestId('flow-timeline-speed-16').click();
    await expect(page.getByTestId('flow-timeline-speed-16')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('flow-timeline-play').click();
    await expect(page.getByTestId('flow-timeline-label')).toContainText('3/3', { timeout: 5000 });
    await expect(timeline).not.toHaveAttribute('data-playing', 'true');
    await expect(page.getByTestId('flow-timeline-play')).toHaveAttribute('aria-label', 'Play');
    // Counts as of the end of the replay: t1 was called twice, once failing.
    await expect(page.getByTestId('flow-node-tool:t1')).toContainText('2×');

    // Scrub with the keyboard: Home is before the first event.
    await slider.focus();
    await page.keyboard.press('Home');
    await expect(page.getByTestId('flow-timeline-label')).toContainText('0/3');
    await expect(page.getByTestId('flow-node-tool:t1')).toContainText('0×');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('flow-timeline-label')).toContainText('1/3');
    await expect(page.getByTestId('flow-node-tool:t1')).toContainText('1×');
    // Space plays from the timeline.
    await page.keyboard.press('Space');
    await expect(page.getByTestId('flow-timeline-label')).toContainText('3/3', { timeout: 8000 });
  });

  test('an empty window shows 0 events and a disabled timeline', async ({ page, baseURL }) => {
    await session(page, baseURL, { events: { ...EVENTS, events: [] } });
    await page.goto('/flow');
    await expect(page.getByTestId('flow-timeline-label')).toHaveText('0 events');
    await expect(page.getByTestId('flow-timeline-play')).toBeDisabled();
    await expect(page.getByTestId('flow-timeline-scrubber')).toBeDisabled();
  });

  test('the drawer renames a connector in place and switches Response Processing', async ({ page, baseURL }) => {
    const calls: NonNullable<Options['calls']> = [];
    await session(page, baseURL, { calls });
    await page.goto('/flow');

    await page.getByTestId('flow-node-connector:c1').click();
    const name = page.getByTestId('flow-edit-name');
    await expect(name).toHaveValue('Supplier');
    await expect(page.getByTestId('flow-edit-base-url')).toHaveText('https://supplier.example/api');
    await expect(page.getByTestId('flow-edit-enabled')).toHaveAttribute('data-state', 'on');

    // Esc keeps the saved name; an empty name is never sent.
    await name.fill('Nope');
    await name.press('Escape');
    await expect(name).toHaveValue('Supplier');
    await name.fill('   ');
    await name.press('Enter');
    await expect(name).toHaveValue('Supplier');
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);

    const graphLoads = flowCalls(calls, '/api/flow').length;
    await name.fill('Supplier EU');
    await name.press('Enter');
    await expect(page.getByTestId('flow-edit-name-status')).toHaveAttribute('data-phase', 'ok');
    expect(calls.find((c) => c.method === 'PUT' && c.path === '/api/connectors/c1')?.body).toEqual({ name: 'Supplier EU' });
    // The graph is fetched again after a save.
    await expect.poll(() => flowCalls(calls, '/api/flow').length).toBeGreaterThan(graphLoads);

    await page.getByTestId('flow-node-tool:t1').click();
    const rp = page.getByTestId('flow-edit-rp');
    await expect(rp).toHaveAttribute('data-state', 'on');
    await expect(page.getByTestId('flow-edit-tool-link')).toHaveAttribute('href', '/connectors/c1#processing');
    await rp.click();
    await expect(rp).toHaveAttribute('data-state', 'off');
    const put = calls.find((c) => c.method === 'PUT' && c.path === '/api/connectors/c1/tools/t1');
    // Only `enabled` changed; the steps and the transform went back as they were.
    expect(put?.body).toEqual({
      responseMapping: {
        responseProcessing: { version: 1, enabled: false, onError: 'fail', steps: [{ id: 'a' }, { id: 'b' }] },
        transform: { select: { id: 'id' } },
      },
    });
  });

  test('a viewer reads values without switches', async ({ page, baseURL }) => {
    await session(page, baseURL, { role: 'VIEWER' });
    await page.goto('/flow');
    await page.getByTestId('flow-node-connector:c1').click();
    await expect(page.getByTestId('flow-edit-connector')).toBeVisible();
    await expect(page.getByTestId('flow-edit-name')).toHaveCount(0);
    await expect(page.getByTestId('flow-edit-enabled')).toHaveText('On');
    await expect(page.getByRole('switch')).toHaveCount(0);
  });

  test('Ask: LLM off when the workspace has no LLM', async ({ page, baseURL }) => {
    await session(page, baseURL, { llm: false });
    await page.goto('/flow');
    const input = page.getByTestId('flow-ask-input');
    await expect(input).toBeDisabled();
    await expect(input).toHaveAttribute('placeholder', 'LLM off');
    await expect(page.getByTestId('flow-ask-settings')).toHaveAttribute('href', '/settings/organization');
  });

  test('Ask: Tab takes the suggestion, Enter sends, Esc collapses, ⌘K focuses', async ({ page, baseURL }) => {
    const calls: NonNullable<Options['calls']> = [];
    await session(page, baseURL, { llm: true, calls });
    await page.goto('/flow');
    const input = page.getByTestId('flow-ask-input');
    await expect(input).toBeEnabled();
    // The suggestions name real nodes.
    await expect(input).toHaveAttribute('placeholder', 'Why did mock_supplier_list_offers fail?');

    await page.locator('body').click();
    await page.keyboard.press('ControlOrMeta+k');
    await expect(input).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(input).toHaveValue('Why did mock_supplier_list_offers fail?');
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('flow-ask-answer')).toContainText('tool:t1 failed 3 of 10 calls.');
    await expect(page.getByTestId('flow-ask-model')).toHaveText('stub-1');
    await expect(page.getByTestId('flow-ask-question')).toHaveText('Why did mock_supplier_list_offers fail?');
    await expect(input).toHaveValue('');
    const ask = calls.find((c) => c.method === 'POST' && c.path === '/api/flow/ask');
    expect(ask?.body).toEqual({ serverId: null, window: '24h', question: 'Why did mock_supplier_list_offers fail?' });

    await input.press('Escape');
    await expect(page.getByTestId('flow-ask-thread')).toHaveCount(0);
    await page.getByTestId('flow-ask-toggle').click();
    await expect(page.getByTestId('flow-ask-thread')).toBeVisible();
  });
});
