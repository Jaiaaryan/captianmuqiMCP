import { BadRequestException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { FlowController } from './flow.controller';
import { FlowQueryDto } from './flow.dto';
import { FlowService } from './flow.service';

// The same pipe main.ts installs globally.
const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
const parse = (query: Record<string, unknown>) =>
  pipe.transform(query, { type: 'query', metatype: FlowQueryDto }) as Promise<FlowQueryDto>;

const req = (organizationId: string) => ({ user: { sub: 'u1', organizationId } }) as any;

describe('FlowController', () => {
  const buildGraph = jest.fn();
  const controller = new FlowController({ buildGraph } as unknown as FlowService);

  beforeEach(() => buildGraph.mockReset());

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

    it('rejects a missing serverId and unknown parameters with 400', async () => {
      await expect(parse({ since: '1h' })).rejects.toBeInstanceOf(BadRequestException);
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
});
