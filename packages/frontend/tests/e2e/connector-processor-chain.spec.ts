import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Response processor chains in the tool editor (docs/response-processors.md):
 * the ordered steps that *edit* a tool's response — convert a currency, add
 * VAT, clean a description — before the response mapping selects from it.
 *
 * The API is mocked, as in the other smoke tests: the registry the parameter
 * inputs are built from comes from `GET /api/processors`, and the step-by-step
 * view from `POST .../preview-processors`. The chain itself is exercised by the
 * backend unit tests; what is checked here is that the panel builds a step from
 * the declared contract, keeps the order the operator put the steps in, shows
 * what each step did, names the failing step and path when one refuses a value,
 * and refuses to let an incomplete step be saved.
 */

const USER = {
  id: 'u1',
  email: 'test@example.com',
  name: 'Test User',
  role: 'ADMIN',
  organizationId: 'o1',
  emailVerified: true,
};

const CONNECTOR = {
  id: 'c1',
  name: 'Shop API',
  type: 'REST',
  baseUrl: 'https://shop.example.com',
  authType: 'NONE',
  authConfig: null,
  isActive: true,
  envVars: {},
  headers: {},
  config: {},
  userId: 'u1',
  organizationId: 'o1',
  createdAt: '2026-09-01T00:00:00Z',
  tools: [
    {
      id: 't1',
      connectorId: 'c1',
      name: 'shop_list_items',
      description: 'List the items of the catalogue.',
      isEnabled: true,
      parameters: { type: 'object', properties: {} },
      endpointMapping: { method: 'GET', path: '/v1/items' },
    },
  ],
};

/** What `GET /api/processors` answers — the seven registry entries, verbatim. */
const REGISTRY = {
  processors: [
    {
      ref: 'number_scale@1',
      name: 'number_scale',
      version: 1,
      title: 'Scale a number',
      description: 'Multiplies a number by a fixed factor. The usual currency conversion.',
      input: { name: 'value', type: 'number', description: 'The number to scale.' },
      output: { name: 'value', type: 'number', description: 'value × factor.' },
      parameters: [
        {
          name: 'factor',
          type: 'number',
          description: 'What the value is multiplied by, 0.92 for USD → EUR.',
          required: true,
        },
        {
          name: 'round',
          type: 'integer',
          description: 'Decimal places to keep; omit to keep full precision.',
          required: false,
          min: 0,
          max: 10,
        },
      ],
    },
    {
      ref: 'number_offset@1',
      name: 'number_offset',
      version: 1,
      title: 'Add to a number',
      description: 'Adds a fixed amount — a flat fee or a handling charge.',
      input: { name: 'value', type: 'number', description: 'The number to shift.' },
      output: { name: 'value', type: 'number', description: 'value + amount.' },
      parameters: [
        { name: 'amount', type: 'number', description: 'Added to the value.', required: true },
        {
          name: 'round',
          type: 'integer',
          description: 'Decimal places to keep.',
          required: false,
          min: 0,
          max: 10,
        },
      ],
    },
    {
      ref: 'number_vat@1',
      name: 'number_vat',
      version: 1,
      title: 'Add VAT',
      description: 'Turns a net amount into a gross one.',
      input: { name: 'value', type: 'number', description: 'The net amount.' },
      output: { name: 'value', type: 'number', description: 'The gross amount.' },
      parameters: [
        {
          name: 'rate',
          type: 'number',
          description: 'The tax rate as a fraction, 0.19 for 19%.',
          required: true,
          min: 0,
          max: 1,
        },
        {
          name: 'round',
          type: 'integer',
          description: 'Decimal places to keep.',
          required: false,
          min: 0,
          max: 10,
        },
      ],
    },
    {
      ref: 'number_round@1',
      name: 'number_round',
      version: 1,
      title: 'Round a number',
      description: 'Rounds half away from zero, the way an invoice does.',
      input: { name: 'value', type: 'number', description: 'The number to round.' },
      output: { name: 'value', type: 'number', description: 'The rounded number.' },
      parameters: [
        {
          name: 'decimals',
          type: 'integer',
          description: 'Decimal places to keep.',
          required: false,
          default: 2,
          min: 0,
          max: 10,
        },
      ],
    },
    {
      ref: 'text_clean@1',
      name: 'text_clean',
      version: 1,
      title: 'Clean up text',
      description: 'Collapses every run of whitespace into one space and trims the ends.',
      input: { name: 'text', type: 'string', description: 'The string to clean.' },
      output: { name: 'text', type: 'string', description: 'The cleaned string.' },
      parameters: [
        {
          name: 'trim',
          type: 'boolean',
          description: 'Remove leading and trailing whitespace.',
          required: false,
          default: true,
        },
        {
          name: 'collapseWhitespace',
          type: 'boolean',
          description: 'Replace every run of whitespace with a single space.',
          required: false,
          default: true,
        },
      ],
    },
    {
      ref: 'text_truncate@1',
      name: 'text_truncate',
      version: 1,
      title: 'Shorten text',
      description: 'Cuts a string to a maximum length, ellipsis included.',
      input: { name: 'text', type: 'string', description: 'The string to shorten.' },
      output: { name: 'text', type: 'string', description: 'The shortened string.' },
      parameters: [
        {
          name: 'maxLength',
          type: 'integer',
          description: 'Longest result, including the ellipsis.',
          required: true,
          min: 1,
          max: 100000,
        },
        {
          name: 'ellipsis',
          type: 'string',
          description: 'Appended when the text was cut.',
          required: false,
          default: '…',
        },
      ],
    },
    {
      ref: 'value_map@1',
      name: 'value_map',
      version: 1,
      title: 'Translate a value',
      description: "Looks a value up in a table of replacements ('2' → 'shipped').",
      input: { name: 'value', type: 'any', description: 'The value to look up.' },
      output: { name: 'value', type: 'any', description: 'The replacement.' },
      parameters: [
        {
          name: 'map',
          type: 'object',
          description: 'Lookup table: the key is the incoming value as a string.',
          required: true,
        },
        {
          name: 'fallback',
          type: 'any',
          description: 'Used when the value is not in the table.',
          required: false,
        },
      ],
    },
  ],
  writeModes: [
    { mode: 'add', description: 'The target field must not exist yet.' },
    { mode: 'replace', description: 'The target field must already exist.' },
    { mode: 'upsert', description: 'Either.' },
  ],
  limits: {
    maxSteps: 20,
    maxTargets: 100000,
    maxPathLength: 200,
    maxPathSegments: 16,
    maxStepIdLength: 64,
  },
};

const RAW_SAMPLE = {
  items: [
    { sku: 'A-1', price_usd: 100, description: '  A   roomy\n  bag ' },
    { sku: 'A-2', price_usd: 42.5, description: 'A small bag' },
  ],
};

/** `POST .../preview-processors` for the three steps of the worked example. */
const PREVIEW_OK = {
  ok: true,
  sampleSource: 'last-invocation',
  sampleCapturedAt: '2026-10-16T09:30:00.000Z',
  chainActive: true,
  raw: RAW_SAMPLE,
  result: {
    items: [
      {
        sku: 'A-1',
        price_usd: 100,
        price_eur: 92,
        price_eur_gross: 109.48,
        description: 'A roomy bag',
      },
    ],
  },
  rawBytes: 2048,
  resultBytes: 1536,
  steps: [
    {
      id: 'convert_to_eur',
      processor: 'number_scale@1',
      mode: 'add',
      targets: 12,
      written: 12,
      skipped: 0,
      bytesAfter: 2300,
      sample: { sku: 'A-1', price_usd: 100, price_eur: 92 },
    },
    {
      id: 'add_vat',
      processor: 'number_vat@1',
      mode: 'add',
      targets: 12,
      written: 12,
      skipped: 0,
      bytesAfter: 2520,
      sample: { sku: 'A-1', price_eur: 92, price_eur_gross: 109.48 },
    },
    {
      id: 'tidy_description',
      processor: 'text_clean@1',
      mode: 'replace',
      // One item of the recorded response has no description at all, and the
      // step says `skip`, so it is left alone instead of failing the call.
      targets: 12,
      written: 11,
      skipped: 1,
      bytesAfter: 1536,
      sample: { sku: 'A-1', description: 'A roomy bag' },
    },
  ],
};

/** The diagnostic this view exists for: which step refused, and which value. */
const PREVIEW_FAILED = {
  ok: false,
  sampleSource: 'last-invocation',
  sampleCapturedAt: '2026-10-16T09:30:00.000Z',
  chainActive: true,
  raw: RAW_SAMPLE,
  result: RAW_SAMPLE,
  rawBytes: 2048,
  resultBytes: 2048,
  error: 'step add_vat: $.items[3].price_eur is not a number',
  failedStep: 'add_vat',
  failedPath: '$.items[3].price_eur',
  steps: [PREVIEW_OK.steps[0]],
};

interface Opts {
  /** What the preview route answers. */
  preview?: unknown;
  /** Make `GET /api/processors` fail, so the registry cannot be read. */
  registryDown?: boolean;
}

async function openToolEditor(page: Page, baseURL: string, opts: Opts = {}) {
  const previewBodies: Record<string, unknown>[] = [];

  await page.context().addCookies([
    { name: 'amcp_token', value: 'test-token', url: baseURL },
  ]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, USER);

  await page.route(/\/api\//, async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.includes('/tools/t1/preview-processors') && req.method() === 'POST') {
      previewBodies.push(req.postDataJSON());
      return json(opts.preview ?? PREVIEW_OK);
    }
    if (url.includes('/api/processors/validate')) return json({ valid: true });
    if (url.includes('/api/processors')) {
      return opts.registryDown
        ? json({ statusCode: 500, message: 'The registry is unavailable' }, 500)
        : json(REGISTRY);
    }
    if (url.includes('/api/connectors/proxy-availability')) return json({ available: false });
    if (url.includes('/api/connectors/c1/catalog-diff')) return json({ catalogManaged: false });
    if (url.includes('/api/connectors/c1')) return json(CONNECTOR);
    if (url.includes('/api/users/me/onboarding-state')) {
      return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    }
    if (url.includes('/api/users/me')) return json(USER);
    if (url.includes('/api/organizations/current')) return json({ id: 'o1', name: 'Acme' });
    if (url.includes('/api/organizations/mine')) {
      return json([{ id: 'o1', name: 'Acme', role: 'ADMIN', joinedAt: '2026-01-01' }]);
    }
    if (url.includes('/api/license/status')) return json({ plan: 'community', status: 'active' });
    if (url.includes('/api/connectors')) return json([CONNECTOR]);
    return json({});
  });

  await page.goto('/connectors/c1');
  // The first Edit belongs to the connector itself; the last to its one tool.
  await page.getByRole('main').getByRole('button', { name: 'Edit', exact: true }).last().click();

  const panel = page.getByTestId('processor-panel');
  await expect(panel).toBeVisible();
  return { panel, previewBodies, save: page.getByRole('button', { name: 'Update Tool' }) };
}

/** One step card, so a label like `factor` means this step's `factor`. */
const step = (panel: Locator, index: number) => panel.getByTestId('processor-step').nth(index);

async function pickProcessor(page: Page, index: number, label: string) {
  await page.getByLabel(`Step ${index + 1} processor`).click();
  await page.getByRole('option', { name: label }).click();
}

test.describe('tool editor — response processors', () => {
  test('the panel sits in the tool editor and starts with no steps', async ({ page, baseURL }) => {
    const { panel } = await openToolEditor(page, baseURL!);

    await expect(panel).toContainText('Response Processors');
    await expect(panel).toContainText(
      'No steps — the response reaches the mapping exactly as the API returned it.',
    );
    await expect(panel.getByTestId('processor-step')).toHaveCount(0);
    // The chain runs before the mapping, and both panels are in the editor.
    await expect(page.getByText('Response Mapping', { exact: false }).first()).toBeVisible();
  });

  test('the processor picker is populated from the registry the installation returns', async ({
    page,
    baseURL,
  }) => {
    const { panel } = await openToolEditor(page, baseURL!);
    await panel.getByRole('button', { name: 'Add step' }).click();

    // The new step starts on the first registry entry, and shows its contract.
    await expect(page.getByLabel('Step 1 processor')).toContainText('Scale a number · number_scale@1');
    await expect(step(panel, 0)).toContainText('Multiplies a number by a fixed factor');
    await expect(step(panel, 0)).toContainText('Reads a number, writes a number.');

    await page.getByLabel('Step 1 processor').click();
    await expect(page.getByRole('option')).toHaveCount(REGISTRY.processors.length);
    await expect(page.getByRole('option', { name: 'Add VAT · number_vat@1' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Translate a value · value_map@1' })).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('a step is added, filled in and moved, and the order is the operator’s', async ({
    page,
    baseURL,
  }) => {
    const { panel } = await openToolEditor(page, baseURL!);

    await panel.getByRole('button', { name: 'Add step' }).click();
    await expect(page.getByLabel('Step 1 id')).toHaveValue('step_1');
    await page.getByLabel('Step 1 id').fill('convert_to_eur');
    await step(panel, 0).getByLabel('Runs over (each)').fill('$.items[*]');
    await step(panel, 0).getByLabel('Reads').fill('price_usd');
    await step(panel, 0).getByLabel('Writes').fill('price_eur');
    await step(panel, 0).getByLabel('factor').fill('0.92');

    await panel.getByRole('button', { name: 'Add step' }).click();
    await page.getByLabel('Step 2 id').fill('add_vat');
    await pickProcessor(page, 1, 'Add VAT · number_vat@1');
    await step(panel, 1).getByLabel('Runs over (each)').fill('$.items[*]');
    // A later step reads what an earlier one wrote.
    await step(panel, 1).getByLabel('Reads').fill('price_eur');
    await step(panel, 1).getByLabel('Writes').fill('price_eur_gross');
    await step(panel, 1).getByLabel('rate').fill('0.19');
    await expect(panel.getByTestId('processor-step')).toHaveCount(2);

    // The ends of the chain cannot be moved past themselves.
    await expect(page.getByLabel('Move step 1 up')).toBeDisabled();
    await expect(page.getByLabel('Move step 2 down')).toBeDisabled();

    await page.getByLabel('Move step 2 up').click();
    await expect(page.getByLabel('Step 1 id')).toHaveValue('add_vat');
    await expect(page.getByLabel('Step 2 id')).toHaveValue('convert_to_eur');
    // The whole step travels with its id, not just the name.
    await expect(step(panel, 0).getByLabel('Reads')).toHaveValue('price_eur');
    await expect(step(panel, 0).getByLabel('rate')).toHaveValue('0.19');
    await expect(step(panel, 1).getByLabel('factor')).toHaveValue('0.92');

    await page.getByLabel('Move step 1 down').click();
    await expect(page.getByLabel('Step 1 id')).toHaveValue('convert_to_eur');
    await expect(page.getByLabel('Step 2 id')).toHaveValue('add_vat');

    await step(panel, 1).getByRole('button', { name: 'Remove' }).click();
    await expect(panel.getByTestId('processor-step')).toHaveCount(1);
    await expect(page.getByLabel('Step 1 id')).toHaveValue('convert_to_eur');
  });

  test('each parameter input is the one the declared contract asks for', async ({
    page,
    baseURL,
  }) => {
    const { panel } = await openToolEditor(page, baseURL!);
    await panel.getByRole('button', { name: 'Add step' }).click();
    const first = step(panel, 0);

    // A number: a number input, required, with the bounds the registry declares.
    await expect(first.getByLabel('factor')).toHaveAttribute('type', 'number');
    await expect(first.getByLabel('round')).toHaveAttribute('type', 'number');
    await expect(first.getByLabel('round')).toHaveAttribute('min', '0');
    await expect(first.getByLabel('round')).toHaveAttribute('max', '10');
    await expect(first).toContainText('factor *');

    // A boolean: a checkbox, starting on the processor's declared default.
    await pickProcessor(page, 0, 'Clean up text · text_clean@1');
    await expect(first.getByLabel('trim')).toHaveAttribute('type', 'checkbox');
    await expect(first.getByLabel('trim')).toBeChecked();
    await first.getByLabel('trim').uncheck();
    await expect(first.getByLabel('trim')).not.toBeChecked();
    await expect(first.getByLabel('collapseWhitespace')).toBeChecked();

    // An object: a JSON textarea, with the shape of the table as a placeholder.
    await pickProcessor(page, 0, 'Translate a value · value_map@1');
    const map = first.getByLabel('map');
    await expect(map).toHaveAttribute('placeholder', '{ "2": "shipped" }');
    expect(await map.evaluate((el) => el.tagName)).toBe('TEXTAREA');
    await expect(first).toContainText('Lookup table');

    // A default the registry declares is offered, not silently applied.
    await pickProcessor(page, 0, 'Round a number · number_round@1');
    await expect(first.getByLabel('decimals')).toHaveAttribute('placeholder', '2');
    await expect(first.getByLabel('decimals')).toHaveValue('');
    await expect(first).toContainText('Default 2.');
  });

  test('“Insert example” fills the worked example from the documentation', async ({
    page,
    baseURL,
  }) => {
    const { panel } = await openToolEditor(page, baseURL!);
    await panel.getByRole('button', { name: 'Insert example' }).click();

    await expect(panel.getByTestId('processor-step')).toHaveCount(3);

    // 1. USD → EUR, 0.92, added as a new field.
    await expect(page.getByLabel('Step 1 id')).toHaveValue('convert_to_eur');
    await expect(page.getByLabel('Step 1 processor')).toContainText('number_scale@1');
    await expect(step(panel, 0).getByLabel('Runs over (each)')).toHaveValue('$.items[*]');
    await expect(step(panel, 0).getByLabel('Reads')).toHaveValue('price_usd');
    await expect(step(panel, 0).getByLabel('Writes')).toHaveValue('price_eur');
    await expect(step(panel, 0).getByLabel('factor')).toHaveValue('0.92');
    await expect(step(panel, 0).getByLabel('round')).toHaveValue('2');
    await expect(page.getByLabel('Step 1 write mode')).toContainText('add');

    // 2. 19% VAT on the field the first step wrote, added alongside it.
    await expect(page.getByLabel('Step 2 id')).toHaveValue('add_vat');
    await expect(page.getByLabel('Step 2 processor')).toContainText('number_vat@1');
    await expect(step(panel, 1).getByLabel('Reads')).toHaveValue('price_eur');
    await expect(step(panel, 1).getByLabel('Writes')).toHaveValue('price_eur_gross');
    await expect(step(panel, 1).getByLabel('rate')).toHaveValue('0.19');
    await expect(page.getByLabel('Step 2 write mode')).toContainText('add');

    // 3. The description cleaned in place, and skipped where there is none.
    await expect(page.getByLabel('Step 3 id')).toHaveValue('tidy_description');
    await expect(page.getByLabel('Step 3 processor')).toContainText('text_clean@1');
    await expect(step(panel, 2).getByLabel('Reads')).toHaveValue('description');
    await expect(step(panel, 2).getByLabel('Writes')).toHaveValue('description');
    await expect(page.getByLabel('Step 3 write mode')).toContainText('replace');
    await expect(
      page.getByLabel('Step 3 behaviour when the field is missing'),
    ).toContainText('skip');
    await expect(step(panel, 2).getByLabel('trim')).toBeChecked();

    // Nothing is incomplete, so the example can be saved as it stands.
    await expect(panel.getByText('Saving is disabled')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Update Tool' })).toBeEnabled();
  });

  test('the step-by-step preview shows what every step did and the size after it', async ({
    page,
    baseURL,
  }) => {
    const { panel, previewBodies } = await openToolEditor(page, baseURL!);
    await panel.getByRole('button', { name: 'Insert example' }).click();
    await panel.getByRole('button', { name: 'Preview step by step' }).click();

    const traces = panel.getByTestId('processor-trace');
    await expect(traces).toHaveCount(3);
    await expect(traces.nth(0)).toContainText('1. convert_to_eur');
    await expect(traces.nth(0)).toContainText('number_scale@1');
    await expect(traces.nth(0)).toContainText('12 elements · 12 written · 0 skipped · add');
    await expect(traces.nth(0)).toContainText('2.2 KB after');
    await expect(traces.nth(0)).toContainText('"price_eur": 92');
    await expect(traces.nth(1)).toContainText('2. add_vat');
    await expect(traces.nth(1)).toContainText('"price_eur_gross": 109.48');
    // The step that leaves an element alone counts it as skipped, not written.
    await expect(traces.nth(2)).toContainText('3. tidy_description');
    await expect(traces.nth(2)).toContainText('12 elements · 11 written · 1 skipped · replace');
    await expect(traces.nth(2)).toContainText('1.5 KB after');

    await expect(panel.getByTestId('processor-size')).toContainText('2.0 KB → 1.5 KB');
    await expect(panel.getByTestId('processor-size')).toContainText('25%');

    // Before and after, side by side.
    await expect(panel).toContainText('Response as it arrived');
    await expect(panel).toContainText('After the chain (before the mapping)');
    await expect(panel.getByTestId('processor-failure')).toHaveCount(0);

    // The chain the operator is editing is what was previewed — not what is stored.
    expect(previewBodies).toHaveLength(1);
    expect(previewBodies[0]).toEqual({
      processors: {
        version: 1,
        enabled: true,
        onError: 'fail',
        steps: [
          {
            id: 'convert_to_eur',
            processor: 'number_scale@1',
            reads: 'price_usd',
            writes: 'price_eur',
            mode: 'add',
            onMissing: 'fail',
            each: '$.items[*]',
            params: { factor: 0.92, round: 2 },
          },
          {
            id: 'add_vat',
            processor: 'number_vat@1',
            reads: 'price_eur',
            writes: 'price_eur_gross',
            mode: 'add',
            onMissing: 'fail',
            each: '$.items[*]',
            params: { rate: 0.19, round: 2 },
          },
          {
            id: 'tidy_description',
            processor: 'text_clean@1',
            reads: 'description',
            writes: 'description',
            mode: 'replace',
            onMissing: 'skip',
            each: '$.items[*]',
            params: { trim: true, collapseWhitespace: true },
          },
        ],
      },
    });
  });

  test('a refused value names the step and the path it refused', async ({ page, baseURL }) => {
    const { panel } = await openToolEditor(page, baseURL!, { preview: PREVIEW_FAILED });
    await panel.getByRole('button', { name: 'Insert example' }).click();
    await panel.getByRole('button', { name: 'Preview step by step' }).click();

    const failure = panel.getByTestId('processor-failure');
    await expect(failure).toBeVisible();
    await expect(failure).toContainText('The chain stopped at step add_vat');
    await expect(failure).toContainText('$.items[3].price_eur');
    await expect(failure).toContainText('step add_vat: $.items[3].price_eur is not a number');
    // What it means for the client, which depends on the On error setting.
    await expect(failure).toContainText('Nothing half-edited is returned');

    // The steps that did run are still shown, and the result is the unedited response.
    await expect(panel.getByTestId('processor-trace')).toHaveCount(1);
    await expect(panel.getByTestId('processor-trace')).toContainText('1. convert_to_eur');
    await expect(panel).toContainText('What the client would get — unedited, the chain stopped');
    // The failing step and path carry the message; it is not also repeated loose.
    await expect(panel.getByTestId('processor-size')).toHaveCount(0);
  });

  test('an incomplete step or unparseable parameter blocks the save', async ({ page, baseURL }) => {
    const { panel, save } = await openToolEditor(page, baseURL!);
    await expect(save).toBeEnabled();

    // A step with nothing in it yet: the save is off and the panel says why.
    await panel.getByRole('button', { name: 'Add step' }).click();
    await expect(save).toBeDisabled();
    await expect(step(panel, 0)).toContainText('Name the field this step reads.');
    await expect(step(panel, 0)).toContainText('Saving is disabled until this step is complete.');

    await step(panel, 0).getByLabel('Reads').fill('price_usd');
    await expect(step(panel, 0)).toContainText('Name the field this step writes.');
    await step(panel, 0).getByLabel('Writes').fill('price_eur');
    // A required parameter of the chosen processor is part of being complete.
    await expect(step(panel, 0)).toContainText('"factor" is required.');
    await expect(save).toBeDisabled();
    await step(panel, 0).getByLabel('factor').fill('0.92');
    await expect(save).toBeEnabled();

    // A params JSON that does not parse is not stored as text and saved later.
    await pickProcessor(page, 0, 'Translate a value · value_map@1');
    await expect(step(panel, 0)).toContainText('"map" is required.');
    await expect(save).toBeDisabled();
    await step(panel, 0).getByLabel('map').fill('{ "2": "shipped"');
    await expect(step(panel, 0)).toContainText('"map" is not valid JSON.');
    await expect(save).toBeDisabled();
    await step(panel, 0).getByLabel('map').fill('{ "2": "shipped" }');
    await expect(save).toBeEnabled();

    // An id that is not a name a step can be referred to by.
    await page.getByLabel('Step 1 id').fill('convert to eur');
    await expect(step(panel, 0)).toContainText('The id can only use letters, digits');
    await expect(save).toBeDisabled();
    await page.getByLabel('Step 1 id').fill('translate_state');
    await expect(save).toBeEnabled();

    // Two steps of the same name: the id appears in every error, so it must be unique.
    await panel.getByRole('button', { name: 'Add step' }).click();
    await step(panel, 1).getByLabel('Reads').fill('price_usd');
    await step(panel, 1).getByLabel('Writes').fill('price_eur');
    await step(panel, 1).getByLabel('factor').fill('0.92');
    await expect(save).toBeEnabled();
    await page.getByLabel('Step 2 id').fill('translate_state');
    await expect(step(panel, 1)).toContainText('The id "translate_state" is used by another step.');
    await expect(save).toBeDisabled();
  });

  test('the preview is unavailable while a step is incomplete', async ({ page, baseURL }) => {
    const { panel, previewBodies } = await openToolEditor(page, baseURL!);
    const preview = panel.getByRole('button', { name: 'Preview step by step' });

    await panel.getByRole('button', { name: 'Add step' }).click();
    await expect(preview).toBeDisabled();
    expect(previewBodies).toHaveLength(0);

    await step(panel, 0).getByLabel('Reads').fill('price_usd');
    await step(panel, 0).getByLabel('Writes').fill('price_eur');
    await step(panel, 0).getByLabel('factor').fill('0.92');
    await expect(preview).toBeEnabled();
  });

  test('a registry that cannot be read says so and leaves the steps editable', async ({
    page,
    baseURL,
  }) => {
    const { panel } = await openToolEditor(page, baseURL!, { registryDown: true });

    await expect(panel).toContainText('Could not load the processor list');
    // Without the contract there are no parameter inputs, but the example's own
    // steps are still there to be read and corrected.
    await panel.getByRole('button', { name: 'Insert example' }).click();
    await expect(panel.getByTestId('processor-step')).toHaveCount(3);
    await expect(page.getByLabel('Step 1 id')).toHaveValue('convert_to_eur');
    await expect(page.getByLabel('Step 1 processor')).toContainText('not in this registry');
  });
});
