import { DemoController } from './demo.controller';

function res() {
  return { setHeader: jest.fn() } as any;
}

describe('DemoController', () => {
  const seed = (result: any, accounts: any[] = []) =>
    ({ lastResult: () => result, publishedAccounts: () => accounts }) as any;
  const state = (on: boolean) => ({ isEnabled: () => on }) as any;

  it('says disabled while demo mode is off', () => {
    const r = res();
    expect(new DemoController(seed(null), state(false)).get(r)).toEqual({ enabled: false });
    expect(r.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  it('says disabled when the switch is off, even with the data seeded', () => {
    const out = new DemoController(seed({ workspaces: { A: { serverId: 's1' } } }, [{ email: 'x' }]), state(false)).get(
      res(),
    );
    expect(out).toEqual({ enabled: false });
  });

  it('publishes the accounts and MCP paths in demo mode', () => {
    const accounts = [{ email: 'alice@alpha.codebound.test', password: 'p', name: 'Alice', role: 'ADMIN', workspace: 'A' }];
    const out = new DemoController(
      seed({ workspaces: { A: { serverId: 'srvA' }, B: { serverId: null } } }, accounts),
      state(true),
    ).get(res());
    expect(out).toEqual({ enabled: true, accounts, mcp: { A: '/mcp/srvA' } });
  });
});
