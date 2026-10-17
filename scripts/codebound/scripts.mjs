// The CODEBOUND scripts: what the kit's Level 2 checks (F1-F4) call by name.
//
// Each one is a saved sandbox script with typed parameters, so it is offered to agents as
// a tool of its own name. The code runs in the sandbox next to the data: it calls the
// workspace's tools (`tools.<name>(args)`) and returns only the answer.
//
// The connectors and tools a script calls are found from its code when it is saved
// (`tools.mock_erp_list_articles(...)` and so on), so nothing here lists them.

export const SCRIPTS = [
  {
    name: 'price_drift_check',
    description:
      'Active articles whose current supplier price is more than `threshold` percent above the ERP purchase price, ' +
      'highest drift first. Walks every ERP page and asks the supplier in batches of 100 SKUs; returns only the ' +
      'articles that drifted.',
    parameters: {
      type: 'object',
      properties: { threshold: { type: 'number', description: 'Minimum drift in percent, e.g. 5.' } },
      required: ['threshold'],
    },
    code: `
// ERP: active articles, 100 per page, until the last page.
const articles = [];
for (let page = 1, pages = 1; page <= pages; page++) {
  const r = await tools.mock_erp_list_articles({ status: 'active', page, pageSize: 100 });
  pages = r.totalPages;
  articles.push(...r.items);
}

// Supplier: at most 100 SKUs per call. Articles it does not carry are simply absent.
const prices = {};
for (let i = 0; i < articles.length; i += 100) {
  const r = await tools.mock_supplier_get_prices({ skus: articles.slice(i, i + 100).map((a) => a.sku) });
  Object.assign(prices, r.prices);
}

return articles
  .filter((a) => prices[a.sku] !== undefined)
  .map((a) => {
    const drift = ((prices[a.sku] - a.purchasePrice) / a.purchasePrice) * 100;
    return { sku: a.sku, purchasePrice: a.purchasePrice, supplierPrice: prices[a.sku], driftPct: Math.round(drift * 10) / 10 };
  })
  .filter((row) => row.driftPct > args.threshold)
  .sort((x, y) => y.driftPct - x.driftPct);
`.trim(),
  },
  {
    name: 'catalogue_total',
    description:
      'Counts the items of one supplier catalogue category by walking every page (the API never says how many ' +
      'pages exist: an empty page is the end). If a page fails it stops and returns what it counted with ' +
      'complete: false, instead of guessing.',
    parameters: {
      type: 'object',
      properties: { category: { type: 'string', description: 'fasteners, adhesives or legacy.' } },
      required: ['category'],
    },
    code: `
let total = 0;
for (let page = 1; ; page++) {
  let r;
  try {
    r = await tools.mock_supplier_list_catalogue({ category: args.category, page });
  } catch (err) {
    // The source failed part-way: report what was counted and say it is not the whole.
    return { category: args.category, total, complete: false };
  }
  if (!r.items || r.items.length === 0) return { category: args.category, total, complete: true };
  total += r.items.length;
}
`.trim(),
  },
  {
    name: 'stuck_orders',
    description:
      'Shipped ERP orders whose parcel is not delivered and has not been scanned for more than `days` days before ' +
      '`as_of`, oldest scan first. Joins the ERP orders with the carrier tracking, one lookup per shipped order.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Days without a scan.' },
        as_of: { type: 'string', description: 'Reference time, ISO 8601, so the answer does not depend on today.' },
      },
      required: ['days', 'as_of'],
    },
    code: `
const cutoff = Date.parse(args.as_of) - args.days * 24 * 3600 * 1000;

// ERP: every shipped order, 50 per page.
const shipped = [];
for (let page = 1, pages = 1; page <= pages; page++) {
  const r = await tools.mock_erp_list_orders({ status: 'shipped', page, pageSize: 50 });
  pages = r.totalPages;
  shipped.push(...r.items);
}

// Carrier: where is each parcel?
const stuck = [];
for (const order of shipped) {
  const parcel = await tools.mock_carrier_get_tracking({ tracking_no: order.trackingNo });
  if (parcel.status !== 'delivered' && Date.parse(parcel.lastScanAt) < cutoff) {
    stuck.push({ orderNo: order.orderNo, trackingNo: parcel.trackingNo, status: parcel.status, lastScanAt: parcel.lastScanAt });
  }
}
return stuck.sort((a, b) => Date.parse(a.lastScanAt) - Date.parse(b.lastScanAt));
`.trim(),
  },
  {
    // Level 3. No tool exposes GET /v1/account, so the script calls it directly, with the key
    // the connector already holds. It needs the connector's variables (env) and a request to
    // the connector's own host (http).
    name: 'supplier_account',
    description:
      'Reads the supplier account (name and customer number) with the API key the Mock Supplier connector ' +
      'holds. Calls GET /v1/account directly, which no tool exposes. The key never appears in the answer.',
    parameters: { type: 'object', properties: {}, required: [] },
    capabilities: { env: true, http: true },
    // The code calls no tool, so the connector it is bound to is declared by naming one of its tools.
    declareTools: ['mock_supplier_list_catalogue'],
    code: `
const r = await http.fetch(\`\${env.MOCK_SUPPLIER_URL}/v1/account\`, {
  headers: { 'X-Api-Key': env.MOCK_SUPPLIER_API_KEY },
});
if (r.status !== 200) throw new Error(\`supplier account: HTTP \${r.status}\`);
return { accountName: r.json.accountName, customerNo: r.json.customerNo };
`.trim(),
  },
];

/**
 * Response Processing on the supplier's offers (Level 1): the US supplier answers in dollars with
 * messy descriptions; the chain runs after the supplier answered and before the tool's response
 * mapping. A price that is not a number stops the call with an error that names the path.
 */
export const PROCESSED_TOOL = 'mock_supplier_list_offers';
export const OFFER_CHAIN = {
  version: 1,
  enabled: true,
  onError: 'fail',
  steps: [
    { id: 'convert_to_eur', use: 'scale@1', each: '$.items[*]', reads: 'price_usd', writes: 'price_eur', mode: 'add', params: { factor: 0.92, round: 2 } },
    { id: 'add_vat', use: 'vat@1', each: '$.items[*]', reads: 'price_eur', writes: 'price_eur_gross', mode: 'add', params: { rate: 0.19, round: 2 } },
    { id: 'clean_description', use: 'clean_text@1', each: '$.items[*]', reads: 'description', writes: 'description', mode: 'replace', params: { trim: true, collapseWhitespace: true } },
  ],
};

/**
 * Tools that are lookups although they are POSTs: the supplier takes its SKUs in the body.
 * Scripts are read-only unless a tool is a read, and no heuristic can know that a POST is
 * one, so the administrator says so (PATCH .../tools/:id/annotations). Nothing else changes:
 * every other POST stays a write, and a script still cannot call it.
 */
export const READ_ONLY_POST_TOOLS = ['mock_supplier_get_prices'];
