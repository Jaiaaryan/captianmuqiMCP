import { BadRequestException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { FlowAskDto, FlowEventsQueryDto, FlowQueryDto } from './flow.dto';
import { FlowService } from './flow.service';
import { FlowController, flowAskTracker } from './flow.controller';
import type { FlowAskService } from './flow-ask.service';

// The same pipe main.ts installs globally.
const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
const parse = (query: Record<string, unknown>) =>
  pipe.transform(query, { type: 'query', metatype: FlowQueryDto }) as Promise<FlowQueryDto>;
const parseEvents = (query: Record<string, unknown>) =>
  pipe.transform(query, { type: 'query', metatype: FlowEventsQueryDto }) as Promise<FlowEventsQueryDto>;
const parseAsk = (body: Record<string, unknown>) =>
  pipe.transform(body, { type: 'body', metatype: FlowAskDto }) as Promise<FlowAskDto>;

const req = (organizationId: string) => ({ user: { sub: 'u1', organizationId } }) as any;

describe('FlowController', () => {
  const buildGraph = jest.fn();
  const listEvents = jest.fn();
  const ask = jest.fn();
  const status = jest.fn();
  const controller = new FlowController(
    { buildGraph, listEvents } as unknown as FlowService,
    { ask, status } as unknown as FlowAskService,
  );

  beforeEach(() => {
    buildGraph.mockReset();
    listEvents.mockReset();
    ask.mockReset();
    status.mockReset();
  });

  describe('query validation', () => {
    it('accepts a server id and defaults since to 24h in the controller', async () => {
      const q = await parse({ serverId: 'srv-1' });
      expect(q).toEqual({ serverId: 'srv-1' });
      buildGraph.mockResolvedValue({ nodes: [], edges: [] });
      await controller.getFlow(req('org-a'), q);
      expect(buildGraph).toHaveBeenCalledWith('org-a', 'srv-1', '24h');
    });

    it.each(['1h', '24h', '7d'])('accepts since=%s', async (since) => {
      const q = await parse({ serverId: 'srv-1', since });
      buildGraph.mockResolvedValue({});
      await controller.getFlow(req('org-a'), q);
      expect(buildGraph).toHaveBeenCalledWith('org-a', 'srv-1', since);
    });

    it.each(['2h', '30d', '', 'forever'])('rejects since=%j with 400', async (since) => {
      await expect(parse({ serverId: 'srv-1', since })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('draws every server when serverId is left out', async () => {
      const q = await parse({ since: '1h' });
      buildGraph.mockResolvedValue({});
      await controller.getFlow(req('org-a'), q);
      expect(buildGraph).toHaveBeenCalledWith('org-a', null, '1h');
    });

    it('rejects an empty serverId and unknown parameters with 400', async () => {
      await expect(parse({ serverId: '' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(parse({ serverId: 'srv-1', organizationId: 'org-b' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  it('uses the organization of the caller, never one from the request', async () => {
    buildGraph.mockResolvedValue({});
    await controller.getFlow(req('org-a'), { serverId: 'srv-1', since: '1h' });
    expect(buildGraph).toHaveBeenCalledWith('org-a', 'srv-1', '1h');
  });

  it('passes a 404 for a server of another organization through', async () => {
    buildGraph.mockRejectedValue(new NotFoundException('MCP server not found'));
    await expect(controller.getFlow(req('org-a'), { serverId: 'srv-of-b' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  describe('events', () => {
    it('defaults to every server, 24h, now and the service limit', async () => {
      const q = await parseEvents({});
      listEvents.mockResolvedValue({ events: [] });
      await controller.getEvents(req('org-a'), q);
      expect(listEvents).toHaveBeenCalledWith('org-a', null, '24h', undefined, undefined);
    });

    it('accepts a window token or an ISO time, until and a numeric limit', async () => {
      const q = await parseEvents({ serverId: 'srv-1', since: '2026-10-17T10:00:00Z', until: '2026-10-17T11:00:00.000Z', limit: '50' });
      expect(q.limit).toBe(50);
      listEvents.mockResolvedValue({ events: [] });
      await controller.getEvents(req('org-a'), q);
      expect(listEvents).toHaveBeenCalledWith('org-a', 'srv-1', '2026-10-17T10:00:00Z', '2026-10-17T11:00:00.000Z', 50);
      await expect(parseEvents({ since: '7d' })).resolves.toEqual({ since: '7d' });
    });

    it.each([{ since: '2h' }, { since: 'yesterday' }, { until: 'soon' }, { limit: '0' }, { limit: '2001' }, { limit: 'x' }])(
      'rejects %j with 400',
      async (q) => {
        await expect(parseEvents(q)).rejects.toBeInstanceOf(BadRequestException);
      },
    );
  });

  describe('ask', () => {
    it('validates the question: trimmed, 1 to 500 characters', async () => {
      const ok = await parseAsk({ question: '  Why?  ', window: '1h', nodeId: 'tool:t1', serverId: null });
      expect(ok.question).toBe('Why?');
      await expect(parseAsk({ question: '   ' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(parseAsk({ question: 'x'.repeat(501) })).rejects.toBeInstanceOf(BadRequestException);
      await expect(parseAsk({ question: 'ok', window: '2h' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(parseAsk({ question: 'ok', organizationId: 'org-b' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('asks in the caller organization', async () => {
      ask.mockResolvedValue({ answer: 'a', model: 'm' });
      await expect(controller.ask(req('org-a'), { question: 'q' } as FlowAskDto)).resolves.toEqual({ answer: 'a', model: 'm' });
      expect(ask).toHaveBeenCalledWith('org-a', { question: 'q' });
      status.mockResolvedValue({ enabled: false });
      await expect(controller.askStatus(req('org-a'))).resolves.toEqual({ enabled: false });
      expect(status).toHaveBeenCalledWith('org-a');
    });

    it('rate-limits 10 per minute, keyed by the user of the token', () => {
      const meta = (key: string) => Reflect.getMetadata(key, FlowController.prototype.ask);
      expect(meta('THROTTLER:LIMITdefault')).toBe(10);
      expect(meta('THROTTLER:TTLdefault')).toBe(60_000);
      expect(meta('THROTTLER:TRACKERdefault')).toBe(flowAskTracker);
      const jwt = (payload: object) =>
        `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
      expect(flowAskTracker({ headers: { authorization: `Bearer ${jwt({ sub: 'u1' })}` }, ip: '1.2.3.4' })).toBe('user:u1');
      expect(flowAskTracker({ headers: { authorization: 'Bearer nonsense' }, ip: '1.2.3.4' })).toBe('ip:1.2.3.4');
      expect(flowAskTracker({ headers: {}, ip: '1.2.3.4' })).toBe('ip:1.2.3.4');
    });
  });
});
