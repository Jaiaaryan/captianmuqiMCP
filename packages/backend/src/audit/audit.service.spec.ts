import { AuditService } from './audit.service';

describe('AuditService', () => {
  let service: AuditService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      toolInvocation: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        aggregate: jest.fn().mockResolvedValue({ _sum: { repeatCount: 0 } }),
        update: jest.fn().mockResolvedValue({}),
      },
      // resolveUserId consults users to satisfy the FK before insert.
      // Default: the test user exists. Individual tests override
      // findUnique to simulate missing-row or email-fallback paths.
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-1' }),
      },
    };
    service = new AuditService(mockPrisma);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  describe('logInvocation', () => {
    it('should persist an invocation record', async () => {
      await service.logInvocation({
        toolId: 'tool-1',
        userId: 'user-1',
        input: { query: 'test' },
        output: { result: 'ok' },
        status: 'SUCCESS',
        durationMs: 150,
      });

      expect(mockPrisma.toolInvocation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            toolId: 'tool-1',
            userId: 'user-1',
            status: 'SUCCESS',
            durationMs: 150,
          }),
        }),
      );
    });

    it('should not throw if persistence fails', async () => {
      mockPrisma.toolInvocation.create.mockRejectedValue(new Error('DB down'));

      await expect(
        service.logInvocation({
          toolId: 'tool-1',
          input: {},
          status: 'ERROR',
          error: 'something broke',
        }),
      ).resolves.not.toThrow();
    });
  });

  describe('getRecentInvocations', () => {
    it('should query with default pagination', async () => {
      await service.getRecentInvocations();

      expect(mockPrisma.toolInvocation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 100,
          skip: 0,
          orderBy: { createdAt: 'desc' },
        }),
      );
    });

    it('should apply filters', async () => {
      await service.getRecentInvocations(50, 10, {
        toolId: 'tool-1',
        status: 'ERROR',
      });

      expect(mockPrisma.toolInvocation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { toolId: 'tool-1', status: 'ERROR' },
          take: 50,
          skip: 10,
        }),
      );
    });
  });

  describe('getStats', () => {
    it('should return aggregated stats', async () => {
      mockPrisma.toolInvocation.aggregate
        .mockResolvedValueOnce({ _sum: { repeatCount: 10 } }) // 24h invocations
        .mockResolvedValueOnce({ _sum: { repeatCount: 2 } }) // 24h errors
        .mockResolvedValueOnce({ _sum: { repeatCount: 50 } }) // 7d invocations
        .mockResolvedValueOnce({ _sum: { repeatCount: 100 } }); // total

      const stats = await service.getStats();

      expect(stats).toEqual({
        invocations24h: 10,
        errors24h: 2,
        invocations7d: 50,
        totalInvocations: 100,
      });
      expect(mockPrisma.toolInvocation.aggregate).toHaveBeenCalledTimes(4);
    });
  });

  describe('repeated failures', () => {
    const fail = (error = '429 Too Many Requests: body={"code":429,"msg":"Request rate limit reached"}') =>
      service.logInvocation({
        toolId: 'tool-1',
        connectorId: 'conn-1',
        organizationId: 'org-1',
        input: { view: 'api.pgb_v1' },
        status: 'ERROR',
        error,
      });

    beforeEach(() => {
      let n = 0;
      mockPrisma.toolInvocation.create.mockImplementation(async () => ({ id: `row-${++n}` }));
    });

    it('stores the first failure and counts identical ones on it', async () => {
      await fail();
      await fail();
      await fail();
      expect(mockPrisma.toolInvocation.create).toHaveBeenCalledTimes(1);

      await service.flushRepeats(true);
      expect(mockPrisma.toolInvocation.update).toHaveBeenCalledWith({
        where: { id: 'row-1' },
        data: { repeatCount: { increment: 2 } },
      });
    });

    it('treats errors that differ only in numbers as the same', async () => {
      await fail('upstream timeout after 3012 ms (request 8812)');
      await fail('upstream timeout after 2977 ms (request 9001)');
      expect(mockPrisma.toolInvocation.create).toHaveBeenCalledTimes(1);
    });

    it('stores a different error, or a success, as its own row', async () => {
      await fail();
      await fail('403 Forbidden: Access denied');
      await service.logInvocation({ toolId: 'tool-1', connectorId: 'conn-1', input: {}, status: 'SUCCESS' });
      expect(mockPrisma.toolInvocation.create).toHaveBeenCalledTimes(3);
    });

    it('stores the failure again once the window has passed, carrying over the count', async () => {
      const now = jest.spyOn(Date, 'now');
      now.mockReturnValue(1_000_000);
      await fail();
      await fail();
      now.mockReturnValue(1_000_000 + 61_000);
      await fail();
      expect(mockPrisma.toolInvocation.create).toHaveBeenCalledTimes(2);
      expect(mockPrisma.toolInvocation.update).toHaveBeenCalledWith({
        where: { id: 'row-1' },
        data: { repeatCount: { increment: 1 } },
      });
      now.mockRestore();
    });
  });

  describe('connector-failure alerts', () => {
    it('notifies on every failing call, even ones the repeat-dedup check collapses into an existing row', async () => {
      const alerts = { recordFailure: jest.fn().mockResolvedValue(undefined) };
      const svc = new AuditService(mockPrisma, undefined, alerts as any);
      // Dedup only engages once create() returns a row id to count repeats
      // against — same setup as the 'repeated failures' block above.
      let n = 0;
      mockPrisma.toolInvocation.create.mockImplementation(async () => ({ id: `row-${++n}` }));

      const fail = () =>
        svc.logInvocation({
          toolId: 'tool-1',
          connectorId: 'conn-1',
          organizationId: 'org-1',
          input: {},
          status: 'ERROR',
          error: '429 Too Many Requests',
        });

      await fail();
      await fail();
      await fail();
      // Only one row was written (see 'repeated failures' above), but all
      // three attempts are real failures and must all reach the alert hook.
      expect(mockPrisma.toolInvocation.create).toHaveBeenCalledTimes(1);
      expect(alerts.recordFailure).toHaveBeenCalledTimes(3);
      expect(alerts.recordFailure).toHaveBeenCalledWith({
        organizationId: 'org-1',
        connectorId: 'conn-1',
        toolId: 'tool-1',
        error: '429 Too Many Requests',
      });

      await svc.onModuleDestroy();
    });

    it('does not notify on success, or when organizationId/connectorId is missing', async () => {
      const alerts = { recordFailure: jest.fn().mockResolvedValue(undefined) };
      const svc = new AuditService(mockPrisma, undefined, alerts as any);

      await svc.logInvocation({ toolId: 't', organizationId: 'org-1', connectorId: 'conn-1', input: {}, status: 'SUCCESS' });
      await svc.logInvocation({ toolId: 't', connectorId: 'conn-1', input: {}, status: 'ERROR', error: 'e' }); // no org
      await svc.logInvocation({ toolId: 't', organizationId: 'org-1', input: {}, status: 'ERROR', error: 'e' }); // no connector

      expect(alerts.recordFailure).not.toHaveBeenCalled();
      await svc.onModuleDestroy();
    });

    it('never lets a failing alert dispatch affect logInvocation', async () => {
      const alerts = { recordFailure: jest.fn().mockRejectedValue(new Error('webhook down')) };
      const svc = new AuditService(mockPrisma, undefined, alerts as any);

      await expect(
        svc.logInvocation({
          toolId: 't',
          organizationId: 'org-1',
          connectorId: 'conn-1',
          input: {},
          status: 'ERROR',
          error: 'e',
        }),
      ).resolves.toBeUndefined();

      await svc.onModuleDestroy();
    });
  });

  describe('payload budget', () => {
    it('keeps only a short excerpt once an organisation has logged its hourly budget', async () => {
      const big = { rows: 'x'.repeat(20_000) };
      for (let i = 0; i < 1001; i++) {
        await service.logInvocation({ toolId: 't', organizationId: 'busy-org', input: {}, output: big, status: 'SUCCESS' });
      }
      const calls = mockPrisma.toolInvocation.create.mock.calls;
      const size = (call: any) => JSON.stringify(call[0].data.output).length;
      // Within the budget the normal excerpt rules apply; past it, 512 bytes.
      expect(size(calls[999])).toBeGreaterThan(1_500);
      expect(size(calls[1000])).toBeLessThanOrEqual(512);
      expect(calls[1000][0].data.status).toBe('SUCCESS');
    });
  });

  describe('logRefusal', () => {
    let securityEvents: { log: jest.Mock };
    let svc: AuditService;

    beforeEach(() => {
      mockPrisma.toolInvocation.create = jest.fn().mockResolvedValue({ id: 'row-1' });
      mockPrisma.mcpTool = { findFirst: jest.fn().mockResolvedValue(null) };
      securityEvents = { log: jest.fn().mockResolvedValue(undefined) };
      svc = new AuditService(mockPrisma, undefined, undefined, undefined, securityEvents as any);
    });

    afterEach(async () => {
      await svc.onModuleDestroy();
    });

    const refusal = {
      organizationId: 'org-a',
      userId: 'user-1',
      mcpServerId: 'srv-a',
      toolName: 'mock_payroll_list_salaries',
      code: 'ROLE_FORBIDDEN' as const,
      reason: 'not granted   by\nrole',
      sandboxRunId: 'run-1',
    };

    it('writes a tool_invocations ERROR row when the tool is in the caller org', async () => {
      mockPrisma.mcpTool.findFirst.mockResolvedValue({ id: 'tool-payroll', connectorId: 'conn-payroll' });
      await svc.logRefusal(refusal);

      expect(mockPrisma.mcpTool.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ connector: { organizationId: 'org-a' } }),
        }),
      );
      expect(mockPrisma.toolInvocation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            toolId: 'tool-payroll',
            connectorId: 'conn-payroll',
            organizationId: 'org-a',
            userId: 'user-1',
            status: 'ERROR',
            durationMs: 0,
            error: 'REFUSED ROLE_FORBIDDEN: not granted by role',
            input: { refused: true, toolName: 'mock_payroll_list_salaries' },
          }),
        }),
      );
      expect(securityEvents.log).not.toHaveBeenCalled();
    });

    it('writes a TOOL_REFUSED security event in the caller org when no org tool matches', async () => {
      await svc.logRefusal({ ...refusal, organizationId: 'org-b', code: 'TOOL_NOT_ALLOWED', requestedToolId: 'tool-of-a' });

      expect(mockPrisma.toolInvocation.create).not.toHaveBeenCalled();
      expect(securityEvents.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'TOOL_REFUSED',
          actorType: 'USER',
          organizationId: 'org-b',
          actorUserId: 'user-1',
          metadata: expect.objectContaining({
            toolName: 'mock_payroll_list_salaries',
            code: 'TOOL_NOT_ALLOWED',
            error: 'REFUSED TOOL_NOT_ALLOWED: not granted by role',
            sandboxRunId: 'run-1',
          }),
        }),
      );
    });

    it('never stores more than the tool name, code and reason', async () => {
      mockPrisma.mcpTool.findFirst.mockResolvedValue({ id: 't', connectorId: 'c' });
      await svc.logRefusal({ ...refusal, args: { password: 'hunter2' } } as any);
      expect(JSON.stringify(mockPrisma.toolInvocation.create.mock.calls)).not.toContain('hunter2');
    });

    it('counts a repeat on the first row instead of writing another', async () => {
      mockPrisma.mcpTool.findFirst.mockResolvedValue({ id: 't', connectorId: 'c' });
      await svc.logRefusal(refusal);
      await svc.logRefusal(refusal);
      expect(mockPrisma.toolInvocation.create).toHaveBeenCalledTimes(1);
      await svc.flushRepeats(true);
      expect(mockPrisma.toolInvocation.update).toHaveBeenCalledWith({
        where: { id: 'row-1' },
        data: { repeatCount: { increment: 1 } },
      });
    });

    it('caps the rows one caller can add in a run', async () => {
      for (let i = 0; i < 50; i++) {
        await svc.logRefusal({ ...refusal, toolName: `tool_${i}`, code: 'TOOL_NOT_ALLOWED' });
      }
      expect(securityEvents.log).toHaveBeenCalledTimes(20);
    });

    it('never throws, whatever fails', async () => {
      mockPrisma.mcpTool.findFirst.mockRejectedValue(new Error('DB down'));
      await expect(svc.logRefusal(refusal)).resolves.toBeUndefined();
      mockPrisma.mcpTool.findFirst.mockResolvedValue({ id: 't', connectorId: 'c' });
      mockPrisma.toolInvocation.create.mockRejectedValue(new Error('DB down'));
      await expect(svc.logRefusal({ ...refusal, toolName: 'other' })).resolves.toBeUndefined();
      await expect(svc.logRefusal(null as any)).resolves.toBeUndefined();
    });
  });

  describe('getRecentRefusals', () => {
    it('merges both row types of the org, newest first', async () => {
      mockPrisma.toolInvocation.findMany.mockResolvedValue([
        {
          id: 'i1',
          createdAt: new Date('2026-10-17T10:00:00Z'),
          error: 'REFUSED ROLE_FORBIDDEN: no',
          repeatCount: 2,
          clientInfo: JSON.stringify({ sandboxRunId: 'run-9' }),
          mcpServerId: 'srv',
          tool: { name: 'payroll' },
          user: { email: 'carol@a' },
        },
      ]);
      mockPrisma.securityEvent = {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'e1',
            createdAt: new Date('2026-10-17T11:00:00Z'),
            metadata: { toolName: 'payroll', code: 'TOOL_NOT_ALLOWED', error: 'REFUSED TOOL_NOT_ALLOWED: x' },
            actorUser: { email: 'bob@b' },
          },
        ]),
      };
      const rows = await service.getRecentRefusals('org-a');
      expect(mockPrisma.toolInvocation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: 'org-a', status: 'ERROR', error: { startsWith: 'REFUSED ' } },
        }),
      );
      expect(mockPrisma.securityEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { organizationId: 'org-a', event: 'TOOL_REFUSED' } }),
      );
      expect(rows.map((r) => [r.source, r.code, r.userEmail, r.sandboxRunId])).toEqual([
        ['security_event', 'TOOL_NOT_ALLOWED', 'bob@b', null],
        ['tool_invocation', 'ROLE_FORBIDDEN', 'carol@a', 'run-9'],
      ]);
    });
  });
});
