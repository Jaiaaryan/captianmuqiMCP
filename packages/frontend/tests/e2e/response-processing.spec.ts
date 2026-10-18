import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Response Processing: the per-tool chain that edits a response before Response Mapping.
 * The API is mocked, as in the other smoke tests. The panel is reached the way an operator
 * reaches it: Connectors -> connector -> Edit on a tool, then the summary's Open (or ⌘.),
 * which slides in the sheet that hosts the editor. Everything is targeted through
 * data-testid values; the panel carries no explanatory text.
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
  ['currency@1', 'Currency', [
    { name: 'rate', type: 'number', exclusiveMin: 0 },
    { name: 'from', type: 'string', pattern: '^[A-Z]{3}$', default: 'USD' },
    { name: 'to', type: 'string', pattern: '^[A-Z]{3}$', default: 'EUR' },
  ]],
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
  options: { chain?: unknown; sample?: unknown; sampleAfterRun?: unknown; open?: boolean } = {},
) {
  const toolSaves: Array<Record<string, any>> = [];
  const runs: Array<Record<string, any>> = [];
  const state: { previewFails: boolean; sample: unknown } = { previewFails: false, sample: options.sample };
  const tool = {
    id: 't1',
    name: 'mock_supplier_list_offers',
    description: 'Lists the offers of the mock supplier.',
    isEnabled: true,
    parameters: { type: 'object', properties: { category: { type: 'string', description: 'Category' } } },
    endpointMapping: { method: 'GET', path: '/offers' },
    responseMapping: (options.chain ? { responseProcessing: options.chain } : {}) as Record<string, unknown>,
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
      return json(
        state.sample !== undefined
          ? {
              chain: options.chain ?? null,
              sampleAvailable: true,
              sampleCapturedAt: new Date(Date.now() - 120_000).toISOString(),
              sample: state.sample,
              sampleTruncated: true,
              sampleLengths: { '$.items': 30 },
              sampleInput: { category: 'fasteners' },
            }
          : { chain: options.chain ?? null, sampleAvailable: false },
      );
    }
    if (path.startsWith('/api/response-processing/')) return json({});

    // Run from the tree: the editor's test route, asked to record the response.
    if (path === '/api/connectors/c1/tools/t1/test' && method === 'POST') {
      const body = req.postDataJSON() ?? {};
      runs.push(body);
      if (body.recordSample && options.sampleAfterRun !== undefined) state.sample = options.sampleAfterRun;
      return json({ ok: true, durationMs: 12, result: options.sampleAfterRun ?? {}, sampleRecorded: !!body.recordSample });
    }

    // The tool's own save (PUT today; PATCH accepted too).
    if (/^\/api\/connectors\/c1\/tools\/t1$/.test(path) && (method === 'PUT' || method === 'PATCH')) {
      const body = req.postDataJSON();
      toolSaves.push(body);
      // The next GET of the connector returns what was saved.
      if (body?.responseMapping) tool.responseMapping = body.responseMapping;
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
  await editTool(page);
  if (options.open !== false) await openSheet(page);
  return { toolSaves, state, runs };
}

/** The tool rows are the last section of the page; Edit opens the tool editor in place. */
async function editTool(page: Page) {
  await page.getByRole('button', { name: 'Edit', exact: true }).last().click();
  await expect(page.getByTestId('rp-summary')).toBeVisible();
}

/** Open (with steps) or ⌘. (an empty chain has no Open button) slides the sheet in. */
async function openSheet(page: Page) {
  const open = page.getByTestId('rp-open');
  if (await open.isVisible()) await open.click();
  else await page.keyboard.press('ControlOrMeta+.');
  await expect(page.getByTestId('rp-sheet')).toHaveAttribute('data-state', 'open');
  await expect(page.getByTestId('rp-root')).toBeVisible();
}

async function closeSheet(page: Page) {
  await page.getByTestId('rp-sheet-close').click();
  await expect(page.getByTestId('rp-sheet')).toHaveAttribute('data-state', 'closed');
  await expect(page.getByTestId('rp-root')).toBeHidden();
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

test.describe('Response Processing panel', () => {
  test('with no steps it is a header with a way to add one, and the response tree', async ({ page, baseURL }) => {
    await openToolEditor(page, baseURL!);

    await expect(page.getByTestId('rp-sheet-breadcrumb')).toContainText('Response Processing');
    await expect(page.getByTestId('rp-toggle')).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('rp-toggle')).toContainText('Off');
    await expect(page.getByTestId('rp-add-step')).toBeVisible();
    await expect(page.getByTestId('rp-add-step-top')).toHaveCount(0);
    await expect(page.locator('[data-testid^="rp-step-"]')).toHaveCount(0);
    await expect(page.getByTestId('rp-tree-empty')).toHaveText('no sample');
    await expect(page.getByTestId('rp-tree-run')).toBeVisible();
    await expect(page.getByTestId('rp-tree-paste')).toContainText('Paste JSON');
  });

  test('a new built-in step is invalid until it has an Input, then valid with writes = input', async ({ page, baseURL }) => {
    await openToolEditor(page, baseURL!);

    await addStep(page, 'rp-add-scale@1');
    await expect(page.getByTestId('rp-toggle')).toHaveAttribute('aria-checked', 'true');
    const step = page.getByTestId('rp-step-0');
    await expect(step).toHaveAttribute('data-invalid', 'true');
    const input = page.getByTestId('rp-step-0-input');
    await expect(input).toHaveAttribute('placeholder', 'pick a field');
    await expect(input).toHaveAttribute('data-tone', 'danger');
    await expect(page.getByTestId('rp-status')).toHaveAttribute('data-tone', 'error');
    await expect(page.getByTestId('rp-step-1')).toHaveCount(0);

    await input.fill('price_usd');
    await expect(input).toHaveAttribute('data-value', 'price_usd');
    await expect(page.getByTestId('rp-step-0-writes')).toHaveAttribute('data-value', '$.price_usd');
    await expect(page.getByTestId('rp-step-0-writes-note')).toHaveText('= input');
    await expect(page.getByTestId('rp-step-0-mode')).toContainText('replace');
    await expect(step).not.toHaveAttribute('data-invalid', 'true');

    // Validation runs 400 ms after the change.
    const status = page.getByTestId('rp-status');
    await expect(status).toHaveText('1 step');
    await expect(status).toHaveAttribute('data-tone', 'ok');

    await input.fill('');
    await expect(status).toHaveAttribute('data-tone', 'error');
    await expect(status).toContainText('scale');
    await expect(step).toHaveAttribute('data-invalid', 'true');
  });

  test('the one Script item adds a script step that is valid as added', async ({ page, baseURL }) => {
    await openToolEditor(page, baseURL!);

    await page.getByTestId('rp-add-step').click();
    await expect(page.locator('[data-testid^="rp-add-script"]')).toHaveCount(1);
    await page.getByTestId('rp-add-script@1').click();
    await expect(page.getByTestId('rp-step-0')).toBeVisible();

    const code = page.getByTestId('rp-code-0');
    expect(await codeOf(code)).toContain('return value;');
    await expect(page.getByTestId('rp-step-0-input')).toHaveAttribute('data-value', '$');
    await expect(page.getByTestId('rp-step-0-writes')).toHaveAttribute('data-value', '$');
    await expect(page.getByTestId('rp-step-0-mode')).toContainText('replace');
    await expect(page.getByTestId('rp-step-0')).not.toHaveAttribute('data-invalid', 'true');
  });

  test('preview renders into the tree: a row per step, new keys green, changed values old → new', async ({ page, baseURL }) => {
    const { state } = await openToolEditor(page, baseURL!, { chain: P1_CHAIN, sample: SAMPLE });

    await page.getByTestId('rp-preview').click();
    const tree = page.getByTestId('rp-tree');
    await expect(tree.getByTestId('rp-preview-step-convert_to_eur')).toBeVisible();
    await expect(tree.getByTestId('rp-preview-step-add_vat')).toBeVisible();
    await expect(tree.getByTestId('rp-preview-step-clean_description')).toBeVisible();
    await expect(page.getByTestId('rp-preview-error')).toHaveCount(0);

    const eur = page.getByTestId('rp-path-node-$.items[*].price_eur');
    await expect(eur).toHaveAttribute('data-added', 'true');
    await expect(eur).toHaveAttribute('data-step', '1');
    await expect(eur).toContainText('50.3 · 01');
    const description = page.getByTestId('rp-path-node-$.items[*].description');
    await expect(description).toHaveAttribute('data-changed', 'true');
    await expect(description).toContainText('→');
    await expect(description).toContainText('"Black Screw 60mm"');

    // ⌘↵ previews too; a refusal is one red row that focuses its step.
    state.previewFails = true;
    await page.getByTestId('rp-step-1-id').focus();
    await page.keyboard.press('ControlOrMeta+Enter');
    const error = page.getByTestId('rp-preview-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('price_usd');
    await expect(error).toContainText('convert_to_eur');
    await error.click();
    await expect(page.getByTestId('rp-step-0-id')).toBeFocused();
  });

  test('deleting a step offers an undo that brings the card back', async ({ page, baseURL }) => {
    await openToolEditor(page, baseURL!, { chain: P1_CHAIN });

    await expect(page.getByTestId('rp-step-2')).toBeVisible();
    await page.getByTestId('rp-step-1-menu').click();
    await page.getByTestId('rp-step-1-menu-delete').click();

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
    await page.getByTestId('rp-step-0-input').fill('items[*].price_usd');
    await expect(page.getByTestId('rp-step-0-input')).toHaveAttribute('data-value', 'items[*].price_usd');
    await page.getByTestId('rp-step-0-writes').fill('price_eur');
    await page.getByTestId('rp-step-0-param-factor').fill('0.92');
    await expect(page.getByTestId('rp-status')).toHaveAttribute('data-tone', 'ok');

    // The sheet writes to the editor; the tool's own button saves.
    await closeSheet(page);
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
      params: { factor: 0.92 },
    });
    expect(['add', 'replace', 'upsert']).toContain(chain.steps[0].mode);
    expect(['fail', 'passthrough']).toContain(chain.onError);
  });

  test('pick mode: a path field is filled from the response tree', async ({ page, baseURL }) => {
    await openToolEditor(page, baseURL!, { sample: SAMPLE });
    await addStep(page, 'rp-add-scale@1');

    // Input: every row can be picked; an array gives its elements, with what one run receives.
    const input = page.getByTestId('rp-step-0-input');
    await input.click();
    await expect(input).toHaveAttribute('data-picking', 'true');
    await expect(page.getByTestId('rp-step-0')).toContainText('pick in response →');
    await expect(page.getByTestId('rp-path-node-$.total')).toHaveAttribute('data-pickable', 'true');
    await expect(page.getByTestId('rp-path-node-$.items[*]')).toContainText('30 items');
    await page.getByTestId('rp-path-node-$.items[*]').click();
    await expect(input).toHaveAttribute('data-value', 'items[*]');
    await expect(input).not.toHaveAttribute('data-picking', 'true');
    await expect(page.getByTestId('rp-step-0-input-type')).toHaveText('object[30]');

    // A value inside the elements: its full path; writes follows it.
    await input.click();
    await expect(page.getByTestId('rp-path-node-$.items[*].pricing.net')).toHaveAttribute('data-pickable', 'true');
    await page.getByTestId('rp-path-node-$.items[*].pricing.net').click();
    await expect(input).toHaveAttribute('data-value', 'items[*].pricing.net');
    await expect(page.getByTestId('rp-step-0-input-type')).toHaveText('number[30]');
    await expect(page.getByTestId('rp-step-0-writes')).toHaveAttribute('data-value', 'pricing.net');
    await expect(page.getByTestId('rp-step-0-writes-note')).toHaveText('= input');

    // The header is the whole response.
    await input.click();
    await page.getByTestId('rp-tree-root').click();
    await expect(input).toHaveAttribute('data-value', '$');
    await expect(page.getByTestId('rp-step-0-input-type')).toHaveText('object{2}');

    // Typing completes from the tree: `.` descends, Enter takes the option.
    await input.fill('items[*].pri');
    const picker = page.getByTestId('rp-path-picker');
    await expect(picker.getByTestId('rp-path-option-items[*].price_usd')).toBeVisible();
    await expect(picker.getByTestId('rp-path-option-items[*].pricing.')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(input).toHaveAttribute('data-value', 'items[*].price_usd');
    await page.keyboard.press('Escape');
    await expect(input).not.toHaveAttribute('data-picking', 'true');

    // writes: only the fields of the element; the element row is highlighted.
    const writes = page.getByTestId('rp-step-0-writes');
    await writes.click();
    await expect(page.getByTestId('rp-path-node-$.items[*]')).toHaveAttribute('data-scope', 'true');
    await expect(page.getByTestId('rp-path-node-$.total')).not.toHaveAttribute('data-pickable', 'true');
    await expect(page.getByTestId('rp-path-node-$.items[*].description')).toHaveAttribute('data-pickable', 'true');
    await page.keyboard.press('Escape');

    // A field the sample lacks is a new field, and the mode becomes add.
    await writes.fill('price_eur');
    // While picking, the note is the pick hint; once out of pick mode it names the field.
    await expect(page.getByTestId('rp-step-0')).toContainText('pick in response →');
    await page.keyboard.press('Escape');
    await expect(writes).not.toHaveAttribute('data-picking', 'true');
    await expect(page.getByTestId('rp-step-0-writes-note')).toHaveText('new field');
    await expect(page.getByTestId('rp-step-0-mode')).toContainText('add');
    await expect(page.getByTestId('rp-path-node-$.items[*].price_eur')).toHaveAttribute('data-step', '1');

    // Esc leaves pick mode without changing the value.
    await writes.click();
    await expect(writes).toHaveAttribute('data-picking', 'true');
    await page.keyboard.press('Escape');
    await expect(writes).not.toHaveAttribute('data-picking', 'true');
    await expect(writes).toHaveAttribute('data-value', 'price_eur');
  });

  test('"+" on a tree row adds a step on that field', async ({ page, baseURL }) => {
    await openToolEditor(page, baseURL!, { sample: SAMPLE });

    const row = page.getByTestId('rp-path-node-$.items[*].price_usd');
    await row.hover();
    await page.getByTestId('rp-tree-add-$.items[*].price_usd').click();
    await expect(page.getByTestId('rp-step-0-input')).toHaveAttribute('data-value', 'items[*].price_usd');
    await expect(page.getByTestId('rp-step-0-writes')).toHaveAttribute('data-value', 'price_usd');
    await expect(page.getByTestId('rp-step-0-use')).toContainText('Scale');
    await expect(page.getByTestId('rp-step-0-mode')).toContainText('replace');

    // The next built-in starts with an empty Input.
    await addStep(page, 'rp-add-vat@1');
    await expect(page.getByTestId('rp-step-1-input')).toHaveAttribute('placeholder', 'pick a field');
    await expect(page.getByTestId('rp-step-1-input')).toHaveAttribute('data-value', '');
  });

  test('steps collapse to one line, Alt toggles all, and the state survives a reload', async ({ page, baseURL }) => {
    await openToolEditor(page, baseURL!, { chain: P1_CHAIN });

    await page.getByTestId('rp-step-0-toggle').click();
    const first = page.getByTestId('rp-step-0');
    await expect(first).toHaveAttribute('data-collapsed', 'true');
    await expect(page.getByTestId('rp-step-0-input')).toHaveCount(0);
    await expect(page.getByTestId('rp-step-0-summary')).toHaveText('items[*].price_usd → price_eur');
    await expect(page.getByTestId('rp-step-0-id')).toHaveValue('convert_to_eur');

    // Alt-click: one expanded step left -> all collapse; again -> all expand.
    await page.getByTestId('rp-step-1-toggle').click({ modifiers: ['Alt'] });
    for (const i of [0, 1, 2]) await expect(page.getByTestId(`rp-step-${i}`)).toHaveAttribute('data-collapsed', 'true');
    await page.getByTestId('rp-step-1-toggle').click({ modifiers: ['Alt'] });
    for (const i of [0, 1, 2]) await expect(page.getByTestId(`rp-step-${i}`)).not.toHaveAttribute('data-collapsed', 'true');

    await page.getByTestId('rp-step-2-toggle').click();
    await page.reload();
    // #processing survived the reload: the sheet opens as soon as the editor does.
    await editTool(page);
    await expect(page.getByTestId('rp-sheet')).toHaveAttribute('data-state', 'open');
    await expect(page.getByTestId('rp-step-2')).toHaveAttribute('data-collapsed', 'true');
    await expect(page.getByTestId('rp-step-0')).not.toHaveAttribute('data-collapsed', 'true');

    // A new step is added expanded.
    await addStep(page, 'rp-add-round@1');
    await expect(page.getByTestId('rp-step-3')).not.toHaveAttribute('data-collapsed', 'true');
  });

  test('a pipe of built-ins is stored as use[] with params aligned by index', async ({ page, baseURL }) => {
    const { toolSaves } = await openToolEditor(page, baseURL!, { sample: SAMPLE });

    await addStep(page, 'rp-add-scale@1');
    await page.getByTestId('rp-step-0-input').fill('items[*].price_usd');
    await page.getByTestId('rp-step-0-param-factor').fill('0.92');
    await page.getByTestId('rp-pipe-0-add').click();
    await page.getByTestId('rp-pipe-0-add-round@1').click();

    await expect(page.getByTestId('rp-pipe-0-0')).toContainText('scale');
    await expect(page.getByTestId('rp-pipe-0-0')).toContainText('0.92');
    await expect(page.getByTestId('rp-pipe-0-1')).toContainText('round');
    await expect(page.getByTestId('rp-pipe-0-1')).toContainText('2');

    // A stage's params open from its chip.
    await page.getByTestId('rp-pipe-0-1').click();
    await page.getByTestId('rp-pipe-0-1-param-decimals').fill('1');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('rp-pipe-0-1')).toContainText('1');
    await expect(page.getByTestId('rp-status')).toHaveAttribute('data-tone', 'ok');

    await closeSheet(page);
    await page.getByRole('button', { name: 'Update Tool' }).click();
    await expect.poll(() => toolSaves.length).toBe(1);
    const step = toolSaves[0].responseMapping.responseProcessing.steps[0];
    expect(step.use).toEqual(['scale@1', 'round@1']);
    expect(step.params).toEqual([{ factor: 0.92 }, { decimals: 1 }]);
    expect(step.writes).toBe('price_usd');
  });

  test('Run records a sample through the test route; Paste uses JSON without storing it', async ({ page, baseURL }) => {
    const { runs } = await openToolEditor(page, baseURL!, { sampleAfterRun: SAMPLE });

    await expect(page.getByTestId('rp-tree-empty')).toBeVisible();
    await page.getByTestId('rp-tree-run').click();
    const param = page.getByTestId('rp-tree-run-param-category');
    await expect(param).toBeVisible();
    await param.fill('fasteners');
    await page.getByTestId('rp-tree-run-submit').click();

    await expect(page.getByTestId('rp-path-node-$.items[*]')).toBeVisible();
    await expect(page.getByTestId('rp-tree-source')).toContainText('2m');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ recordSample: true, arguments: { category: 'fasteners' } });

    await page.getByTestId('rp-tree-paste').click();
    await page.getByTestId('rp-tree-paste-input').fill('{"rows":[{"n":1}]}');
    await page.getByTestId('rp-tree-paste-submit').click();
    await expect(page.getByTestId('rp-tree-source')).toHaveText('pasted');
    await expect(page.getByTestId('rp-path-node-$.rows[*].n')).toBeVisible();
    expect(runs).toHaveLength(1);
  });

  test('nothing in the panel reads the clipboard', async ({ page, baseURL }) => {
    await page.addInitScript(() => {
      (window as unknown as { __clipboardReads: number }).__clipboardReads = 0;
      const clip = navigator.clipboard as Clipboard | undefined;
      if (!clip) return;
      for (const name of ['read', 'readText'] as const) {
        const original = clip[name]?.bind(clip);
        Object.defineProperty(clip, name, {
          configurable: true,
          value: (...args: unknown[]) => {
            (window as unknown as { __clipboardReads: number }).__clipboardReads += 1;
            return (original as (...a: unknown[]) => Promise<unknown>)(...args);
          },
        });
      }
    });
    await openToolEditor(page, baseURL!, { chain: P1_CHAIN, sample: SAMPLE });
    await addStep(page, 'rp-add-script@1');
    const editor = page.getByTestId('rp-code-3-editor');
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.press('ControlOrMeta+V');
    await page.getByTestId('rp-tree-paste').click();
    await page.getByTestId('rp-tree-paste-input').focus();
    await page.keyboard.press('ControlOrMeta+V');
    expect(await page.evaluate(() => (window as unknown as { __clipboardReads: number }).__clipboardReads)).toBe(0);
  });
});

test.describe('Response Processing summary and sheet', () => {
  test('the page shows a summary; Open slides in the sheet, Esc closes it, #processing follows', async ({ page, baseURL }) => {
    await openToolEditor(page, baseURL!, { chain: P1_CHAIN, open: false });

    const summary = page.getByTestId('rp-summary');
    await expect(summary).toContainText('Response Processing');
    await expect(page.getByTestId('rp-summary-toggle')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('rp-summary-status')).toHaveText('3 steps');
    await expect(page.getByTestId('rp-summary-on-error')).toContainText('Fail');
    for (const i of [0, 1, 2]) await expect(page.getByTestId(`rp-summary-step-${i}`)).toBeVisible();
    await expect(page.getByTestId('rp-summary-step-0')).toContainText('convert_to_eur');
    await expect(page.getByTestId('rp-summary-step-0-paths')).toHaveText('items[*].price_usd → price_eur');
    await expect(page.getByTestId('rp-summary-step-2-paths')).toHaveText('items[*].description');
    await expect(page.getByTestId('rp-summary-step-0')).toContainText('Scale');
    await expect(page.getByTestId('rp-summary-step-2')).toContainText('replace');
    // No editor and no tree on the page.
    await expect(page.getByTestId('rp-root')).toBeHidden();
    await expect(page.getByTestId('rp-tree')).toBeHidden();
    expect(new URL(page.url()).hash).toBe('');

    await page.getByTestId('rp-open').click();
    const sheet = page.getByTestId('rp-sheet');
    await expect(sheet).toHaveAttribute('data-state', 'open');
    await expect(page.getByTestId('rp-sheet-breadcrumb')).toHaveText(/Mock Supplier.*mock_supplier_list_offers.*Response Processing/);
    await expect(page.getByTestId('rp-step-0')).toBeVisible();
    await expect(page.getByTestId('rp-tree')).toBeVisible();
    await expect(page.getByTestId('rp-sheet-unsaved')).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).hash).toBe('#processing');

    await page.keyboard.press('Escape');
    await expect(sheet).toHaveAttribute('data-state', 'closed');
    await expect(page.getByTestId('rp-root')).toBeHidden();
    await expect.poll(() => new URL(page.url()).hash).toBe('');
    await expect(page.getByTestId('rp-open')).toBeFocused();

    // The scrim closes it too.
    await page.getByTestId('rp-open').click();
    await expect(sheet).toHaveAttribute('data-state', 'open');
    await page.getByTestId('rp-sheet-scrim').click({ position: { x: 10, y: 400 } });
    await expect(sheet).toHaveAttribute('data-state', 'closed');
  });

  test('⌘. toggles the sheet from anywhere on the page', async ({ page, baseURL }) => {
    await openToolEditor(page, baseURL!, { chain: P1_CHAIN, open: false });
    const sheet = page.getByTestId('rp-sheet');

    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('ControlOrMeta+.');
    await expect(sheet).toHaveAttribute('data-state', 'open');
    await page.getByTestId('rp-step-1-input').focus();
    await page.keyboard.press('ControlOrMeta+.');
    await expect(sheet).toHaveAttribute('data-state', 'closed');
  });

  test('a summary row opens the sheet on that step, expanded and focused', async ({ page, baseURL }) => {
    await openToolEditor(page, baseURL!, { chain: P1_CHAIN });
    await page.getByTestId('rp-step-2-toggle').click();
    await expect(page.getByTestId('rp-step-2')).toHaveAttribute('data-collapsed', 'true');
    await closeSheet(page);

    await page.getByTestId('rp-summary-step-2').click();
    await expect(page.getByTestId('rp-sheet')).toHaveAttribute('data-state', 'open');
    await expect(page.getByTestId('rp-step-2')).not.toHaveAttribute('data-collapsed', 'true');
    await expect(page.getByTestId('rp-step-2-id')).toBeFocused();
    await expect(page.getByTestId('rp-step-2')).toBeInViewport();
  });

  test('an invalid step is outlined in the summary with the field that fails', async ({ page, baseURL }) => {
    const chain = {
      ...P1_CHAIN,
      steps: [...P1_CHAIN.steps, { id: 'scale', use: 'scale@1', each: '$.items[*]', reads: '', writes: '', mode: 'upsert', params: { factor: 2 } }],
    };
    await openToolEditor(page, baseURL!, { chain, open: false });

    const row = page.getByTestId('rp-summary-step-3');
    await expect(row).toHaveAttribute('data-invalid', 'true');
    await expect(page.getByTestId('rp-summary-step-3-issue')).toHaveText('input');
    await expect(page.getByTestId('rp-summary-step-3-paths')).toHaveText('?');
    await expect(page.getByTestId('rp-summary-step-0')).not.toHaveAttribute('data-invalid', 'true');
    await expect(page.getByTestId('rp-summary-status')).toHaveAttribute('data-tone', 'error');
    await expect(page.getByTestId('rp-summary-status')).toContainText('scale');
  });

  test('"+ Step" on the page adds a step and opens the sheet on it', async ({ page, baseURL }) => {
    await openToolEditor(page, baseURL!, { open: false });
    await expect(page.locator('[data-testid^="rp-summary-step-"]')).toHaveCount(0);
    await expect(page.getByTestId('rp-open')).toHaveCount(0);

    await page.getByTestId('rp-summary-add-step').click();
    await page.getByTestId('rp-summary-add-vat@1').click();
    await expect(page.getByTestId('rp-sheet')).toHaveAttribute('data-state', 'open');
    await expect(page.getByTestId('rp-step-0-input')).toBeFocused();
    await expect(page.getByTestId('rp-toggle')).toHaveAttribute('aria-checked', 'true');
  });

  test('the unsaved chip shows after an edit and is gone once the tool is saved', async ({ page, baseURL }) => {
    const { toolSaves } = await openToolEditor(page, baseURL!, { chain: P1_CHAIN });
    await expect(page.getByTestId('rp-sheet-unsaved')).toHaveCount(0);

    await page.getByTestId('rp-step-1-param-rate').fill('0.2');
    await expect(page.getByTestId('rp-sheet-unsaved')).toHaveText('unsaved');
    // Back to the saved value: nothing to save.
    await page.getByTestId('rp-step-1-param-rate').fill('0.19');
    await expect(page.getByTestId('rp-sheet-unsaved')).toHaveCount(0);
    await page.getByTestId('rp-step-1-param-rate').fill('0.2');
    await expect(page.getByTestId('rp-sheet-unsaved')).toBeVisible();

    // Closing keeps the edit; the tool's own button saves it.
    await closeSheet(page);
    await page.getByTestId('rp-open').click();
    await expect(page.getByTestId('rp-step-1-param-rate')).toHaveValue('0.2');
    await closeSheet(page);
    await page.getByRole('button', { name: 'Update Tool' }).click();
    await expect.poll(() => toolSaves.length).toBe(1);
    expect(toolSaves[0].responseMapping.responseProcessing.steps[1].params.rate).toBe(0.2);

    await editTool(page);
    await openSheet(page);
    await expect(page.getByTestId('rp-step-1-param-rate')).toHaveValue('0.2');
    await expect(page.getByTestId('rp-sheet-unsaved')).toHaveCount(0);
  });

  test('Preview on the page opens the sheet with the preview in the tree', async ({ page, baseURL }) => {
    await openToolEditor(page, baseURL!, { chain: P1_CHAIN, sample: SAMPLE, open: false });
    await page.getByTestId('rp-summary-preview').click();
    await expect(page.getByTestId('rp-sheet')).toHaveAttribute('data-state', 'open');
    await expect(page.getByTestId('rp-tree').getByTestId('rp-preview-step-add_vat')).toBeVisible();
    // Esc closes the preview first, then the sheet.
    await page.getByTestId('rp-step-0-id').focus();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('rp-preview-result')).toHaveCount(0);
    await expect(page.getByTestId('rp-sheet')).toHaveAttribute('data-state', 'open');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('rp-sheet')).toHaveAttribute('data-state', 'closed');
  });
});

test.describe('Currency built-in and the ⌘S save key', () => {
  /** Every ⌘S / Ctrl+S keydown, seen first (window capture, registered before the app). */
  async function recordSaveKeys(page: Page) {
    await page.addInitScript(() => {
      const seen: KeyboardEvent[] = [];
      (window as unknown as { __saveKeys: KeyboardEvent[] }).__saveKeys = seen;
      window.addEventListener(
        'keydown',
        (e) => {
          if (e.key.toLowerCase() === 's' && (e.metaKey || e.ctrlKey)) seen.push(e);
        },
        true,
      );
    });
  }
  const prevented = (page: Page) =>
    page.evaluate(() => (window as unknown as { __saveKeys: KeyboardEvent[] }).__saveKeys.map((e) => e.defaultPrevented));

  test('Currency is the first built-in in the add menu, with from, to and rate', async ({ page, baseURL }) => {
    const { toolSaves } = await openToolEditor(page, baseURL!);

    await page.getByTestId('rp-add-step').click();
    const builtins = page.locator('[data-testid^="rp-add-"][data-testid$="@1"]');
    await expect(builtins.first()).toHaveAttribute('data-testid', 'rp-add-currency@1');
    await expect(builtins.first()).toHaveText('Currency');
    await expect(builtins.nth(1)).toHaveAttribute('data-testid', 'rp-add-scale@1');
    await builtins.first().click();

    await expect(page.getByTestId('rp-step-0-use')).toContainText('Currency');
    await expect(page.getByTestId('rp-step-0-param-from')).toContainText('USD');
    await expect(page.getByTestId('rp-step-0-param-to')).toContainText('EUR');
    const params = page.getByTestId('rp-step-0-param-rate');

    await page.getByTestId('rp-step-0-input').fill('price_usd');
    await params.fill('0.92');
    await expect(page.getByTestId('rp-status')).toHaveAttribute('data-tone', 'ok');
    await page.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => toolSaves.length).toBe(1);
    const step = toolSaves[0].responseMapping.responseProcessing.steps[0];
    expect(step.use).toBe('currency@1');
    expect(step.params).toEqual({ from: 'USD', to: 'EUR', rate: 0.92 });
  });

  test('⌘S saves once from the sheet and from the page, and the browser never sees it', async ({ page, baseURL }) => {
    await recordSaveKeys(page);
    const { toolSaves } = await openToolEditor(page, baseURL!, { chain: P1_CHAIN, sample: SAMPLE });

    // Sheet open: the header shows the key, one press is one save.
    await expect(page.getByTestId('rp-sheet-save-hint')).toHaveText(/Save\s*⌘S/);
    await page.getByTestId('rp-step-0-id').focus();
    await page.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => toolSaves.length).toBe(1);
    await page.waitForTimeout(400);
    expect(toolSaves).toHaveLength(1);

    // Page only (sheet closed), with Ctrl.
    await editTool(page);
    await expect(page.getByTestId('rp-sheet')).toHaveAttribute('data-state', 'closed');
    await page.keyboard.press('Control+s');
    await expect.poll(() => toolSaves.length).toBe(2);
    await page.waitForTimeout(400);
    expect(toolSaves).toHaveLength(2);

    expect(await prevented(page)).toEqual([true, true]);
  });

  test('⌘S on an invalid form is swallowed and saves nothing', async ({ page, baseURL }) => {
    await recordSaveKeys(page);
    const { toolSaves } = await openToolEditor(page, baseURL!, { chain: P1_CHAIN, sample: SAMPLE, open: false });

    await page.getByPlaceholder('get_users').fill('');
    await expect(page.getByRole('button', { name: 'Update Tool' })).toBeDisabled();
    await page.keyboard.press('ControlOrMeta+s');
    await openSheet(page);
    await page.keyboard.press('ControlOrMeta+s');
    await page.waitForTimeout(400);
    expect(toolSaves).toHaveLength(0);
    expect(await prevented(page)).toEqual([true, true]);
  });
});

test.describe('Response Processing Input field', () => {
  // A price list keyed by item number: an object whose values the step walks (`prices[*]`).
  const MAP_SAMPLE = {
    ...SAMPLE,
    prices: { 'A-10339': 12.5, 'B-20001': 3, 'C-30002': 7.25 },
    stock: { north: { qty: 4, unit: 'pcs' }, south: { qty: 9, unit: 'pcs' } },
  };

  test('an object gives its values: prices[*], number[3], writes locked to = input', async ({ page, baseURL }) => {
    const { toolSaves } = await openToolEditor(page, baseURL!, { sample: MAP_SAMPLE });
    await addStep(page, 'rp-add-scale@1');

    const input = page.getByTestId('rp-step-0-input');
    await input.click();
    await expect(page.getByTestId('rp-path-node-$.prices')).toHaveAttribute('data-pickable', 'true');
    await page.getByTestId('rp-path-node-$.prices').click();
    await expect(input).toHaveAttribute('data-value', 'prices[*]');
    await expect(page.getByTestId('rp-step-0-input-type')).toHaveText('number[3]');
    // Scalar elements: nothing to write under them, writes is the Input itself.
    await expect(page.getByTestId('rp-step-0-writes')).toHaveCount(0);
    await expect(page.getByTestId('rp-step-0-writes-note')).toHaveText('= input');
    await expect(page.getByTestId('rp-step-0-mode')).toContainText('replace');

    // One value of the object: a single number, under the response (writes is free again).
    await input.click();
    await page.getByTestId("rp-path-node-$.prices['A-10339']").click();
    await expect(input).toHaveAttribute('data-value', "prices['A-10339']");
    await expect(page.getByTestId('rp-step-0-input-type')).toHaveText('number');
    await expect(page.getByTestId('rp-step-0-writes')).toBeVisible();

    // The whole object, the whole array: one value each.
    await input.fill('prices');
    await expect(page.getByTestId('rp-step-0-input-type')).toHaveText('object{3}');
    await input.fill('items');
    await expect(page.getByTestId('rp-step-0-input-type')).toHaveText('array[30]');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    await input.click();
    await page.getByTestId('rp-path-node-$.prices').click();
    await page.getByTestId('rp-step-0-param-factor').fill('0.92');
    await expect(page.getByTestId('rp-status')).toHaveAttribute('data-tone', 'ok');
    await closeSheet(page);
    await expect(page.getByTestId('rp-summary-step-0-paths')).toHaveText('prices[*]');
    await page.getByRole('button', { name: 'Update Tool' }).click();
    await expect.poll(() => toolSaves.length).toBe(1);
    expect(toolSaves[0].responseMapping.responseProcessing.steps[0]).toMatchObject({
      use: 'scale@1',
      each: '$.prices[*]',
      reads: '$',
      writes: '$',
      mode: 'replace',
    });
  });

  test('the mode follows writes: add for a new field, replace for the Input or an existing one', async ({ page, baseURL }) => {
    await openToolEditor(page, baseURL!, { sample: SAMPLE });
    await addStep(page, 'rp-add-scale@1');
    const mode = page.getByTestId('rp-step-0-mode');
    const writes = page.getByTestId('rp-step-0-writes');
    const note = page.getByTestId('rp-step-0-writes-note');
    await expect(mode).toContainText('upsert');

    await page.getByTestId('rp-step-0-input').fill('items[*].price_usd');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('rp-step-0-input-type')).toHaveText('number[30]');
    await expect(note).toHaveText('= input');
    await expect(mode).toContainText('replace');

    await writes.fill('price_eur');
    await page.keyboard.press('Escape');
    await expect(note).toHaveText('new field');
    await expect(mode).toContainText('add');

    // An override stays while writes keeps pointing at a new field...
    await mode.click();
    await page.getByTestId('rp-step-0-mode-upsert').click();
    await expect(mode).toContainText('upsert');
    await writes.fill('price_gbp');
    await page.keyboard.press('Escape');
    await expect(mode).toContainText('upsert');

    // ...and is re-derived when it flips to an existing field and back.
    await writes.fill('description');
    await page.keyboard.press('Escape');
    await expect(note).toHaveCount(0);
    await expect(mode).toContainText('replace');
    await writes.fill('price_eur');
    await page.keyboard.press('Escape');
    await expect(mode).toContainText('add');
    await expect(writes).not.toHaveAttribute('data-tone', 'danger');
  });

  test('the kit P1 chain round-trips untouched', async ({ page, baseURL }) => {
    const { toolSaves } = await openToolEditor(page, baseURL!, { chain: P1_CHAIN, sample: SAMPLE });

    await expect(page.getByTestId('rp-step-0-input')).toHaveAttribute('data-value', 'items[*].price_usd');
    await expect(page.getByTestId('rp-step-0-input-type')).toHaveText('number[30]');
    await expect(page.getByTestId('rp-step-0-writes')).toHaveAttribute('data-value', 'price_eur');
    await expect(page.getByTestId('rp-step-1-input')).toHaveAttribute('data-value', 'items[*].price_eur');
    await expect(page.getByTestId('rp-step-2-input')).toHaveAttribute('data-value', 'items[*].description');
    await expect(page.getByTestId('rp-step-2-input-type')).toHaveText('string[30]');
    await expect(page.getByTestId('rp-step-2-writes-note')).toHaveText('= input');

    // Entering and leaving pick mode changes nothing.
    for (const i of [0, 1, 2]) {
      await page.getByTestId(`rp-step-${i}-input`).click();
      await page.keyboard.press('Escape');
    }
    await expect(page.getByTestId('rp-sheet-unsaved')).toHaveCount(0);

    await page.getByTestId('rp-step-1-param-rate').fill('0.2');
    await closeSheet(page);
    await page.getByRole('button', { name: 'Update Tool' }).click();
    await expect.poll(() => toolSaves.length).toBe(1);
    const saved = toolSaves[0].responseMapping.responseProcessing.steps;
    expect(saved.map(({ params: _p, ...rest }: Record<string, unknown>) => rest)).toEqual(
      P1_CHAIN.steps.map(({ params: _p, ...rest }) => rest),
    );
  });

  test('an object of objects shows a [*] row: its fields are the Input, writes picks inside it', async ({ page, baseURL }) => {
    await openToolEditor(page, baseURL!, { sample: MAP_SAMPLE });
    await addStep(page, 'rp-add-scale@1');

    // Not a row of its own until something uses it.
    await expect(page.getByTestId('rp-path-node-$.stock[*]')).toHaveCount(0);
    const input = page.getByTestId('rp-step-0-input');
    await input.click();
    await expect(page.getByTestId('rp-path-node-$.stock[*]')).toBeVisible();
    await page.getByTestId('rp-path-node-$.stock[*].qty').click();
    await expect(input).toHaveAttribute('data-value', 'stock[*].qty');
    await expect(page.getByTestId('rp-step-0-input-type')).toHaveText('number[2]');

    // writes: the fields of one value; the step's scope row stays.
    const writes = page.getByTestId('rp-step-0-writes');
    await writes.click();
    await expect(page.getByTestId('rp-path-node-$.stock[*]')).toHaveAttribute('data-scope', 'true');
    await expect(page.getByTestId('rp-path-node-$.stock[*].unit')).toHaveAttribute('data-pickable', 'true');
    await expect(page.getByTestId('rp-path-node-$.stock.north.unit')).not.toHaveAttribute('data-pickable', 'true');
    await page.keyboard.press('Escape');
    await writes.fill('qty_x2');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('rp-step-0-mode')).toContainText('add');
    await expect(page.getByTestId('rp-path-node-$.stock[*].qty_x2')).toHaveAttribute('data-step', '1');
  });
});

test.describe('Currency rates: from, to, rate and the ECB table', () => {
  const RATES = {
    base: 'EUR',
    asOf: '2026-10-16',
    source: 'ECB',
    currencies: ['EUR', 'GBP', 'JPY', 'USD'],
    rates: { USD: 1.25, GBP: 0.8, JPY: 160 },
    status: 'live',
    auto: true,
    fetchedAt: '2026-10-16T15:00:00Z',
  };

  /** The rates routes, registered after the editor's catch-all so they win. */
  async function mockRates(page: Page, refresh: () => Record<string, unknown>) {
    const calls = { get: 0, refresh: 0 };
    await page.route('**/api/response-processing/rates**', async (route) => {
      const refreshing = route.request().url().endsWith('/refresh');
      calls[refreshing ? 'refresh' : 'get']++;
      const body = refreshing ? refresh() : RATES;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    return calls;
  }

  test('a new Currency step is USD→EUR, live from the table; typing flips to manual, × and Esc go back', async ({ page, baseURL }) => {
    const { toolSaves } = await openToolEditor(page, baseURL!);
    await mockRates(page, () => RATES);
    await addStep(page, 'rp-add-currency@1');

    const rate = page.getByTestId('rp-step-0-param-rate');
    const note = page.getByTestId('rp-step-0-param-rate-note');
    await expect(rate).toHaveValue('0.8000');
    await expect(rate).toHaveAttribute('data-mode', 'live');
    await expect(note).toHaveText('ECB · 2026-10-16');

    // Tab order: from -> to -> rate.
    await page.getByTestId('rp-step-0-param-from').focus();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('rp-step-0-param-to')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(rate).toBeFocused();

    await rate.fill('0.5');
    await expect(rate).toHaveAttribute('data-mode', 'manual');
    await expect(note).toHaveText('manual');
    await page.getByTestId('rp-step-0-param-rate-clear').click();
    await expect(rate).toHaveAttribute('data-mode', 'live');
    await expect(rate).toHaveValue('0.8000');
    await expect(note).toHaveText('ECB · 2026-10-16');

    // Esc restores what the field held when it got focus.
    await rate.focus();
    await rate.fill('0.7');
    await expect(note).toHaveText('manual');
    await page.keyboard.press('Escape');
    await expect(rate).toHaveAttribute('data-mode', 'live');
    await expect(page.getByTestId('rp-sheet')).toHaveAttribute('data-state', 'open');

    // Another pair: the field follows the table (USD -> GBP = 0.8 / 1.25).
    await page.getByTestId('rp-step-0-param-to').click();
    await page.getByTestId('rp-step-0-param-option-GBP').click();
    await expect(rate).toHaveValue('0.6400');

    await page.getByTestId('rp-step-0-input').fill('price_usd');
    await expect(page.getByTestId('rp-status')).toHaveAttribute('data-tone', 'ok');
    await page.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => toolSaves.length).toBe(1);
    expect(toolSaves[0].responseMapping.responseProcessing.steps[0].params).toEqual({ from: 'USD', to: 'GBP' });

    // The page summary names the pair (the save left the editor).
    await editTool(page);
    await expect(page.getByTestId('rp-summary-step-0-currency')).toHaveText('USD→GBP');
  });

  test('admin refresh: busy, then the new date on every step; a failure turns the icon red with the code', async ({ page, baseURL }) => {
    const chain = {
      version: 1,
      enabled: true,
      onError: 'fail',
      steps: [
        { id: 'eur', use: 'currency@1', each: '$.items[*]', reads: 'price_usd', writes: 'price_eur', mode: 'add', params: { from: 'USD', to: 'EUR' } },
        { id: 'jpy', use: 'currency@1', each: '$.items[*]', reads: 'price_usd', writes: 'price_jpy', mode: 'add', params: { from: 'USD', to: 'JPY' } },
      ],
    };
    let next: Record<string, unknown> = { ...RATES, asOf: '2026-10-17', rates: { USD: 1.6, GBP: 0.8, JPY: 160 } };
    await openToolEditor(page, baseURL!, { chain, sample: SAMPLE, open: false });
    const calls = await mockRates(page, () => next);
    // The panel is mounted (and asked for the table) before the mock: load again.
    await page.reload();
    await editTool(page);
    await openSheet(page);

    await expect(page.getByTestId('rp-step-0-param-rate-note')).toHaveText('ECB · 2026-10-16');
    const refresh = page.getByTestId('rp-step-0-param-rates-refresh');
    await expect(refresh).toHaveAttribute('aria-label', 'Refresh rates');
    await refresh.click();
    await expect.poll(() => calls.refresh).toBe(1);
    await expect(page.getByTestId('rp-step-0-param-rate-note')).toHaveText('ECB · 2026-10-17');
    await expect(page.getByTestId('rp-step-1-param-rate-note')).toHaveText('ECB · 2026-10-17');
    await expect(page.getByTestId('rp-step-0-param-rate')).toHaveValue('0.6250');
    await expect(page.getByTestId('rp-step-1-param-rate')).toHaveValue('100.0000');
    await expect(refresh).toHaveAttribute('data-state', 'idle');

    next = { ...next, error: 'timeout' };
    await refresh.click();
    await expect(refresh).toHaveAttribute('data-state', 'error');
    await expect(refresh).toHaveAttribute('title', 'timeout');
    await expect(page.getByTestId('rp-step-0-param-rate-note')).toHaveText('ECB · 2026-10-17');
  });

  test('a viewer sees the table date but no refresh button', async ({ page, baseURL }) => {
    const chain = {
      version: 1,
      enabled: true,
      onError: 'fail',
      steps: [{ id: 'eur', use: 'currency@1', each: '$.items[*]', reads: 'price_usd', writes: 'price_eur', mode: 'add', params: { from: 'USD', to: 'EUR' } }],
    };
    await openToolEditor(page, baseURL!, { chain, sample: SAMPLE, open: false });
    await mockRates(page, () => RATES);
    const viewer = { ...USER, role: 'VIEWER' };
    await page.route('**/api/users/me', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(viewer) }),
    );
    await page.evaluate((u) => localStorage.setItem('amcp_user', JSON.stringify(u)), viewer);
    await page.reload();
    await editTool(page);
    await openSheet(page);

    await expect(page.getByTestId('rp-step-0-param-rate-note')).toHaveText('ECB · 2026-10-16');
    await expect(page.getByTestId('rp-step-0-param-rates-refresh')).toHaveCount(0);
  });
});

test.describe('Response Processing script example', () => {
  const EMPTY_SCRIPT = {
    version: 1,
    enabled: true,
    onError: 'fail',
    steps: [{ id: 'note', use: 'script@1', reads: '$', writes: '$', mode: 'upsert', code: '' }],
  };

  test('an empty script field shows `return value;` as ghost text; Tab inserts it, a second Tab does not', async ({
    page,
    baseURL,
  }) => {
    await openToolEditor(page, baseURL!, { chain: EMPTY_SCRIPT, sample: SAMPLE });

    const field = page.getByTestId('rp-code-0');
    const editor = page.getByTestId('rp-code-0-editor');
    await expect(editor.locator('.view-line').first()).toBeVisible();
    const ghost = editor.locator('.editorPlaceholder');
    await expect(ghost).toBeVisible();
    await expect(ghost).toHaveText('return value;');

    await editor.locator('.view-lines').click();
    await page.keyboard.press('Tab');
    await expect(field).toHaveValue('return value;');
    await expect(ghost).toBeHidden();

    // With text in the editor, Tab is the editor's own again: it never re-inserts the example.
    await page.keyboard.press('Tab');
    await expect(field).toHaveValue(/^return value;\s+$/);
  });
});
