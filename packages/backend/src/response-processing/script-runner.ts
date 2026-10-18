/**
 * Level 1 script runner for `script@1` steps.
 *
 * A step's code is a function body: it gets `value` (the field, or with `reads:
 * "$"` the whole element), `params`, `response` (the whole document) and a
 * frozen `builtins` object (currency, scale, offset, vat, round, clean_text,
 * truncate, map: the step processors as plain functions) and returns the new value. It runs SYNCHRONOUSLY inside an isolated-vm isolate
 * that has no capabilities at all: no console, timers, require, process, fetch,
 * tools, env, Buffer or WebAssembly. The only thing that can leave is the
 * JSON-serialisable value it returns.
 *
 * Bounds: 250 ms of run time, 32 MB of heap, 16 KB of code, 1 MB of result. A
 * run that times out, throws or exhausts memory throws the isolate away.
 *
 * It is synchronous because the response mapping runs inside a synchronous
 * pipeline (applyResponseTransform), unlike the code-mode SandboxService, which
 * is async and can call tools. That is also why there is no `await` here.
 */
import ivm from 'isolated-vm';

export const SCRIPT_LIMITS = {
  timeoutMs: 250,
  memoryMb: 32,
  maxCodeBytes: 16 * 1024,
  maxResultBytes: 1024 * 1024,
} as const;

const SCRIPT_FILE = 'response-script.js';
const PRELUDE_FILE = 'response-builtins.js';

/**
 * `builtins` inside the isolate: the same pure processors as builtins.ts,
 * as source code evaluated in each fresh context. Source, never a host
 * reference, so the isolate stays without capabilities: nothing here can
 * reach outside it. Frozen, so a script cannot swap one for the next call
 * (every call gets a new context anyway). Same rounding (half away from
 * zero, on the decimal text) and the same refusals as the step processors.
 */
export const BUILTINS_PRELUDE = `(function () {
  'use strict';
  function fail(name, what) { throw new TypeError('builtins.' + name + ': ' + what); }
  function num(name, v, label) {
    if (typeof v !== 'number' || !isFinite(v)) fail(name, (label || 'value') + ' is not a number');
    return v;
  }
  function str(name, v) { if (typeof v !== 'string') fail(name, 'value is not a string'); return v; }
  function opts(p) { return p && typeof p === 'object' ? p : {}; }
  function roundTo(value, decimals) {
    if (!isFinite(value)) return value;
    var abs = Math.abs(value), sign = value < 0 ? -1 : 1, text = String(abs), r;
    if (text.indexOf('e') >= 0) { var f = Math.pow(10, decimals); r = Math.round(abs * f) / f; }
    else r = Number(Math.round(Number(text + 'e' + decimals)) + 'e-' + decimals);
    var out = sign * r;
    return out === 0 ? 0 : out;
  }
  function places(name, p) {
    if (p.round === undefined) return undefined;
    var d = num(name, p.round, 'round');
    if (d < 0 || d > 10 || Math.floor(d) !== d) fail(name, 'round must be an integer between 0 and 10');
    return d;
  }
  function finish(name, result, p) {
    if (!isFinite(result)) fail(name, 'produced a number that is not finite');
    var d = places(name, p);
    return d === undefined ? result : roundTo(result, d);
  }
  // A number, or an array / plain object of numbers mapped one level deep (same shape back).
  function nums(name, value, one) {
    if (Array.isArray(value)) {
      return value.map(function (v, i) { return one(num(name, v, 'value[' + i + ']')); });
    }
    if (value && typeof value === 'object') {
      var out = {};
      Object.keys(value).forEach(function (k) {
        Object.defineProperty(out, k, { value: one(num(name, value[k], 'value[' + JSON.stringify(k) + ']')), enumerable: true, writable: true, configurable: true });
      });
      return out;
    }
    return one(num(name, value));
  }
  var b = {
    currency: function (value, p) {
      p = typeof p === 'number' ? { rate: p } : opts(p);
      var rate = num('currency', p.rate, 'rate');
      if (rate <= 0) fail('currency', 'rate must be a number greater than 0');
      return nums('currency', value, function (v) {
        var result = v * rate;
        if (!isFinite(result)) fail('currency', 'produced a number that is not finite');
        return roundTo(result, 2);
      });
    },
    scale: function (value, p) { p = opts(p); var f = num('scale', p.factor, 'factor'); return nums('scale', value, function (v) { return finish('scale', v * f, p); }); },
    offset: function (value, p) { p = opts(p); var a = num('offset', p.amount, 'amount'); return nums('offset', value, function (v) { return finish('offset', v + a, p); }); },
    vat: function (value, p) { p = opts(p); var r = num('vat', p.rate, 'rate'); return nums('vat', value, function (v) { return finish('vat', v * (1 + r), p); }); },
    round: function (value, p) {
      p = typeof p === 'number' ? { decimals: p } : opts(p);
      var d = p.decimals === undefined ? 2 : num('round', p.decimals, 'decimals');
      return nums('round', value, function (v) { return roundTo(v, d); });
    },
    clean_text: function (value, p) {
      p = opts(p);
      var text = str('clean_text', value);
      if (p.collapseWhitespace !== false) text = text.replace(/\\s+/g, ' ');
      if (p.trim !== false) text = text.trim();
      return text;
    },
    truncate: function (value, p) {
      p = typeof p === 'number' ? { maxLength: p } : opts(p);
      var text = str('truncate', value), max = num('truncate', p.maxLength, 'maxLength');
      var ellipsis = typeof p.ellipsis === 'string' ? p.ellipsis : '\u2026';
      if (text.length <= max) return text;
      if (ellipsis.length >= max) return ellipsis.slice(0, max);
      return text.slice(0, max - ellipsis.length) + ellipsis;
    },
    map: function (value, p) {
      p = opts(p);
      var table = p.map && typeof p.map === 'object' ? p.map : fail('map', 'map is not an object');
      var key = typeof value === 'string' ? value : JSON.stringify(value);
      if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
      if (typeof p.fallback === 'string') return p.fallback;
      fail('map', 'no entry for ' + JSON.stringify(String(key).slice(0, 40)));
    },
  };
  Object.defineProperty(globalThis, 'builtins', { value: Object.freeze(b), writable: false, configurable: false, enumerable: false });
})();`;
/** Lines the wrapper puts before the user's first line. */
const WRAPPER_LINE_OFFSET = 1;

function wrap(code: string): string {
  return `(function(){\n${code}\n})()`;
}

function codeTooLarge(code: string): boolean {
  return Buffer.byteLength(code, 'utf8') > SCRIPT_LIMITS.maxCodeBytes;
}

function messageOf(err: unknown): string {
  if (err && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}

function disposeQuietly(isolate: ivm.Isolate | null): void {
  try {
    if (isolate && !isolate.isDisposed) isolate.dispose();
  } catch {
    /* already gone */
  }
}

/**
 * Compile only, never run. Returns `"<message> (line N)"` for a syntax error,
 * null when the code compiles.
 */
export function checkScriptSyntax(code: string): string | null {
  if (typeof code !== 'string') return 'code must be a string';
  if (codeTooLarge(code)) return 'script code too large';
  const lineCount = code.split('\n').length;
  const isolate = new ivm.Isolate({ memoryLimit: 8 });
  try {
    isolate.compileScriptSync(wrap(code), { filename: SCRIPT_FILE });
    return null;
  } catch (err) {
    const text = messageOf(err);
    const m = new RegExp(`\\s*\\[${SCRIPT_FILE.replace('.', '\\.')}:(\\d+):\\d+\\]\\s*$`).exec(text);
    const message = (m ? text.slice(0, m.index) : text).trim() || 'Invalid syntax';
    // An unclosed block is reported on the wrapper's closing line: clamp to
    // the last line of the user's code.
    const line = m
      ? Math.min(Math.max(Number(m[1]) - WRAPPER_LINE_OFFSET, 1), lineCount)
      : 1;
    return `${message} (line ${line})`;
  } finally {
    disposeQuietly(isolate);
  }
}

/**
 * Is `v` JSON data that survives a round trip unchanged? Rejects undefined,
 * functions, symbols, bigint, NaN/Infinity, class instances (Date, Map, ...)
 * and the `__proto__` key.
 */
function isJsonValue(v: unknown, depth = 0): boolean {
  if (depth > 200) return false;
  if (v === null) return true;
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(v);
    case 'object': {
      if (Array.isArray(v)) {
        for (const item of v) if (!isJsonValue(item, depth + 1)) return false;
        return true;
      }
      // A plain object: null prototype, or one whose own prototype is the end
      // of the chain. Compared structurally, not against this realm's
      // Object.prototype, because the copy may come from another realm.
      const proto = Object.getPrototypeOf(v);
      if (proto !== null && Object.getPrototypeOf(proto) !== null) return false;
      if (Object.prototype.toString.call(v) !== '[object Object]') return false;
      for (const key of Object.keys(v as object)) {
        if (key === '__proto__') return false;
        if (!isJsonValue((v as Record<string, unknown>)[key], depth + 1)) return false;
      }
      return true;
    }
    default:
      return false;
  }
}

/**
 * Runs one script over many values with a single isolate, so a step over 1000
 * elements pays for one isolate, not 1000. Every value still gets a fresh
 * context: nothing a script leaves on the global object reaches the next call.
 * Dispose it when the step is done.
 */
export class ScriptSession {
  private isolate: ivm.Isolate | null;
  private script: ivm.Script;
  private prelude: ivm.Script;
  private paramsExternal: ivm.ExternalCopy<unknown>;

  constructor(code: string, params: unknown) {
    if (typeof code !== 'string' || codeTooLarge(code)) {
      throw new Error('script code too large');
    }
    this.isolate = new ivm.Isolate({ memoryLimit: SCRIPT_LIMITS.memoryMb });
    try {
      this.prelude = this.isolate.compileScriptSync(BUILTINS_PRELUDE, { filename: PRELUDE_FILE });
      this.script = this.isolate.compileScriptSync(wrap(code), { filename: SCRIPT_FILE });
      this.paramsExternal = new ivm.ExternalCopy(params ?? null);
    } catch (err) {
      this.dispose();
      throw new Error(`script threw: ${messageOf(err)}`);
    }
  }

  /**
   * Run on one value. `response` is the whole document the chain is working
   * on (the root), so a per-element script can still look around it; it
   * defaults to `value` when no root is given. Throws Error with the messages
   * the chain reports.
   */
  run(value: unknown, response: unknown = value): unknown {
    const isolate = this.isolate;
    if (!isolate || isolate.isDisposed) throw new Error('script threw: isolate is gone');
    let raw: unknown;
    try {
      const context = isolate.createContextSync();
      const jail = context.global;
      // Only the data goes in. There is no host reference in the context, so
      // there is nothing to escape through.
      jail.setSync(
        'value',
        new ivm.ExternalCopy(value === undefined ? null : value).copyInto(),
      );
      jail.setSync('params', this.paramsExternal.copyInto());
      // Copied on its own: a Reference to `value` would not be plain data.
      jail.setSync(
        'response',
        new ivm.ExternalCopy(response === undefined ? null : response).copyInto(),
      );
      // A bare V8 context still has console and WebAssembly; the script gets neither.
      context.evalSync('delete globalThis.WebAssembly; delete globalThis.console;');
      // Pure helpers, defined from source inside the context (see BUILTINS_PRELUDE).
      this.prelude.runSync(context, { timeout: SCRIPT_LIMITS.timeoutMs });
      raw = this.script.runSync(context, {
        timeout: SCRIPT_LIMITS.timeoutMs,
        copy: true,
      });
      context.release();
    } catch (err) {
      // Anything that went wrong may have left the isolate half-dead (heap
      // limit, timeout): never reuse it.
      this.dispose();
      throw classify(err);
    }

    if (!isJsonValue(raw)) throw new Error('script returned a non-JSON value');
    const size = Buffer.byteLength(JSON.stringify(raw), 'utf8');
    if (size > SCRIPT_LIMITS.maxResultBytes) {
      throw new Error(
        `script result too large (${size} bytes, limit ${SCRIPT_LIMITS.maxResultBytes})`,
      );
    }
    return raw;
  }

  dispose(): void {
    try {
      this.paramsExternal?.release();
    } catch {
      /* already released */
    }
    disposeQuietly(this.isolate);
    this.isolate = null;
  }
}

function classify(err: unknown): Error {
  const text = messageOf(err);
  if (/Script execution timed out/i.test(text)) {
    return new Error(`script timed out (${SCRIPT_LIMITS.timeoutMs} ms)`);
  }
  if (/due to memory limit|Array buffer allocation failed|Invalid string length/i.test(text)) {
    return new Error(`script threw: out of memory (limit ${SCRIPT_LIMITS.memoryMb} MB)`);
  }
  // Returning a function, symbol or host-unclonable object.
  if (/could not be cloned|An object could not be cloned|Cannot clone/i.test(text)) {
    return new Error('script returned a non-JSON value');
  }
  // Drop the "[response-script.js:L:C]" tail V8 adds; the chain names the field.
  const cleaned = text.replace(/\s*\[response-script\.js:\d+:\d+\]\s*$/, '').trim();
  return new Error(`script threw: ${cleaned || 'unknown error'}`);
}

/**
 * Run `code` once over `value`. Throws Error with one of: `script timed out
 * (250 ms)`, `script threw: <msg>`, `script returned a non-JSON value`, `script
 * result too large (<n> bytes, limit 1048576)`, `script code too large`.
 */
export function runScript(code: string, value: unknown, params?: unknown, response?: unknown): unknown {
  const session = new ScriptSession(code, params);
  try {
    return session.run(value, response === undefined ? value : response);
  } finally {
    session.dispose();
  }
}
