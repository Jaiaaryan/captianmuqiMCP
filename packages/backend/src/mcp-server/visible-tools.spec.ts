import type { RegisteredTool } from './tool-registry';
import { toSandboxTools, visibleServerTools } from './visible-tools';

function tool(over: Partial<RegisteredTool> & { id: string; name: string }): RegisteredTool {
  return {
    connectorId: 'conn-1',
    organizationId: 'org-a',
    description: `${over.name} tool`,
    parameters: { type: 'object', properties: {} },
    connectorType: 'REST',
    connectorConfig: { baseUrl: 'https://api.example.com', authType: 'NONE' },
    endpointMapping: { method: 'GET', path: '/x' },
    ...over,
  };
}

const orders = tool({ id: 't1', name: 'shop_list_orders' });
const refunds = tool({ id: 't2', name: 'shop_create_refund' });
const customers = tool({ id: 't3', name: 'shop_list_customers' });

describe('visibleServerTools', () => {
  it('keeps every tool when the caller is unrestricted (null allow-list)', () => {
    expect(visibleServerTools([orders, refunds, customers], null)).toEqual([
      orders,
      refunds,
      customers,
    ]);
  });

  it('keeps only the tools the role allows, in registration order', () => {
    expect(visibleServerTools([orders, refunds, customers], ['t3', 't1'])).toEqual([
      orders,
      customers,
    ]);
  });

  it('gives a caller with an empty allow-list nothing (fail closed)', () => {
    expect(visibleServerTools([orders, refunds], [])).toEqual([]);
  });

  it('drops tools whose connector is not set up, and keeps ones with no status', () => {
    const pending = tool({ id: 't4', name: 'erp_pending', setupStatus: 'needs_credentials' as any });
    const ready = tool({ id: 't5', name: 'erp_ready', setupStatus: 'ready' });
    expect(visibleServerTools([pending, ready, orders], null)).toEqual([ready, orders]);
  });

  it('keeps the first tool of a duplicated name and reports the skipped copy', () => {
    const copy = tool({ id: 't9', name: 'shop_list_orders', connectorId: 'conn-2' });
    const skipped: RegisteredTool[] = [];
    const out = visibleServerTools([orders, copy], null, (t) => skipped.push(t));
    expect(out).toEqual([orders]);
    expect(skipped).toEqual([copy]);
  });

  it('does not report a duplicate that the role filter already hid', () => {
    const copy = tool({ id: 't9', name: 'shop_list_orders', connectorId: 'conn-2' });
    const skipped: RegisteredTool[] = [];
    // Only the copy is allowed: it becomes the visible one, and nothing is a duplicate.
    const out = visibleServerTools([orders, copy], ['t9'], (t) => skipped.push(t));
    expect(out).toEqual([copy]);
    expect(skipped).toEqual([]);
  });

  it('does not mutate its inputs', () => {
    const list = [orders, refunds];
    const allowed = ['t1'];
    visibleServerTools(list, allowed);
    expect(list).toEqual([orders, refunds]);
    expect(allowed).toEqual(['t1']);
  });
});

describe('toSandboxTools', () => {
  it('exposes name, connector, description, schema and output schema only', () => {
    const t = tool({ id: 't1', name: 'shop_list_orders', outputSchema: { type: 'array' } });
    expect(toSandboxTools([t])).toEqual([
      {
        name: 'shop_list_orders',
        connectorId: 'conn-1',
        description: 'shop_list_orders tool',
        parameters: { type: 'object', properties: {} },
        outputSchema: { type: 'array' },
      },
    ]);
  });

  it('does not leak connector credentials or endpoints into the script-facing tool', () => {
    const t = tool({
      id: 't1',
      name: 'shop_list_orders',
      connectorConfig: {
        baseUrl: 'https://secret.internal',
        authType: 'API_KEY',
        authConfig: '{"apiKey":"sk-live-123"}',
        headers: { 'X-Token': 'abc' },
      },
    });
    const json = JSON.stringify(toSandboxTools([t]));
    expect(json).not.toContain('sk-live-123');
    expect(json).not.toContain('secret.internal');
    expect(json).not.toContain('X-Token');
  });

  it('hides parameters that the gateway fills from environment variables', () => {
    const t = tool({
      id: 't1',
      name: 'shop_list_orders',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number' }, apiKey: { type: 'string' } },
        required: ['apiKey'],
      },
      connectorConfig: {
        baseUrl: 'https://api.example.com',
        authType: 'NONE',
        envVars: { apiKey: 'from-env' },
      },
    });
    const [out] = toSandboxTools([t]);
    expect(Object.keys((out.parameters as any).properties)).toEqual(['limit']);
  });
});
