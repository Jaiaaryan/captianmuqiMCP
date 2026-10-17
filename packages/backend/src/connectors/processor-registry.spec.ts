import {
  PROCESSORS,
  ProcessorValueError,
  describeProcessors,
  findProcessor,
  processorRef,
  resolveProcessorParams,
  roundTo,
  type ProcessorDefinition,
} from './processor-registry';

/** Look a processor up the way a chain does, failing loudly if it is gone. */
function def(ref: string): ProcessorDefinition {
  const found = findProcessor(ref);
  if (!found) throw new Error(`the registry has no processor "${ref}"`);
  return found;
}

/**
 * Apply a processor the way the chain runner does: resolve the step's params
 * against the contract first, so the declared defaults are part of the test.
 */
function run(ref: string, value: unknown, raw: unknown = {}): unknown {
  const d = def(ref);
  const resolved = resolveProcessorParams(d, raw);
  if (!resolved.ok) throw new Error(`params did not resolve: ${resolved.error}`);
  return d.apply(value, resolved.params);
}

function resolvedParams(ref: string, raw: unknown): Record<string, unknown> {
  const result = resolveProcessorParams(def(ref), raw);
  if (!result.ok) throw new Error(`expected the params to resolve, got: ${result.error}`);
  return result.params;
}

function paramError(ref: string, raw: unknown): string {
  const result = resolveProcessorParams(def(ref), raw);
  if (result.ok) throw new Error(`expected a parameter error, got ${JSON.stringify(result.params)}`);
  return result.error;
}

describe('findProcessor', () => {
  it('resolves a bare name to the newest version', () => {
    const newest = findProcessor('number_scale');
    expect(newest).not.toBeNull();
    expect(newest!.name).toBe('number_scale');
    expect(newest!.version).toBe(
      Math.max(...PROCESSORS.filter((p) => p.name === 'number_scale').map((p) => p.version)),
    );
  });

  it('resolves a pinned `name@1` to that version', () => {
    expect(findProcessor('number_scale@1')).toBe(findProcessor('number_scale'));
    expect(findProcessor('text_clean@1')!.version).toBe(1);
    // Trimmed, because a chain may carry operator-typed whitespace.
    expect(findProcessor('  number_vat@1  ')).toBe(findProcessor('number_vat'));
  });

  it('returns null for an unknown name or an unknown version', () => {
    expect(findProcessor('number_sclae')).toBeNull();
    expect(findProcessor('number_scale@2')).toBeNull();
    expect(findProcessor('number_scale@')).toBeNull();
    expect(findProcessor('number_scale@x')).toBeNull();
    expect(findProcessor('')).toBeNull();
    expect(findProcessor('   ')).toBeNull();
    expect(findProcessor(undefined as unknown as string)).toBeNull();
  });
});

describe('the registry itself', () => {
  it('exposes the documented set of processors, each with a unique ref', () => {
    expect(PROCESSORS.map((p) => p.name).sort()).toEqual([
      'number_offset',
      'number_round',
      'number_scale',
      'number_vat',
      'text_clean',
      'text_truncate',
      'value_map',
    ]);
    const refs = PROCESSORS.map(processorRef);
    expect(new Set(refs).size).toBe(refs.length);
    expect(processorRef(def('number_scale'))).toBe('number_scale@1');
  });

  it('is frozen, so nothing can add a processor at runtime', () => {
    expect(Object.isFrozen(PROCESSORS)).toBe(true);
  });
});

describe('roundTo', () => {
  it('rounds half away from zero, for negatives too', () => {
    expect(roundTo(1.5, 0)).toBe(2);
    expect(roundTo(2.5, 0)).toBe(3);
    // Math.round(-1.5) is -1 and Math.round(-2.5) is -2: half-up, which an
    // invoice must not do. The registry rounds the magnitude instead.
    expect(roundTo(-1.5, 0)).toBe(-2);
    expect(roundTo(-2.5, 0)).toBe(-3);
    expect(Math.round(-2.5)).toBe(-2);
  });

  it('rounds to the requested number of decimals', () => {
    expect(roundTo(1.23456, 3)).toBe(1.235);
    expect(roundTo(1.23456, 0)).toBe(1);
    expect(roundTo(50.2964, 2)).toBe(50.3);
    expect(roundTo(-50.2964, 2)).toBe(-50.3);
    expect(roundTo(0, 2)).toBe(0);
  });

  it('passes non-finite values straight through', () => {
    expect(roundTo(Infinity, 2)).toBe(Infinity);
    expect(roundTo(-Infinity, 2)).toBe(-Infinity);
    expect(roundTo(NaN, 2)).toBeNaN();
  });
});

describe('number_scale', () => {
  it('multiplies by the factor, rounding when asked', () => {
    expect(run('number_scale', 10, { factor: 0.5 })).toBe(5);
    expect(run('number_scale', 54.67, { factor: 0.92, round: 2 })).toBe(50.3);
    expect(run('number_scale', -10, { factor: 0.92, round: 2 })).toBe(-9.2);
  });

  it('keeps full precision when `round` is omitted', () => {
    expect(run('number_scale', 54.67, { factor: 0.92 })).toBeCloseTo(50.2964, 10);
  });

  it('refuses a value that is not a number', () => {
    expect(() => run('number_scale', 'n/a', { factor: 0.92 })).toThrow(ProcessorValueError);
    expect(() => run('number_scale', 'n/a', { factor: 0.92 })).toThrow(/is not a number/);
    expect(() => run('number_scale', null, { factor: 0.92 })).toThrow(/is not a number/);
    expect(() => run('number_scale', NaN, { factor: 0.92 })).toThrow(/is not a number/);
    expect(() => run('number_scale', Infinity, { factor: 0.92 })).toThrow(/is not a number/);
  });
});

describe('number_offset', () => {
  it('adds the amount', () => {
    expect(run('number_offset', 10, { amount: 2.5 })).toBe(12.5);
    expect(run('number_offset', 10, { amount: -2.5 })).toBe(7.5);
    expect(run('number_offset', 0.1, { amount: 0.2, round: 2 })).toBe(0.3);
  });

  it('refuses a value that is not a number', () => {
    expect(() => run('number_offset', '10', { amount: 1 })).toThrow(ProcessorValueError);
    expect(() => run('number_offset', '10', { amount: 1 })).toThrow(/is not a number/);
  });
});

describe('number_vat', () => {
  it('turns a net amount into a gross one', () => {
    expect(run('number_vat', 100, { rate: 0.19, round: 2 })).toBe(119);
    expect(run('number_vat', 50.3, { rate: 0.19, round: 2 })).toBe(59.86);
    expect(run('number_vat', 100, { rate: 0, round: 2 })).toBe(100);
  });

  it('refuses a value that is not a number', () => {
    expect(() => run('number_vat', { amount: 100 }, { rate: 0.19 })).toThrow(ProcessorValueError);
    expect(() => run('number_vat', { amount: 100 }, { rate: 0.19 })).toThrow(/is not a number/);
  });
});

describe('number_round', () => {
  it('rounds to the declared default of 2 decimals', () => {
    expect(resolvedParams('number_round', {})).toEqual({ decimals: 2 });
    expect(run('number_round', 1.23456, {})).toBe(1.23);
    expect(run('number_round', 1.23456, { decimals: 3 })).toBe(1.235);
    expect(run('number_round', 1.6, { decimals: 0 })).toBe(2);
  });

  it('refuses a value that is not a number', () => {
    expect(() => run('number_round', 'x', {})).toThrow(ProcessorValueError);
    expect(() => run('number_round', 'x', {})).toThrow(/is not a number/);
  });
});

describe('text_clean', () => {
  it('trims and collapses whitespace by default', () => {
    expect(resolvedParams('text_clean', {})).toEqual({ trim: true, collapseWhitespace: true });
    expect(run('text_clean', '  Black   Screw\n60mm ')).toBe('Black Screw 60mm');
    expect(run('text_clean', 'a\t\t\nb')).toBe('a b');
    // Collapsed before trimming, so a whitespace-only value ends up empty.
    expect(run('text_clean', '   \n  ')).toBe('');
  });

  it('honours the switches being turned off', () => {
    expect(run('text_clean', 'a  b', { collapseWhitespace: false })).toBe('a  b');
    expect(run('text_clean', ' a ', { trim: false })).toBe(' a ');
    expect(run('text_clean', ' a  b ', { trim: false, collapseWhitespace: false })).toBe(' a  b ');
  });

  it('refuses a value that is not a string', () => {
    expect(() => run('text_clean', 42)).toThrow(ProcessorValueError);
    expect(() => run('text_clean', 42)).toThrow(/is not a string/);
    expect(() => run('text_clean', null)).toThrow(/is not a string/);
  });
});

describe('text_truncate', () => {
  it('caps the text and appends the default ellipsis', () => {
    expect(resolvedParams('text_truncate', { maxLength: 5 })).toEqual({
      maxLength: 5,
      ellipsis: '…',
    });
    expect(run('text_truncate', 'abcdefghij', { maxLength: 5 })).toBe('abcd…');
    expect(run('text_truncate', 'abcdefghij', { maxLength: 5 })).toHaveLength(5);
  });

  it('leaves text that already fits alone', () => {
    expect(run('text_truncate', 'abc', { maxLength: 5 })).toBe('abc');
    expect(run('text_truncate', 'abcde', { maxLength: 5 })).toBe('abcde');
  });

  it('drops the ellipsis when it is longer than maxLength', () => {
    // Appending it would overshoot the cap the operator asked for, so the cut
    // text wins and the marker is left off entirely.
    expect(run('text_truncate', 'abcdefghij', { maxLength: 2, ellipsis: '......' })).toBe('ab');
    expect(run('text_truncate', 'abcdefghij', { maxLength: 1, ellipsis: '…' })).toBe('a');
    expect(run('text_truncate', 'abcdefghij', { maxLength: 5, ellipsis: '' })).toBe('abcde');
  });

  it('refuses a value that is not a string', () => {
    expect(() => run('text_truncate', 42, { maxLength: 5 })).toThrow(ProcessorValueError);
    expect(() => run('text_truncate', 42, { maxLength: 5 })).toThrow(/is not a string/);
  });
});

describe('value_map', () => {
  it('replaces a value that is in the table', () => {
    expect(run('value_map', '2', { map: { '2': 'shipped' } })).toBe('shipped');
    // Non-strings are compared as their JSON form, so a numeric status code
    // still finds its string key.
    expect(run('value_map', 2, { map: { '2': 'shipped' } })).toBe('shipped');
    expect(run('value_map', true, { map: { true: 'yes' } })).toBe('yes');
  });

  it('uses the fallback for a value that is not', () => {
    expect(run('value_map', '9', { map: { '2': 'shipped' }, fallback: 'unknown' })).toBe('unknown');
    expect(run('value_map', '9', { map: {}, fallback: '' })).toBe('');
  });

  it('fails when the value is neither mapped nor covered by a fallback', () => {
    expect(() => run('value_map', '9', { map: { '2': 'shipped' } })).toThrow(ProcessorValueError);
    expect(() => run('value_map', '9', { map: { '2': 'shipped' } })).toThrow(
      /has no entry in the map \("9"\)/,
    );
  });

  it('does not read the map through the prototype chain', () => {
    // `toString` is on Object.prototype but not an own key of the table.
    expect(() => run('value_map', 'toString', { map: { '2': 'shipped' } })).toThrow(
      /has no entry in the map/,
    );
  });
});

describe('resolveProcessorParams', () => {
  it('fills the declared defaults in', () => {
    expect(resolvedParams('number_round', undefined)).toEqual({ decimals: 2 });
    expect(resolvedParams('number_round', null)).toEqual({ decimals: 2 });
    expect(resolvedParams('text_clean', {})).toEqual({ trim: true, collapseWhitespace: true });
    expect(resolvedParams('text_truncate', { maxLength: 80 })).toEqual({
      maxLength: 80,
      ellipsis: '…',
    });
  });

  it('leaves an optional parameter with no default out', () => {
    expect(resolvedParams('number_scale', { factor: 2 })).toEqual({ factor: 2 });
    expect(resolvedParams('value_map', { map: { a: 'b' } })).toEqual({ map: { a: 'b' } });
  });

  it('rejects a parameter the processor does not declare', () => {
    expect(paramError('number_scale', { factor: 1, facotr: 2 })).toMatch(
      /number_scale@1 has no parameter "facotr"/,
    );
    // The message lists what the processor does take, so the typo is obvious.
    expect(paramError('number_scale', { factor: 1, facotr: 2 })).toMatch(/factor, round/);
  });

  it('rejects a missing required parameter', () => {
    expect(paramError('number_scale', {})).toMatch(/number_scale@1 needs the parameter "factor"/);
    expect(paramError('number_vat', { round: 2 })).toMatch(/needs the parameter "rate"/);
    expect(paramError('text_truncate', {})).toMatch(/needs the parameter "maxLength"/);
    expect(paramError('value_map', {})).toMatch(/needs the parameter "map"/);
  });

  it('rejects a parameter of the wrong type', () => {
    expect(paramError('number_scale', { factor: '0.92' })).toMatch(
      /parameter "factor" must be a number/,
    );
    expect(paramError('number_scale', { factor: NaN })).toMatch(/must be a number/);
    expect(paramError('number_round', { decimals: 1.5 })).toMatch(/must be a whole number/);
    expect(paramError('text_truncate', { maxLength: 5, ellipsis: 3 })).toMatch(/must be a string/);
    expect(paramError('text_clean', { trim: 'yes' })).toMatch(/must be true or false/);
    expect(paramError('value_map', { map: 'nope' })).toMatch(/must be an object/);
    expect(paramError('value_map', { map: [] })).toMatch(/must be an object/);
  });

  it('rejects a value outside the declared min / max', () => {
    expect(paramError('number_vat', { rate: -0.1 })).toMatch(/parameter "rate" must be at least 0/);
    // The bound exists to catch the one typo that matters: 19 for 19%.
    expect(paramError('number_vat', { rate: 19 })).toMatch(/parameter "rate" must be at most 1/);
    expect(paramError('number_scale', { factor: 1, round: -1 })).toMatch(/must be at least 0/);
    expect(paramError('number_scale', { factor: 1, round: 11 })).toMatch(/must be at most 10/);
    expect(paramError('text_truncate', { maxLength: 0 })).toMatch(/must be at least 1/);
  });

  it('rejects a params value that is not an object at all', () => {
    expect(paramError('number_scale', 'factor=1')).toMatch(/"params" must be an object/);
    expect(paramError('number_scale', [{ factor: 1 }])).toMatch(/"params" must be an object/);
  });
});

describe('describeProcessors', () => {
  it('describes every processor without exposing its code', () => {
    const described = describeProcessors();
    expect(described).toHaveLength(PROCESSORS.length);
    expect(described.map((p) => p.ref)).toContain('number_scale@1');
    for (const entry of described) {
      expect(entry).not.toHaveProperty('apply');
      expect(entry.title).toBeTruthy();
      expect(entry.description).toBeTruthy();
      expect(entry.input.type).toBeTruthy();
      expect(entry.output.type).toBeTruthy();
    }
  });

  it('exposes which parameters are required and what the defaults are', () => {
    const described = describeProcessors();
    const scale = described.find((p) => p.ref === 'number_scale@1')!;
    expect(scale.parameters.find((p) => p.name === 'factor')).toEqual({
      name: 'factor',
      type: 'number',
      description: expect.any(String),
      required: true,
    });
    expect(scale.parameters.find((p) => p.name === 'round')).toEqual({
      name: 'round',
      type: 'integer',
      description: expect.any(String),
      required: false,
      min: 0,
      max: 10,
    });

    const round = described.find((p) => p.ref === 'number_round@1')!;
    expect(round.parameters.find((p) => p.name === 'decimals')).toMatchObject({
      required: false,
      default: 2,
    });

    const truncate = described.find((p) => p.ref === 'text_truncate@1')!;
    expect(truncate.parameters.find((p) => p.name === 'maxLength')).toMatchObject({
      required: true,
      min: 1,
    });
    expect(truncate.parameters.find((p) => p.name === 'ellipsis')).toMatchObject({
      required: false,
      default: '…',
    });
  });
});
