import { DEMO_ENABLED_SETTING, DemoStateService } from './demo-state.service';

function settings(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => void store.set(k, v)),
  };
}
const selfHosted = { isSelfHosted: () => true, isCloud: () => false } as any;
const cloud = { isSelfHosted: () => false, isCloud: () => true } as any;

describe('DemoStateService', () => {
  it('is off before load and without a setting or DEMO_MODE', async () => {
    const s = settings();
    const state = new DemoStateService(s as any, selfHosted);
    expect(state.isEnabled()).toBe(false);
    await expect(state.load({})).resolves.toBe(false);
    // Nothing written: DEMO_MODE=true on a later boot still turns it on.
    expect(s.set).not.toHaveBeenCalled();
  });

  it('takes DEMO_MODE=true as the initial default and stores it', async () => {
    const s = settings();
    const state = new DemoStateService(s as any, selfHosted);
    await expect(state.load({ DEMO_MODE: 'true' })).resolves.toBe(true);
    expect(s.store.get(DEMO_ENABLED_SETTING)).toBe('true');
    expect(state.isEnabled()).toBe(true);
  });

  it('lets a stored setting win over the environment', async () => {
    const off = new DemoStateService(settings({ [DEMO_ENABLED_SETTING]: 'false' }) as any, selfHosted);
    await expect(off.load({ DEMO_MODE: 'true' })).resolves.toBe(false);
    const on = new DemoStateService(settings({ [DEMO_ENABLED_SETTING]: 'true' }) as any, selfHosted);
    await expect(on.load({})).resolves.toBe(true);
  });

  it('persists set() and updates the cache', async () => {
    const s = settings();
    const state = new DemoStateService(s as any, selfHosted);
    await state.set(true);
    expect(state.isEnabled()).toBe(true);
    expect(s.store.get(DEMO_ENABLED_SETTING)).toBe('true');
    await state.set(false);
    expect(state.isEnabled()).toBe(false);
    expect(s.store.get(DEMO_ENABLED_SETTING)).toBe('false');
  });

  it('suspend() turns it off in memory only', async () => {
    const s = settings({ [DEMO_ENABLED_SETTING]: 'true' });
    const state = new DemoStateService(s as any, selfHosted);
    await state.load({});
    state.suspend();
    expect(state.isEnabled()).toBe(false);
    expect(s.store.get(DEMO_ENABLED_SETTING)).toBe('true');
  });

  it('is always off on Cloud, whatever the setting or the environment', async () => {
    const s = settings({ [DEMO_ENABLED_SETTING]: 'true' });
    const state = new DemoStateService(s as any, cloud);
    expect(state.available()).toBe(false);
    await expect(state.load({ DEMO_MODE: 'true' })).resolves.toBe(false);
    expect(state.isEnabled()).toBe(false);
    await expect(state.set(true)).rejects.toThrow(/Cloud/);
    expect(s.set).not.toHaveBeenCalled();
  });
});
