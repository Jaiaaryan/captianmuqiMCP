/**
 * One-click questions for the Benchmark tab: a raw read-only tool call against a
 * script that answers the same question inside the gateway. The named presets
 * call the CODEBOUND mock connectors (kit `connectors/connectors.mjs`, demo
 * `backend/src/demo/demo-fixtures.ts`); every other read-only tool of the
 * server gets a generic entry.
 */

export interface BenchmarkPreset {
  id: string;
  /** Three words at most. */
  title: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  code: string;
  /** The script's `args`, if it reads any. */
  args?: Record<string, unknown>;
  /** Every tool the script calls; the preset is offered only when the server has them all. */
  needs: string[];
}

/** A JSON Schema property, as far as example values need it. */
interface SchemaProp {
  type?: string | string[];
  enum?: unknown[];
  default?: unknown;
  examples?: unknown[];
  example?: unknown;
  minimum?: number;
  description?: string;
  items?: SchemaProp;
}

export interface SchemaLike {
  properties?: Record<string, SchemaProp>;
  required?: string[];
}

export interface ToolSchema {
  name: string;
  parameters?: SchemaLike | null;
}

const PRICE_DRIFT = `// Active ERP articles whose supplier price is more than args.threshold % above the purchase price.
const articles = [];
for (let page = 1; ; page++) {
  const r = await tools.mock_erp_list_articles({ status: 'active', page, pageSize: 100 });
  const items = r.items ?? [];
  articles.push(...items);
  if (items.length === 0 || page >= (r.totalPages ?? 1)) break;
}
const price = {};
for (let i = 0; i < articles.length; i += 100) {
  const r = await tools.mock_supplier_get_prices({ skus: articles.slice(i, i + 100).map((a) => a.sku) });
  Object.assign(price, r.prices ?? {});
}
return articles
  .filter((a) => price[a.sku] !== undefined)
  .map((a) => ({
    sku: a.sku,
    purchasePrice: a.purchasePrice,
    supplierPrice: price[a.sku],
    driftPct: Math.round(((price[a.sku] - a.purchasePrice) / a.purchasePrice) * 1000) / 10,
  }))
  .filter((a) => a.driftPct > args.threshold)
  .sort((x, y) => y.driftPct - x.driftPct);
`;

const CATALOGUE = `// Walk the catalogue until an empty page; a failing page means incomplete.
let total = 0;
let complete = true;
for (let page = 1; ; page++) {
  let r;
  try {
    r = await tools.mock_supplier_list_catalogue({ category: args.category, page });
  } catch {
    complete = false;
    break;
  }
  const items = r.items ?? [];
  if (items.length === 0) break;
  total += items.length;
}
return { category: args.category, total, complete };
`;

const STUCK = `// Shipped orders whose parcel is not delivered and was last scanned over args.days days before args.as_of.
const cutoff = Date.parse(args.as_of) - args.days * 864e5;
const orders = [];
for (let page = 1; ; page++) {
  const r = await tools.mock_erp_list_orders({ status: 'shipped', page, pageSize: 50 });
  const items = r.items ?? [];
  orders.push(...items);
  if (items.length === 0 || page >= (r.totalPages ?? 1)) break;
}
const stuck = [];
for (const o of orders) {
  if (!o.trackingNo) continue;
  const t = await tools.mock_carrier_get_tracking({ tracking_no: o.trackingNo });
  if (t.status !== 'delivered' && Date.parse(t.lastScanAt) < cutoff) {
    stuck.push({ orderNo: o.orderNo, trackingNo: o.trackingNo, status: t.status, lastScanAt: t.lastScanAt });
  }
}
return stuck.sort((a, b) => a.lastScanAt.localeCompare(b.lastScanAt));
`;

const PING = `return await tools.mock_erp_ping({ nonce: 'bench' });
`;

export const NAMED_PRESETS: BenchmarkPreset[] = [
  {
    id: 'price-drift',
    title: 'Four rows from 400',
    toolName: 'mock_erp_list_articles',
    toolArgs: { page: 1 },
    code: PRICE_DRIFT,
    args: { threshold: 5 },
    needs: ['mock_erp_list_articles', 'mock_supplier_get_prices'],
  },
  {
    id: 'catalogue-total',
    title: 'Count a catalogue',
    toolName: 'mock_supplier_list_catalogue',
    toolArgs: { category: 'fasteners', page: 1 },
    code: CATALOGUE,
    args: { category: 'fasteners' },
    needs: ['mock_supplier_list_catalogue'],
  },
  {
    id: 'stuck-orders',
    title: 'Stuck orders',
    toolName: 'mock_erp_list_orders',
    toolArgs: { status: 'shipped' },
    code: STUCK,
    args: { days: 3, as_of: '2026-10-16T12:00:00.000Z' },
    needs: ['mock_erp_list_orders', 'mock_carrier_get_tracking'],
  },
  {
    id: 'ping',
    title: 'Ping',
    toolName: 'mock_erp_ping',
    toolArgs: { nonce: 'bench' },
    code: PING,
    needs: ['mock_erp_ping'],
  },
];

const READ_ONLY_NAME = /list|get|ping|search|catalogue|tracking|offers|prices|articles|orders/i;

/** Whether the raw side may call the tool. The backend refuses writes with a sentence. */
export function isReadOnlyName(name: string): boolean {
  return READ_ONLY_NAME.test(name);
}

const typeOf = (p: SchemaProp): string => (Array.isArray(p.type) ? p.type[0] : p.type) ?? 'string';

/** An example value for one property, from the schema first, then by name and type. */
export function exampleValue(name: string, p: SchemaProp = {}): unknown {
  if (p.examples?.length) return p.examples[0];
  if (p.example !== undefined) return p.example;
  if (p.default !== undefined) return p.default;
  if (p.enum?.length) return p.enum[0];
  switch (typeOf(p)) {
    case 'number':
    case 'integer':
      return /page/i.test(name) ? 1 : (p.minimum ?? 1);
    case 'boolean':
      return false;
    case 'array':
      return [exampleValue(name.replace(/s$/, ''), p.items ?? {})];
    case 'object':
      return {};
    default: {
      const eg = /e\.g\.\s*([\w.:/@-]+[\w])/i.exec(p.description ?? '');
      if (eg) return eg[1];
      // "fasteners, adhesives or legacy." / "Filter: open or shipped."
      const choice = /(?:^|:\s*)([\w-]+)(?:,\s|\sor\s)/.exec(p.description ?? '');
      if (choice) return choice[1];
      if (/(^|_)(date|from|to|since|until|as_of)($|_)|_at$/i.test(name)) return '2026-10-01';
      return 'example';
    }
  }
}

/** Example arguments: the required ones, or the first property when none is required. */
export function exampleArgs(schema: SchemaLike | null | undefined): Record<string, unknown> {
  const props = schema?.properties ?? {};
  const names = schema?.required?.length ? schema.required : Object.keys(props).slice(0, 1);
  return Object.fromEntries(names.map((n) => [n, exampleValue(n, props[n])]));
}

/** Every argument a saved script declares, filled with an example by type. */
export function exampleScriptArgs(schema: SchemaLike | null | undefined): Record<string, unknown> {
  const props = schema?.properties ?? {};
  return Object.fromEntries(Object.keys(props).map((n) => [n, exampleValue(n, props[n])]));
}

export const toJson = (v: Record<string, unknown> | undefined) =>
  v && Object.keys(v).length ? JSON.stringify(v, null, 2) : '';

const callLiteral = (args: Record<string, unknown>) => {
  const entries = Object.entries(args);
  if (!entries.length) return '{}';
  const key = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));
  return `{ ${entries.map(([k, v]) => `${key(k)}: ${JSON.stringify(v)}`).join(', ')} }`;
};

/** The generic question for any tool: how much does the answer hold. */
export function genericCode(tool: string, args: Record<string, unknown> = {}): string {
  return `const r = await tools.${tool}(${callLiteral(args)});
return Array.isArray(r) ? r.length : Object.keys(r ?? {}).length;
`;
}

/** The named presets whose tools all exist on the server, then one generic entry per read-only tool. */
export function presetsFor(toolNames: string[], schemas: ToolSchema[] | null): BenchmarkPreset[] {
  const have = new Set(toolNames);
  const byName = new Map((schemas ?? []).map((t) => [t.name, t]));
  const named = NAMED_PRESETS.filter((p) => p.needs.every((n) => have.has(n)));
  const generic = toolNames.filter(isReadOnlyName).map((name): BenchmarkPreset => {
    const toolArgs = exampleArgs(byName.get(name)?.parameters ?? null);
    return { id: `tool:${name}`, title: name, toolName: name, toolArgs, code: genericCode(name, toolArgs), needs: [name] };
  });
  return [...named, ...generic];
}
