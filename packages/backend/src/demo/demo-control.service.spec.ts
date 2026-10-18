import { ConflictException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { DEMO_ENABLED_SETTING, DemoStateService } from './demo-state.service';
import { DEMO_MODE_CHANGED, DEMO_TOGGLE_INTERVAL_MS, DemoControlService } from './demo-control.service';
import { MockSystemsService } from './mock-systems.service';

const ADMIN = { sub: 'u-admin', organizationId: 'org-x' };
const VIEWER = { sub: 'u-viewer', organizationId: 'org-x' };

function world(opts: { cloud?: boolean; stored?: string } = {}) {
  const store = new Map<string, string>(opts.stored ? [[DEMO_ENABLED_SETTING, opts.stored]] : []);
  const settings = {
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => void store.set(k, v)),
  };
  const deployment = { isSelfHosted: () => !opts.cloud, isCloud: () => !!opts.cloud };
  const state = new DemoStateService(settings as any, deployment as any);
  const mocks = new MockSystemsService();
  const seed = {
    assertMocksReachable: jest.fn(async () => undefined),
    seedAndLog: jest.fn(async () => ({ workspaces: {}, users: {}, created: {}, updated: {} })),
  };
  const reset = {
    status: jest.fn(async (org?: string) => ({ enabled: true, currentWorkspace: org === 'org-a' ? 'A' : null })),
    isDemoAdmin: jest.fn(async (id?: string) => id === 'u-alice'),
  };
  const prisma = {
    organizationMember: {
      findFirst: jest.fn(async ({ where }: any) =>
        ['u-admin', 'u-alice'].includes(where.userId) && where.role === 'ADMIN' && where.deactivatedAt === null
          ? { userId: where.userId }
          : null,
      ),
    },
  };
  const securityEvents = { log: jest.fn(async () => undefined) };
  const service = new DemoControlService(
    state,
    mocks,
    seed as any,
    reset as any,
    prisma as any,
    securityEvents as any,
  );
  jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
  jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
  jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn((state as any).logger, 'log').mockImplementation(() => undefined);
  jest.spyOn((mocks as any).logger, 'log').mockImplementation(() => undefined);
  return { service, state, mocks, seed, reset, prisma, securityEvents, store };
}

describe('DemoControlService', () => {
  const saved = { ...process.env };
  let worlds: Array<ReturnType<typeof world>> = [];
  const make = (o?: Parameters<typeof world>[0]) => {
    const w = world(o);
    worlds.push(w);
    return w;
  };
  beforeEach(() => {
    process.env.DEMO_PASSWORD_SEED = 'control-spec';
    process.env.DEMO_MOCK_PORT = '0';
    delete process.env.DEMO_MODE;
  });
  afterEach(async () => {
    for (const w of worlds) await w.mocks.stop();
    worlds = [];
    jest.useRealTimers();
    process.env = { ...saved };
  });

  describe('GET control', () => {
    it('reports off, with the toggle for an admin and without it for anyone else', async () => {
      const w = make();
      await w.state.load({});
      await expect(w.service.control(ADMIN)).resolves.toEqual({
        available: true,
        enabled: false,
        canToggle: true,
        canReset: false,
      });
      await expect(w.service.control(VIEWER)).resolves.toMatchObject({ available: true, canToggle: false });
      expect(w.reset.status).not.toHaveBeenCalled();
    });

    it('includes the status and the reset right while on', async () => {
      const w = make({ stored: 'true' });
      await w.state.load({});
      await expect(w.service.control({ sub: 'u-alice', organizationId: 'org-a' })).resolves.toEqual({
        available: true,
        enabled: true,
        canToggle: true,
        canReset: true,
        status: { enabled: true, currentWorkspace: 'A' },
      });
      await expect(w.service.control(ADMIN)).resolves.toMatchObject({ canReset: false });
    });

    it('is unavailable on Cloud', async () => {
      const w = make({ cloud: true, stored: 'true' });
      await w.state.load({ DEMO_MODE: 'true' });
      await expect(w.service.control(ADMIN)).resolves.toEqual({
        available: false,
        enabled: false,
        canToggle: false,
        canReset: false,
      });
    });
  });

  describe('PUT control', () => {
    it('off → on: starts the mocks, seeds without force, persists, audits', async () => {
      const w = make();
      await w.state.load({});
      expect(w.mocks.port()).toBeNull();
      const out = await w.service.setEnabled(true, ADMIN);
      const port = w.mocks.port();
      expect(port).toBeGreaterThan(0);
      expect((await fetch(`http://127.0.0.1:${port}/__health`)).status).toBe(200);
      expect(w.seed.assertMocksReachable).toHaveBeenCalled();
      expect(w.seed.seedAndLog).toHaveBeenCalledWith(port);
      expect(w.store.get(DEMO_ENABLED_SETTING)).toBe('true');
      expect(w.state.isEnabled()).toBe(true);
      expect(out).toMatchObject({ available: true, enabled: true, canToggle: true });
      expect(w.securityEvents.log).toHaveBeenCalledWith({
        event: DEMO_MODE_CHANGED,
        actorType: 'USER',
        organizationId: 'org-x',
        actorUserId: 'u-admin',
        metadata: { enabled: true, userId: 'u-admin' },
      });
    });

    it('on → off: persists, stops the mocks, deletes nothing, audits', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'], now: 1_000_000 });
      const w = make();
      await w.state.load({});
      await w.service.setEnabled(true, ADMIN);
      const port = w.mocks.port();
      jest.setSystemTime(1_000_000 + DEMO_TOGGLE_INTERVAL_MS);
      const out = await w.service.setEnabled(false, ADMIN);
      expect(out).toEqual({ available: true, enabled: false, canToggle: true, canReset: false });
      expect(w.mocks.port()).toBeNull();
      jest.useRealTimers();
      await expect(fetch(`http://127.0.0.1:${port}/__health`)).rejects.toThrow();
      expect(w.store.get(DEMO_ENABLED_SETTING)).toBe('false');
      expect(w.securityEvents.log).toHaveBeenLastCalledWith(
        expect.objectContaining({ event: DEMO_MODE_CHANGED, metadata: { enabled: false, userId: 'u-admin' } }),
      );
      // Off never seeds (or resets) anything.
      expect(w.seed.seedAndLog).toHaveBeenCalledTimes(1);
    });

    it('is 403 for a user who is not an admin anywhere, and does not take the window', async () => {
      const w = make();
      await w.state.load({});
      await expect(w.service.setEnabled(true, VIEWER)).rejects.toThrow(ForbiddenException);
      expect(w.mocks.port()).toBeNull();
      expect(w.securityEvents.log).not.toHaveBeenCalled();
      await expect(w.service.setEnabled(true, ADMIN)).resolves.toMatchObject({ enabled: true });
    });

    it('is 404 on Cloud', async () => {
      const w = make({ cloud: true });
      await expect(w.service.setEnabled(true, ADMIN)).rejects.toThrow(NotFoundException);
      expect(w.store.size).toBe(0);
    });

    it('allows one toggle per 5 s (429 inside the window)', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'], now: 2_000_000 });
      const w = make();
      await w.state.load({});
      await w.service.setEnabled(true, ADMIN);
      jest.setSystemTime(2_000_000 + DEMO_TOGGLE_INTERVAL_MS - 1);
      const err = await w.service.setEnabled(false, ADMIN).catch((e) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect(err.getStatus()).toBe(429);
      expect(w.state.isEnabled()).toBe(true);
      jest.setSystemTime(2_000_000 + DEMO_TOGGLE_INTERVAL_MS);
      await expect(w.service.setEnabled(false, ADMIN)).resolves.toMatchObject({ enabled: false });
    });

    it('refuses to turn on (409) when the outbound policy blocks the mocks', async () => {
      const w = make();
      await w.state.load({});
      w.seed.assertMocksReachable.mockRejectedValueOnce(new Error('add 127.0.0.1 to SSRF_ALLOWED_HOSTS'));
      await expect(w.service.setEnabled(true, ADMIN)).rejects.toThrow(ConflictException);
      expect(w.mocks.port()).toBeNull();
      expect(w.state.isEnabled()).toBe(false);
      expect(w.securityEvents.log).not.toHaveBeenCalled();
    });

    it('stays off and stops the mocks again when the seed fails', async () => {
      const w = make();
      await w.state.load({});
      w.seed.seedAndLog.mockRejectedValueOnce(new Error('db down'));
      await expect(w.service.setEnabled(true, ADMIN)).rejects.toThrow(/Demo seed failed/);
      expect(w.mocks.port()).toBeNull();
      expect(w.state.isEnabled()).toBe(false);
      expect(w.store.has(DEMO_ENABLED_SETTING)).toBe(false);
    });

    it('writes no audit event when nothing changes', async () => {
      const w = make({ stored: 'false' });
      await w.state.load({});
      await w.service.setEnabled(false, ADMIN);
      expect(w.securityEvents.log).not.toHaveBeenCalled();
    });
  });

  describe('on boot', () => {
    it('does nothing while off', async () => {
      const w = make();
      await w.service.onApplicationBootstrap();
      expect(w.mocks.port()).toBeNull();
      expect(w.seed.seedAndLog).not.toHaveBeenCalled();
    });

    it('starts and seeds with DEMO_MODE=true on a fresh database, and stores the switch', async () => {
      process.env.DEMO_MODE = 'true';
      const w = make();
      await w.service.onApplicationBootstrap();
      expect(w.mocks.port()).toBeGreaterThan(0);
      expect(w.seed.seedAndLog).toHaveBeenCalledWith(w.mocks.port());
      expect(w.store.get(DEMO_ENABLED_SETTING)).toBe('true');
    });

    it('starts from the stored switch without DEMO_MODE', async () => {
      const w = make({ stored: 'true' });
      await w.service.onApplicationBootstrap();
      expect(w.state.isEnabled()).toBe(true);
      expect(w.mocks.port()).toBeGreaterThan(0);
    });

    it('refuses on Cloud, and logs it when DEMO_MODE=true', async () => {
      process.env.DEMO_MODE = 'true';
      const w = make({ cloud: true, stored: 'true' });
      await w.service.onApplicationBootstrap();
      expect(w.mocks.port()).toBeNull();
      expect((w.service as any).logger.warn).toHaveBeenCalledWith(expect.stringMatching(/refused/));
    });

    it('fails the boot when DEMO_MODE=true and the outbound policy blocks the mocks', async () => {
      process.env.DEMO_MODE = 'true';
      const w = make();
      w.seed.assertMocksReachable.mockRejectedValueOnce(new Error('SSRF_ALLOWED_HOSTS=127.0.0.1'));
      await expect(w.service.onApplicationBootstrap()).rejects.toThrow(/SSRF_ALLOWED_HOSTS/);
      expect(w.mocks.port()).toBeNull();
    });

    it('stays off for the boot (setting kept) when only the switch asked for it', async () => {
      const w = make({ stored: 'true' });
      w.seed.assertMocksReachable.mockRejectedValueOnce(new Error('blocked'));
      await w.service.onApplicationBootstrap();
      expect(w.state.isEnabled()).toBe(false);
      expect(w.store.get(DEMO_ENABLED_SETTING)).toBe('true');
      expect(w.mocks.port()).toBeNull();
    });

    it('keeps booting when the seed fails', async () => {
      const w = make({ stored: 'true' });
      w.seed.seedAndLog.mockRejectedValueOnce(new Error('db down'));
      await expect(w.service.onApplicationBootstrap()).resolves.toBeUndefined();
      expect(w.state.isEnabled()).toBe(true);
    });
  });
});
