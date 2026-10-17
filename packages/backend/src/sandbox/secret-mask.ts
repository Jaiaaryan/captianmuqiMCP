/**
 * Masking of connector secrets in everything a Level 3 script run hands back
 * (result, logs, error, run meta), so a secret that was injected into the run
 * with `env`, or that belongs to a connector the script declares, comes back as
 * `***` instead of its value.
 *
 * This is a guard against accidental disclosure (`return env.API_KEY`,
 * `console.log(headers)`, an API that echoes the key in an error), not against
 * a script written to smuggle a secret out: one that reverses or splits the
 * value is not caught. That is why only the script's author or an
 * administrator can give a script access to secrets in the first place.
 */

export const SECRET_MASK = '***';

/** Shorter values are not masked: masking "abc" would shred ordinary text. */
export const MIN_MASKED_SECRET_LENGTH = 6;

/** Deeper structures are cut off rather than walked forever. */
const MAX_DEPTH = 64;

/**
 * Every spelling of the secrets that is worth searching for: as is,
 * URL-encoded (a key in a query string), JSON-escaped (a key inside a
 * serialised string) and base64 / base64url (HTTP Basic, tokens). Longest
 * first, so a longer form is replaced before a shorter one inside it.
 */
export function secretVariants(secrets: readonly string[]): string[] {
  const out = new Set<string>();
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < MIN_MASKED_SECRET_LENGTH) continue;
    out.add(secret);
    out.add(encodeURIComponent(secret));
    out.add(JSON.stringify(secret).slice(1, -1));
    const b64 = Buffer.from(secret, 'utf8').toString('base64');
    out.add(b64);
    out.add(b64.replace(/=+$/, ''));
    out.add(Buffer.from(secret, 'utf8').toString('base64url'));
  }
  return [...out]
    .filter((v) => v.length >= MIN_MASKED_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
}

function maskString(text: string, variants: readonly string[]): string {
  let out = text;
  for (const v of variants) {
    if (out.includes(v)) out = out.split(v).join(SECRET_MASK);
  }
  return out;
}

function walk(value: unknown, variants: readonly string[], depth: number): unknown {
  if (typeof value === 'string') return maskString(value, variants);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return SECRET_MASK;
  if (Array.isArray(value)) return value.map((item) => walk(item, variants, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[maskString(key, variants)] = walk(item, variants, depth + 1);
  }
  return out;
}

/**
 * A copy of `value` in which every occurrence of every secret (in any of the
 * spellings of {@link secretVariants}) in a string or an object key is
 * replaced by `***`. The input is not changed. Values shorter than six
 * characters are ignored.
 */
export function maskSecrets<T>(value: T, secrets: readonly string[]): T {
  const variants = secretVariants(secrets);
  if (variants.length === 0) return value;
  return walk(value, variants, 0) as T;
}
