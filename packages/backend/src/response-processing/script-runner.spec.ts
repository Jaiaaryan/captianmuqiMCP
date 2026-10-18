import {
  SCRIPT_LIMITS,
  ScriptSession,
  checkScriptSyntax,
  runScript,
} from './script-runner';

describe('runScript', () => {
  it('returns the value of a function body', () => {
    expect(runScript('return value * 2', 21)).toBe(42);
  });

  it('shows the params to the code', () => {
    expect(runScript('return value + params.bonus', 1, { bonus: 9 })).toBe(10);
    expect(runScript('return params', 1)).toBeNull();
  });

  it('exposes `response` as the whole document, defaulting to `value`', () => {
    expect(runScript('return response.a + value.a', { a: 2 })).toBe(4);
    expect(runScript('return response.items.length + value.n', { n: 1 }, undefined, { items: [1, 2, 3] })).toBe(4);
  });

  it('passes objects in and out without sharing them with the host', () => {
    const input = { items: [{ n: 1 }] };
    const out = runScript('value.items[0].n = 5; return value', input) as typeof input;
    expect(out.items[0].n).toBe(5);
    expect(input.items[0].n).toBe(1);
  });

  it.each([
    'require',
    'process',
    'fetch',
    'setTimeout',
    'setInterval',
    'tools',
    'env',
    'Buffer',
    'WebAssembly',
    'console',
    'global',
  ])('has no %s', (name) => {
    expect(runScript(`return typeof ${name}`, null)).toBe('undefined');
  });

  it('cannot reach the host through the constructor chain', () => {
    const out = runScript(
      `try { return typeof (0, value.constructor.constructor)('return process')().version } catch (e) { return 'blocked' }`,
      {},
    );
    expect(out === 'undefined' || out === 'blocked').toBe(true);
  });

  it('times out an endless loop within the limit', () => {
    const started = Date.now();
    expect(() => runScript('while(true){}', 1)).toThrow(
      `script timed out (${SCRIPT_LIMITS.timeoutMs} ms)`,
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('fails an allocation bomb and keeps working afterwards', () => {
    expect(() =>
      runScript('const a=[]; while(true){ a.push(new Array(1e6).fill("x".repeat(100))); }', 1),
    ).toThrow(/script (timed out|threw)/);
    expect(runScript('return value + 1', 1)).toBe(2);
  });

  it('wraps what the code throws', () => {
    expect(() => runScript('throw new Error("boom")', 1)).toThrow('script threw: boom');
    expect(() => runScript('return value.a.b', {})).toThrow(/^script threw: /);
  });

  it('refuses a result that is not JSON', () => {
    expect(() => runScript('return () => 1', 1)).toThrow('script returned a non-JSON value');
    expect(() => runScript('return undefined', 1)).toThrow('script returned a non-JSON value');
    expect(() => runScript('return NaN', 1)).toThrow('script returned a non-JSON value');
    expect(() => runScript('return new Date()', 1)).toThrow('script returned a non-JSON value');
  });

  it('refuses a result over 1 MB', () => {
    expect(() => runScript('return "x".repeat(2 * 1024 * 1024)', 1)).toThrow(
      /^script result too large \(\d+ bytes, limit 1048576\)$/,
    );
  });

  it('refuses code over 16 KB', () => {
    const big = `return 1; //${'x'.repeat(SCRIPT_LIMITS.maxCodeBytes)}`;
    expect(() => runScript(big, 1)).toThrow('script code too large');
    expect(checkScriptSyntax(big)).toContain('too large');
  });

  it('does not leak globals between values of one session', () => {
    const session = new ScriptSession('globalThis.seen = (globalThis.seen || 0) + 1; return seen', {});
    try {
      expect(session.run(1)).toBe(1);
      expect(session.run(2)).toBe(1);
    } finally {
      session.dispose();
    }
  });

  it('is unusable after a failure', () => {
    const session = new ScriptSession('while(true){}', {});
    expect(() => session.run(1)).toThrow('script timed out');
    expect(() => session.run(1)).toThrow(/^script threw: /);
  });
});

describe('checkScriptSyntax', () => {
  it('accepts valid code, including a top-level return', () => {
    expect(checkScriptSyntax('return value')).toBeNull();
  });

  it('reports the line in the user code', () => {
    const problem = checkScriptSyntax('const a = 1;\nconst b = ;\nreturn a');
    expect(problem).toMatch(/\(line 2\)$/);
  });

  it('clamps an unclosed block to the last line', () => {
    expect(checkScriptSyntax('if (value) {\nreturn 1;')).toMatch(/\(line 2\)$/);
  });
});

describe('builtins inside the script', () => {
  it('match the step processors', () => {
    expect(runScript('return builtins.currency(value, { rate: 0.92 })', 54.67)).toBe(50.3);
    expect(runScript('return builtins.currency(value, 0.1)', 3)).toBe(0.3);
    expect(runScript('return builtins.scale(value, { factor: 0.92, round: 2 })', 54.67)).toBe(50.3);
    expect(runScript('return builtins.vat(value, { rate: 0.19, round: 2 })', 50.3)).toBe(59.86);
    expect(runScript('return builtins.offset(value, { amount: -1 })', 3)).toBe(2);
    expect(runScript('return builtins.round(value, 2)', 1.005)).toBe(1.01);
    expect(runScript('return builtins.round(value)', -0.001)).toBe(0);
    expect(runScript('return builtins.clean_text(value)', '  Black   Screw ')).toBe('Black Screw');
    expect(runScript('return builtins.truncate(value, { maxLength: 4 })', 'abcdefgh')).toBe('abc…');
    expect(runScript("return builtins.map(value, { map: { a: 'A' } })", 'a')).toBe('A');
  });

  it('refuse a wrong input with a sentence', () => {
    expect(() => runScript("return builtins.currency('x', { rate: 2 })", 1)).toThrow(
      'script threw: builtins.currency: value is not a number',
    );
    expect(() => runScript('return builtins.currency(value, { rate: 0 })', 1)).toThrow(
      'script threw: builtins.currency: rate must be a number greater than 0',
    );
    expect(() => runScript("return builtins.scale('x', { factor: 2 })", 1)).toThrow(
      'script threw: builtins.scale: value is not a number',
    );
  });

  it('map the numeric ones over an array or object of numbers, like the steps', () => {
    expect(runScript('return builtins.currency(value, 1.1)', { 'A-1': 10, B: 2.5 })).toEqual({ 'A-1': 11, B: 2.75 });
    expect(runScript('return builtins.scale(value, { factor: 2 })', [1, 2])).toEqual([2, 4]);
    expect(runScript('return builtins.round(value, 0)', { a: 2.5 })).toEqual({ a: 3 });
    expect(() => runScript('return builtins.vat(value, { rate: 0.19 })', { 'A-1': 'n/a' })).toThrow(
      'script threw: builtins.vat: value["A-1"] is not a number',
    );
    expect(() => runScript('return builtins.offset(value, { amount: 1 })', [1, [2]])).toThrow(
      'script threw: builtins.offset: value[1] is not a number',
    );
  });

  it('are frozen and give the script no capabilities', () => {
    expect(runScript("'use strict'; try { builtins.scale = 1; } catch (e) { return 'frozen'; } return 'open';", 1)).toBe('frozen');
    expect(runScript('return Object.isFrozen(builtins) + typeof require + typeof process + typeof fetch', 1)).toBe(
      'trueundefinedundefinedundefined',
    );
  });

  it('are fresh in every call', () => {
    const session = new ScriptSession('globalThis.n = (globalThis.n || 0) + 1; return n + typeof builtins.round', null);
    try {
      expect(session.run(1)).toBe('1function');
      expect(session.run(1)).toBe('1function');
    } finally {
      session.dispose();
    }
  });
});
