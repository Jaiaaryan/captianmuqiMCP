import {
  PROCESSOR_CHAIN_LIMITS,
  hasProcessorChain,
  readProcessorChain,
  runProcessorChain,
  validateProcessorChain,
  type ProcessorChain,
  type ProcessorChainResult,
} from './processor-chain.util';
import { applyResponseTransform } from './response-transform.util';

/* ------------------------------------------------------------------ */
/*  Fixtures — the supplier catalogue rows the feature was built for   */
/* ------------------------------------------------------------------ */

interface CatalogueItem {
  itemNo: string;
  description: string;
  price_usd: unknown;
  currency: string;
  moq: number;
}

/** A fresh copy per test, so one test's edits can never reach another. */
function catalogue(): { page: number; items: CatalogueItem[] } {
  return {
    page: 1,
    items: [
      {
        itemNo: 'A-OFF-FAS-001',
        description: '  Black   Screw\n60mm ',
        price_usd: 54.67,
        currency: 'USD',
        moq: 100,
      },
      {
        itemNo: 'A-OFF-FAS-002',
        description: 'Hex\tNut   M8 ',
        price_usd: 75.87,
        currency: 'USD',
        moq: 250,
      },
      {
        itemNo: 'A-OFF-FAS-004',
        description: ' Anchor   Bolt\r\n120mm',
        price_usd: 245.4,
        currency: 'USD',
        moq: 50,
      },
      {
        itemNo: 'A-OFF-FAS-015',
        description: 'Washer    DIN125 ',
        price_usd: 89.05,
        currency: 'USD',
        moq: 1000,
      },
      {
        itemNo: 'A-OFF-FAS-022',
        description: '  Wood\n\nScrew  40mm',
        price_usd: 8.33,
        currency: 'USD',
        moq: 500,
      },
    ],
  };
}

/** The numbers P1 of the acceptance contract quotes, row by row. */
const P1_EXPECTED = [
  { itemNo: 'A-OFF-FAS-001', price_eur: 50.3, price_eur_gross: 59.86 },
  { itemNo: 'A-OFF-FAS-002', price_eur: 69.8, price_eur_gross: 83.06 },
  { itemNo: 'A-OFF-FAS-004', price_eur: 225.77, price_eur_gross: 268.67 },
  { itemNo: 'A-OFF-FAS-015', price_eur: 81.93, price_eur_gross: 97.5 },
  { itemNo: 'A-OFF-FAS-022', price_eur: 7.66, price_eur_gross: 9.12 },
];

const P1_CLEANED_DESCRIPTIONS = [
  'Black Screw 60mm',
  'Hex Nut M8',
  'Anchor Bolt 120mm',
  'Washer DIN125',
  'Wood Screw 40mm',
];

/** USD → EUR, then VAT on the converted price, then tidy the description. */
const P1_CHAIN: ProcessorChain = {
  version: 1,
  enabled: true,
  onError: 'fail',
  steps: [
    {
      id: 'convert_to_eur',
      processor: 'number_scale@1',
      each: '$.items[*]',
      reads: 'price_usd',
      writes: 'price_eur',
      mode: 'add',
      params: { factor: 0.92, round: 2 },
    },
    {
      id: 'add_vat',
      processor: 'number_vat@1',
      each: '$.items[*]',
      reads: 'price_eur',
      writes: 'price_eur_gross',
      mode: 'add',
      params: { rate: 0.19, round: 2 },
    },
    {
      id: 'clean_description',
      processor: 'text_clean@1',
      each: '$.items[*]',
      reads: 'description',
      writes: 'description',
      mode: 'replace',
    },
  ],
};

/** The index P2 of the acceptance contract puts the unconvertible row at. */
const BAD_ROW_INDEX = 2;

/** The same catalogue with one row the upstream filled in as text. */
function catalogueWithBadPrice(): { page: number; items: CatalogueItem[] } {
  const doc = catalogue();
  doc.items[BAD_ROW_INDEX].price_usd = 'n/a';
  return doc;
}

/* ------------------------------------------------------------------ */
/*  Narrowing helpers                                                  */
/* ------------------------------------------------------------------ */

function expectOk(result: ProcessorChainResult): Extract<ProcessorChainResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected the chain to succeed, got: ${result.error}`);
  return result;
}

function expectFailed(result: ProcessorChainResult): Extract<ProcessorChainResult, { ok: false }> {
  if (result.ok) throw new Error('expected the chain to fail, but it succeeded');
  return result;
}

/** A one-step chain over the whole response, for the write-mode cases. */
function singleStep(step: Partial<ProcessorChain['steps'][number]>): ProcessorChain {
  return {
    steps: [
      {
        id: 'step_one',
        processor: 'number_scale@1',
        reads: 'price',
        writes: 'price_eur',
        params: { factor: 0.5 },
        ...step,
      } as ProcessorChain['steps'][number],
    ],
  };
}

/* ------------------------------------------------------------------ */
/*  The acceptance contract: Level 1 · processor chains, checks P1/P2  */
/* ------------------------------------------------------------------ */

describe('runProcessorChain — CODEBOUND Level 1 processor chains, check P1', () => {
  it('P1: converts, adds VAT and cleans every catalogue row to the quoted numbers', () => {
    const result = expectOk(runProcessorChain(catalogue(), P1_CHAIN));
    const items = (result.value as { items: Record<string, unknown>[] }).items;

    expect(result.applied).toBe(true);
    expect(items).toHaveLength(P1_EXPECTED.length);
    for (const [index, expected] of P1_EXPECTED.entries()) {
      expect({
        itemNo: items[index].itemNo,
        price_eur: items[index].price_eur,
        price_eur_gross: items[index].price_eur_gross,
      }).toEqual(expected);
    }
  });

  it('P1: preserves the order of the items', () => {
    const result = expectOk(runProcessorChain(catalogue(), P1_CHAIN));
    const items = (result.value as { items: CatalogueItem[] }).items;
    expect(items.map((item) => item.itemNo)).toEqual(P1_EXPECTED.map((row) => row.itemNo));
  });

  it('P1: leaves every field it was not pointed at byte-identical', () => {
    const before = catalogue();
    const result = expectOk(runProcessorChain(before, P1_CHAIN));
    const items = (result.value as { items: CatalogueItem[] }).items;

    const untouched = (doc: { items: CatalogueItem[] }) =>
      doc.items.map((item) => ({
        itemNo: item.itemNo,
        currency: item.currency,
        moq: item.moq,
        price_usd: item.price_usd,
      }));
    expect(JSON.stringify(untouched({ items }))).toBe(JSON.stringify(untouched(before)));
    expect((result.value as { page: number }).page).toBe(1);
  });

  it('P1: cleans the descriptions in place, collapsing runs of whitespace', () => {
    const result = expectOk(runProcessorChain(catalogue(), P1_CHAIN));
    const items = (result.value as { items: CatalogueItem[] }).items;
    expect(items[0].description).toBe('Black Screw 60mm');
    expect(items.map((item) => item.description)).toEqual(P1_CLEANED_DESCRIPTIONS);
  });

  it('P1: reports what each of the three steps touched', () => {
    const result = expectOk(runProcessorChain(catalogue(), P1_CHAIN));
    expect(result.steps).toEqual([
      {
        id: 'convert_to_eur',
        processor: 'number_scale@1',
        mode: 'add',
        targets: 5,
        written: 5,
        skipped: 0,
      },
      {
        id: 'add_vat',
        processor: 'number_vat@1',
        mode: 'add',
        targets: 5,
        written: 5,
        skipped: 0,
      },
      {
        id: 'clean_description',
        processor: 'text_clean@1',
        mode: 'replace',
        targets: 5,
        written: 5,
        skipped: 0,
      },
    ]);
  });
});

describe('runProcessorChain — CODEBOUND Level 1 processor chains, check P2', () => {
  it('P2: fails the run and names the step and the exact path of the refused value', () => {
    const result = expectFailed(runProcessorChain(catalogueWithBadPrice(), P1_CHAIN));

    expect(result.error).toBe(
      `step convert_to_eur: $.items[${BAD_ROW_INDEX}].price_usd is not a number`,
    );
    expect(result.error).toContain(`$.items[${BAD_ROW_INDEX}].price_usd`);
    expect(result.failedStep).toBe('convert_to_eur');
    expect(result.failedPath).toBe(`$.items[${BAD_ROW_INDEX}].price_usd`);
  });

  it('P2: returns the original response, never a half-converted one', () => {
    const raw = catalogueWithBadPrice();
    const result = expectFailed(runProcessorChain(raw, P1_CHAIN));

    expect(result.applied).toBe(false);
    expect(result.value).toBe(raw); // identity, not just deep equality
    const items = (result.value as { items: CatalogueItem[] }).items;
    // The rows before the bad one were converted on the private copy; none of
    // that may show up here.
    for (const item of items) {
      expect(item).not.toHaveProperty('price_eur');
      expect(item).not.toHaveProperty('price_eur_gross');
    }
    expect(items[0].description).toBe('  Black   Screw\n60mm ');
  });

  it('P2: does not mutate the caller’s response on the way out', () => {
    const raw = catalogueWithBadPrice();
    const before = JSON.stringify(raw);
    runProcessorChain(raw, P1_CHAIN);
    expect(JSON.stringify(raw)).toBe(before);
  });
});

/* ------------------------------------------------------------------ */
/*  Reading the config off a tool                                      */
/* ------------------------------------------------------------------ */

describe('readProcessorChain / hasProcessorChain', () => {
  const steps = P1_CHAIN.steps;

  it('returns null when there is nothing to run', () => {
    expect(readProcessorChain(undefined)).toBeNull();
    expect(readProcessorChain(null)).toBeNull();
    expect(readProcessorChain({})).toBeNull();
    expect(readProcessorChain({ transform: { select: { a: 'a' } } })).toBeNull();
    expect(readProcessorChain({ processors: 'nope' })).toBeNull();
    expect(readProcessorChain({ processors: { enabled: false, steps } })).toBeNull();
    expect(readProcessorChain({ processors: { steps: [] } })).toBeNull();
    expect(readProcessorChain({ processors: { steps: 'nope' } })).toBeNull();
  });

  it('returns the chain when it has steps and is not turned off', () => {
    expect(readProcessorChain({ processors: { steps } })).toEqual({ steps });
    expect(readProcessorChain({ processors: { enabled: true, steps } })).toEqual({
      enabled: true,
      steps,
    });
  });

  it('hasProcessorChain mirrors it', () => {
    expect(hasProcessorChain({ processors: { steps } })).toBe(true);
    expect(hasProcessorChain({ processors: { enabled: false, steps } })).toBe(false);
    expect(hasProcessorChain({ cacheTtl: 300 })).toBe(false);
    expect(hasProcessorChain(undefined)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Validation — save time, a message rather than a throw              */
/* ------------------------------------------------------------------ */

describe('validateProcessorChain', () => {
  const good = P1_CHAIN.steps[0];

  it('accepts an absent config and a usable chain', () => {
    expect(validateProcessorChain(undefined)).toBeNull();
    expect(validateProcessorChain(null)).toBeNull();
    expect(validateProcessorChain(P1_CHAIN)).toBeNull();
    expect(validateProcessorChain({ steps: [] })).toBeNull();
    expect(validateProcessorChain({ steps: [{ ...good, each: undefined }] })).toBeNull();
  });

  it('reports a message instead of throwing, for every shape problem', () => {
    expect(validateProcessorChain('nope')).toMatch(/processors must be an object/);
    expect(validateProcessorChain({})).toMatch(/processors.steps must be an array/);
    expect(validateProcessorChain({ steps: {} })).toMatch(/processors.steps must be an array/);
    expect(validateProcessorChain({ steps: ['nope'] })).toMatch(
      /processors\.steps\[0\] must be an object/,
    );
  });

  it('rejects an unknown processor', () => {
    expect(validateProcessorChain({ steps: [{ ...good, processor: 'number_sclae' }] })).toMatch(
      /processors\.steps\[0\]\.processor "number_sclae" is not a known processor/,
    );
    expect(validateProcessorChain({ steps: [{ ...good, processor: 'number_scale@7' }] })).toMatch(
      /is not a known processor/,
    );
    expect(validateProcessorChain({ steps: [{ ...good, processor: undefined }] })).toMatch(
      /is not a known processor/,
    );
  });

  it('rejects a duplicate step id', () => {
    expect(validateProcessorChain({ steps: [good, { ...good, writes: 'other' }] })).toMatch(
      /processors\.steps\[1\]\.id "convert_to_eur" is used twice/,
    );
  });

  it('rejects a step id that is not a name', () => {
    for (const id of ['', 'has a space', '-leading-dash', 'dots.not.allowed', 42, undefined]) {
      expect(validateProcessorChain({ steps: [{ ...good, id }] })).toMatch(
        /\.id must be a name of letters, digits/,
      );
    }
    expect(
      validateProcessorChain({
        steps: [{ ...good, id: 'a'.repeat(PROCESSOR_CHAIN_LIMITS.maxStepIdLength + 1) }],
      }),
    ).toMatch(/\.id is too long/);
  });

  it('rejects an unknown write mode or onMissing', () => {
    expect(validateProcessorChain({ steps: [{ ...good, mode: 'overwrite' }] })).toMatch(
      /\.mode "overwrite" must be one of add, replace, upsert/,
    );
    expect(validateProcessorChain({ steps: [{ ...good, onMissing: 'ignore' }] })).toMatch(
      /\.onMissing "ignore" must be "fail" or "skip"/,
    );
  });

  it('rejects a malformed path', () => {
    expect(validateProcessorChain({ steps: [{ ...good, reads: 'price[' }] })).toMatch(
      /"reads" has an unclosed "\["/,
    );
    expect(validateProcessorChain({ steps: [{ ...good, reads: '' }] })).toMatch(
      /"reads" must be a non-empty path/,
    );
    expect(validateProcessorChain({ steps: [{ ...good, each: 'items[x]' }] })).toMatch(
      /"each" has an invalid array index "x"/,
    );
    expect(
      validateProcessorChain({
        steps: [{ ...good, reads: 'x'.repeat(PROCESSOR_CHAIN_LIMITS.maxPathLength + 1) }],
      }),
    ).toMatch(/"reads" is too long/);
  });

  it('rejects a path deeper than the segment limit', () => {
    const dotted = (n: number) => Array.from({ length: n }, (_, i) => `k${i}`).join('.');
    const bracketed = (n: number) => `k${'[0]'.repeat(n - 1)}`;

    expect(validateProcessorChain({ steps: [{ ...good, reads: dotted(18) }] })).toMatch(
      /"reads" is too deep \(max 16 segments\)/,
    );
    expect(validateProcessorChain({ steps: [{ ...good, each: dotted(18) }] })).toMatch(
      /"each" is too deep/,
    );
    expect(
      validateProcessorChain({
        steps: [{ ...good, reads: bracketed(PROCESSOR_CHAIN_LIMITS.maxPathSegments + 1) }],
      }),
    ).toMatch(/"reads" is too deep/);

    // Paths at or under the limit are accepted.
    expect(
      validateProcessorChain({
        steps: [{ ...good, reads: dotted(PROCESSOR_CHAIN_LIMITS.maxPathSegments) }],
      }),
    ).toBeNull();

    // Both spellings refuse the same depth: the scanner's own check runs inside
    // its loop, so the last dotted key is re-checked after the final flush.
    expect(
      validateProcessorChain({
        steps: [{ ...good, reads: dotted(PROCESSOR_CHAIN_LIMITS.maxPathSegments + 1) }],
      }),
    ).toMatch(/"reads" is too deep/);
  });

  it('rejects a write target that is not a plain field path', () => {
    expect(validateProcessorChain({ steps: [{ ...good, writes: 'items[*]' }] })).toMatch(
      /"writes" must name fields of the element/,
    );
    expect(validateProcessorChain({ steps: [{ ...good, writes: 'items[0]' }] })).toMatch(
      /"writes" must name fields of the element/,
    );
  });

  it('rejects more steps than the limit allows', () => {
    const steps = Array.from({ length: PROCESSOR_CHAIN_LIMITS.maxSteps + 1 }, (_, i) => ({
      ...good,
      id: `step_${i}`,
    }));
    expect(validateProcessorChain({ steps })).toMatch(
      new RegExp(`processors.steps has too many entries \\(max ${PROCESSOR_CHAIN_LIMITS.maxSteps}\\)`),
    );
  });

  it('rejects an unknown config version, enabled flag or onError policy', () => {
    expect(validateProcessorChain({ version: 2, steps: [good] })).toMatch(
      /Unknown processors version 2 — expected 1/,
    );
    expect(validateProcessorChain({ version: '1', steps: [good] })).toMatch(
      /Unknown processors version "1"/,
    );
    expect(validateProcessorChain({ enabled: 'yes', steps: [good] })).toMatch(
      /processors.enabled must be true or false/,
    );
    expect(validateProcessorChain({ onError: 'ignore', steps: [good] })).toMatch(
      /Unknown processors.onError "ignore" — expected "fail" or "passthrough"/,
    );
  });

  it('rejects a step whose parameters do not match the processor contract', () => {
    expect(validateProcessorChain({ steps: [{ ...good, params: {} }] })).toMatch(
      /needs the parameter "factor"/,
    );
    expect(validateProcessorChain({ steps: [{ ...good, params: { factor: 1, nope: 2 } }] })).toMatch(
      /has no parameter "nope"/,
    );
  });

  it('refuses prototype-pollution attempts in reads, writes and each', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expect(validateProcessorChain({ steps: [{ ...good, reads: key }] })).toMatch(
        new RegExp(`"reads" may not use the segment "${key}"`),
      );
      expect(validateProcessorChain({ steps: [{ ...good, writes: key }] })).toMatch(
        new RegExp(`"writes" may not use the segment "${key}"`),
      );
      expect(validateProcessorChain({ steps: [{ ...good, each: `$.items[*].${key}` }] })).toMatch(
        new RegExp(`"each" may not use the segment "${key}"`),
      );
      expect(validateProcessorChain({ steps: [{ ...good, reads: `a['${key}']` }] })).toMatch(
        new RegExp(`"reads" may not use the segment "${key}"`),
      );
    }
  });
});

/* ------------------------------------------------------------------ */
/*  `each` — what a step runs over                                     */
/* ------------------------------------------------------------------ */

describe('runProcessorChain — selecting the elements with `each`', () => {
  it('runs once on the root object when `each` is omitted', () => {
    const result = expectOk(runProcessorChain({ price: 10 }, singleStep({})));
    expect(result.value).toEqual({ price: 10, price_eur: 5 });
    expect(result.steps[0]).toMatchObject({ targets: 1, written: 1, skipped: 0 });
  });

  it('treats `each: "$.items"` as every element, the same as `$.items[*]`', () => {
    const doc = { items: [{ price: 10 }, { price: 20 }] };
    const viaCollection = expectOk(runProcessorChain(doc, singleStep({ each: '$.items' })));
    const viaWildcard = expectOk(runProcessorChain(doc, singleStep({ each: '$.items[*]' })));

    expect(viaCollection.value).toEqual({ items: [{ price: 10, price_eur: 5 }, { price: 20, price_eur: 10 }] });
    expect(viaCollection.value).toEqual(viaWildcard.value);
    expect(viaCollection.steps[0].targets).toBe(2);
    expect(viaWildcard.steps[0].targets).toBe(2);
  });

  it('runs over every element of a bare-array response with `each` omitted', () => {
    const result = expectOk(runProcessorChain([{ price: 10 }, { price: 20 }], singleStep({})));
    expect(result.value).toEqual([
      { price: 10, price_eur: 5 },
      { price: 20, price_eur: 10 },
    ]);
    expect(result.steps[0]).toMatchObject({ targets: 2, written: 2 });
  });

  it('runs over a single indexed element when `each` names one', () => {
    const doc = { items: [{ price: 10 }, { price: 20 }] };
    const result = expectOk(runProcessorChain(doc, singleStep({ each: '$.items[1]' })));
    expect(result.value).toEqual({ items: [{ price: 10 }, { price: 20, price_eur: 10 }] });
    expect(result.steps[0].targets).toBe(1);
  });

  it('reports no targets, and nothing applied, when `each` resolves to nothing', () => {
    const result = expectOk(runProcessorChain({ items: [] }, singleStep({ each: '$.items[*]' })));
    expect(result.value).toEqual({ items: [] });
    expect(result.applied).toBe(false);
    expect(result.steps[0]).toMatchObject({ targets: 0, written: 0, skipped: 0 });
  });
});

/* ------------------------------------------------------------------ */
/*  Write modes                                                        */
/* ------------------------------------------------------------------ */

describe('runProcessorChain — write modes', () => {
  it('upsert writes whether or not the target is there (the default)', () => {
    expect(expectOk(runProcessorChain({ price: 10 }, singleStep({}))).value).toEqual({
      price: 10,
      price_eur: 5,
    });
    expect(
      expectOk(runProcessorChain({ price: 10, price_eur: 999 }, singleStep({ mode: 'upsert' })))
        .value,
    ).toEqual({ price: 10, price_eur: 5 });
  });

  it('add refuses a target that already exists, naming the path', () => {
    const result = expectFailed(
      runProcessorChain({ price: 10, price_eur: 999 }, singleStep({ mode: 'add' })),
    );
    expect(result.error).toBe(
      'step step_one: $.price_eur already exists, and the mode is "add" — use "replace" or "upsert"',
    );
    expect(result.failedPath).toBe('$.price_eur');
  });

  it('replace refuses a target that is missing, naming the path', () => {
    const result = expectFailed(runProcessorChain({ price: 10 }, singleStep({ mode: 'replace' })));
    expect(result.error).toBe(
      'step step_one: $.price_eur does not exist, and the mode is "replace" — use "add" or "upsert"',
    );
    expect(result.failedPath).toBe('$.price_eur');
  });

  it('creates the intermediate object for a nested `writes` on upsert', () => {
    const result = expectOk(runProcessorChain({ price: 10 }, singleStep({ writes: 'pricing.eur' })));
    expect(result.value).toEqual({ price: 10, pricing: { eur: 5 } });
    // A plain object, not something carrying a prototype from the path.
    expect(Object.getPrototypeOf((result.value as { pricing: object }).pricing)).toBe(
      Object.prototype,
    );
  });

  it('refuses to create the intermediate object under `replace`', () => {
    const result = expectFailed(
      runProcessorChain({ price: 10 }, singleStep({ writes: 'pricing.eur', mode: 'replace' })),
    );
    expect(result.error).toBe('step step_one: $.pricing does not exist, and the mode is "replace"');
    expect(result.failedPath).toBe('$.pricing');
  });

  it('writes into an intermediate object that is already there', () => {
    const result = expectOk(
      runProcessorChain({ price: 10, pricing: { usd: 10 } }, singleStep({ writes: 'pricing.eur' })),
    );
    expect(result.value).toEqual({ price: 10, pricing: { usd: 10, eur: 5 } });
  });

  it('refuses to write inside a non-object intermediate', () => {
    const result = expectFailed(
      runProcessorChain({ price: 10, pricing: 'none' }, singleStep({ writes: 'pricing.eur' })),
    );
    expect(result.error).toMatch(/\$\.pricing is not an object, so the step cannot write inside it/);
  });
});

/* ------------------------------------------------------------------ */
/*  Missing values                                                     */
/* ------------------------------------------------------------------ */

describe('runProcessorChain — a missing `reads` field', () => {
  const doc = () => ({ items: [{ price: 10 }, { other: 1 }, { price: 20 }] });

  it('fails the run by default, naming the element that is missing it', () => {
    const result = expectFailed(runProcessorChain(doc(), singleStep({ each: '$.items[*]' })));
    expect(result.error).toBe('step step_one: $.items[1].price is missing');
    expect(result.failedPath).toBe('$.items[1].price');
  });

  it('leaves the element alone and counts it in `skipped` when onMissing is "skip"', () => {
    const result = expectOk(
      runProcessorChain(doc(), singleStep({ each: '$.items[*]', onMissing: 'skip' })),
    );
    expect(result.value).toEqual({
      items: [{ price: 10, price_eur: 5 }, { other: 1 }, { price: 20, price_eur: 10 }],
    });
    expect(result.steps[0]).toMatchObject({ targets: 3, written: 2, skipped: 1 });
  });
});

/* ------------------------------------------------------------------ */
/*  Chaining, immutability and the trace                               */
/* ------------------------------------------------------------------ */

describe('runProcessorChain — steps, state and the trace', () => {
  it('lets a later step read what an earlier step wrote', () => {
    const result = expectOk(
      runProcessorChain(
        { price: 100 },
        {
          steps: [
            {
              id: 'to_eur',
              processor: 'number_scale@1',
              reads: 'price',
              writes: 'price_eur',
              mode: 'add',
              params: { factor: 0.92, round: 2 },
            },
            {
              id: 'to_gross',
              processor: 'number_vat@1',
              reads: 'price_eur',
              writes: 'price_eur_gross',
              mode: 'add',
              params: { rate: 0.19, round: 2 },
            },
          ],
        },
      ),
    );
    expect(result.value).toEqual({ price: 100, price_eur: 92, price_eur_gross: 109.48 });
  });

  it('never mutates the response it was given', () => {
    const raw = catalogue();
    const before = JSON.stringify(raw);
    const result = expectOk(runProcessorChain(raw, P1_CHAIN));

    expect(JSON.stringify(raw)).toBe(before);
    expect(raw.items[0]).not.toHaveProperty('price_eur');
    expect(raw.items[0].description).toBe('  Black   Screw\n60mm ');
    expect(result.value).not.toBe(raw);
    expect((result.value as { items: unknown[] }).items[0]).not.toBe(raw.items[0]);
  });

  it('fills bytesAfter and a sample element when tracing', () => {
    const result = expectOk(runProcessorChain(catalogue(), P1_CHAIN, { trace: true }));
    for (const step of result.steps) {
      expect(typeof step.bytesAfter).toBe('number');
      expect(step.bytesAfter!).toBeGreaterThan(0);
      expect(step.sample).toBeDefined();
    }
    // The document grows as the steps add fields.
    expect(result.steps[1].bytesAfter!).toBeGreaterThan(result.steps[0].bytesAfter!);
    expect(result.steps[0].sample).toMatchObject({ itemNo: 'A-OFF-FAS-001', price_eur: 50.3 });
  });

  it('samples each step as it left the element, not as the chain finished it', () => {
    const result = expectOk(runProcessorChain(catalogue(), P1_CHAIN, { trace: true }));
    // The element stays in the document and the later steps edit it, so a
    // sample that held the element itself would show the finished one three
    // times over and the step-by-step view would say nothing.
    expect(result.steps[0].sample).not.toHaveProperty('price_eur_gross');
    expect(result.steps[1].sample).toMatchObject({ price_eur: 50.3, price_eur_gross: 59.86 });
    expect((result.steps[1].sample as { description: string }).description).toBe(
      '  Black   Screw\n60mm ',
    );
    expect((result.steps[2].sample as { description: string }).description).toBe(
      'Black Screw 60mm',
    );
  });

  it('leaves bytesAfter and sample out when not tracing', () => {
    const result = expectOk(runProcessorChain(catalogue(), P1_CHAIN));
    for (const step of result.steps) {
      expect(step).not.toHaveProperty('bytesAfter');
      expect(step).not.toHaveProperty('sample');
    }
  });

  it('reports a config problem as a failure rather than throwing', () => {
    const unknownProcessor = expectFailed(
      runProcessorChain({ price: 10 }, singleStep({ processor: 'number_sclae' })),
    );
    expect(unknownProcessor.error).toMatch(/step step_one: "number_sclae" is not a known processor/);
    expect(unknownProcessor.failedStep).toBe('');
    expect(unknownProcessor.failedPath).toBe('$');

    const badParams = expectFailed(
      runProcessorChain({ price: 10 }, singleStep({ params: { factor: 'half' } })),
    );
    expect(badParams.error).toMatch(/step step_one: .*parameter "factor" must be a number/);
  });

  it('refuses a prototype-polluting path at run time too', () => {
    const result = expectFailed(
      runProcessorChain({ price: 10 }, singleStep({ writes: '__proto__.polluted' })),
    );
    expect(result.error).toMatch(/"writes" may not use the segment "__proto__"/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('reports `applied: false` when a chain had nothing to write', () => {
    const result = expectOk(
      runProcessorChain({ items: [] }, singleStep({ each: '$.items[*]', onMissing: 'skip' })),
    );
    expect(result.applied).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Wiring into applyResponseTransform                                 */
/* ------------------------------------------------------------------ */

describe('applyResponseTransform — the chain and the mapping together', () => {
  it('runs the chain before the mapping, so a select can pick a field it wrote', () => {
    const out = applyResponseTransform(catalogue(), {
      processors: P1_CHAIN,
      transform: {
        select: {
          rows: {
            $from: '$.items[*]',
            $select: { itemNo: 'itemNo', gross: 'price_eur_gross', description: 'description' },
          },
        },
      },
    });

    expect(out.applied).toBe(true);
    expect(out.error).toBeUndefined();
    expect(out.value).toEqual({
      rows: P1_EXPECTED.map((row, index) => ({
        itemNo: row.itemNo,
        gross: row.price_eur_gross,
        description: P1_CLEANED_DESCRIPTIONS[index],
      })),
    });
    expect(out.processorSteps).toHaveLength(3);
  });

  it('applies a chain on its own, with no transform configured', () => {
    const out = applyResponseTransform(catalogue(), { processors: P1_CHAIN });
    expect(out.applied).toBe(true);
    expect((out.value as { items: Record<string, unknown>[] }).items[0].price_eur).toBe(50.3);
    expect(out.processorSteps).toHaveLength(3);
  });

  it('surfaces a failed chain as fatal, at the processors stage, with the raw value', () => {
    const raw = catalogueWithBadPrice();
    const out = applyResponseTransform(raw, {
      processors: P1_CHAIN,
      transform: { select: { rows: '$.items[*].price_eur' } },
    });

    expect(out.applied).toBe(false);
    expect(out.fatal).toBe(true);
    expect(out.stage).toBe('processors');
    expect(out.error).toBe(
      `step convert_to_eur: $.items[${BAD_ROW_INDEX}].price_usd is not a number`,
    );
    expect(out.value).toBe(raw); // the untouched response, not a mapped one
  });

  it('onError "passthrough" carries the error but returns the untouched response', () => {
    const raw = catalogueWithBadPrice();
    const out = applyResponseTransform(raw, {
      processors: { ...P1_CHAIN, onError: 'passthrough' },
    });

    expect(out.fatal).toBeUndefined();
    expect(out.applied).toBe(false);
    expect(out.stage).toBe('processors');
    expect(out.error).toBe(
      `step convert_to_eur: $.items[${BAD_ROW_INDEX}].price_usd is not a number`,
    );
    expect(out.value).toBe(raw);
  });

  it('gives back the identical raw reference for a tool with no processors key', () => {
    const raw = catalogue();
    for (const mapping of [undefined, null, {}, { cacheTtl: 300 }, { processors: { steps: [] } }]) {
      const out = applyResponseTransform(raw, mapping);
      expect(out.value).toBe(raw); // identity, not just deep equality
      expect(out.applied).toBe(false);
      expect(out.processorSteps).toBeUndefined();
      expect(out.error).toBeUndefined();
    }
  });

  it('is a no-op for a chain that is present but turned off', () => {
    const raw = catalogue();
    const out = applyResponseTransform(raw, { processors: { ...P1_CHAIN, enabled: false } });
    expect(out.value).toBe(raw);
    expect(out.applied).toBe(false);
  });
});
