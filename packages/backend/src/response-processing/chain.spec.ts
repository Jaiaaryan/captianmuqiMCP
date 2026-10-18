import {
  ResponseProcessingChain,
  Step,
  readChain,
  runChain,
  validateChain,
} from './chain';
import { SNAPSHOT_TABLE, setRatesProvider } from './rates-table';

const sample = () => ({
  category: 'fasteners',
  items: [
    {
      itemNo: 'X',
      description: '  Black Screw   60mm',
      price_usd: 54.67,
      currency: 'USD',
      moq: 100,
    },
  ],
});

const step = (over: Partial<Step> & Pick<Step, 'id' | 'use'>): Step => ({
  each: '$.items[*]',
  reads: 'price_usd',
  writes: 'price_eur',
  mode: 'add',
  ...over,
});

const chainOf = (steps: Step[], over: Partial<ResponseProcessingChain> = {}): ResponseProcessingChain => ({
  version: 1,
  enabled: true,
  onError: 'fail',
  steps,
  ...over,
});

/** The P1 chain of the CODEBOUND kit. */
const P1: ResponseProcessingChain = chainOf([
  step({
    id: 'convert_to_eur',
    use: 'scale@1',
    reads: 'price_usd',
    writes: 'price_eur',
    mode: 'add',
    params: { factor: 0.92, round: 2 },
  }),
  step({
    id: 'add_vat',
    use: 'vat@1',
    reads: 'price_eur',
    writes: 'price_eur_gross',
    mode: 'add',
    params: { rate: 0.19, round: 2 },
  }),
  step({
    id: 'tidy_description',
    use: 'clean_text@1',
    reads: 'description',
    writes: 'description',
    mode: 'replace',
  }),
]);

function ok(raw: unknown, chain: ResponseProcessingChain, trace = false) {
  const r = runChain(raw, chain, { trace });
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r;
}

function fail(raw: unknown, chain: ResponseProcessingChain) {
  const r = runChain(raw, chain);
  if (r.ok) throw new Error('expected a failure');
  return r;
}

describe('runChain: the P1 chain', () => {
  it('adds EUR net and gross prices and tidies the description, in field order', () => {
    const { value } = ok(sample(), P1);
    const item = (value as ReturnType<typeof sample>).items[0] as Record<string, unknown>;
    expect(item.price_eur).toBe(50.3);
    expect(item.price_eur_gross).toBe(59.86);
    expect(item.description).toBe('Black Screw 60mm');
    expect(Object.keys(item)).toEqual([
      'itemNo',
      'description',
      'price_usd',
      'currency',
      'moq',
      'price_eur',
      'price_eur_gross',
    ]);
    expect((value as any).category).toBe('fasteners');
  });

  it('does not touch its input', () => {
    const input = sample();
    ok(input, P1);
    expect(input).toEqual(sample());
  });

  it('fails the whole response for one bad element, with nothing half-edited', () => {
    const input = sample();
    (input.items[0] as any).price_usd = 'n/a';
    const r = fail(input, P1);
    expect(r.error).toBe('step convert_to_eur: $.items[0].price_usd is not a number');
    expect(r.failedStep).toBe('convert_to_eur');
    expect(r.failedPath).toBe('$.items[0].price_usd');
    expect('value' in r).toBe(false);
  });

  it('names the element index of the failure', () => {
    const input = sample();
    input.items.push({ ...input.items[0] }, { ...input.items[0], price_usd: null as any });
    const r = fail(input, P1);
    expect(r.error).toBe('step convert_to_eur: $.items[2].price_usd is not a number');
  });
});

describe('runChain: modes and missing fields', () => {
  it('add refuses an existing target', () => {
    const r = fail(
      sample(),
      chainOf([step({ id: 'a', use: 'scale@1', writes: 'moq', params: { factor: 2 } })]),
    );
    expect(r.error).toBe('step a: $.items[0].moq already exists, and the mode is "add"');
  });

  it('replace refuses a missing target', () => {
    const r = fail(
      sample(),
      chainOf([step({ id: 'a', use: 'scale@1', mode: 'replace', params: { factor: 2 } })]),
    );
    expect(r.error).toBe('step a: $.items[0].price_eur does not exist, and the mode is "replace"');
  });

  it('upsert takes either', () => {
    const { value } = ok(
      sample(),
      chainOf([
        step({ id: 'a', use: 'scale@1', mode: 'upsert', params: { factor: 2 } }),
        step({ id: 'b', use: 'scale@1', reads: 'price_eur', writes: 'price_eur', mode: 'upsert', params: { factor: 2 } }),
      ]),
    );
    expect((value as any).items[0].price_eur).toBe(218.68);
  });

  it('fails on a missing reads by default', () => {
    const r = fail(
      sample(),
      chainOf([step({ id: 'a', use: 'scale@1', reads: 'nope', params: { factor: 2 } })]),
    );
    expect(r.error).toBe('step a: $.items[0].nope is missing');
  });

  it('onMissing skip leaves those elements alone and counts them', () => {
    const input = sample();
    input.items.push({ itemNo: 'Y' } as any);
    const r = ok(
      input,
      chainOf([step({ id: 'a', use: 'scale@1', onMissing: 'skip', params: { factor: 2 } })]),
      true,
    );
    expect((r.value as any).items[1]).toEqual({ itemNo: 'Y' });
    expect((r.value as any).items[0].price_eur).toBe(109.34);
    expect(r.steps[0]).toMatchObject({ id: 'a', wrote: 1, skipped: 1 });
  });

  it('refuses a missing collection, or skips it', () => {
    const base = step({ id: 'a', use: 'scale@1', each: '$.rows[*]', params: { factor: 2 } });
    expect(fail(sample(), chainOf([base])).error).toBe('step a: $.rows[*] is missing');
    const r = ok(sample(), chainOf([{ ...base, onMissing: 'skip' }]));
    expect(r.value).toEqual(sample());
  });

  it('writes into nested objects, creating them', () => {
    const { value } = ok(
      sample(),
      chainOf([step({ id: 'a', use: 'scale@1', writes: 'prices.eur', params: { factor: 2 } })]),
    );
    expect((value as any).items[0].prices).toEqual({ eur: 109.34 });
  });

  it('refuses to write under a non-object', () => {
    const r = fail(
      sample(),
      chainOf([step({ id: 'a', use: 'scale@1', writes: 'moq.eur', params: { factor: 2 } })]),
    );
    expect(r.error).toBe('step a: $.items[0].moq is not an object, so nothing can be written under it');
  });

  it('reports a map miss', () => {
    const input = { items: [{ s: 7 }] };
    const r = fail(
      input,
      chainOf([
        step({ id: 'm', use: 'map@1', reads: 's', writes: 'label', params: { map: { '1': 'x' } } }),
      ]),
    );
    expect(r.error).toBe('step m: $.items[0].s has no entry in the map ("7")');
  });
});

describe('runChain: collections', () => {
  const doubler = (each?: string) =>
    step({ id: 'a', use: 'scale@1', each, reads: 'n', writes: 'n2', params: { factor: 2 } });

  it('`$.items` means its elements', () => {
    const { value } = ok({ items: [{ n: 1 }, { n: 2 }] }, chainOf([doubler('$.items')]));
    expect((value as any).items).toEqual([{ n: 1, n2: 2 }, { n: 2, n2: 4 }]);
  });

  it('a root array is processed element by element when `each` is omitted', () => {
    const { value } = ok([{ n: 1 }, { n: 2 }], chainOf([doubler(undefined)]));
    expect(value).toEqual([{ n: 1, n2: 2 }, { n: 2, n2: 4 }]);
  });

  it('a root object is the single element when `each` is omitted', () => {
    const { value } = ok({ n: 3 }, chainOf([doubler(undefined)]));
    expect(value).toEqual({ n: 3, n2: 6 });
  });

  it('nested wildcards', () => {
    const { value } = ok(
      { groups: [{ rows: [{ n: 1 }] }, { rows: [{ n: 2 }, { n: 3 }] }] },
      chainOf([doubler('$.groups[*].rows[*]')]),
    );
    expect((value as any).groups[1].rows[1]).toEqual({ n: 3, n2: 6 });
  });

  it('refuses an unsafe path at validation', () => {
    expect(validateChain(chainOf([doubler('$.__proto__[*]')]))).toMatch(/Unsafe path segment/);
  });
});

describe('runChain: script@1', () => {
  it('computes one field from another', () => {
    const { value } = ok(
      sample(),
      chainOf([
        step({
          id: 'clean',
          use: 'script@1',
          reads: 'description',
          writes: 'description',
          mode: 'replace',
          code: "return String(value).trim().replace(/\\s+/g, ' ');",
        }),
      ]),
    );
    expect((value as any).items[0].description).toBe('Black Screw 60mm');
  });

  it('sees params', () => {
    const { value } = ok(
      sample(),
      chainOf([
        step({ id: 's', use: 'script@1', code: 'return value * params.k', params: { k: 3 } }),
      ]),
    );
    expect((value as any).items[0].price_eur).toBeCloseTo(164.01, 2);
  });

  it('reads the whole element with `$` and writes a field', () => {
    const { value } = ok(
      sample(),
      chainOf([
        step({
          id: 's',
          use: 'script@1',
          reads: '$',
          writes: 'label',
          code: 'return value.itemNo + "-" + value.moq',
        }),
      ]),
    );
    expect((value as any).items[0].label).toBe('X-100');
  });

  it('replaces each element with `$` / `$`', () => {
    const { value } = ok(
      sample(),
      chainOf([
        step({
          id: 's',
          use: 'script@1',
          reads: '$',
          writes: '$',
          mode: 'replace',
          code: 'return { no: value.itemNo }',
        }),
      ]),
    );
    expect((value as any).items).toEqual([{ no: 'X' }]);
  });

  it('gives a per-element script the whole response as `response`', () => {
    const { value } = ok(
      sample(),
      chainOf([
        step({
          id: 's',
          use: 'script@1',
          each: '$.items[*]',
          reads: '$',
          writes: 'of',
          mode: 'add',
          code: 'return response.items.length',
        }),
      ]),
    );
    const items = (value as { items: Array<{ of: number }> }).items;
    expect(items.every((it) => it.of === items.length)).toBe(true);
  });

  it('replaces the whole response when `each` is omitted', () => {
    const { value } = ok(
      sample(),
      chainOf([
        step({
          id: 's',
          use: 'script@1',
          each: undefined,
          reads: '$',
          writes: '$',
          mode: 'replace',
          code: 'return { count: value.items.length }',
        }),
      ]),
    );
    expect(value).toEqual({ count: 1 });
  });

  it('does not allow mode add on `$`', () => {
    const r = fail(
      sample(),
      chainOf([
        step({ id: 's', use: 'script@1', reads: '$', writes: '$', mode: 'add', code: 'return 1' }),
      ]),
    );
    expect(r.error).toBe('step s: $.items[0] already exists, and the mode is "add"');
  });

  it('reports a throw, with the path', () => {
    const r = fail(
      sample(),
      chainOf([step({ id: 's', use: 'script@1', code: 'throw new Error("boom")' })]),
    );
    expect(r.error).toBe('step s: $.items[0].price_usd script threw: boom');
  });

  it('reports a timeout', () => {
    const started = Date.now();
    const r = fail(
      sample(),
      chainOf([step({ id: 's', use: 'script@1', code: 'while(true){}' })]),
    );
    expect(r.error).toBe('step s: $.items[0].price_usd script timed out (250 ms)');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('runs many elements through one step', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ n: i }));
    const { value } = ok(
      { items },
      chainOf([
        step({ id: 's', use: 'script@1', reads: 'n', writes: 'sq', code: 'return value * value' }),
      ]),
    );
    expect((value as any).items[7].sq).toBe(49);
  });
});

describe('runChain: control', () => {
  it('enabled: false runs nothing and returns the same value', () => {
    const input = sample();
    const r = runChain(input, { ...P1, enabled: false }, { trace: true });
    expect(r).toEqual({ ok: true, value: input, steps: [] });
    expect((r as any).value).toBe(input);
  });

  it('traces counts, size and the first element after each step', () => {
    const r = ok(sample(), P1, true);
    expect(r.steps.map((s) => s.id)).toEqual(['convert_to_eur', 'add_vat', 'tidy_description']);
    expect(r.steps.every((s) => s.wrote === 1 && s.skipped === 0)).toBe(true);
    expect(r.steps[0].sample).toMatchObject({ price_eur: 50.3 });
    expect((r.steps[0].sample as any).price_eur_gross).toBeUndefined();
    expect(r.steps[2].sample).toMatchObject({ description: 'Black Screw 60mm' });
    expect(r.steps[2].bytes).toBe(Buffer.byteLength(JSON.stringify(r.value)));
    expect(r.steps[0].bytes).toBeLessThan(r.steps[1].bytes);
  });

  it('keeps the trace of the steps before a failure', () => {
    const input = sample();
    const chain = chainOf([
      P1.steps[0],
      step({ id: 'boom', use: 'scale@1', reads: 'currency', writes: 'x', params: { factor: 1 } }),
    ]);
    const r = runChain(input, chain, { trace: true });
    expect(r.ok).toBe(false);
    expect(r.steps.map((s) => s.id)).toEqual(['convert_to_eur']);
  });

  it('reports a malformed stored chain as a failure', () => {
    const r = runChain(sample(), { version: 2 } as any);
    expect(r).toMatchObject({ ok: false, error: 'version must be 1' });
  });
});

describe('readChain', () => {
  it('returns null without the key and the chain with it', () => {
    expect(readChain(null)).toBeNull();
    expect(readChain({})).toBeNull();
    expect(readChain({ responseProcessing: null })).toBeNull();
    expect(readChain({ responseProcessing: P1 })).toBe(P1);
  });
});

describe('validateChain', () => {
  const good = () => structuredClone(P1);

  it('accepts the P1 chain and an empty one', () => {
    expect(validateChain(good())).toBeNull();
    expect(validateChain(chainOf([]))).toBeNull();
  });

  it('checks the chain level', () => {
    expect(validateChain(null)).toBe('chain must be an object');
    expect(validateChain({ ...good(), version: 2 })).toBe('version must be 1');
    expect(validateChain({ ...good(), enabled: 'yes' })).toMatch(/enabled/);
    expect(validateChain({ ...good(), onError: 'x' })).toMatch(/onError/);
    expect(validateChain({ ...good(), steps: 'x' })).toMatch(/steps must be an array/);
    expect(validateChain({ ...good(), extra: 1 })).toBe('unknown field "extra"');
  });

  it('allows at most 20 steps', () => {
    const many = Array.from({ length: 21 }, (_, i) =>
      step({ id: `s${i}`, use: 'round@1', mode: 'upsert' }),
    );
    expect(validateChain(chainOf(many))).toBe('steps: at most 20');
    expect(validateChain(chainOf(many.slice(0, 20)))).toBeNull();
  });

  it('checks ids', () => {
    expect(validateChain(chainOf([step({ id: '-a', use: 'round@1' })]))).toMatch(/^steps\[0\]: id must match/);
    const dup = chainOf([step({ id: 'a', use: 'round@1' }), step({ id: 'a', use: 'round@1', writes: 'b' })]);
    expect(validateChain(dup)).toBe('step a: id is used twice');
  });

  it('checks the processor and its params', () => {
    expect(validateChain(chainOf([step({ id: 'a', use: 'nope@1' as any })]))).toBe(
      'step a: unknown processor "nope@1"',
    );
    expect(validateChain(chainOf([step({ id: 'a', use: 'scale@1' })]))).toBe(
      'step a: params.factor is required',
    );
    expect(
      validateChain(chainOf([step({ id: 'a', use: 'scale@1', params: { factor: 1, round: 11 } })])),
    ).toMatch(/^step a: params\.round must be an integer between 0 and 10/);
    expect(
      validateChain(chainOf([step({ id: 'a', use: 'scale@1', params: { factor: 1, bogus: 1 } })])),
    ).toMatch(/^step a: unknown param "bogus"/);
  });

  it('allows `$` for every processor', () => {
    expect(validateChain(chainOf([step({ id: 'a', use: 'round@1', reads: '$' })]))).toBeNull();
    expect(
      validateChain(chainOf([step({ id: 'a', use: 'round@1', reads: '$', writes: '$', mode: 'replace' })])),
    ).toBeNull();
    expect(
      validateChain(
        chainOf([step({ id: 'a', use: 'script@1', reads: '$', writes: '$', mode: 'replace', code: 'return value' })]),
      ),
    ).toBeNull();
  });

  it('runs a built-in on the values of an object (`$.prices[*]`, `$` -> `$`)', () => {
    const doc = { prices: { 'A-1': 10, 'B-2': 2.5 } };
    const c = chainOf([
      step({ id: 'eur', use: 'scale@1', each: '$.prices[*]', reads: '$', writes: '$', mode: 'replace', params: { factor: 2 } }),
    ]);
    expect(ok(doc, c).value).toEqual({ prices: { 'A-1': 20, 'B-2': 5 } });
    const add = chainOf([{ ...c.steps[0], mode: 'add' }]);
    expect(validateChain(add)).toBeNull();
    expect(fail(doc, add).error).toBe(`step eur: $.prices['A-1'] already exists, and the mode is "add"`);
  });

  it('checks paths', () => {
    expect(validateChain(chainOf([step({ id: 'a', use: 'round@1', reads: 'a[*]' })]))).toMatch(
      /reads must address exactly one value/,
    );
    expect(validateChain(chainOf([step({ id: 'a', use: 'round@1', writes: 'a[0]' })]))).toMatch(
      /writes must be an object-key path/,
    );
    for (const bad of ['__proto__.x', 'constructor', "a['prototype']"]) {
      expect(validateChain(chainOf([step({ id: 'a', use: 'round@1', writes: bad })]))).toMatch(
        /Unsafe path segment/,
      );
    }
    expect(validateChain(chainOf([step({ id: 'a', use: 'round@1', mode: 'x' as any })]))).toMatch(/mode must be/);
    expect(validateChain(chainOf([step({ id: 'a', use: 'round@1', onMissing: 'x' as any })]))).toMatch(/onMissing/);
  });

  it('checks script code', () => {
    expect(validateChain(chainOf([step({ id: 'a', use: 'script@1' })]))).toBe(
      'step a: code is required for script@1',
    );
    expect(validateChain(chainOf([step({ id: 'a', use: 'round@1', code: 'return 1' })]))).toBe(
      'step a: code is only for script@1',
    );
    expect(
      validateChain(chainOf([step({ id: 'a', use: 'script@1', code: 'return 1; //' + 'x'.repeat(16384) })])),
    ).toMatch(/^step a: code too large/);
    expect(
      validateChain(chainOf([step({ id: 'a', use: 'script@1', code: 'const a = 1;\nconst b = ;' })])),
    ).toMatch(/^step a: .*\(line 2\)$/);
  });
});

describe('pipes: use as a list of built-ins', () => {
  const pipe = (over: Partial<Step> = {}) =>
    chainOf([
      step({
        id: 'convert_to_eur',
        use: ['scale@1', 'round@1'],
        params: [{ factor: 0.92 }, { decimals: 2 }],
        ...over,
      }),
    ]);

  it('applies the processors in order to the same read value', () => {
    const r = ok(sample(), pipe());
    expect((r.value as any).items[0].price_eur).toBe(50.3);
  });

  it('gives the same result as the single step with its own round', () => {
    const single = ok(sample(), chainOf([P1.steps[0]]));
    expect((ok(sample(), pipe()).value as any).items[0].price_eur).toBe(
      (single.value as any).items[0].price_eur,
    );
  });

  it('validates every processor against its own params', () => {
    expect(validateChain(pipe())).toBeNull();
    expect(validateChain(pipe({ params: [{ factor: 0.92 }, { decimals: 99 }] }))).toMatch(
      /^step convert_to_eur: round@1: params\.decimals must be an integer/,
    );
    expect(validateChain(pipe({ params: { factor: 1 } as any }))).toMatch(/params must be an array/);
    expect(validateChain(pipe({ params: undefined, use: ['round@1', 'round@1'] }))).toBeNull();
  });

  it('refuses script@1, unknown names and empty pipes', () => {
    expect(validateChain(pipe({ use: ['scale@1', 'script@1'] as any }))).toMatch(/script@1 cannot be part of a pipe/);
    expect(validateChain(pipe({ use: ['scale@1', 'nope@1'] as any }))).toMatch(/unknown processor "nope@1"/);
    expect(validateChain(pipe({ use: [] as any, params: undefined }))).toMatch(/at least one processor/);
    expect(validateChain(pipe({ reads: '$', writes: '$', mode: 'replace' }))).toBeNull();
  });

  it('accepts currency@1 in a pipe', () => {
    const c = pipe({ use: ['currency@1', 'offset@1'], params: [{ rate: 0.92 }, { amount: 1 }] });
    expect(validateChain(c)).toBeNull();
    expect((ok(sample(), c).value as any).items[0].price_eur).toBe(51.3);
    expect(validateChain(pipe({ use: ['currency@1'], params: [{ rate: 0 }] }))).toMatch(
      /^step convert_to_eur: currency@1: params\.rate must be a number greater than 0/,
    );
    const single = chainOf([step({ id: 'eur', use: 'currency@1', params: { rate: 0.92 } })]);
    expect(validateChain(single)).toBeNull();
    expect(fail({ items: [{ price_usd: 'n/a' }] }, single).error).toBe(
      'step eur: $.items[0].price_usd is not a number',
    );
  });

  it('names the processor that refused the value', () => {
    const r = fail(
      { items: [{ price_usd: 1, label: 'x' }] },
      chainOf([step({ id: 'p', use: ['clean_text@1', 'round@1'], reads: 'label', params: [{}, {}] })]),
    );
    expect(r.error).toBe('step p: $.items[0].label is not a number (round@1)');
  });
});

describe('script@1: builtins', () => {
  const script = (code: string) =>
    chainOf([step({ id: 's', use: 'script@1', reads: 'price_usd', writes: 'price_eur', mode: 'add', code })]);

  it('offers the step processors as functions', () => {
    const r = ok(sample(), script('return builtins.round(builtins.scale(value, { factor: 0.92 }), 2);'));
    expect((r.value as any).items[0].price_eur).toBe(50.3);
  });
});

describe('numeric built-ins on an array or object value', () => {
  const prices = (over: Record<string, unknown> = {}) => ({
    prices: { 'A-10338': 10, 'A-10339': 2.5, B1: 100, ...over },
  });
  const convert = (over: Partial<Step> = {}) =>
    chainOf([
      step({ id: 'convert', use: 'currency@1', each: undefined, reads: 'prices', writes: 'prices_eur', params: { rate: 1.1 }, ...over }),
    ]);

  it('maps an object of numbers to an object with the same keys', () => {
    const r = ok(prices(), convert());
    expect((r.value as any).prices_eur).toEqual({ 'A-10338': 11, 'A-10339': 2.75, B1: 110 });
    expect((r.value as any).prices).toEqual(prices().prices);
  });

  it('maps an array of numbers to an array', () => {
    const r = ok({ prices: [1, 2] }, convert());
    expect((r.value as any).prices_eur).toEqual([1.1, 2.2]);
  });

  it('names the inner path of a value that is not a number', () => {
    expect(fail(prices({ 'A-10339': 'n/a' }), convert()).error).toBe(
      "step convert: $.prices['A-10339'] is not a number",
    );
    const nested = fail(prices({ B1: { net: 1 } }), convert());
    expect(nested.error).toBe('step convert: $.prices.B1 is not a number');
    expect(nested.failedPath).toBe('$.prices.B1');
    expect(fail({ prices: [1, 'x'] }, convert()).error).toBe('step convert: $.prices[1] is not a number');
  });

  it('works through a pipe, stage by stage', () => {
    const pipe = convert({ use: ['currency@1', 'offset@1'], params: [{ rate: 1.1 }, { amount: 1 }] });
    expect((ok({ prices: { a: 10 } }, pipe).value as any).prices_eur).toEqual({ a: 12 });
    expect(fail({ prices: { a: 10, b: 'x' } }, pipe).error).toBe('step convert: $.prices.b is not a number (currency@1)');
  });
});

describe('currency@1 from/to: the rate looked up in the rates table', () => {
  const rates = { base: 'EUR', asOf: '2026-10-17', source: 'ECB', rates: { USD: 1.25, GBP: 0.8 } };
  const convert = (params: Record<string, unknown>) =>
    chainOf([step({ id: 'eur', use: 'currency@1', params })]);
  afterEach(() => setRatesProvider(() => SNAPSHOT_TABLE));

  it('converts with rates[to] / rates[from], base EUR = 1', () => {
    const r = runChain({ items: [{ price_usd: 10 }] }, convert({ from: 'USD', to: 'EUR' }), { rates });
    expect(r.ok && (r.value as any).items[0].price_eur).toBe(8);
    const cross = runChain({ items: [{ price_usd: 10 }] }, convert({ from: 'USD', to: 'GBP' }), { rates });
    expect(cross.ok && (cross.value as any).items[0].price_eur).toBe(6.4);
  });

  it('keeps a stored rate over the table (manual)', () => {
    const r = runChain({ items: [{ price_usd: 10 }] }, convert({ from: 'USD', to: 'EUR', rate: 0.5 }), { rates });
    expect(r.ok && (r.value as any).items[0].price_eur).toBe(5);
  });

  it('fails the step for a pair the table lacks', () => {
    const r = runChain({ items: [{ price_usd: 10 }] }, convert({ from: 'USD', to: 'XAU' }), { rates });
    expect(r).toMatchObject({ ok: false, error: 'step eur: no rate for USD→XAU', failedStep: 'eur' });
  });

  it('reads the registered table once per response, not per element', () => {
    const provider = jest.fn(() => rates);
    setRatesProvider(provider);
    const items = Array.from({ length: 5 }, () => ({ price_usd: 2 }));
    const two = chainOf([
      step({ id: 'a', use: 'currency@1', params: { from: 'USD', to: 'EUR' } }),
      step({ id: 'b', use: ['currency@1', 'round@1'], writes: 'price_gbp', params: [{ from: 'USD', to: 'GBP' }, {}] }),
    ]);
    const r = runChain({ items }, two);
    expect(r.ok).toBe(true);
    expect((r as any).value.items[4]).toMatchObject({ price_eur: 1.6, price_gbp: 1.28 });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('does not read the table for a rate-only chain', () => {
    const provider = jest.fn(() => rates);
    setRatesProvider(provider);
    expect(runChain({ items: [{ price_usd: 10 }] }, convert({ rate: 0.92 })).ok).toBe(true);
    expect(provider).not.toHaveBeenCalled();
  });

  it('falls back to the shipped snapshot (USD→EUR about 0.92)', () => {
    const r = runChain({ items: [{ price_usd: 100 }] }, convert({ from: 'USD', to: 'EUR' }));
    expect(r.ok && (r.value as any).items[0].price_eur).toBe(92);
  });

  it('validates the codes at save time', () => {
    expect(validateChain(convert({ from: 'USD', to: 'EUR' }))).toBeNull();
    expect(validateChain(convert({ from: 'usd', to: 'EUR' }))).toMatch(/^step eur: params\.from must be a currency code/);
    expect(validateChain(convert({ to: 'EUR' }))).toBe('step eur: params.rate, or params.from and params.to is required');
  });
});
