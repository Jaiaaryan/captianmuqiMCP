import { BadGatewayException, ConflictException } from '@nestjs/common';
import { ASK_GRAPH_BYTES, ASK_SYSTEM_PROMPT, FlowAskService, buildAskContext } from './flow-ask.service';
import type { FlowGraph } from './flow.service';
import * as llm from '../knowledge-graph/llm-client';

jest.mock('../knowledge-graph/llm-client', () => ({
  resolveLlmConfig: jest.fn(),
  chatText: jest.fn(),
}));

const resolveLlmConfig = llm.resolveLlmConfig as jest.Mock;
const chatText = llm.chatText as jest.Mock;

const NOW = Date.parse('2026-10-17T12:00:00Z');

const GRAPH: FlowGraph = {
  serverId: 'srv-1',
  since: '2026-10-16T12:00:00.000Z',
  generatedAt: '2026-10-17T12:00:00.000Z',
  nodes: [
    { id: 'agent', kind: 'agent', label: 'Agent', stats: { calls: 9, errors: 4 } },
    { id: 'server:srv-1', kind: 'server', label: 'Main', stats: { calls: 9, errors: 4 } },
    { id: 'tool:t1', kind: 'tool', label: 'mock_supplier_list_offers', stats: { calls: 7, errors: 4, lastAt: '2026-10-17T11:55:00.000Z' }, meta: { readOnly: true } },
    { id: 'connector:c1', kind: 'connector', label: 'Supplier', stats: { calls: 7, errors: 4 } },
  ],
  edges: [
    { id: 'mcp:agent>server:srv-1', source: 'agent', target: 'server:srv-1', kind: 'mcp', stats: { calls: 9, errors: 4 } },
    { id: 'tool:server:srv-1>tool:t1', source: 'server:srv-1', target: 'tool:t1', kind: 'tool', stats: { calls: 7, errors: 4 } },
    { id: 'http:tool:t1>connector:c1', source: 'tool:t1', target: 'connector:c1', kind: 'http', stats: { calls: 7, errors: 4 } },
  ],
};

describe('buildAskContext', () => {
  it('sends ids, kinds, labels and counts, the selected node and the latest errors with their age', () => {
    const ctx = JSON.parse(
      buildAskContext(GRAPH, '24h', 'tool:t1', [
        { at: new Date(NOW - 5 * 60_000), nodeId: 'tool:t1', message: 'HTTP 500\n  upstream down' },
      ], NOW),
    );
    expect(ctx.graph.window).toBe('24h');
    expect(ctx.graph.server).toBe('srv-1');
    // The selected node and its neighbours come first.
    expect(ctx.graph.nodes.slice(0, 3).map((n: unknown[]) => n[0])).toEqual(['tool:t1', 'server:srv-1', 'connector:c1']);
    expect(ctx.graph.nodes.map((n: unknown[]) => n[0])).toEqual(
      expect.arrayContaining(['agent', 'server:srv-1', 'tool:t1', 'connector:c1']),
    );
    expect(ctx.graph.nodes.find((n: unknown[]) => n[0] === 'tool:t1')).toEqual(['tool:t1', 'tool', 'mock_supplier_list_offers', 7, 4]);
    expect(ctx.graph.edges).toContainEqual(['tool:t1', 'connector:c1', 'http', 7, 4]);
    expect(ctx.selected).toMatchObject({ id: 'tool:t1', kind: 'tool', calls: 7, errors: 4, lastCall: '5m', meta: { readOnly: true } });
    expect(ctx.selected.edges).toHaveLength(2);
    expect(ctx.recentErrors).toEqual([
      { age: '5m', node: 'tool:t1', label: 'mock_supplier_list_offers', message: 'HTTP 500 upstream down' },
    ]);
    // No absolute times: they would only be redacted as numbers.
    expect(JSON.stringify(ctx)).not.toMatch(/2026-/);
  });

  it('trims a large graph to the byte budget and says how much it left out', () => {
    const nodes = Array.from({ length: 2000 }, (_, i) => ({
      id: `tool:t${i}`,
      kind: 'tool' as const,
      label: `tool_number_${i}_with_a_long_name`,
      stats: { calls: i, errors: i === 1999 ? 1 : 0 },
    }));
    const edges = nodes.map((n) => ({ id: `e${n.id}`, source: 'server:s', target: n.id, kind: 'tool' as const, stats: { calls: 1, errors: 0 } }));
    const ctx = JSON.parse(buildAskContext({ ...GRAPH, serverId: null, nodes, edges }, '1h', undefined, []));
    expect(Buffer.byteLength(JSON.stringify(ctx.graph))).toBeLessThanOrEqual(ASK_GRAPH_BYTES);
    expect(ctx.graph.server).toBe('all');
    expect(ctx.graph.omittedNodes).toBeGreaterThan(0);
    // Errors first, then calls.
    expect(ctx.graph.nodes[0][0]).toBe('tool:t1999');
    expect(ctx.graph.nodes[1][0]).toBe('tool:t1998');
    expect(ctx.selected).toBeNull();
  });
});

describe('FlowAskService', () => {
  const buildGraph = jest.fn();
  const recentErrors = jest.fn();
  const isEnabled = jest.fn();
  const service = new FlowAskService({ buildGraph, recentErrors } as any, { isEnabled } as any);
  const CFG = { provider: 'custom', model: 'stub-1', apiKey: '', baseUrl: 'http://127.0.0.1:9' };

  beforeEach(() => {
    jest.clearAllMocks();
    resolveLlmConfig.mockReturnValue(CFG);
    isEnabled.mockResolvedValue(true);
    buildGraph.mockResolvedValue(GRAPH);
    recentErrors.mockResolvedValue([{ at: new Date(), nodeId: 'tool:t1', message: 'mail bob@example.com failed' }]);
    chatText.mockResolvedValue({ text: 'tool:t1 failed 4 of 7 calls.', usage: { inputTokens: 900, outputTokens: 12 } });
  });

  it('answers 409 LLM_OFF without a provider, or when the workspace switch is off, reading nothing', async () => {
    resolveLlmConfig.mockReturnValue(null);
    await expect(service.ask('org-a', { question: 'q' })).rejects.toMatchObject({
      constructor: ConflictException,
      response: { code: 'LLM_OFF' },
    });
    resolveLlmConfig.mockReturnValue(CFG);
    isEnabled.mockResolvedValue(false);
    const err = await service.ask('org-a', { question: 'q' }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: 'LLM_OFF' });
    expect(isEnabled).toHaveBeenCalledWith('org-a');
    expect(buildGraph).not.toHaveBeenCalled();
    expect(chatText).not.toHaveBeenCalled();
    await expect(service.status('org-a')).resolves.toEqual({ enabled: false });
  });

  it('builds the context for the organization, server and window, redacts it and returns the answer', async () => {
    const out = await service.ask('org-a', { question: 'Why did it fail? call +49 170 1234567', serverId: 'srv-1', window: '1h', nodeId: 'tool:t1' });
    expect(out).toEqual({ answer: 'tool:t1 failed 4 of 7 calls.', model: 'stub-1', usage: { inputTokens: 900, outputTokens: 12 } });
    expect(buildGraph).toHaveBeenCalledWith('org-a', 'srv-1', '1h');
    expect(recentErrors).toHaveBeenCalledWith('org-a', 'srv-1', '1h', 10);
    const [cfg, system, user, maxTokens] = chatText.mock.calls[0];
    expect(cfg).toBe(CFG);
    expect(system).toBe(ASK_SYSTEM_PROMPT);
    expect(system).toMatch(/language of the question/);
    expect(system).toMatch(/120 words/);
    expect(system).toMatch(/never invent data/);
    expect(maxTokens).toBeLessThanOrEqual(400);
    expect(user).toContain('Why did it fail?');
    expect(user).toContain('mock_supplier_list_offers');
    expect(user).toContain('[email]');
    expect(user).not.toContain('bob@example.com');
    expect(user).not.toContain('1234567');
    await expect(service.status('org-a')).resolves.toEqual({ enabled: true, model: 'stub-1' });
  });

  it('asks about every server when serverId is null or left out, 24h by default', async () => {
    await service.ask('org-a', { question: 'q', serverId: null });
    expect(buildGraph).toHaveBeenCalledWith('org-a', null, '24h');
  });

  it('turns a provider failure into 502 with the status only, logging neither question nor answer', async () => {
    chatText.mockRejectedValue(new Error('LLM 401: {"error":"bad key","echo":"secret question"}'));
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    const log = jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
    const err = await service.ask('org-a', { question: 'secret question' }).catch((e) => e);
    expect(err).toBeInstanceOf(BadGatewayException);
    expect(err.getResponse()).toMatchObject({ code: 'LLM_ERROR', message: 'LLM 401' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret question');
    expect(log).not.toHaveBeenCalled();
  });
});
