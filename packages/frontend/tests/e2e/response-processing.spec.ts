import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Response Processing: the per-tool chain that edits a response before Response Mapping.
 * The API is mocked, as in the other smoke tests. The panel is reached the way an operator
 * reaches it: Connectors -> connector -> Edit on a tool. Everything the panel shows is
 * targeted through its data-testid values; the panel carries no explanatory text.
 */

const USER = {
  id: 'u1',
  email: 'test@example.com',
  name: 'Test User',
  role: 'ADMIN',
  organizationId: 'o1',
  emailVerified: true,
};

// The CODEBOUND kit P1: dollars to euros, add VAT, tidy the description.
const P1_CHAIN = {
  version: 1,
  enabled: true,
  onError: 'fail',
  steps: [
    {
      id: 'convert_to_eur',
      use: 'scale@1',
      each: '$.items[*]',
      reads: 'price_usd',
      writes: 'price_eur',
      mode: 'add',
      params: { factor: 0.92, round: 2 },
    },
    {
      id: 'add_vat',
      use: 'vat@1',
      each: '$.items[*]',
      reads: 'price_eur',
      writes: 'price_eur_gross',
      mode: 'add',
      params: { rate: 0.19, round: 2 },
    },
    {
      id: 'clean_description',
      use: 'clean_text@1',
      each: '$.items[*]',
      reads: 'description',
      writes: 'description',
      mode: 'replace',
      params: { trim: true, collapseWhitespace: true },
    },
  ],
};

// A recorded response, as GET /tools/:id returns it (already cut server-side).
const SAMPLE = {
  items: [
    { price_usd: 54.67, description: ' Black  Screw ', pricing: { net: 50, currency: 'USD' }, tags: ['a'] },
    { price_usd: 12.5, description: 'Nut', pricing: { net: 11, currency: 'USD' }, tags: [] },
  ],
  total: 2,
};

const BUILTINS = [
  ['scale@1', 'Scale', [{ name: 'factor', type: 'number', required: true }, { name: 'round', type: 'integer', min: 0, max: 10 }]],
  ['offset@1', 'Offset', [{ name: 'amount', type: 'number', required: true }, { name: 'round', type: 'integer', min: 0, max: 10 }]],
  ['vat@1', 'VAT', [{ name: 'rate', type: 'number', required: true, min: 0, max: 1 }, { name: 'round', type: 'integer', min: 0, max: 10 }]],
  ['round@1', 'Round', [{ name: 'decimals', type: 'integer', default: 2, min: 0, max: 10 }]],
  ['clean_text@1', 'Clean text', [{ name: 'trim', type: 'boolean' }, { name: 'collapseWhitespace', type: 'boolean' }]],
  ['truncate@1', 'Truncate', [{ name: 'maxLength', type: 'integer', required: true }, { name: 'ellipsis', type: 'string', default: '…' }]],
  ['map@1', 'Map', [{ name: 'map', type: 'object', required: true }, { name: 'fallback', type: 'any' }]],
].map(([use, title, params]) => ({ use, id: use, name: use, title, params }));

const BUILTINS_RESPONSE = {
  builtins: BUILTINS,
  modes: ['add', 'replace', 'upsert'],
  limits: { maxSteps: 20, script: { timeoutMs: 250, memoryMb: 32, maxCodeBytes: 16384, maxResultBytes: 1048576 } },
};

const PREVIEW_OK = {
  ok: true,
  sampleSource: 'recorded',
  result: {
    items: [{ price_usd: 54.67, price_eur: 50.3, price_eur_gross: 59.86, description: 'Black Screw 60mm' }],
  },
  steps: [
    { id: 'convert_to_eur', wrote: 12, skipped: 0, bytes: 2140 },
    { id: 'add_vat', wrote: 12, skipped: 0, bytes: 2380 },
    { id: 'clean_description', wrote: 12, skipped: 0, bytes: 2350 },
  ],
};

const PREVIEW_FAILED = {
  ok: false,
  sampleSource: 'recorded',
  error: 'step convert_to_eur: $.items[3].price_usd is not a number',
  failedStep: 'convert_to_eur',
  failedPath: '$.items[3].price_usd',
  steps: [],
};

type Chain = { steps?: Array<{ reads?: string }> } | undefined;

async function openToolEditor(
  page: Page,
  baseURL: string,
  options: { chain?: unknown; sample?: unknown } = {},
) {
  const toolSaves: Array<Record<string, any>> = [];
  const state = { previewFails: false };
  const tool = {
    id: 't1',
    name: 'mock_supplier_list_offers',
    description: 'Lists the offers of the mock supplier.',
    isEnabled: true,
    parameters: { type: 'object', properties: {} },
    endpointMapping: { method: 'GET', path: '/offers' },
    responseMapping: options.chain ? { responseProcessing: options.chain } : {},
  };
  const connector = {
    id: 'c1',
    name: 'Mock Supplier',
    type: 'REST',
    baseUrl: 'https://supplier.example.com',
    authType: 'NONE',
    authConfig: null,
    isActive: true,
    headers: {},
    maskedHeaders: [],
    envVars: {},
    maskedEnvVars: [],
    config: {},
    tools: [tool],
    createdAt: '2026-09-01T00:00:00Z',
    userId: 'u1',
    organizationId: 'o1',
  };

  await page.context().addCookies([{ name: 'amcp_token', value: 'test-token', url: baseURL }]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, USER);

  await page.route(/\/(api|health)\//, async (route) => {
    const req = route.request();
    const url = req.url();
    const path = new URL(url).pathname;
    const method = req.method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.includes('/health/server-info')) {
      return json({ deploymentMode: 'self-hosted', mcpAuthMode: 'both', serverUrl: 'http://localhost:4000', mcpEndpoint: 'http://localhost:4000/mcp', hasUsers: true, registrationEnabled: true, ssoProviders: [] });
    }

    // Response Processing routes.
    if (path === '/api/response-processing/builtins') return json(BUILTINS_RESPONSE);
    if (path === '/api/response-processing/validate' && method === 'POST') {
      const chain = (req.postDataJSON()?.chain ?? {}) as Chain;
      const bad = (chain?.steps ?? []).find((s) => !s.reads || !String(s.reads).trim());
      return json(bad ? { valid: false, problem: 'step bad: reads is required' } : { valid: true });
    }
    if (path === '/api/response-processing/tools/t1/preview' && method === 'POST') {
      const body = req.postDataJSON() ?? {};
      const broken = state.previewFails || body?.sample?.category === 'broken';
      return json(broken ? PREVIEW_FAILED : PREVIEW_OK);
    }
    if (path === '/api/response-processing/tools/t1' && method === 'GET') {
      return json({
        chain: options.chain ?? null,
        sampleAvailable: true,
        sampleCapturedAt: '2026-10-01T10:00:00Z',
        ...(options.sample !== undefined ? { sample: options.sample, sampleTruncated: false } : {}),
      });
    }
    if (path.startsWith('/api/response-processing/')) return json({});

    // The tool's own save (PUT today; PATCH accepted too).
    if (/^\/api\/connectors\/c1\/tools\/t1$/.test(path) && (method === 'PUT' || method === 'PATCH')) {
      toolSaves.push(req.postDataJSON());
      return json({});
    }
    if (path.includes('/api/connectors/c1/tools/t1/response-mapping')) {
      return json({ transform: null, active: false, sampleAvailable: true, sampleCapturedAt: null });
    }

    if (url.includes('/api/connectors/proxy-availability')) return json({ available: false });
    if (url.includes('/api/connectors/c1/catalog-diff')) return json({ catalogManaged: false });
    if (url.includes('/api/connectors/c1')) return json(connector);
    if (url.includes('/api/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (url.includes('/api/users/me')) return json(USER);
    if (url.includes('/api/organizations/current')) return json({ id: 'o1', name: 'Acme', createdAt: '2026-01-01' });
    if (url.includes('/api/organizations/mine')) return json([{ id: 'o1', name: 'Acme', role: 'ADMIN', joinedAt: '2026-01-01' }]);
    if (url.includes('/api/license/status')) return json({ plan: 'community', status: 'active' });
    if (url.includes('/api/connectors')) return json([connector]);
    return json({});
  });

  await page.goto('/connectors/c1');
  // The tool rows are the last section of the page; Edit opens the tool editor in place.
  await page.getByRole('button', { name: 'Edit', exact: true }).last().click();
  await expect(page.getByTestId('rp-root')).toBeVisible();
  return { toolSaves, state };
}

/** The text of a code field, whether it is a textarea or a rendered editor. */
async function codeOf(field: Locator): Promise<string> {
  return field.evaluate((el) => {
    const input = el as HTMLTextAreaElement;
    return typeof input.value === 'string' && input.value !== '' ? input.value : (el.textContent ?? '');
  });
}

async function addStep(page: Page, item: string) {
  await page.getByTestId('rp-add-step').click();
  await page.getByTestId(item).click();
}

/** Without a recorded response the pickers have nothing to offer: paths are typed in the raw fields. */
async function advancedPaths(page: Page, index: number) {
  await page.getByTestId(`rp-step-${index}-menu`).click();
  await page.getByTestId(`rp-step-${index}-advanced`).click();
}

test.describe('Response Processing panel', () => {
  test('collapsed with no steps it is a single row with a way to add one', async ({ page, baseURL }) => {
    await openToolEditor(page, baseURL!);

    const root = page.getByTestId('rp-root');
    await expect(root).toContainText('Response Processing');
    await expect(root).toContainText('Off');
    await expect(page.getByTestId('rp-add-step')).toBeVisible();
    await expect(page.getByTestId('rp-step-0')).toHaveCount(0);
    await expect(page.locator('[data-testid^="rp-step-"]')).toHaveCount(0);
  });

  test('adding a scale step creates a row and the status chip turns to one valid step', async ({ page, baseURL }) => {
    await openToolEditor(page, baseURL!);

    await addStep(page, 'rp-add-scale@1');
    await expect(page.getByTestId('rp-step-0')).toBeVisible();
    await expect(page.getByTestId('rp-step-0-mode')).toBeVisible();
    await expect(page.getByTestId('rp-step-1')).toHaveCount(0);

    await advancedPaths(page, 0);
    await page.getByTestId('rp-step-0-reads').fill('price_usd');
    await page.getByTestId('rp-step-0-writes').fill('price_eur');

    // Validation runs 400 ms after the change. The state is an icon, carried as data-tone.
    const chip = page.getByTestId('rp-status');
    await expect(chip).toContainText(/1 steps?/);
    await expect(chip).toHaveAttribute('data-tone', 'ok');
  });

  test('clearing a step\'s reads makes the chip show a failure after validation', async ({ page, baseURL }) => {
    await openToolEditor(page, baseURL!);

    await addStep(page, 'rp-add-scale@1');
    await advancedPaths(page, 0);
    await page.getByTestId('rp-step-0-reads').fill('price_usd');
    await page.getByTestId('rp-step-0-writes').fill('price_eur');
    await expect(page.getByTestId('rp-status')).toHaveAttribute('data-tone', 'ok');

    await page.getByTestId('rp-step-0-reads').fill('');
    await expect(page.getByTestId('rp-status')).toHaveAttribute('data-tone', 'error');
    await expect(page.getByTestId('rp-step-0')).toHaveAttribute('data-invalid', 'true');
  });

  test('the one Script item adds a script step that is valid as added', async ({ page, baseURL }) => {
    await openToolEditor(page, baseURL!);

    await page.getByTestId('rp-add-step').click();
    await expect(page.locator('[data-testid^="rp-add-script"]')).toHaveCount(1);
    await page.getByTestId('rp-add-script@1').click();
    await expect(page.getByTestId('rp-step-0')).toBeVisible();

    const code = page.getByTestId('rp-code-0');
    await expect(code).toBeVisible();
    expect(await codeOf(code)).toContain('return value;');
    await expect(page.getByTestId('rp-step-0-reads')).toHaveAttribute('data-value', '$');
    await expect(page.getByTestId('rp-step-0-writes')).toHaveAttribute('data-value', '$');
    await expect(page.getByTestId('rp-step-0-mode')).toContainText('upsert');
    await expect(page.getByTestId('rp-step-problems')).toHaveCount(0);
    await expect(page.getByTestId('rp-step-0')).not.toHaveAttribute('data-invalid', 'true');
  });

  test('preview shows a row per step, and the first refusal when the sample is broken', async ({ page, baseURL }) => {
    const { state } = await openToolEditor(page, baseURL!, { chain: P1_CHAIN });

    await page.getByTestId('rp-preview').click();
    await expect(page.getByTestId('rp-preview-step-convert_to_eur')).toBeVisible();
    await expect(page.getByTestId('rp-preview-step-add_vat')).toBeVisible();
    await expect(page.getByTestId('rp-preview-step-clean_description')).toBeVisible();
    await expect(page.getByTestId('rp-preview-error')).toHaveCount(0);

    state.previewFails = true;
    await page.getByTestId('rp-preview').click();
    const error = page.getByTestId('rp-preview-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('price_usd');
    await expect(error).toContainText('convert_to_eur');
  });

  test('deleting a step offers an undo that brings the row back', async ({ page, baseURL }) => {
    await openToolEditor(page, baseURL!, { chain: P1_CHAIN });

    await expect(page.getByTestId('rp-step-2')).toBeVisible();
    await page.getByTestId('rp-step-1-menu').click();
    await page
      .getByRole('menuitem', { name: /delete/i })
      .or(page.getByTestId('rp-root').getByRole('button', { name: /^delete$/i }))
      .first()
      .click();

    await expect(page.getByTestId('rp-step-2')).toHaveCount(0);
    const undo = page.getByTestId('rp-undo');
    await expect(undo).toBeVisible();

    await undo.click();
    await expect(page.getByTestId('rp-step-2')).toBeVisible();
    await expect(page.getByTestId('rp-undo')).toHaveCount(0);
  });

  test('saving the tool sends the chain inside responseMapping', async ({ page, baseURL }) => {
    const { toolSaves } = await openToolEditor(page, baseURL!);

    await addStep(page, 'rp-add-scale@1');
    await page.getByTestId('rp-step-0-id').fill('convert_to_eur');
    await advancedPaths(page, 0);
    await page.getByTestId('rp-step-0-each').fill('$.items[*]');
    await page.getByTestId('rp-step-0-reads').fill('price_usd');
    await page.getByTestId('rp-step-0-writes').fill('price_eur');
    await expect(page.getByTestId('rp-status')).toHaveAttribute('data-tone', 'ok');

    await page.getByRole('button', { name: 'Update Tool' }).click();
    await expect.poll(() => toolSaves.length).toBe(1);

    const chain = toolSaves[0].responseMapping.responseProcessing;
    expect(chain.version).toBe(1);
    expect(chain.steps).toHaveLength(1);
    expect(chain.steps[0]).toMatchObject({
      id: 'convert_to_eur',
      use: 'scale@1',
      each: '$.items[*]',
      reads: 'price_usd',
      writes: 'price_eur',
    });
    expect(['add', 'replace', 'upsert']).toContain(chain.steps[0].mode);
    expect(['fail', 'passthrough']).toContain(chain.onError);
  });

  test('with a recorded response the path fields pick from a tree', async ({ page, baseURL }) => {
    await openToolEditor(page, baseURL!, { sample: SAMPLE });
    await addStep(page, 'rp-add-scale@1');

    // each: rooted at the response; `any` first, only lists selectable (written as [*]).
    const each = page.getByTestId('rp-step-0-each');
    await expect(each).toContainText('any');
    await each.click();
    const picker = page.getByTestId('rp-path-picker');
    await expect(picker).toBeVisible();
    await expect(picker.getByTestId('rp-path-mode')).toContainText('each');
    await expect(picker.getByTestId('rp-path-any')).toBeVisible();
    await expect(picker.getByTestId('rp-path-node-$.items[*]')).toContainText('2 items');
    await picker.getByTestId('rp-path-node-$.items[*]').click();
    await expect(picker).toHaveCount(0);
    await expect(each).toHaveAttribute('data-value', '$.items[*]');

    // reads: relative to the first element; keyboard ↓ ↓ ↓ → → Enter reaches pricing.net.
    const reads = page.getByTestId('rp-step-0-reads');
    await reads.click();
    await expect(page.getByTestId('rp-path-mode')).toContainText('items[*]');
    await expect(page.getByTestId('rp-path-node-price_usd')).toBeVisible();
    await expect(page.getByTestId('rp-path-tree')).toBeFocused();
    for (const key of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowRight']) await page.keyboard.press(key);
    await expect(page.getByTestId('rp-path-node-pricing.net')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(reads).toHaveAttribute('data-value', 'pricing.net');

    // writes: existing keys are flagged; a new key goes through the `new key…` row.
    const writes = page.getByTestId('rp-step-0-writes');
    await writes.click();
    await expect(page.getByTestId('rp-path-node-price_usd')).toContainText('exists');
    await page.getByTestId('rp-path-newkey').click();
    await page.getByTestId('rp-path-newkey-input').fill('price eur!');
    await expect(page.getByTestId('rp-path-newkey-input')).toHaveValue('priceeur');
    await page.getByTestId('rp-path-newkey-input').fill('price_eur');
    await page.keyboard.press('Enter');
    await expect(writes).toHaveAttribute('data-value', 'price_eur');

    // `add` onto a key that exists is flagged at once.
    await writes.click();
    await page.getByTestId('rp-path-node-description').click();
    await expect(writes).toHaveAttribute('data-tone', 'danger');
    await expect(page.getByTestId('rp-step-problems')).toContainText('exists');
    await writes.click();
    await page.getByTestId('rp-path-newkey').click();
    await page.getByTestId('rp-path-newkey-input').fill('price_eur');
    await page.keyboard.press('Enter');
    await expect(writes).not.toHaveAttribute('data-tone', 'danger');

    // Esc closes without changing the value.
    await writes.click();
    await expect(page.getByTestId('rp-path-picker')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('rp-path-picker')).toHaveCount(0);
    await expect(writes).toHaveAttribute('data-value', 'price_eur');
  });
});
