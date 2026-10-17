#!/usr/bin/env node
// CODEBOUND attack cards A1-A13, run against this AnythingMCP instance through
// its per-server MCP endpoint. Plain Node ESM (>= 22), no dependencies.
//
//   node scripts/codebound-cards/run.mjs [--card A1 --card A5 | --card A1,A5]
//        [--kit /tmp/codebound-kit-src/codebound-kit] [--url http://localhost:4001]
//        [--backend-log /tmp/amcp-backend.log] [--verbose]
//
// Every card first calls mock_erp_ping with a nonce and finds it in the mock log
// (proof that it ran), then attacks, then prints a verdict with its evidence.
// Exit code 1 when a knock-out card (A1 A2 A3 A5 A6 A7) fails or did not run.
// See README.md in this directory.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { McpClient } from './mcp.mjs';

const KNOCKOUT = new Set(['A1', 'A2', 'A3', 'A5', 'A6', 'A7']);
const PAYROLL = 'mock_payroll_list_salaries';

// ---- options ----------------------------------------------------------------

function parseArgs(argv) {
  const opts = { cards: [], kit: '/tmp/codebound-kit-src/codebound-kit', url: null, backendLog: '/tmp/amcp-backend.log', verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--card') opts.cards.push(...String(next()).split(',').map((c) => c.trim().toUpperCase()).filter(Boolean));
    else if (a === '--kit') opts.kit = next();
    else if (a === '--url') opts.url = next();
    else if (a === '--backend-log') opts.backendLog = next();
    else if (a === '--mock-admin') opts.mockAdmin = next();
    else if (a === '--outside-admin') opts.outsideAdmin = next();
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, 12).join('\n'));
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const state = JSON.parse(fs.readFileSync(path.join(opts.kit, '.codebound', 'state.json'), 'utf8'));
const BASE = (opts.url || process.env.AMCP_URL || state.url || 'http://localhost:4001').replace(/\/$/, '');
const MOCK_ADMIN = opts.mockAdmin || 'http://127.0.0.1:4180';
const OUTSIDE_ADMIN = opts.outsideAdmin || 'http://127.0.0.1:4181';

const nonce = (card) => `card-${card.toLowerCase()}-${randomBytes(5).toString('hex')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (v, n = 160) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s === undefined ? 'undefined' : s.length > n ? `${s.slice(0, n)}…` : s;
};
const log = (...a) => opts.verbose && console.log('  ·', ...a);

// ---- clients ----------------------------------------------------------------

const clients = new Map();
function mcp(user) {
  if (!clients.has(user)) {
    const u = state.users[user];
    const ws = state.workspaces[u.workspace];
    clients.set(user, new McpClient(`${BASE}/mcp/${ws.serverId}`, u.key));
  }
  return clients.get(user);
}

/** JWT per user, logged in once (login is throttled to 5/minute). */
const tokens = new Map();
async function jwt(user) {
  if (tokens.has(user)) return tokens.get(user);
  const u = state.users[user];
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: u.email, password: u.password }),
    });
    if (res.status === 429 && attempt < 4) {
      console.log(`  (login rate-limited for ${user}, waiting 20 s)`);
      await sleep(20_000);
      continue;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.accessToken) throw new Error(`login ${user}: HTTP ${res.status} ${short(body)}`);
    tokens.set(user, body.accessToken);
    return body.accessToken;
  }
}

async function api(user, method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { authorization: `Bearer ${await jwt(user)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, ok: res.ok, json };
}

// ---- mock log -----------------------------------------------------------------

async function mockSeq(admin = MOCK_ADMIN) {
  const r = await fetch(`${admin}/__health`, { signal: AbortSignal.timeout(5000) });
  return (await r.json()).seq;
}
async function mockSince(since, admin = MOCK_ADMIN) {
  const r = await fetch(`${admin}/__log?since=${since}`, { signal: AbortSignal.timeout(5000) });
  return (await r.json()).entries || [];
}

/** Step 1 of every card: a ping with a nonce, found in the mock log. */
async function ping(user, card) {
  const n = nonce(card);
  const before = await mockSeq();
  const res = await mcp(user).callTool('mock_erp_ping', { nonce: n });
  const hit = (await mockSince(before)).find((e) => e.query?.nonce === n);
  return { ran: !!hit, seq: hit?.seq ?? null, tenant: hit?.tenant ?? null, res, before };
}

// ---- sandbox helpers ----------------------------------------------------------

/** sandbox_run_script; returns { ok, result, code, message, runId, meta, text, raw }. */
async function script(user, args, { timeoutMs } = {}) {
  const res = await mcp(user).callTool('sandbox_run_script', args, { timeoutMs: timeoutMs ?? 90_000 });
  const j = res.json && typeof res.json === 'object' ? res.json : {};
  return {
    ok: res.ok && j.ok === true,
    result: j.result,
    code: j.error?.code ?? (res.transportError ? 'TRANSPORT' : null),
    message: j.error?.message ?? (res.ok ? null : res.text),
    runId: j.runId ?? null,
    meta: j.meta,
    text: res.text,
    raw: res.raw,
  };
}

/** Admin's view of the refusals recorded in its own workspace (GET /api/audit/refusals). */
async function refusals(adminUser, toolName, sinceMs) {
  await sleep(500); // logRefusal is fire-and-forget
  const r = await api(adminUser, 'GET', '/api/audit/refusals?limit=200');
  if (!r.ok) return { error: `HTTP ${r.status} ${short(r.json)}`, rows: [] };
  // A repeat inside the 60 s repeat window is folded into the first row.
  const rows = (r.json || []).filter(
    (row) => row.toolName === toolName && new Date(row.createdAt).getTime() >= sinceMs - 61_000,
  );
  return { rows };
}

/**
 * A saved Level 3 script of bob's workspace, bound to the ERP only, created over
 * REST and deleted afterwards. Returns null (with the reason) when the instance
 * does not accept Level 3 capabilities.
 */
async function withBoundScript(user, card, code, capabilities, fn) {
  const ws = state.workspaces[state.users[user].workspace];
  const name = `card_${card.toLowerCase()}_${randomBytes(4).toString('hex')}`;
  const created = await api(user, 'POST', `/api/sandbox/servers/${ws.serverId}/scripts`, {
    name,
    code,
    description: `CODEBOUND card ${card} (temporary, deleted after the run)`,
    uses: [{ connectorId: ws.connectorIds.erp, tools: ['mock_erp_ping'] }],
    capabilities,
  });
  if (!created.ok) return { unavailable: `create failed: HTTP ${created.status} ${short(created.json, 200)}` };
  const caps = created.json?.capabilities;
  try {
    const run = await script(user, { scriptName: name });
    return await fn(run, { name, caps });
  } finally {
    await api(user, 'DELETE', `/api/sandbox/scripts/${created.json.id}`).catch(() => undefined);
  }
}

const allCanaries = () => {
  const out = [];
  for (const ws of Object.values(state.canaries.connectors || {})) out.push(...Object.values(ws));
  if (state.canaries.hostEnv) out.push(state.canaries.hostEnv);
  if (state.canaries.hostFile) out.push(state.canaries.hostFile);
  return out.filter(Boolean);
};

function backendLogSince(offset) {
  try {
    const fd = fs.openSync(opts.backendLog, 'r');
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.max(0, size - offset));
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return null;
  }
}
const backendLogSize = () => {
  try {
    return fs.statSync(opts.backendLog).size;
  } catch {
    return 0;
  }
};

// ---- cards --------------------------------------------------------------------

/**
 * Shared by A1, A2 and A11: a direct tools/call and a script call to a tool the
 * caller must not reach; neither may reach the payroll mock, both must be in the
 * caller's workspace audit log.
 */
async function refusedAndAudited(card, user, adminUser, toolName, scriptCode, p) {
  const start = Date.now();
  const direct = await mcp(user).callTool(toolName, {});
  const viaScript = await script(user, { code: scriptCode });
  const payrollHits = (await mockSince(p.before)).filter((e) => e.service === 'payroll');
  const audit = await refusals(adminUser, toolName, start);
  const directRow = audit.rows.find((r) => !r.sandboxRunId);
  const scriptRow = audit.rows.find((r) => r.sandboxRunId && r.sandboxRunId === viaScript.runId);

  const directRefused = direct.isError === true;
  const scriptRefused = !viaScript.ok && ['TOOL_NOT_ALLOWED', 'NOT_FOUND'].includes(viaScript.code);
  const problems = [];
  if (!directRefused) problems.push('direct call was NOT refused');
  if (!scriptRefused) problems.push(`script call was NOT refused (${viaScript.code ?? 'ok'})`);
  if (payrollHits.length) problems.push(`${payrollHits.length} payroll request(s) reached the mock`);
  if (audit.error) problems.push(`audit route: ${audit.error}`);
  if (!directRow) problems.push('direct refusal NOT in audit log');
  if (!scriptRow) problems.push('script refusal NOT in audit log');
  const ws = state.users[adminUser].workspace;
  return {
    pass: problems.length === 0,
    evidence: [
      `direct: ${short(direct.rpc ? `JSON-RPC ${direct.rpc.code} ${direct.rpc.message}` : direct.text, 90)}`,
      `script: ${viaScript.code} run ${viaScript.runId?.slice(0, 8) ?? '-'}`,
      `payroll mock entries: ${payrollHits.length}`,
      `audit(${ws}): direct=${directRow ? `${directRow.source}/${directRow.code}` : 'none'} script=${scriptRow ? `${scriptRow.source}/${scriptRow.code}` : 'none'}`,
      ...problems.map((x) => `FAIL: ${x}`),
    ],
  };
}

const CARDS = {
  async A1() {
    const p = await ping('bob', 'A1');
    return { p, ...(await refusedAndAudited('A1', 'bob', 'bob', PAYROLL, `return await tools.${PAYROLL}({})`, p)) };
  },

  async A2() {
    const p = await ping('bob', 'A2');
    const id = state.workspaces.A.toolIds[PAYROLL];
    return { p, ...(await refusedAndAudited('A2', 'bob', 'bob', id, `return await tools[${JSON.stringify(id)}]({})`, p)) };
  },

  async A3() {
    const p = await ping('bob', 'A3');
    const inline = await script('bob', { code: `return typeof env === 'undefined' ? 'absent' : Object.keys(env)` });
    const evidence = [`inline: ${short(inline.ok ? inline.result : inline.code)}`];
    let pass = inline.ok && (inline.result === 'absent' || (Array.isArray(inline.result) && inline.result.length === 0));
    // Level 3: a saved script bound to the ERP only, with env.
    const bound = await withBoundScript(
      'bob',
      'A3',
      `await tools.mock_erp_ping({ nonce: 'a3-bound' }); return typeof env === 'undefined' ? 'absent' : Object.keys(env);`,
      { env: true },
      async (run) => run,
    );
    if (bound.unavailable) evidence.push(`bound script: n/a (${bound.unavailable})`);
    else {
      const keys = bound.ok ? bound.result : null;
      const foreign = Array.isArray(keys) ? keys.filter((k) => /SUPPLIER|CARRIER|PAYROLL|CODEBOUND/i.test(k)) : [];
      const leaked = allCanaries().filter((c) => bound.raw.includes(c) && !c.startsWith('cbk_erp_b'));
      evidence.push(`bound(ERP) env: ${short(bound.ok ? keys : `${bound.code} ${bound.message}`)}`);
      if (!bound.ok) pass = false;
      if (foreign.length) evidence.push(`FAIL: foreign vars ${foreign.join(',')}`);
      if (leaked.length) evidence.push(`FAIL: ${leaked.length} canary value(s) in output`);
      if (foreign.length || leaked.length) pass = false;
      evidence.push(keys === 'absent' ? 'Level 3 env not injected → absent' : 'Level 3 env: only bound connector vars');
    }
    return { p, pass, evidence };
  },

  async A4() {
    const p = await ping('bob', 'A4');
    const target = 'http://169.254.169.254/latest/meta-data/';
    const inline = await script('bob', {
      code: `if (typeof http === 'undefined') return 'no-http';
             try { const r = await http.fetch(${JSON.stringify(target)}); return { reached: true, status: r.status }; }
             catch (e) { return { blocked: true, code: e.code, message: String(e.message).slice(0, 200) }; }`,
    });
    const evidence = [`inline: ${short(inline.ok ? inline.result : inline.code)}`];
    let pass = inline.ok && (inline.result === 'no-http' || inline.result?.blocked === true);
    if (inline.result === 'no-http') evidence.push('inline: blocked by construction (no http)');
    const bound = await withBoundScript(
      'bob',
      'A4',
      `await tools.mock_erp_ping({ nonce: 'a4-bound' });
       if (typeof http === 'undefined') return 'no-http';
       try { const r = await http.fetch(${JSON.stringify(target)}); return { reached: true, status: r.status }; }
       catch (e) { return { blocked: true, code: e.code, message: String(e.message).slice(0, 200) }; }`,
      { http: true },
      async (run) => run,
    );
    if (bound.unavailable) evidence.push(`bound script: n/a (${bound.unavailable})`);
    else {
      evidence.push(`bound(ERP,http): ${short(bound.ok ? bound.result : `${bound.code} ${bound.message}`)}`);
      if (!(bound.ok && (bound.result === 'no-http' || bound.result?.blocked === true))) pass = false;
    }
    return { p, pass, evidence };
  },

  async A5() {
    const p = await ping('bob', 'A5');
    const outsideBefore = await mockSeq(OUTSIDE_ADMIN);
    const targets = [state.mockUrls.outsideByName, state.mockUrls.outsideByIp].map((u) => `${u}/codebound-a5`);
    const tryAll = (urls) => `
      if (typeof http === 'undefined') return 'no-http';
      const out = [];
      for (const url of ${JSON.stringify(urls)}) {
        try { const r = await http.fetch(url); out.push({ url, reached: true, status: r.status }); }
        catch (e) { out.push({ url, blocked: true, code: e.code }); }
      }
      return out;`;
    const inline = await script('bob', { code: tryAll(targets) });
    const evidence = [];
    let pass = inline.ok && (inline.result === 'no-http' || (Array.isArray(inline.result) && inline.result.every((r) => r.blocked)));
    evidence.push(inline.result === 'no-http' ? 'inline: blocked by construction (no http)' : `inline: ${short(inline.ok ? inline.result : inline.code)}`);

    const carrierBefore = await mockSeq();
    const bound = await withBoundScript(
      'bob',
      'A5',
      `await tools.mock_erp_ping({ nonce: 'a5-bound' });${tryAll([...targets, `${state.mockUrls.carrier}/v1/tracking/B-TRK-00001`])}`,
      { http: true },
      async (run) => run,
    );
    if (bound.unavailable) evidence.push(`bound script: n/a (${bound.unavailable})`);
    else {
      const ok = bound.ok && (bound.result === 'no-http' || (Array.isArray(bound.result) && bound.result.every((r) => r.blocked)));
      evidence.push(`bound(ERP)→outside+carrier: ${short(bound.ok ? bound.result : `${bound.code} ${bound.message}`, 200)}`);
      if (!ok) pass = false;
    }
    const outsideHits = (await mockSince(outsideBefore, OUTSIDE_ADMIN)).length;
    const carrierHits = (await mockSince(carrierBefore)).filter((e) => e.service === 'carrier').length;
    evidence.push(`outside-host log: ${outsideHits} new entries; carrier mock: ${carrierHits}`);
    if (outsideHits || carrierHits) pass = false;
    return { p, pass, evidence };
  },

  async A6() {
    const p = await ping('bob', 'A6');
    const probe = await script('bob', {
      code: `const out = {};
        out.process = typeof process; out.require = typeof require; out.Deno = typeof Deno; out.Bun = typeof Bun;
        out.canaryGlobal = typeof globalThis.CODEBOUND_HOST_CANARY;
        out.env = typeof env;
        try { out.viaCtor = (function(){}).constructor('return typeof process')(); } catch (e) { out.viaCtor = 'error'; }
        try { out.viaThis = Function('return typeof this.process')(); } catch (e) { out.viaThis = 'error'; }
        out.globals = Object.getOwnPropertyNames(globalThis).filter((n) => /env|proc|canary|require|fs|file/i.test(n));
        return out;`,
    });
    const imp = await script('bob', {
      code: `try { const m = await import('fs'); return 'loaded:' + typeof m.readFileSync; } catch (e) { return 'error: ' + String(e && e.message).slice(0, 120); }`,
    });
    const fileRead = await script('bob', {
      code: `if (typeof http === 'undefined') return 'no-http';
             try { const r = await http.fetch('file://${state.canaries.hostFilePath || '/etc/codebound-canary'}'); return { reached: true, status: r.status }; }
             catch (e) { return { blocked: true, code: e.code }; }`,
    });
    const outputs = [probe.raw, imp.raw, fileRead.raw].join('\n');
    const leaked = [state.canaries.hostEnv, state.canaries.hostFile].filter((c) => c && outputs.includes(c));
    const r = probe.result || {};
    const undef = ['process', 'require', 'Deno', 'Bun', 'canaryGlobal'].every((k) => r[k] === 'undefined');
    const ctorOk = ['undefined', 'error'].includes(r.viaCtor) && ['undefined', 'error'].includes(r.viaThis);
    const importBlocked = !imp.ok || !String(imp.result).startsWith('loaded');
    const fileBlocked = fileRead.ok ? fileRead.result === 'no-http' || fileRead.result?.blocked === true : true;
    const pass = probe.ok && undef && ctorOk && importBlocked && fileBlocked && leaked.length === 0;
    return {
      p,
      pass,
      evidence: [
        `typeof process/require/Deno/Bun/CANARY: ${['process', 'require', 'Deno', 'Bun', 'canaryGlobal'].map((k) => r[k]).join('/')}`,
        `Function-ctor escape: ${r.viaCtor}/${r.viaThis}; suspicious globals: ${short(r.globals)}`,
        `import('fs'): ${short(imp.ok ? imp.result : `${imp.code} ${imp.message}`, 80)}`,
        `file:// read: ${short(fileRead.ok ? fileRead.result : fileRead.code, 60)}`,
        `host canaries in output: ${leaked.length} (hostEnv ${state.canaries.hostEnv ? 'known' : 'not set'}, hostFile known)`,
      ],
    };
  },

  async A7() {
    const p = await ping('bob', 'A7');
    const marker = `A7-${randomBytes(6).toString('hex')}`;
    const fsProbe = `[typeof require, typeof process, typeof Deno, typeof fs, typeof File, typeof Blob].join('/')`;
    const write = await script('alice', {
      code: `globalThis.__codebound_a7 = ${JSON.stringify(marker)}; return { fs: ${fsProbe}, wrote: globalThis.__codebound_a7 };`,
    });
    // The other kind of "file" a script can leave behind: a saved script.
    const saveName = `card_a7_${randomBytes(4).toString('hex')}`;
    const saved = await mcp('alice').callTool('sandbox_create_script', { name: saveName, code: `return ${JSON.stringify(marker)};` });
    const read = await script('bob', {
      code: `return { fs: ${fsProbe}, seen: typeof globalThis.__codebound_a7 === 'undefined' ? null : globalThis.__codebound_a7 };`,
    });
    const bobList = await mcp('bob').callTool('sandbox_list_scripts', {});
    const bobRun = await script('bob', { scriptName: saveName });
    // Clean up alice's saved script.
    const aliceScripts = await api('alice', 'GET', `/api/sandbox/servers/${state.workspaces.A.serverId}/scripts`);
    const mine = (Array.isArray(aliceScripts.json) ? aliceScripts.json : aliceScripts.json?.scripts || []).find((s) => s.name === saveName);
    if (mine) await api('alice', 'DELETE', `/api/sandbox/scripts/${mine.id}`);

    const noFs = (s) => typeof s === 'string' && s.split('/').every((t) => t === 'undefined');
    const leaked = [read.raw, bobList.raw, bobRun.raw].some((x) => x.includes(marker));
    const pass = write.ok && read.ok && read.result?.seen === null && noFs(read.result?.fs) && !leaked && !bobRun.ok;
    return {
      p,
      pass,
      evidence: [
        `alice@A fs APIs: ${write.result?.fs ?? write.code} → no filesystem by construction`,
        `bob@B sees global marker: ${short(read.result?.seen)}; marker in any B output: ${leaked}`,
        `alice saved '${saveName}': ${saved.ok ? 'yes' : short(saved.text, 60)}; bob runs it: ${bobRun.ok ? 'RAN' : `refused (${short(bobRun.code ?? bobRun.message ?? bobRun.text, 70)})`}`,
      ],
    };
  },

  async A8() {
    const p = await ping('bob', 'A8');
    const t0 = Date.now();
    const run = await script('bob', { code: 'while (true) {}', timeoutMs: 3000 });
    const ms = Date.now() - t0;
    const next = await script('bob', { code: `return await tools.mock_erp_ping({ nonce: 'a8-after' })` });
    return {
      p,
      pass: run.code === 'TIMEOUT' && next.ok,
      evidence: [`run: ${run.code} after ${ms} ms (limit 3000)`, `next call: ${next.ok ? 'ok' : next.code}`],
    };
  },

  async A9() {
    const p = await ping('bob', 'A9');
    const t0 = Date.now();
    const run = await script('bob', {
      code: 'const keep = []; for (;;) keep.push(new Array(1e6).fill(Math.random()));',
      timeoutMs: 20_000,
    });
    const ms = Date.now() - t0;
    const next = await script('bob', { code: `return await tools.mock_erp_ping({ nonce: 'a9-after' })` });
    return {
      p,
      pass: ['MEMORY_LIMIT', 'TIMEOUT'].includes(run.code) && next.ok,
      evidence: [`run: ${run.code} after ${ms} ms: ${short(run.message, 80)}`, `next call: ${next.ok ? 'ok' : next.code}`],
    };
  },

  async A10() {
    const p = await ping('bob', 'A10');
    const prefix = nonce('A10');
    const before = await mockSeq();
    const run = await script('bob', {
      code: `for (let i = 0; i < 1000000; i++) await tools.mock_erp_ping({ nonce: ${JSON.stringify(prefix)} + '-' + i }); return 'finished';`,
      timeoutMs: 30_000,
    });
    const hits = (await mockSince(before)).filter((e) => String(e.query?.nonce || '').startsWith(`${prefix}-`)).length;
    const limit = /\((\d+)\)/.exec(run.message || '')?.[1];
    const next = await script('bob', { code: `return await tools.mock_erp_ping({ nonce: 'a10-after' })` });
    return {
      p,
      pass: run.code === 'CONNECTOR_CALL_LIMIT' && !!limit && hits <= Number(limit) && next.ok,
      evidence: [
        `run: ${run.code}: ${short(run.message, 80)}`,
        `limit named: ${limit ?? 'no'}; pings that reached the mock: ${hits}`,
        `next call: ${next.ok ? 'ok' : next.code}`,
      ],
    };
  },

  async A11() {
    const p = await ping('carol', 'A11');
    const out = await refusedAndAudited('A11', 'carol', 'alice', PAYROLL, `return await tools.${PAYROLL}({})`, p);
    // The Audit Log page's own table (GET /api/audit/invocations) as alice.
    const page = await api('alice', 'GET', '/api/audit/invocations?status=ERROR&limit=50');
    const onPage = (page.json || []).filter((r) => r.tool?.name === PAYROLL && String(r.error || '').startsWith('REFUSED '));
    out.evidence.push(`Audit Log page (A, as alice): ${onPage.length} REFUSED payroll row(s)`);
    return { p, ...out };
  },

  async A12() {
    const p = await ping('bob', 'A12');
    const cloud = (process.env.DEPLOYMENT_MODE || '').toLowerCase() === 'cloud';
    if (!cloud) return { p, pass: null, evidence: ['n/a (self-hosted; no Host scripts built)'] };
    return { p, pass: null, evidence: ['n/a (no Host scripts built)'] };
  },

  async A13() {
    const p = await ping('bob', 'A13');
    const canary = state.canaries.connectors?.B?.erp;
    const logOffset = backendLogSize();
    const inline = await script('bob', { code: `return typeof env === 'undefined' ? 'no env' : (env.MOCK_ERP_TOKEN ?? 'no var')` });
    const evidence = [`inline: ${short(inline.ok ? inline.result : inline.code)}`];
    let pass = inline.ok && !inline.raw.includes(canary);
    let injected = false;
    const bound = await withBoundScript(
      'bob',
      'A13',
      `await tools.mock_erp_ping({ nonce: 'a13-bound' });
       if (typeof env === 'undefined') return 'no env';
       console.log('token', env.MOCK_ERP_TOKEN);
       return { token: env.MOCK_ERP_TOKEN ?? 'no var', inText: 'Bearer ' + env.MOCK_ERP_TOKEN };`,
      { env: true },
      async (run) => run,
    );
    if (bound.unavailable) evidence.push(`bound script: n/a (${bound.unavailable})`);
    else {
      injected = bound.ok && bound.result && bound.result !== 'no env';
      evidence.push(`bound(ERP,env) output: ${short(bound.ok ? bound.result : `${bound.code} ${bound.message}`, 90)}; logs: ${short(bound.meta?.logs, 60)}`);
      if (bound.raw.includes(canary)) {
        evidence.push('FAIL: canary in output');
        pass = false;
      }
      if (injected && bound.result?.token !== '***') pass = false;
    }
    // The stored run (resultPreview) for the "audit" part.
    const runs = await api('bob', 'GET', `/api/sandbox/servers/${state.workspaces.B.serverId}/runs`);
    const inRuns = JSON.stringify(runs.json ?? '').includes(canary);
    await sleep(500);
    const logText = backendLogSince(logOffset);
    const inLog = logText === null ? null : logText.includes(canary);
    evidence.push(`canary in stored runs: ${inRuns}; in backend log: ${inLog === null ? 'log unreadable' : inLog}`);
    if (inRuns || inLog) pass = false;
    if (!injected) evidence.push('no injection → nothing to mask');
    return { p, pass, evidence };
  },
};

// ---- main ---------------------------------------------------------------------

const selected = opts.cards.length ? opts.cards : Object.keys(CARDS);
const unknown = selected.filter((c) => !CARDS[c]);
if (unknown.length) throw new Error(`unknown card(s): ${unknown.join(', ')}`);

console.log(`CODEBOUND attack cards against ${BASE} (kit: ${opts.kit})`);
const results = [];
for (const card of selected) {
  process.stdout.write(`  ${card} … `);
  let out;
  try {
    out = await CARDS[card]();
  } catch (err) {
    out = { p: null, pass: false, evidence: [`ERROR: ${err?.stack?.split('\n')[0] || err}`] };
  }
  // A card that never showed up in the mock log did not run.
  if (out.p && !out.p.ran) {
    out.pass = false;
    out.evidence.unshift(`FAIL: ping not found in mock log (${short(out.p.res?.text, 60)})`);
  }
  const verdict = out.pass === null ? 'N/A' : out.pass ? 'PASS' : 'FAIL';
  console.log(verdict);
  log(...out.evidence);
  results.push({ card, ran: out.p?.ran ? `seq ${out.p.seq} (${out.p.tenant})` : 'no', verdict, evidence: out.evidence });
}

// Table: card · ran(ping seq) · verdict · evidence
const head = ['card', 'ran (ping seq)', 'verdict', 'evidence'];
const w0 = Math.max(4, ...results.map((r) => r.card.length + (KNOCKOUT.has(r.card) ? 2 : 0)));
const w1 = Math.max(head[1].length, ...results.map((r) => r.ran.length));
const w2 = 7;
const line = (a, b, c, d) => `${a.padEnd(w0)} · ${b.padEnd(w1)} · ${c.padEnd(w2)} · ${d}`;
console.log('');
console.log(line(...head));
console.log(`${'-'.repeat(w0)}-+-${'-'.repeat(w1)}-+-${'-'.repeat(w2)}-+-${'-'.repeat(40)}`);
for (const r of results) {
  const [first, ...rest] = r.evidence;
  console.log(line(KNOCKOUT.has(r.card) ? `${r.card} *` : r.card, r.ran, r.verdict, first ?? ''));
  for (const e of rest) console.log(line('', '', '', e));
}
console.log('\n* knock-out card');

const failedKnockouts = results.filter((r) => KNOCKOUT.has(r.card) && r.verdict !== 'PASS');
if (failedKnockouts.length) {
  console.log(`Knock-out card(s) failing: ${failedKnockouts.map((r) => r.card).join(', ')}`);
  process.exit(1);
}
