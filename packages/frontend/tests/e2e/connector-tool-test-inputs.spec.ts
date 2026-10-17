import { expect, test, type Page } from '@playwright/test';

const USER = { id: 'u1', email: 'test@example.com', name: 'Test User', role: 'ADMIN', organizationId: 'o1', emailVerified: true };

async function openTest(page: Page, baseURL: string, withExample = true) {
  const requests: Record<string, unknown>[] = [];
  const connector = {
    id: 'c1', name: 'Mock Carrier', type: 'REST', baseUrl: 'http://localhost:4103',
    authType: 'NONE', authConfig: null, isActive: true, envVars: {}, headers: {},
    config: {}, userId: 'u1', organizationId: 'o1', createdAt: '2026-01-01T00:00:00Z',
    tools: [{
      id: 't1', connectorId: 'c1', name: 'mock_carrier_get_tracking', description: 'Track one parcel.',
      isEnabled: true, parameters: { type: 'object', properties: {
        tracking_no: { type: 'string', ...(withExample ? { examples: ['ATRK000001'] } : {}) },
        optionalFilter: { type: 'string' },
      }, required: ['tracking_no'] },
      endpointMapping: { method: 'GET', path: '/v1/tracking/{tracking_no}' },
    }],
  };
  await page.context().addCookies([{ name: 'amcp_token', value: 'test-token', url: baseURL }]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, USER);
  await page.route(/\/api\//, async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/connectors/c1/tools/t1/test') && req.method() === 'POST') {
      requests.push(req.postDataJSON());
      return json({ ok: true, durationMs: 8, result: { trackingNo: 'ATRK000001', status: 'in_transit' } });
    }
    if (url.includes('/api/connectors/proxy-availability')) return json({ available: false });
    if (url.includes('/api/connectors/c1/catalog-diff')) return json({ catalogManaged: false });
    if (url.includes('/api/connectors/c1')) return json(connector);
    if (url.includes('/api/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (url.includes('/api/users/me')) return json(USER);
    if (url.includes('/api/organizations/current')) return json({ id: 'o1', name: 'Acme' });
    if (url.includes('/api/organizations/mine')) return json([{ id: 'o1', name: 'Acme', role: 'ADMIN' }]);
    if (url.includes('/api/license/status')) return json({ plan: 'community', status: 'active' });
    if (url.includes('/api/connectors')) return json([connector]);
    return json({});
  });
  await page.goto('/connectors/c1');
  await page.getByRole('main').getByRole('button', { name: 'Test', exact: true }).click();
  return { requests, input: page.getByLabel('Input Parameters (JSON)') };
}

test('prefills a real schema example and sends it from Run Test', async ({ page, baseURL }) => {
  const { requests, input } = await openTest(page, baseURL!);
  await expect(input).toHaveValue(JSON.stringify({ tracking_no: 'ATRK000001' }, null, 2));
  await page.getByRole('button', { name: 'Run Test', exact: true }).click();
  await expect(page.getByText('Success (8ms)')).toBeVisible();
  expect(requests).toEqual([{ arguments: { tracking_no: 'ATRK000001' }, params: { tracking_no: 'ATRK000001' } }]);
});

test('blocks empty required tracking numbers before sending a request, and accepts a correction', async ({ page, baseURL }) => {
  const { requests, input } = await openTest(page, baseURL!, false);
  await page.getByRole('button', { name: 'Run Test', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Enter a value for required parameter "tracking_no".');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(requests).toHaveLength(0);
  await input.fill('{"tracking_no":"   "}');
  await page.getByRole('button', { name: 'Run Test', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toBeVisible();
  expect(requests).toHaveLength(0);
  await input.fill('{"tracking_no":"ATRK000001"}');
  await page.getByRole('button', { name: 'Run Test', exact: true }).click();
  await expect(page.getByText('Success (8ms)')).toBeVisible();
  expect(requests).toHaveLength(1);
});

test('rejects a JSON array instead of sending it as tool arguments', async ({ page, baseURL }) => {
  const { requests, input } = await openTest(page, baseURL!);
  await input.fill('[]');
  await page.getByRole('button', { name: 'Run Test', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Input parameters must be a JSON object.');
  expect(requests).toHaveLength(0);
});
