import { Injectable, Logger } from '@nestjs/common';
import ivm from 'isolated-vm';
import { SANDBOX_LIMITS, type SandboxLimits } from './limits';
import { countLines, HINTS, parseSyntaxError, toSandboxError } from './sandbox-errors';
import {
  RUNTIME_FILE,
  RUNTIME_SOURCE,
  SCRIPT_FILE,
  wrapUserCode,
} from './sandbox-runtime';
import type {
  SandboxError,
  SandboxRunMeta,
  SandboxRunRequest,
  SandboxRunResult,
  SandboxSyntaxCheck,
  SandboxTool,
  SandboxToolResult,
} from './types';

const MAX_AVAILABLE_NAMES = 20;
const MAX_TOOL_ERROR_CHARS = 2_000;

/**
 * Runs agent-written JavaScript in an isolated V8 isolate next to the connectors.
 *
 * The isolate has no filesystem, network, process, timers or credentials: those
 * APIs do not exist in it, so there is nothing to bypass. The only way out is the
 * `tools.<name>(args)` bridge, which resolves names against `allowedTools` (already
 * role-filtered) and calls `executeTool` with the caller's own invocation context.
 * The script can never choose or change the tenant.
 *
 * Resource caps: V8 heap (`memoryMb`), wall clock for the whole run (`timeoutMs`),
 * connector call count and bytes, result size. The wall clock is enforced by the
 * host disposing the isolate: isolated-vm's own `timeout` only covers synchronous
 * execution and would not stop a loop that starts after an `await`.
 */
@Injectable()
export class SandboxService {
  private readonly logger = new Logger(SandboxService.name);
  /** Runs in flight per organization (the BUSY guard). */
  private readonly active = new Map<string, number>();

  async run(req: SandboxRunRequest): Promise<SandboxRunResult> {
    const started = Date.now();
    const limits = mergeLimits(req.limits);
    const meta: SandboxRunMeta = {
      ms: 0,
      connectorCalls: 0,
      bytesFromConnectors: 0,
      bytesReturned: 0,
      logs: [],
      toolsCalled: [],
    };
    const failWith = (error: SandboxError): SandboxRunResult => {
      meta.ms = Date.now() - started;
      return {
        ok: false,
        error: { ...error, hint: error.hint ?? HINTS[error.code] },
        meta: snapshot(meta),
      };
    };

    const codeBytes = Buffer.byteLength(req.code);
    if (codeBytes > limits.maxCodeBytes) {
      return failWith({
        code: 'CODE_TOO_LARGE',
        message: `Code is ${codeBytes} bytes; limit is ${limits.maxCodeBytes}.`,
      });
    }

    // Claim a slot before the first await so concurrent callers see it.
    const orgKey = req.invocationContext.organizationId ?? '__anonymous__';
    const running = this.active.get(orgKey) ?? 0;
    if (running >= limits.maxConcurrent) {
      return failWith({
        code: 'BUSY',
        message: `${running} scripts are already running for this organization (limit ${limits.maxConcurrent}).`,
      });
    }
    this.active.set(orgKey, running + 1);
    try {
      const result = await this.execute(req, limits, meta, started, failWith);
      this.logger.debug(
        `sandbox run ok=${result.ok} code=${result.error?.code ?? '-'} ms=${result.meta.ms} ` +
          `calls=${result.meta.connectorCalls} in=${result.meta.bytesFromConnectors}B out=${result.meta.bytesReturned}B`,
      );
      return result;
    } finally {
      const left = (this.active.get(orgKey) ?? 1) - 1;
      if (left <= 0) this.active.delete(orgKey);
      else this.active.set(orgKey, left);
    }
  }

  /** Compile (never run) a script to report syntax errors with line and column. */
  async checkSyntax(code: string): Promise<SandboxSyntaxCheck> {
    if (Buffer.byteLength(code) > SANDBOX_LIMITS.maxCodeBytes) {
      return {
        ok: false,
        line: 1,
        column: 1,
        message: `Code exceeds ${SANDBOX_LIMITS.maxCodeBytes} bytes`,
      };
    }
    const isolate = new ivm.Isolate({ memoryLimit: 16 });
    try {
      await isolate.compileScript(wrapUserCode(code), { filename: SCRIPT_FILE });
      return { ok: true };
    } catch (err) {
      return { ok: false, ...parseSyntaxError(err, countLines(code)) };
    } finally {
      disposeQuietly(isolate);
    }
  }

  private async execute(
    req: SandboxRunRequest,
    limits: SandboxLimits,
    meta: SandboxRunMeta,
    started: number,
    failWith: (error: SandboxError) => SandboxRunResult,
  ): Promise<SandboxRunResult> {
    const lineCount = countLines(req.code);
    const allowed = new Map<string, SandboxTool>(req.allowedTools.map((t) => [t.name, t]));
    const names = [...allowed.keys()];

    let argsJson: string;
    try {
      argsJson = JSON.stringify(req.args ?? {});
    } catch {
      return failWith({ code: 'RUNTIME_ERROR', message: 'args must be JSON-serialisable.' });
    }

    const isolate = new ivm.Isolate({ memoryLimit: limits.memoryMb });
    let timedOut = false;
    let done = false;
    // Host-side wall clock. Disposing a busy isolate stops it (about 200 ms).
    const timer = setTimeout(() => {
      timedOut = true;
      disposeQuietly(isolate);
    }, limits.timeoutMs);

    const classify = (err: unknown): SandboxRunResult =>
      failWith(
        toSandboxError(err, {
          timedOut,
          lineCount,
          timeoutMs: limits.timeoutMs,
          memoryMb: limits.memoryMb,
        }),
      );

    // ---- host side of the bridge -------------------------------------------
    // These never reject: they resolve a JSON envelope the in-isolate wrapper
    // turns into a throw. A rejecting callback whose isolate is already gone
    // would surface as an unhandled rejection on the host.
    const refuse = (code: SandboxError['code'], message: string): string =>
      JSON.stringify({ ok: false, code, message });

    const callTool = async (nameArg: unknown, argsArg: unknown): Promise<string> => {
      try {
        if (done) return refuse('TOOL_ERROR', 'The sandbox run has already finished.');
        const name = String(nameArg);
        const tool = allowed.get(name);
        if (!tool) return refuse('TOOL_NOT_ALLOWED', notAvailable(name, names));
        if (meta.connectorCalls >= limits.maxConnectorCalls) {
          return refuse(
            'CONNECTOR_CALL_LIMIT',
            `Connector call limit (${limits.maxConnectorCalls}) reached.`,
          );
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(argsArg));
        } catch {
          return refuse('TOOL_ERROR', 'Tool arguments must be valid JSON.');
        }
        if (!isPlainObject(parsed)) {
          return refuse(
            'TOOL_ERROR',
            `Tool arguments must be an object, e.g. tools.${name}({ limit: 10 }).`,
          );
        }

        meta.connectorCalls++;
        if (!meta.toolsCalled.includes(name)) meta.toolsCalled.push(name);

        let result: SandboxToolResult;
        try {
          // Scope to the owning connector (avoids cross-connector name clashes)
          // and keep everything else from the authenticated session.
          result = await req.executeTool(name, parsed, {
            ...req.invocationContext,
            connectorIds: [tool.connectorId],
          });
        } catch (err) {
          this.logger.warn(
            `Tool "${name}" threw inside a sandbox run: ${(err as Error)?.constructor?.name ?? 'error'}`,
          );
          return refuse('TOOL_ERROR', `Tool '${name}' failed unexpectedly.`);
        }
        if (done) return refuse('TOOL_ERROR', 'The sandbox run has already finished.');
        if (result.isError) return refuse('TOOL_ERROR', toolErrorText(result));

        const out = JSON.stringify(toolValue(result)) ?? 'null';
        meta.bytesFromConnectors += Buffer.byteLength(out);
        if (meta.bytesFromConnectors > limits.maxConnectorBytes) {
          return refuse(
            'CONNECTOR_BYTES_LIMIT',
            `Connector data limit (${limits.maxConnectorBytes} bytes) reached.`,
          );
        }
        return `{"ok":true,"v":${out}}`;
      } catch {
        return refuse('TOOL_ERROR', 'Sandbox bridge error.');
      }
    };

    const describeTool = async (nameArg: unknown): Promise<string> => {
      try {
        const name = String(nameArg);
        const tool = allowed.get(name);
        if (!tool) return refuse('TOOL_NOT_ALLOWED', notAvailable(name, names));
        return `{"ok":true,"v":${JSON.stringify({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          outputSchema: tool.outputSchema ?? null,
        })}}`;
      } catch {
        return refuse('TOOL_ERROR', 'Sandbox bridge error.');
      }
    };

    const logLine = (line: unknown): void => {
      if (done || meta.logs.length >= limits.maxLogLines) return;
      meta.logs.push(String(line).slice(0, 500));
    };

    // ---- run ----------------------------------------------------------------
    try {
      const context = await isolate.createContext();
      const jail = context.global;
      await jail.set('__call', new ivm.Reference(callTool));
      await jail.set('__describe', new ivm.Reference(describeTool));
      await jail.set('__log', new ivm.Reference(logLine));
      await jail.set('__toolNamesJson', JSON.stringify(names));
      await jail.set('__argsJson', argsJson);
      await jail.set('__maxOut', limits.maxOutputBytes);
      await jail.set('__maxLog', limits.maxLogLines);
      const runtime = await isolate.compileScript(RUNTIME_SOURCE, { filename: RUNTIME_FILE });
      await runtime.run(context);

      let script: ivm.Script;
      try {
        script = await isolate.compileScript(wrapUserCode(req.code), { filename: SCRIPT_FILE });
      } catch (err) {
        if (timedOut || isolate.isDisposed || (err as Error)?.name !== 'SyntaxError') {
          return classify(err);
        }
        const syntax = parseSyntaxError(err, lineCount);
        return failWith({
          code: 'SYNTAX_ERROR',
          message: `Syntax error at line ${syntax.line}, column ${syntax.column}: ${syntax.message}`,
          line: syntax.line,
          column: syntax.column,
        });
      }

      const raw: unknown = await script.run(context, {
        timeout: limits.timeoutMs,
        promise: true,
        copy: true,
      });
      return this.finish(raw, limits, meta, started, failWith);
    } catch (err) {
      return classify(err);
    } finally {
      done = true;
      clearTimeout(timer);
      disposeQuietly(isolate);
    }
  }

  /** Validate what the isolate handed back; never trust its shape. */
  private finish(
    raw: unknown,
    limits: SandboxLimits,
    meta: SandboxRunMeta,
    started: number,
    failWith: (error: SandboxError) => SandboxRunResult,
  ): SandboxRunResult {
    const out = (raw && typeof raw === 'object' ? raw : {}) as {
      k?: unknown;
      j?: unknown;
      n?: unknown;
      m?: unknown;
    };
    const tooLarge = (bytes: number) =>
      failWith({
        code: 'OUTPUT_TOO_LARGE',
        message:
          `Result is ${bytes} bytes; limit is ${limits.maxOutputBytes}. ` +
          'Return aggregates, counts, or the first 20 rows (e.g. rows.slice(0, 20)).',
      });

    if (out.k === 'ok' && typeof out.j === 'string') {
      const bytes = Buffer.byteLength(out.j);
      if (bytes > limits.maxOutputBytes) return tooLarge(bytes);
      meta.bytesReturned = bytes;
      meta.ms = Date.now() - started;
      return { ok: true, result: JSON.parse(out.j), meta: snapshot(meta) };
    }
    if (out.k === 'toolarge' && typeof out.n === 'number') return tooLarge(out.n);
    if (out.k === 'unserializable') {
      return failWith({
        code: 'RUNTIME_ERROR',
        message: `Result is not JSON-serialisable: ${String(out.m).slice(0, 200)}`,
      });
    }
    return failWith({
      code: 'RUNTIME_ERROR',
      message: 'Script ended without producing a result.',
    });
  }
}

function mergeLimits(over?: Partial<SandboxLimits>): SandboxLimits {
  const merged = { ...SANDBOX_LIMITS };
  for (const [key, value] of Object.entries(over ?? {})) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      (merged as Record<string, number>)[key] = value;
    }
  }
  return merged;
}

/** Copy of the meta so a late callback cannot mutate a result already returned. */
function snapshot(meta: SandboxRunMeta): SandboxRunMeta {
  return { ...meta, logs: [...meta.logs], toolsCalled: [...meta.toolsCalled] };
}

function disposeQuietly(isolate: ivm.Isolate): void {
  try {
    if (!isolate.isDisposed) isolate.dispose();
  } catch {
    /* already gone (memory-limit kill disposes on its own) */
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function notAvailable(name: string, names: string[]): string {
  const shown = names.slice(0, MAX_AVAILABLE_NAMES).join(', ');
  const more = names.length > MAX_AVAILABLE_NAMES ? '…' : '';
  return `Tool '${name}' is not available in this sandbox. Available: ${shown}${more}`;
}

/** Pre-serialised object when the executor gave one, else the first text block. */
function toolValue(result: SandboxToolResult): unknown {
  if (result.structured !== undefined) return result.structured;
  const text = result.content?.[0]?.text;
  if (text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toolErrorText(result: SandboxToolResult): string {
  const text = result.content?.[0]?.text ?? 'Tool failed.';
  let message = text;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed?.error === 'string') message = parsed.error;
  } catch {
    /* plain text error */
  }
  return message.slice(0, MAX_TOOL_ERROR_CHARS);
}
