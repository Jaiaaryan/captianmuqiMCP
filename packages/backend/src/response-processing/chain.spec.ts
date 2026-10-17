import {
  ResponseProcessingChain,
  Step,
  readChain,
  runChain,
  validateChain,
} from './chain';

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

  it('allows `$` only for script@1', () => {
    expect(validateChain(chainOf([step({ id: 'a', use: 'round@1', reads: '$' })]))).toBe(
      'step a: reads "$" is only allowed for script@1',
    );
    expect(validateChain(chainOf([step({ id: 'a', use: 'round@1', writes: '$', mode: 'replace' })]))).toBe(
      'step a: writes "$" is only allowed for script@1',
    );
    expect(
      validateChain(
        chainOf([step({ id: 'a', use: 'script@1', reads: '$', writes: '$', mode: 'replace', code: 'return value' })]),
      ),
    ).toBeNull();
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
