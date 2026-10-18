import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SelfHostedOnlyGuard } from '../common/self-hosted-only.guard';
import { DemoControlController, SetDemoModeDto } from './demo-control.controller';

describe('DemoControlController', () => {
  const guardsOf = (handler: object) => Reflect.getMetadata('__guards__', handler) as unknown[];

  it('signs in for GET without hiding it (it is how the pill learns the switch is off)', () => {
    const guards = guardsOf(DemoControlController.prototype.get);
    expect(guards).toHaveLength(1);
    expect(guards).not.toContain(SelfHostedOnlyGuard);
  });

  it('hides PUT on Cloud before authentication', () => {
    const guards = guardsOf(DemoControlController.prototype.set);
    expect(guards[0]).toBe(SelfHostedOnlyGuard);
    expect(guards).toHaveLength(2);
    const cloud = new SelfHostedOnlyGuard({ isSelfHosted: () => false } as any);
    expect(() => cloud.canActivate({} as any)).toThrow(NotFoundException);
  });

  it('passes the caller to the service', async () => {
    const demo = { control: jest.fn(async () => ({ available: true })), setEnabled: jest.fn(async () => ({})) };
    const c = new DemoControlController(demo as any);
    const req = { user: { sub: 'u1', organizationId: 'o1', role: 'ADMIN' } };
    await c.get(req);
    expect(demo.control).toHaveBeenCalledWith({ sub: 'u1', organizationId: 'o1' });
    await c.set(req, { enabled: true });
    expect(demo.setEnabled).toHaveBeenCalledWith(true, { sub: 'u1', organizationId: 'o1' });
  });

  it('accepts only a boolean `enabled`', async () => {
    expect(await validate(plainToInstance(SetDemoModeDto, { enabled: true }))).toHaveLength(0);
    expect(await validate(plainToInstance(SetDemoModeDto, { enabled: 'yes' }))).not.toHaveLength(0);
    expect(await validate(plainToInstance(SetDemoModeDto, {}))).not.toHaveLength(0);
  });
});
