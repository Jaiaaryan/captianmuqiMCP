import { SAMPLE_LIMITS, truncateSample } from './response-processing.service';

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');

describe('truncateSample', () => {
  it('leaves a small response alone', () => {
    const value = { items: [{ a: 1, b: 'x', c: null, d: true }], total: 1 };
    expect(truncateSample(value)).toEqual({ sample: value, truncated: false });
  });

  it('cuts arrays to their first three elements', () => {
    const out = truncateSample({ items: [1, 2, 3, 4] });
    expect(out).toEqual({ sample: { items: [1, 2, 3] }, truncated: true });
  });

  it('keeps depth to eight, emptying deeper containers', () => {
    let deep: unknown = { leaf: 1 };
    for (let i = 0; i < 12; i++) deep = { n: deep };
    const out = truncateSample(deep);
    expect(out.truncated).toBe(true);
    let v = out.sample as Record<string, unknown>;
    let depth = 0;
    while (v && typeof v === 'object' && 'n' in v) {
      v = v.n as Record<string, unknown>;
      depth++;
    }
    expect(depth).toBe(SAMPLE_LIMITS.maxDepth);
    expect(v).toEqual({});
  });

  it('fits 64 KB however large the response', () => {
    const wide = Object.fromEntries(
      Array.from({ length: 5000 }, (_, i) => [`key_${i}`, 'x'.repeat(500)]),
    );
    const out = truncateSample({ items: [wide, wide, wide, wide] });
    expect(out.truncated).toBe(true);
    expect(bytes(out.sample)).toBeLessThanOrEqual(SAMPLE_LIMITS.maxBytes);
  });

  it('drops values JSON cannot carry', () => {
    const out = truncateSample({ a: undefined, f: () => 1, n: 2 });
    expect(out.sample).toEqual({ a: null, f: null, n: 2 });
  });
});
