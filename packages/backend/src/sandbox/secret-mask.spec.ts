import { maskSecrets, secretVariants, SECRET_MASK } from './secret-mask';

const KEY = 'cbk_supplier_a_0123456789abcdef';

describe('maskSecrets', () => {
  it('replaces a secret anywhere in a string, in nested values and in object keys', () => {
    const input = {
      a: `key=${KEY}`,
      list: ['x', { deep: `${KEY}/${KEY}` }],
      [KEY]: 1,
      n: 42,
      ok: true,
      none: null,
    };
    expect(maskSecrets(input, [KEY])).toEqual({
      a: `key=${SECRET_MASK}`,
      list: ['x', { deep: `${SECRET_MASK}/${SECRET_MASK}` }],
      [SECRET_MASK]: 1,
      n: 42,
      ok: true,
      none: null,
    });
  });

  it('masks the URL-encoded, JSON-escaped and base64 forms', () => {
    const secret = 'p@ss w/"rd"+42';
    const b64 = Buffer.from(secret).toString('base64');
    const text = [
      encodeURIComponent(secret),
      JSON.stringify({ s: secret }),
      `Basic ${b64}`,
      Buffer.from(secret).toString('base64url'),
    ].join(' | ');
    const out = maskSecrets(text, [secret]);
    expect(out).not.toContain(encodeURIComponent(secret));
    expect(out).not.toContain(b64);
    expect(out).not.toContain('w/\\"rd');
    expect(out.split(SECRET_MASK).length - 1).toBeGreaterThanOrEqual(4);
  });

  it('ignores secrets shorter than six characters', () => {
    expect(maskSecrets('abc and 12345', ['abc', '12345'])).toBe('abc and 12345');
    expect(secretVariants(['abc', ''])).toEqual([]);
  });

  it('does not change its input', () => {
    const input = { a: KEY };
    const out = maskSecrets(input, [KEY]);
    expect(input.a).toBe(KEY);
    expect(out).not.toBe(input);
  });

  it('returns the value as it is when there is nothing to mask', () => {
    const input = { a: 1 };
    expect(maskSecrets(input, [])).toBe(input);
  });
});
