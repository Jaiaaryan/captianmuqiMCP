import type { DemoWorkspace, MockService } from './demo.config';

/**
 * What the demo seeds into each workspace: the four mock connectors (from the
 * CODEBOUND kit's connectors/connectors.mjs), the Response Processing chain on
 * the supplier's offers, and the four saved scripts of workspace A.
 *
 * Base URLs and credentials are {{VAR}} placeholders filled from each
 * connector's variables at call time, the mechanism a Level 3 script's `env.*`
 * reuses. The seed sets the variables per workspace.
 */

const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });

export interface DemoToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  endpointMapping: Record<string, unknown>;
}

export interface DemoConnectorDef {
  name: string;
  type: 'REST';
  baseUrl: string;
  authType: 'BEARER_TOKEN' | 'API_KEY';
  authConfig: Record<string, string>;
  headers: Record<string, string>;
  /** [base URL variable, credential variable] */
  envVarNames: [string, string];
  tools: DemoToolDef[];
}

export const DEMO_CONNECTORS: Record<MockService, DemoConnectorDef> = {
  erp: {
    name: 'Mock ERP',
    type: 'REST',
    baseUrl: '{{MOCK_ERP_URL}}',
    authType: 'BEARER_TOKEN',
    authConfig: { token: '{{MOCK_ERP_TOKEN}}' },
    headers: { Accept: 'application/json' },
    envVarNames: ['MOCK_ERP_URL', 'MOCK_ERP_TOKEN'],
    tools: [
      {
        name: 'mock_erp_list_articles',
        description:
          'List articles from the ERP, 100 per page at most. The response carries totalItems and totalPages. Each article has sku, name, category, status (active or inactive), purchasePrice (EUR, what we last paid) and unit.',
        parameters: {
          type: 'object',
          properties: {
            status: str('Filter: active or inactive.'),
            category: str('Filter by category, e.g. fasteners.'),
            page: num('Page number, starting at 1.'),
            pageSize: num('Rows per page, 1-100 (default 100).'),
          },
        },
        endpointMapping: {
          method: 'GET',
          path: '/v1/articles',
          queryParams: { status: '$status', category: '$category', page: '$page', pageSize: '$pageSize' },
        },
      },
      {
        name: 'mock_erp_get_article',
        description: 'Get one ERP article by SKU.',
        parameters: { type: 'object', properties: { sku: str('The article SKU, e.g. A-10001.') }, required: ['sku'] },
        endpointMapping: { method: 'GET', path: '/v1/articles/{sku}' },
      },
      {
        name: 'mock_erp_list_orders',
        description: 'List customer orders, 50 per page at most. Shipped orders carry a trackingNo for the carrier.',
        parameters: {
          type: 'object',
          properties: {
            status: str('Filter: open or shipped.'),
            page: num('Page number, starting at 1.'),
            pageSize: num('Rows per page, 1-50 (default 50).'),
          },
        },
        endpointMapping: {
          method: 'GET',
          path: '/v1/orders',
          queryParams: { status: '$status', page: '$page', pageSize: '$pageSize' },
        },
      },
      {
        name: 'mock_erp_ping',
        description: 'Cheapest possible ERP call. Echoes the nonce back. The attack cards use it to prove a script really ran.',
        parameters: { type: 'object', properties: { nonce: str('Any string; it is echoed back.') } },
        endpointMapping: { method: 'GET', path: '/v1/ping', queryParams: { nonce: '$nonce' } },
      },
    ],
  },
  supplier: {
    name: 'Mock Supplier',
    type: 'REST',
    baseUrl: '{{MOCK_SUPPLIER_URL}}',
    authType: 'API_KEY',
    authConfig: { headerName: 'X-Api-Key', apiKey: '{{MOCK_SUPPLIER_API_KEY}}' },
    headers: { Accept: 'application/json' },
    envVarNames: ['MOCK_SUPPLIER_URL', 'MOCK_SUPPLIER_API_KEY'],
    tools: [
      {
        name: 'mock_supplier_get_prices',
        description:
          'Current supplier prices (EUR) for up to 100 SKUs per call. SKUs the supplier does not carry come back in `unknown`.',
        parameters: {
          type: 'object',
          properties: { skus: { type: 'array', items: { type: 'string' }, description: 'Up to 100 SKUs.' } },
          required: ['skus'],
        },
        endpointMapping: { method: 'POST', path: '/v1/prices', bodyMapping: { skus: '$skus' } },
      },
      {
        name: 'mock_supplier_list_offers',
        description:
          'Offers from the US supplier for a category: itemNo, description, price_usd, currency, moq. Categories: fasteners, broken.',
        parameters: { type: 'object', properties: { category: str('fasteners or broken.') }, required: ['category'] },
        endpointMapping: { method: 'GET', path: '/v1/offers', queryParams: { category: '$category' } },
      },
      {
        name: 'mock_supplier_list_catalogue',
        description:
          'One page (50 items) of the supplier catalogue for a category. The response does not say how many pages exist; an empty page means the end. Categories: fasteners, adhesives, legacy.',
        parameters: {
          type: 'object',
          properties: { category: str('fasteners, adhesives or legacy.'), page: num('Page number, starting at 1.') },
          required: ['category'],
        },
        endpointMapping: { method: 'GET', path: '/v1/catalogue', queryParams: { category: '$category', page: '$page' } },
      },
    ],
  },
  carrier: {
    name: 'Mock Carrier',
    type: 'REST',
    baseUrl: '{{MOCK_CARRIER_URL}}',
    authType: 'BEARER_TOKEN',
    authConfig: { token: '{{MOCK_CARRIER_TOKEN}}' },
    headers: { Accept: 'application/json' },
    envVarNames: ['MOCK_CARRIER_URL', 'MOCK_CARRIER_TOKEN'],
    tools: [
      {
        name: 'mock_carrier_get_tracking',
        description: 'Tracking status of one parcel: status (delivered, in_transit, exception), lastScanAt and lastScanLocation.',
        parameters: {
          type: 'object',
          properties: { tracking_no: str('Tracking number from the ERP order.') },
          required: ['tracking_no'],
        },
        endpointMapping: { method: 'GET', path: '/v1/tracking/{tracking_no}' },
      },
    ],
  },
  payroll: {
    name: 'Mock Payroll',
    type: 'REST',
    baseUrl: '{{MOCK_PAYROLL_URL}}',
    authType: 'BEARER_TOKEN',
    authConfig: { token: '{{MOCK_PAYROLL_TOKEN}}' },
    headers: { Accept: 'application/json' },
    envVarNames: ['MOCK_PAYROLL_URL', 'MOCK_PAYROLL_TOKEN'],
    tools: [
      {
        name: 'mock_payroll_list_salaries',
        description: 'Every employee with monthly salary and IBAN. Sensitive: only the HR role may call it.',
        parameters: { type: 'object', properties: {} },
        endpointMapping: { method: 'GET', path: '/v1/employees' },
      },
    ],
  },
};

/** Tools whose MCP annotations the demo overrides: a price lookup sent as POST is still a read. */
export const DEMO_ANNOTATIONS: Record<string, Record<string, unknown>> = {
  mock_supplier_get_prices: { readOnlyHint: true },
};

/**
 * Response Processing on mock_supplier_list_offers: USD to EUR, add 19 % VAT,
 * tidy the descriptions. The `broken` category carries a price of "n/a", so the
 * first step refuses and the call fails naming price_usd.
 */
export const DEMO_OFFERS_CHAIN = {
  version: 1,
  enabled: true,
  onError: 'fail',
  steps: [
    {
      id: 'convert_to_eur',
      use: 'currency@1',
      each: '$.items[*]',
      reads: 'price_usd',
      writes: 'price_eur',
      mode: 'add',
      params: { rate: 0.92 },
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
} as const;
export const DEMO_OFFERS_TOOL = 'mock_supplier_list_offers';

export interface DemoScriptDef {
  name: string;
  description: string;
  code: string;
  parameters: Record<string, unknown>;
  /** Connector (by service) and the tools of it the script declares. */
  uses: Array<{ service: MockService; tools: string[] }>;
  capabilities?: { env?: boolean; http?: boolean };
}

const PRICE_DRIFT_CHECK = `// CODEBOUND F2 · price_drift_check(threshold: number)
// Bound to: Mock ERP, Mock Supplier.
// Active articles whose current supplier price is more than \`threshold\` %
// above the ERP purchase price, highest drift first. Articles the supplier
// does not carry are left out. ERP pages hold at most 100 articles; the
// supplier takes at most 100 SKUs per call.
const threshold = Number(args.threshold);
if (!Number.isFinite(threshold)) throw new Error('threshold (number) is required');

// 1. Walk every page of active articles.
const articles = [];
for (let page = 1; ; page++) {
  const r = await tools.mock_erp_list_articles({ status: 'active', page, pageSize: 100 });
  const items = Array.isArray(r) ? r : r.items || [];
  articles.push(...items);
  if (items.length === 0 || page >= (r.totalPages || 1)) break;
}

// 2. Ask the supplier in chunks of 100 SKUs.
const supplierPrice = {};
for (let i = 0; i < articles.length; i += 100) {
  const skus = articles.slice(i, i + 100).map((a) => a.sku);
  const r = await tools.mock_supplier_get_prices({ skus });
  Object.assign(supplierPrice, r.prices || {});
}

// 3. Join, filter, sort. Only the few rows that matter leave the sandbox.
const rows = [];
for (const a of articles) {
  const sp = supplierPrice[a.sku];
  if (sp === undefined) continue;
  const driftPct = Math.round(((sp - a.purchasePrice) / a.purchasePrice) * 1000) / 10;
  if (driftPct > threshold) {
    rows.push({ sku: a.sku, purchasePrice: a.purchasePrice, supplierPrice: sp, driftPct });
  }
}
rows.sort((x, y) => y.driftPct - x.driftPct);
console.log(\`\${articles.length} articles in, \${rows.length} rows out\`);
return rows;
`;

const CATALOGUE_TOTAL = `// CODEBOUND F3 · catalogue_total(category: string)
// Bound to: Mock Supplier.
// Walks the supplier catalogue for one category. The API never says how many
// pages exist: an empty page is the end. If a page fails, stop and admit it
// with complete: false instead of guessing.
const category = typeof args.category === 'string' ? args.category.trim() : '';
if (!category) throw new Error('category (string) is required');

let total = 0;
let complete = true;
for (let page = 1; ; page++) {
  let r;
  try {
    r = await tools.mock_supplier_list_catalogue({ category, page });
  } catch (err) {
    console.warn(\`page \${page} failed: \${err && err.message}\`);
    complete = false;
    break;
  }
  const items = Array.isArray(r) ? r : r.items || [];
  if (items.length === 0) break;
  total += items.length;
}
return { category, total, complete };
`;

const STUCK_ORDERS = `// CODEBOUND F4 · stuck_orders(days: number, as_of: string)
// Bound to: Mock ERP, Mock Carrier.
// Shipped orders whose parcel is not delivered and has not been scanned for
// more than \`days\` days before \`as_of\` (ISO 8601), oldest scan first.
// \`as_of\` is a parameter so the answer does not depend on the day it runs.
const days = Number(args.days);
const asOf = new Date(args.as_of);
if (!Number.isFinite(days) || Number.isNaN(asOf.getTime())) {
  throw new Error('days (number) and as_of (ISO 8601 string) are required');
}
const cutoff = asOf.getTime() - days * 864e5;

// 1. Every shipped order (50 per page at most).
const orders = [];
for (let page = 1; ; page++) {
  const r = await tools.mock_erp_list_orders({ status: 'shipped', page, pageSize: 50 });
  const items = Array.isArray(r) ? r : r.items || [];
  orders.push(...items);
  if (items.length === 0 || page >= (r.totalPages || 1)) break;
}

// 2. One tracking call per parcel; keep only the stuck ones.
const rows = [];
for (const o of orders) {
  if (!o.trackingNo) continue;
  const t = await tools.mock_carrier_get_tracking({ tracking_no: o.trackingNo });
  if (t.status === 'delivered') continue;
  const lastScan = new Date(t.lastScanAt).getTime();
  if (Number.isNaN(lastScan) || lastScan < cutoff) {
    rows.push({ orderNo: o.orderNo, trackingNo: o.trackingNo, status: t.status, lastScanAt: t.lastScanAt });
  }
}
rows.sort((a, b) => String(a.lastScanAt).localeCompare(String(b.lastScanAt)));
console.log(\`\${orders.length} shipped orders checked, \${rows.length} stuck\`);
return rows;
`;

const SUPPLIER_ACCOUNT = `const r = await http.fetch(\`\${env.MOCK_SUPPLIER_URL}/v1/account\`, { headers: { 'X-Api-Key': env.MOCK_SUPPLIER_API_KEY } });
if (r.status !== 200) throw new Error(\`account: HTTP \${r.status}\`);
return { accountName: r.json.accountName, customerNo: r.json.customerNo };
`;

/** The saved scripts of workspace A, owned by alice. */
export const DEMO_SCRIPTS: DemoScriptDef[] = [
  {
    name: 'price_drift_check',
    description:
      'Active articles whose current supplier price is more than `threshold` % above the ERP purchase price, highest drift first. Articles the supplier does not carry are left out.',
    code: PRICE_DRIFT_CHECK,
    parameters: {
      type: 'object',
      properties: {
        threshold: { type: 'number', description: 'Minimum drift in percent between ERP and supplier price' },
      },
      required: ['threshold'],
    },
    uses: [
      { service: 'erp', tools: ['mock_erp_list_articles'] },
      { service: 'supplier', tools: ['mock_supplier_get_prices'] },
    ],
  },
  {
    name: 'catalogue_total',
    description:
      'Number of items in one supplier catalogue category. Walks the pages until an empty one; if a page fails, stops and says complete: false.',
    code: CATALOGUE_TOTAL,
    parameters: {
      type: 'object',
      properties: { category: { type: 'string', description: 'Supplier catalogue category, e.g. fasteners' } },
      required: ['category'],
    },
    uses: [{ service: 'supplier', tools: ['mock_supplier_list_catalogue'] }],
  },
  {
    name: 'stuck_orders',
    description:
      'Shipped orders whose parcel is not delivered and has not been scanned for more than `days` days before `as_of`, oldest scan first.',
    code: STUCK_ORDERS,
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Minimum days an order has been without carrier progress' },
        as_of: { type: 'string', description: 'Reference date (ISO 8601) the days are counted to' },
      },
      required: ['days', 'as_of'],
    },
    uses: [
      { service: 'erp', tools: ['mock_erp_list_orders'] },
      { service: 'carrier', tools: ['mock_carrier_get_tracking'] },
    ],
  },
  {
    name: 'supplier_account',
    description:
      'Account name and customer number of this workspace at the supplier (GET /v1/account with the injected key). A Level 3 script: reads the connector variables and calls the supplier directly.',
    code: SUPPLIER_ACCOUNT,
    parameters: { type: 'object', properties: {} },
    // A script declares at least one tool of each connector it uses; this one
    // calls none, the declaration is what binds http.fetch to the supplier.
    uses: [{ service: 'supplier', tools: ['mock_supplier_list_offers'] }],
    capabilities: { env: true, http: true },
  },
];

/** Which MCP role sees which tools in workspace A: payroll is HR-only. */
export function demoRoleTools(toolNames: string[]): Record<string, string[]> {
  return {
    HR: toolNames.filter((n) => n.startsWith('mock_payroll_')),
    Staff: toolNames.filter((n) => !n.startsWith('mock_payroll_')),
  };
}

export const DEMO_ROLES: Array<{ name: string; description: string; workspace: DemoWorkspace }> = [
  { name: 'HR', description: 'May read payroll.', workspace: 'A' },
  { name: 'Staff', description: 'Everything except payroll.', workspace: 'A' },
];

export const DEMO_SERVER = {
  name: 'CODEBOUND',
  slug: 'codebound',
  description: 'Hackathon test bed. Your scripts must show up on this server.',
};
