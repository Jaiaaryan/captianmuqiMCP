import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../auth/roles.guard';
import { DemoAdminController } from './demo-admin.controller';
import { DemoModeGuard } from './demo-mode.guard';

function ctx(handler: (...a: any[]) => any, req: Record<string, unknown>) {
  return {
    getHandler: () => handler,
    getClass: () => DemoAdminController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as any;
}

const liveState = (on: boolean) => ({ isEnabled: () => on }) as any;

describe('DemoAdminController', () => {
  describe('demo mode off', () => {
    it.each([
      ['POST', '/api/demo/reset'],
      ['GET', '/api/demo/status'],
    ])('%s %s answers 404 before authentication', (method, url) => {
      const guard = new DemoModeGuard(liveState(false));
      expect(() => guard.canActivate(ctx(() => 0, { method, originalUrl: url }))).toThrow(NotFoundException);
      try {
        guard.canActivate(ctx(() => 0, { method, originalUrl: url }));
      } catch (e: any) {
        // The message Nest gives a route that does not exist.
        expect(e.message).toBe(`Cannot ${method} ${url}`);
      }
    });

    it('reads the live switch on every request, not the environment', () => {
      let on = false;
      const guard = new DemoModeGuard({ isEnabled: () => on } as any);
      const req = { method: 'GET', url: '/api/demo/status' };
      process.env.DEMO_MODE = 'true';
      expect(() => guard.canActivate(ctx(() => 0, req))).toThrow(NotFoundException);
      on = true;
      expect(guard.canActivate(ctx(() => 0, req))).toBe(true);
      on = false;
      expect(() => guard.canActivate(ctx(() => 0, req))).toThrow(NotFoundException);
      delete process.env.DEMO_MODE;
    });

    it('lets the request through in demo mode', () => {
      expect(new DemoModeGuard(liveState(true)).canActivate(ctx(() => 0, { method: 'GET', url: '/api/demo/status' }))).toBe(
        true,
      );
    });

    it('runs the demo-mode guard first', () => {
      const guards = Reflect.getMetadata('__guards__', DemoAdminController) as unknown[];
      expect(guards[0]).toBe(DemoModeGuard);
      expect(guards).toContain(RolesGuard);
    });
  });

  describe('reset', () => {
    const demo = () => ({
      isDemoAdmin: jest.fn(async (id: string) => id === 'u-alice'),
      reset: jest.fn(async () => ({ ok: true, reset: { runs: 1 }, at: 'now' })),
      status: jest.fn(async (org: string) => ({ enabled: true, currentWorkspace: org === 'org-a' ? 'A' : null })),
    });

    it('needs the ADMIN role (403 for a viewer)', () => {
      const controller = new DemoAdminController(demo() as any);
      const guard = new RolesGuard(new Reflector());
      const handler = DemoAdminController.prototype.reset;
      expect(() => guard.canActivate(ctx(handler, { user: { sub: 'u-carol', role: 'VIEWER' } }))).toThrow(
        ForbiddenException,
      );
      expect(guard.canActivate(ctx(handler, { user: { sub: 'u-alice', role: 'ADMIN' } }))).toBe(true);
      // Status: any signed-in user.
      expect(guard.canActivate(ctx(DemoAdminController.prototype.status, { user: { role: 'VIEWER' } }))).toBe(true);
      expect(controller).toBeDefined();
    });

    it('refuses an ADMIN who is not an admin of a demo workspace', async () => {
      const d = demo();
      const controller = new DemoAdminController(d as any);
      await expect(controller.reset({ user: { sub: 'u-dave', role: 'ADMIN' } })).rejects.toThrow(ForbiddenException);
      expect(d.reset).not.toHaveBeenCalled();
    });

    it('resets for a demo admin', async () => {
      const d = demo();
      const controller = new DemoAdminController(d as any);
      await expect(controller.reset({ user: { sub: 'u-alice', role: 'ADMIN' } })).resolves.toMatchObject({ ok: true });
      expect(d.reset).toHaveBeenCalledTimes(1);
    });

    it('reports the status for the caller\'s workspace', async () => {
      const controller = new DemoAdminController(demo() as any);
      await expect(controller.status({ user: { organizationId: 'org-a' } })).resolves.toEqual({
        enabled: true,
        currentWorkspace: 'A',
      });
    });
  });
});
