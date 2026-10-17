import { declaredOnly, groupUses, missingConnectors } from './script-uses.util';

describe('groupUses', () => {
  it('groups rows by connector and sorts connectors and tools by name', () => {
    const uses = groupUses(
      [
        { connectorId: 'c2', connectorName: 'Shop', toolName: 'b' },
        { connectorId: 'c1', connectorName: 'ERP', toolName: 'z' },
        { connectorId: 'c1', connectorName: 'ERP', toolName: 'a' },
        { connectorId: 'c1', connectorName: 'ERP', toolName: 'a' },
      ],
      new Map([
        ['c1', 'ERP'],
        ['c2', 'Shop'],
      ]),
    );
    expect(uses).toEqual([
      { connectorId: 'c1', connectorName: 'ERP', connectorExists: true, tools: ['a', 'z'] },
      { connectorId: 'c2', connectorName: 'Shop', connectorExists: true, tools: ['b'] },
    ]);
  });

  it('prefers the connector\'s current name and marks a missing connector', () => {
    const uses = groupUses(
      [
        { connectorId: 'c1', connectorName: 'Old name', toolName: 'a' },
        { connectorId: 'c2', connectorName: 'Deleted', toolName: 'b' },
      ],
      new Map([['c1', 'New name']]),
    );
    expect(uses).toEqual([
      { connectorId: 'c2', connectorName: 'Deleted', connectorExists: false, tools: ['b'] },
      { connectorId: 'c1', connectorName: 'New name', connectorExists: true, tools: ['a'] },
    ]);
  });
});

describe('missingConnectors (the rule for offering a script on a server)', () => {
  const uses = [
    { connectorId: 'c1', connectorName: 'ERP' },
    { connectorId: 'c2', connectorName: 'Shop' },
  ];

  it('is empty only when the server has every connector the script uses', () => {
    expect(missingConnectors(uses, ['c1', 'c2', 'c3'])).toEqual([]);
  });

  it('lists each connector the server lacks', () => {
    expect(missingConnectors(uses, ['c1'])).toEqual([{ id: 'c2', name: 'Shop' }]);
    expect(missingConnectors(uses, [])).toEqual([
      { id: 'c1', name: 'ERP' },
      { id: 'c2', name: 'Shop' },
    ]);
  });

  it('offers a script that uses no connector everywhere', () => {
    expect(missingConnectors([], [])).toEqual([]);
  });

  it('never offers a script on a server for a connector that was deleted', () => {
    expect(missingConnectors([{ connectorId: 'gone', connectorName: 'Old CRM' }], ['c1', 'c2'])).toEqual([
      { id: 'gone', name: 'Old CRM' },
    ]);
  });
});

describe('declaredOnly (what a saved script may call)', () => {
  const tools = [
    { connectorId: 'c1', name: 'orders_list' },
    { connectorId: 'c2', name: 'orders_list' },
    { connectorId: 'c1', name: 'items_list' },
  ];

  it('keeps only the declared tools', () => {
    expect(declaredOnly(tools, [{ connectorId: 'c1', tools: ['items_list'] }])).toEqual([
      { connectorId: 'c1', name: 'items_list' },
    ]);
  });

  it('matches the connector as well as the name', () => {
    expect(declaredOnly(tools, [{ connectorId: 'c2', tools: ['orders_list'] }])).toEqual([
      { connectorId: 'c2', name: 'orders_list' },
    ]);
  });

  it('allows nothing when the script declares nothing', () => {
    expect(declaredOnly(tools, [])).toEqual([]);
  });

  it('does not conjure a tool that the caller cannot call', () => {
    expect(declaredOnly([], [{ connectorId: 'c1', tools: ['orders_list'] }])).toEqual([]);
  });
});
