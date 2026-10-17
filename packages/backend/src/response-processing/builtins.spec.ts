import {
  BuiltinError,
  describeBuiltins,
  roundHalfAwayFromZero,
  runBuiltin,
  validateBuiltinParams,
} from './builtins';

describe('roundHalfAwayFromZero', () => {
  it.each([
    [0.005, 2, 0.01],
    [-0.005, 2, -0.01],
    [1.005, 2, 1.01],
    [2.5, 0, 3],
    [-2.5, 0, -3],
    [54.67, 2, 54.67],
    [-0.001, 2, 0],
    [1e-7, 2, 0],
  ])('%p to %p places is %p', (value, decimals, expected) => {
    const out = roundHalfAwayFromZero(value, decimals);
    expect(out).toBe(expected);
    expect(Object.is(out, -0)).toBe(false);
  });
});

describe('scale@1', () => {
  it('multiplies, optionally rounding', () => {
    expect(runBuiltin('scale@1', 54.67, { factor: 0.92, round: 2 })).toBe(50.3);
    expect(runBuiltin('scale@1', 3, { factor: 0.1 })).toBe(0.30000000000000004);
  });
  it('refuses a non-number', () => {
    expect(() => runBuiltin('scale@1', '54', { factor: 2 })).toThrow('is not a number');
    expect(() => runBuiltin('scale@1', NaN, { factor: 2 })).toThrow(BuiltinError);
    expect(() => runBuiltin('scale@1', null, { factor: 2 })).toThrow('is not a number');
  });
  it('refuses a result that is not finite', () => {
    expect(() => runBuiltin('scale@1', 1e308, { factor: 1e308 })).toThrow('not finite');
  });
  it('checks its params', () => {
    expect(validateBuiltinParams('scale@1', { factor: 2 })).toBeNull();
    expect(validateBuiltinParams('scale@1', {})).toBe('params.factor is required');
    expect(validateBuiltinParams('scale@1', { factor: '2' })).toMatch(/must be a number/);
    expect(validateBuiltinParams('scale@1', { factor: 2, round: 11 })).toMatch(/between 0 and 10/);
    expect(validateBuiltinParams('scale@1', { factor: 2, round: 1.5 })).toMatch(/integer/);
    expect(validateBuiltinParams('scale@1', { factor: 2, round: -1 })).toMatch(/between 0 and 10/);
    expect(validateBuiltinParams('scale@1', { factor: 2, nope: 1 })).toMatch(/unknown param "nope"/);
  });
});

describe('offset@1', () => {
  it('adds an amount', () => {
    expect(runBuiltin('offset@1', 10, { amount: -2.5 })).toBe(7.5);
    expect(runBuiltin('offset@1', 0.1, { amount: 0.2, round: 2 })).toBe(0.3);
  });
  it('refuses a string and a missing amount', () => {
    expect(() => runBuiltin('offset@1', 'x', { amount: 1 })).toThrow('is not a number');
    expect(validateBuiltinParams('offset@1', {})).toBe('params.amount is required');
  });
});

describe('vat@1', () => {
  it('multiplies by 1 + rate', () => {
    expect(runBuiltin('vat@1', 50.3, { rate: 0.19, round: 2 })).toBe(59.86);
    expect(runBuiltin('vat@1', 100, { rate: 0 })).toBe(100);
  });
  it('bounds the rate to 0..1', () => {
    expect(validateBuiltinParams('vat@1', { rate: 1.2 })).toMatch(/between 0 and 1/);
    expect(validateBuiltinParams('vat@1', { rate: -0.1 })).toMatch(/between 0 and 1/);
    expect(validateBuiltinParams('vat@1', { rate: 1 })).toBeNull();
  });
  it('refuses a non-number', () => {
    expect(() => runBuiltin('vat@1', '9', { rate: 0.1 })).toThrow('is not a number');
  });
});

describe('round@1', () => {
  it('defaults to 2 decimals and rounds half away from zero', () => {
    expect(runBuiltin('round@1', 1.23456)).toBe(1.23);
    expect(runBuiltin('round@1', -0.005)).toBe(-0.01);
    expect(runBuiltin('round@1', 0.005)).toBe(0.01);
    expect(runBuiltin('round@1', 2.5, { decimals: 0 })).toBe(3);
    expect(runBuiltin('round@1', -2.5, { decimals: 0 })).toBe(-3);
  });
  it('bounds decimals to 0..10 integers', () => {
    expect(validateBuiltinParams('round@1', { decimals: 11 })).toMatch(/between 0 and 10/);
    expect(validateBuiltinParams('round@1', { decimals: 0.5 })).toMatch(/integer/);
    expect(validateBuiltinParams('round@1', undefined)).toBeNull();
  });
  it('refuses a non-number', () => {
    expect(() => runBuiltin('round@1', '1.234')).toThrow('is not a number');
  });
});

describe('clean_text@1', () => {
  it('collapses whitespace, then trims', () => {
    expect(runBuiltin('clean_text@1', '  Black Screw   60mm\n')).toBe('Black Screw 60mm');
  });
  it('collapses first: edge runs become one space that trim removes', () => {
    expect(runBuiltin('clean_text@1', '   a   ')).toBe('a');
    expect(runBuiltin('clean_text@1', '   a   ', { trim: false })).toBe(' a ');
  });
  it('can leave whitespace alone', () => {
    expect(runBuiltin('clean_text@1', '  a   b  ', { collapseWhitespace: false })).toBe('a   b');
    expect(
      runBuiltin('clean_text@1', '  a   b  ', { collapseWhitespace: false, trim: false }),
    ).toBe('  a   b  ');
  });
  it('refuses a non-string and non-boolean params', () => {
    expect(() => runBuiltin('clean_text@1', 5)).toThrow('is not a string');
    expect(validateBuiltinParams('clean_text@1', { trim: 'yes' })).toMatch(/true or false/);
  });
});

describe('truncate@1', () => {
  it('leaves short text alone', () => {
    expect(runBuiltin('truncate@1', 'abc', { maxLength: 3 })).toBe('abc');
  });
  it('counts the ellipsis in maxLength', () => {
    const out = runBuiltin('truncate@1', 'abcdefghij', { maxLength: 5 }) as string;
    expect(out).toBe('abcd…');
    expect(out.length).toBe(5);
    expect(runBuiltin('truncate@1', 'abcdefghij', { maxLength: 6, ellipsis: '...' })).toBe('abc...');
  });
  it('never exceeds maxLength, even with a long ellipsis', () => {
    expect(runBuiltin('truncate@1', 'abcdefghij', { maxLength: 2, ellipsis: '...' })).toBe('..');
    expect(runBuiltin('truncate@1', 'abcdefghij', { maxLength: 4, ellipsis: '' })).toBe('abcd');
  });
  it('bounds maxLength and refuses a non-string', () => {
    expect(validateBuiltinParams('truncate@1', {})).toBe('params.maxLength is required');
    expect(validateBuiltinParams('truncate@1', { maxLength: 0 })).toMatch(/between 1 and 100000/);
    expect(validateBuiltinParams('truncate@1', { maxLength: 100001 })).toMatch(/between 1 and 100000/);
    expect(() => runBuiltin('truncate@1', 12, { maxLength: 5 })).toThrow('is not a string');
  });
});

describe('map@1', () => {
  const map = { '1': 'one', true: 'yes', null: 'none', a: 'A' };
  it('compares strings as they are and other values by JSON form', () => {
    expect(runBuiltin('map@1', 'a', { map })).toBe('A');
    expect(runBuiltin('map@1', 1, { map })).toBe('one');
    expect(runBuiltin('map@1', '1', { map })).toBe('one');
    expect(runBuiltin('map@1', true, { map })).toBe('yes');
    expect(runBuiltin('map@1', null, { map })).toBe('none');
  });
  it('uses the fallback for an unmapped value', () => {
    expect(runBuiltin('map@1', 'zzz', { map, fallback: 'other' })).toBe('other');
  });
  it('refuses an unmapped value without a fallback', () => {
    expect(() => runBuiltin('map@1', 7, { map })).toThrow('has no entry in the map ("7")');
  });
  it('does not see inherited keys', () => {
    expect(() => runBuiltin('map@1', 'constructor', { map })).toThrow('has no entry in the map');
    expect(() => runBuiltin('map@1', 'toString', { map })).toThrow('has no entry in the map');
  });
  it('needs an object map and a string fallback', () => {
    expect(validateBuiltinParams('map@1', {})).toBe('params.map is required');
    expect(validateBuiltinParams('map@1', { map: [] })).toMatch(/must be an object/);
    expect(validateBuiltinParams('map@1', { map, fallback: 3 })).toMatch(/must be a string/);
  });
});

describe('registry', () => {
  it('describes the seven built-ins with contracts', () => {
    const all = describeBuiltins();
    expect(all.map((b) => b.use)).toEqual([
      'scale@1',
      'offset@1',
      'vat@1',
      'round@1',
      'clean_text@1',
      'truncate@1',
      'map@1',
    ]);
    for (const b of all) {
      expect(b.version).toBe(1);
      expect(['number', 'string', 'any']).toContain(b.input);
      expect(Array.isArray(b.params)).toBe(true);
    }
  });
  it('rejects an unknown processor', () => {
    expect(validateBuiltinParams('nope@1', {})).toMatch(/unknown processor/);
    expect(() => runBuiltin('nope@1', 1)).toThrow(BuiltinError);
  });
});
