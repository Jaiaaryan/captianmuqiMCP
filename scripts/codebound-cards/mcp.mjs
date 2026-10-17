// Minimal MCP client over Streamable HTTP (initialize, notifications/initialized,
// tools/list, tools/call; SSE or JSON framing). Adapted from the CODEBOUND kit's
// harness/mcp.mjs so this suite runs with no dependency on a bare Node 22.

const PROTOCOL_VERSION = '2025-06-18';

export class McpClient {
  constructor(url, apiKey) {
    this.url = url;
    this.apiKey = apiKey;
    this.sessionId = null;
    this.nextId = 1;
    this.initialized = false;
  }

  async #post(body, { timeoutMs = 30_000 } = {}) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    // Per-user keys (mcp_...) go in X-API-Key; anything else is a bearer token.
    if (this.apiKey.startsWith('mcp_')) headers['x-api-key'] = this.apiKey;
    else headers.authorization = `Bearer ${this.apiKey}`;
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    if (this.initialized) headers['mcp-protocol-version'] = PROTOCOL_VERSION;
    const res = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const text = await res.text();
    if (body.id === undefined) return { status: res.status };
    const ctype = res.headers.get('content-type') || '';
    let message;
    if (ctype.includes('text/event-stream')) {
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.id === body.id) message = parsed;
        } catch {
          /* keep-alive */
        }
      }
    } else {
      try {
        message = JSON.parse(text);
      } catch {
        /* not JSON */
      }
    }
    if (!message) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    if (message.error) {
      const err = new Error(`JSON-RPC ${message.error.code}: ${message.error.message}`);
      err.rpc = message.error;
      err.status = res.status;
      throw err;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    return message.result;
  }

  async init() {
    if (this.initialized) return;
    await this.#post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'codebound-cards', version: '1.0.0' },
      },
    });
    this.initialized = true;
    await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async listTools() {
    await this.init();
    const tools = [];
    let cursor;
    do {
      const r = await this.#post({
        jsonrpc: '2.0',
        id: this.nextId++,
        method: 'tools/list',
        params: cursor ? { cursor } : {},
      });
      tools.push(...(r.tools || []));
      cursor = r.nextCursor;
    } while (cursor);
    return tools;
  }

  /** Never throws: refusals, timeouts and transport errors come back as data. */
  async callTool(name, args = {}, { timeoutMs = 90_000 } = {}) {
    const started = Date.now();
    try {
      await this.init();
      const result = await this.#post(
        { jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name, arguments: args } },
        { timeoutMs },
      );
      const text = (result?.content || [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      let json = result?.structuredContent;
      if (json === undefined) {
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
      }
      return { ok: !result?.isError, isError: !!result?.isError, text, json, raw: JSON.stringify(result), ms: Date.now() - started };
    } catch (err) {
      return {
        ok: false,
        isError: true,
        transportError: true,
        rpc: err?.rpc,
        text: err?.message || String(err),
        raw: JSON.stringify({ error: err?.message || String(err), rpc: err?.rpc }),
        ms: Date.now() - started,
      };
    }
  }
}
