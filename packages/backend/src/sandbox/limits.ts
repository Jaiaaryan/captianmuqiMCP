/**
 * Resource ceilings for one sandbox run. Every value can be overridden with a
 * SANDBOX_* environment variable; Cloud and self-hosted behave identically,
 * Cloud may simply set lower values.
 */

/** Positive number from the environment, or the default for unset/garbage values. */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const SANDBOX_LIMITS = {
  /** V8 heap cap of the isolate. */
  memoryMb: envNumber('SANDBOX_MEMORY_MB', 128),
  /** Wall clock for the whole script, including time spent waiting on connectors. */
  timeoutMs: envNumber('SANDBOX_TIMEOUT_MS', 10_000),
  /** Largest JSON result that may leave the sandbox (what the model sees). */
  maxOutputBytes: envNumber('SANDBOX_MAX_OUTPUT_BYTES', 32 * 1024),
  maxConnectorCalls: envNumber('SANDBOX_MAX_CONNECTOR_CALLS', 50),
  /** Sum of connector payloads pulled into the isolate. */
  maxConnectorBytes: envNumber('SANDBOX_MAX_CONNECTOR_BYTES', 64 * 1024 * 1024),
  maxCodeBytes: 64 * 1024,
  maxLogLines: 100,
  /** Simultaneous runs per organization; further runs fail fast with BUSY. */
  maxConcurrent: envNumber('SANDBOX_MAX_CONCURRENT', 4),
};

export type SandboxLimits = typeof SANDBOX_LIMITS;

/** Range accepted from callers that choose their own timeout (MCP tool, REST). */
export const SANDBOX_TIMEOUT_RANGE_MS = { min: 1_000, max: 30_000 } as const;
