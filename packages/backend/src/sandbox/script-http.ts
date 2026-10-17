/**
 * Level 3 `http.fetch`: the host side of the bridge, and the run helper that
 * gives a saved script its capabilities and masks the secrets in what it hands
 * back.
 *
 * A request is checked in this order, and refused at the first failing step:
 *   1. the URL is absolute http(s) without user info;
 *   2. its origin (scheme, host, port) is the origin of the resolved base URL of
 *      one of the connectors the script declares (HTTP_NOT_ALLOWED otherwise,
 *      before any DNS lookup or connection);
 *   3. the method is GET or HEAD, unless the operator allows writes
 *      (SANDBOX_ALLOW_WRITES=true, the policy of write tools);
 *   4. the connector-call limit of the run is not reached;
 *   5. the SSRF guard (common/ssrf.util.ts) accepts the host: private, loopback
 *      and link-local addresses such as 169.254.169.254 are refused unless the
 *      host is in SSRF_ALLOWED_HOSTS or the admin allowlist.
 * The request itself goes through the SSRF-guarded outbound client, which checks
 * the address it connects to again; redirects are not followed (the 3xx comes
 * back to the script), the timeout is the connector timeout (bounded by what is
 * left of the run), and the body is capped at maxConnectorResponseBytes. Each
 * request counts as a connector call and its bytes count toward
 * maxConnectorBytes.
 */
import { outboundRequest } from '../common/outbound-http';
import { assertSafeOutboundUrl, SsrfBlockedError } from '../common/ssrf.util';
import type { SandboxLimits } from './limits';
import { maskSecrets } from './secret-mask';
import type { SandboxService } from './sandbox.service';
import type {
  SandboxError,
  SandboxHttpPolicy,
  SandboxHttpRequest,
  SandboxHttpResponse,
  SandboxHttpSend,
  SandboxRunMeta,
  SandboxRunRequest,
  SandboxRunResult,
} from './types';

const READ_METHODS = new Set(['GET', 'HEAD']);
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
/** Set by the HTTP client from the URL and the body; a script does not choose them. */
const FORBIDDEN_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-connection',
]);
const MAX_HEADERS = 50;
const MAX_HEADER_VALUE_CHARS = 8 * 1024;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

interface BridgeState {
  limits: SandboxLimits;
  meta: SandboxRunMeta;
  /** When the run started (Date.now()). */
  started: number;
  /** True once the run has ended: late calls are refused and record nothing. */
  isDone: () => boolean;
  /** Settled by the run when it ends; an in-flight request is aborted then. */
  live?: Set<() => void>;
}

type Envelope = string;

const refuse = (code: SandboxError['code'], message: string): Envelope =>
  JSON.stringify({ ok: false, code, message });

/** `origin + path` of a URL, never its query or fragment. */
function describe(url: URL): { origin: string; path: string } {
  return { origin: url.origin, path: url.pathname };
}

/**
 * The host function behind `http.fetch`, for `new ivm.Reference(...)`. Like the
 * tool bridge it never rejects: it resolves a JSON envelope the runtime turns
 * into a value or a throw.
 */
export function createHttpBridge(
  policy: SandboxHttpPolicy,
  state: BridgeState,
): (requestJson: unknown) => Promise<Envelope> {
  const { limits, meta } = state;
  const send = policy.send ?? defaultSend;
  meta.httpCalls ??= [];
  const allowedList = () => [...policy.origins.keys()].join(', ') || 'none';

  return async (requestJson: unknown): Promise<Envelope> => {
    try {
      if (state.isDone()) return refuse('HTTP_ERROR', 'The sandbox run has already finished.');
      let input: { url?: unknown; method?: unknown; headers?: unknown; body?: unknown };
      try {
        input = JSON.parse(String(requestJson)) as typeof input;
      } catch {
        return refuse('HTTP_ERROR', 'http.fetch arguments must be JSON.');
      }

      // 1. An absolute http(s) URL.
      let url: URL;
      try {
        url = new URL(String(input.url));
      } catch {
        return refuse('HTTP_NOT_ALLOWED', 'http.fetch needs an absolute http:// or https:// URL.');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return refuse('HTTP_NOT_ALLOWED', `Protocol '${url.protocol}' is not allowed; use http or https.`);
      }
      if (url.username || url.password) {
        return refuse('HTTP_NOT_ALLOWED', 'A URL with user info is not allowed; send credentials in a header.');
      }

      // 2. The origin of a declared connector. Decided on the URL alone, before
      // any lookup or connection.
      const connectorName = policy.origins.get(url.origin);
      if (connectorName === undefined) {
        return refuse(
          'HTTP_NOT_ALLOWED',
          `Origin '${url.origin}' is not the address of a connector this script declares ` +
            `(allowed: ${allowedList()}).`,
        );
      }

      // 3. Read-only unless the trusted policy allows writes.
      const method = typeof input.method === 'string' ? input.method.toUpperCase() : 'GET';
      if (!METHODS.has(method)) return refuse('HTTP_ERROR', `Method '${method}' is not supported.`);
      if (!READ_METHODS.has(method) && !policy.allowWrites) {
        return refuse(
          'WRITE_NOT_ALLOWED',
          `http.fetch with ${method} can change data, and sandbox scripts are read-only.`,
        );
      }

      const headers = checkHeaders(input.headers);
      if (typeof headers === 'string') return refuse('HTTP_ERROR', headers);
      let body: string | undefined;
      if (input.body !== undefined && input.body !== null) {
        if (method === 'GET' || method === 'HEAD') {
          return refuse('HTTP_ERROR', `A ${method} request cannot have a body.`);
        }
        body = typeof input.body === 'string' ? input.body : JSON.stringify(input.body);
        if (typeof input.body !== 'string' && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
          headers['content-type'] = 'application/json';
        }
        if (Buffer.byteLength(body ?? '') > MAX_REQUEST_BODY_BYTES) {
          return refuse('HTTP_ERROR', `Request body is larger than ${MAX_REQUEST_BODY_BYTES} bytes.`);
        }
      }

      // 4. One connector call.
      if (meta.connectorCalls >= limits.maxConnectorCalls) {
        return refuse('CONNECTOR_CALL_LIMIT', `Connector call limit (${limits.maxConnectorCalls}) reached.`);
      }
      meta.connectorCalls++;
      const where = describe(url);
      const record = (status: number, bytes: number) => {
        if (!state.isDone()) meta.httpCalls!.push({ ...where, status, bytes });
      };

      // 5. The SSRF policy on the host (allowlists, then the resolved addresses).
      try {
        await assertSafeOutboundUrl(url.toString());
      } catch (err) {
        record(0, 0);
        if (err instanceof SsrfBlockedError) {
          return refuse('HTTP_NOT_ALLOWED', `Blocked by the outbound address policy: ${err.message}`);
        }
        return refuse('HTTP_ERROR', `Could not check the address of ${url.origin}.`);
      }
      if (state.isDone()) return refuse('HTTP_ERROR', 'The sandbox run has already finished.');

      const left = limits.timeoutMs - (Date.now() - state.started);
      const timeoutMs = Math.max(1, Math.min(limits.connectorTimeoutMs, left));
      const request: SandboxHttpRequest = {
        url: url.toString(),
        method,
        headers,
        ...(body !== undefined && { body }),
        timeoutMs,
        maxBytes: limits.maxConnectorResponseBytes,
      };

      let response: SandboxHttpResponse;
      try {
        response = await withLive(send, request, state.live);
      } catch (err) {
        record(0, 0);
        return refuse(...classifySendError(err, url.origin, limits));
      }
      if (state.isDone()) return refuse('HTTP_ERROR', 'The sandbox run has already finished.');

      const bytes = response.body.length;
      record(response.status, bytes);
      if (bytes > limits.maxConnectorResponseBytes) {
        return refuse(
          'CONNECTOR_BYTES_LIMIT',
          `Response of ${bytes} bytes is larger than the per-response limit (${limits.maxConnectorResponseBytes} bytes).`,
        );
      }
      meta.bytesFromConnectors += bytes;
      if (meta.bytesFromConnectors > limits.maxConnectorBytes) {
        return refuse('CONNECTOR_BYTES_LIMIT', `Connector data limit (${limits.maxConnectorBytes} bytes) reached.`);
      }

      const text = response.body.toString('utf8');
      const value: Record<string, unknown> = {
        status: response.status,
        headers: publicHeaders(response.headers),
        text,
      };
      if (text.length > 0) {
        try {
          value.json = JSON.parse(text);
        } catch {
          /* not JSON: `text` only */
        }
      }
      return JSON.stringify({ ok: true, v: value });
    } catch {
      return refuse('HTTP_ERROR', 'Sandbox bridge error.');
    }
  };
}

/** Header names and values as the script gave them, or why they are refused. */
function checkHeaders(raw: unknown): Record<string, string> | string {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'headers must be an object of strings.';
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_HEADERS) return `At most ${MAX_HEADERS} headers.`;
  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!HEADER_NAME.test(name)) return `Invalid header name '${name.slice(0, 50)}'.`;
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) continue;
    if (typeof value !== 'string' && typeof value !== 'number') {
      return `Header '${name}' must be a string.`;
    }
    const text = String(value);
    if (text.length > MAX_HEADER_VALUE_CHARS || /[\r\n\0]/.test(text)) {
      return `Header '${name}' has an invalid value.`;
    }
    out[name] = text;
  }
  return out;
}

/** Response headers a script may read: lower-cased, without cookies. */
function publicHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'set-cookie' || lower === 'set-cookie2') continue;
    out[lower] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

/** Runs one request and aborts it if the run ends first. */
async function withLive(
  send: SandboxHttpSend,
  request: SandboxHttpRequest,
  live: Set<() => void> | undefined,
): Promise<SandboxHttpResponse> {
  const controller = new AbortController();
  const end = () => controller.abort();
  live?.add(end);
  try {
    return await send({ ...request, signal: controller.signal });
  } finally {
    live?.delete(end);
  }
}

function classifySendError(
  err: unknown,
  origin: string,
  limits: SandboxLimits,
): [SandboxError['code'], string] {
  const e = err as { name?: string; code?: string; message?: string; cause?: unknown };
  if (err instanceof SsrfBlockedError || e?.cause instanceof SsrfBlockedError) {
    const message = (err instanceof SsrfBlockedError ? err : (e.cause as Error)).message;
    return ['HTTP_NOT_ALLOWED', `Blocked by the outbound address policy: ${message}`];
  }
  const text = String(e?.message ?? '');
  if (/maxContentLength/i.test(text)) {
    return [
      'CONNECTOR_BYTES_LIMIT',
      `Response from ${origin} is larger than the per-response limit (${limits.maxConnectorResponseBytes} bytes).`,
    ];
  }
  if (e?.code === 'ECONNABORTED' || e?.code === 'ETIMEDOUT' || e?.name === 'CanceledError' || e?.code === 'ERR_CANCELED') {
    return ['CONNECTOR_TIMEOUT', `${origin} did not answer within ${limits.connectorTimeoutMs} ms.`];
  }
  // The code only (ECONNREFUSED, ENOTFOUND ...): a message can carry the full URL.
  return ['HTTP_ERROR', `Request to ${origin} failed${e?.code ? ` (${e.code})` : ''}.`];
}

/**
 * The real request: the SSRF-guarded outbound client (every hop checked, the
 * socket pinned to the addresses the guard accepted), redirects not followed,
 * one deadline, a byte cap, the body buffered.
 */
const defaultSend: SandboxHttpSend = async (req) => {
  const res = await outboundRequest<ArrayBuffer>(
    {
      url: req.url,
      method: req.method,
      headers: req.headers,
      data: req.body,
      timeout: req.timeoutMs,
      signal: req.signal,
      responseType: 'arraybuffer',
      maxContentLength: req.maxBytes,
      maxBodyLength: MAX_REQUEST_BODY_BYTES,
      decompress: true,
      validateStatus: () => true,
      // Kept as bytes: the bridge decodes and parses.
      transformResponse: [(data: unknown) => data],
    },
    { maxRedirects: 0 },
  );
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(res.headers ?? {})) {
    if (value === undefined || value === null) continue;
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return { status: res.status, headers, body: Buffer.from(res.data ?? new ArrayBuffer(0)) };
};

// ---- the run helper --------------------------------------------------------

/** What a saved script may use beyond tools, resolved on the host for one run. */
export interface ScriptRunCapabilities {
  /** `env` of the run, when the script has `capabilities.env`. */
  env?: Record<string, string>;
  /** `http.fetch` policy, when the script has `capabilities.http`. */
  http?: SandboxHttpPolicy;
  /** Every secret of the declared connectors: masked in whatever the run returns. */
  secrets: string[];
}

/**
 * Runs a script with its Level 3 capabilities, if it has any, and masks the
 * secrets of its declared connectors in the outcome: result, logs, error
 * (message, hint, stack) and meta. Every exit path of the run passes through
 * here, so whatever is stored, logged or returned afterwards is masked.
 * `capabilities` null: a plain Level 2 run, unchanged.
 */
export async function runWithCapabilities(
  sandbox: Pick<SandboxService, 'run'>,
  req: SandboxRunRequest,
  capabilities: ScriptRunCapabilities | null | undefined,
): Promise<SandboxRunResult> {
  if (!capabilities) return sandbox.run(req);
  const result = await sandbox.run({
    ...req,
    ...(capabilities.env && { env: capabilities.env }),
    ...(capabilities.http && { http: capabilities.http }),
  });
  return maskSecrets(result, capabilities.secrets);
}
