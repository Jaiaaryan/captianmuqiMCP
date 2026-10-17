#!/usr/bin/env node
// Puts the CODEBOUND scripts (and the settings they need) onto the test bed that the kit's
// `setup` created, so `check` has something to call.
//
//   node scripts/codebound/seed.mjs --kit ../codebound-kit
//   node scripts/codebound/seed.mjs --state /path/to/.codebound/state.json
//
// It reads the kit's state file (urls, logins, workspace ids), signs in as each workspace's
// administrator through the normal REST API, and:
//
//   1. marks the lookups that are POSTs as read-only tools (the supplier takes its SKUs in the
//      body), so a read-only script may call them;
//   2. puts a Response Processing chain on mock_supplier_list_offers (Level 1): dollars to euros,
//      VAT, clean descriptions, and a loud stop on a price that is not a number;
//   3. saves the scripts of scripts.mjs on the workspace's CODEBOUND MCP server. A script with
//      typed parameters is offered to agents as a tool of its own name; supplier_account (Level 3)
//      also gets the connector's variables and direct requests to the connector's own host.
//
// It is safe to run again: scripts that exist are updated, never duplicated. No dependencies.

import fs from 'node:fs';
import path from 'node:path';
import { SCRIPTS, READ_ONLY_POST_TOOLS, PROCESSED_TOOL, OFFER_CHAIN } from './scripts.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--kit') out.kit = argv[++i];
    else if (a === '--state') out.state = argv[++i];
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`Unknown argument ${a}. Try --help.`);
  }
  return out;
}

const HELP = `Usage: node scripts/codebound/seed.mjs [--kit <kit dir> | --state <state.json>] [--url <backend url>]

  --kit    the codebound-kit checkout; its .codebound/state.json is read (default: ./.codebound or
           the CODEBOUND_STATE_DIR environment variable)
  --state  the state file itself
  --url    backend base URL, if it differs from the one in the state file`;

function stateFile(args) {
  if (args.state) return path.resolve(args.state);
  if (args.kit) return path.resolve(args.kit, '.codebound', 'state.json');
  return path.resolve(process.env.CODEBOUND_STATE_DIR || '.codebound', 'state.json');
}

class ApiError extends Error {
  constructor(method, route, status, body) {
    super(`${method} ${route} -> HTTP ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`.slice(0, 500));
    this.status = status;
  }
}

async function http(base, method, route, { token, body } = {}) {
  // Login and a few auth routes are limited to 5 a minute; wait out a 429 instead of failing.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(base + route, {
      method,
      headers: {
        accept: 'application/json',
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...(token && { authorization: `Bearer ${token}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let parsed = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* keep the text */
    }
    if (res.status === 429 && attempt < 4) {
      console.log('  (rate limited, waiting 20 s)');
      await new Promise((r) => setTimeout(r, 20_000));
      continue;
    }
    if (!res.ok) throw new ApiError(method, route, res.status, parsed);
    return parsed;
  }
}

const list = (r) => (Array.isArray(r) ? r : r?.items || r?.data || []);

/** A client signed in as `user`, working in `workspace`. */
async function signIn(base, user, workspace) {
  const login = await http(base, 'POST', '/api/auth/login', { body: { email: user.email, password: user.password } });
  if (!login?.accessToken) throw new Error(`Login for ${user.email} returned no access token`);
  const sw = await http(base, 'POST', '/api/organizations/switch', {
    token: login.accessToken,
    body: { organizationId: workspace.organizationId },
  });
  const token = sw.accessToken;
  return {
    get: (route) => http(base, 'GET', route, { token }),
    post: (route, body) => http(base, 'POST', route, { token, body }),
    put: (route, body) => http(base, 'PUT', route, { token, body }),
    patch: (route, body) => http(base, 'PATCH', route, { token, body }),
  };
}

/** Every tool of the workspace by name: where it lives and what it currently holds. */
async function indexTools(api) {
  const index = new Map();
  for (const connector of list(await api.get('/api/connectors?limit=100'))) {
    for (const tool of list(await api.get(`/api/connectors/${connector.id}/tools`))) {
      index.set(tool.name, { connectorId: connector.id, connectorName: connector.name, tool });
    }
  }
  return index;
}

async function markReadOnlyTools(api, tools, say) {
  for (const name of READ_ONLY_POST_TOOLS) {
    const found = tools.get(name);
    if (!found) {
      say(`! tool ${name} not found in this workspace (skipped)`);
      continue;
    }
    await api.patch(`/api/connectors/${found.connectorId}/tools/${found.tool.id}/annotations`, {
      annotations: { readOnlyHint: true },
    });
    say(`tool ${name} marked read-only`);
  }
}

async function applyChain(api, tools, say) {
  const found = tools.get(PROCESSED_TOOL);
  if (!found) {
    say(`! tool ${PROCESSED_TOOL} not found in this workspace (skipped)`);
    return;
  }
  // The update replaces the whole response mapping, so keep what the tool already has.
  const responseMapping = { ...(found.tool.responseMapping || {}), responseProcessing: OFFER_CHAIN };
  await api.put(`/api/connectors/${found.connectorId}/tools/${found.tool.id}`, { responseMapping });
  say(`processing chain on ${PROCESSED_TOOL}: ${OFFER_CHAIN.steps.map((s) => s.id).join(' > ')}`);
}

/** `uses` for a script that calls no tool: the connectors of the tools it names. */
function usesFor(script, tools) {
  const byConnector = new Map();
  for (const name of script.declareTools || []) {
    const found = tools.get(name);
    if (!found) throw new Error(`Script ${script.name} declares tool ${name}, which this workspace does not have`);
    byConnector.set(found.connectorId, [...(byConnector.get(found.connectorId) || []), name]);
  }
  return [...byConnector].map(([connectorId, names]) => ({ connectorId, tools: names }));
}

async function saveScripts(api, serverId, tools, scripts, say) {
  const existing = new Map(list(await api.get(`/api/sandbox/servers/${serverId}/scripts`)).map((s) => [s.name, s]));
  for (const s of scripts) {
    const uses = usesFor(s, tools);
    const body = {
      code: s.code,
      description: s.description,
      parameters: s.parameters,
      ...(s.capabilities && { capabilities: s.capabilities }),
      ...(uses.length > 0 && { uses }),
    };
    const found = existing.get(s.name);
    const saved = found
      ? await api.patch(`/api/sandbox/scripts/${found.id}`, body)
      : await api.post(`/api/sandbox/servers/${serverId}/scripts`, { name: s.name, ...body });
    const shown = (saved.uses || []).map((u) => `${u.connectorName}: ${u.tools.join(', ')}`).join(' | ');
    const level3 = saved.capabilities ? `  [${Object.keys(saved.capabilities).filter((k) => saved.capabilities[k]).join('+')}]` : '';
    const notes = (saved.warnings || []).map((w) => `\n      ! ${w}`).join('');
    say(`${found ? 'updated' : 'created'} ${s.name}  (uses ${shown || 'no connector'})${level3}${notes}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(HELP);

  const file = stateFile(args);
  if (!fs.existsSync(file)) {
    throw new Error(`No state file at ${file}. Run the kit's setup first (node harness/cli.mjs setup ...), or pass --kit / --state.`);
  }
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = (args.url || state.url).replace(/\/$/, '');

  for (const [key, workspace] of Object.entries(state.workspaces)) {
    // The workspace's administrator: alice in A, bob in B.
    const user = Object.values(state.users).find((u) => u.workspace === key && u.role === 'ADMIN');
    if (!user) {
      console.log(`Workspace ${key}: no administrator in the state file, skipped`);
      continue;
    }
    console.log(`\nWorkspace ${key} (${workspace.name}) as ${user.email}`);
    const say = (msg) => console.log(`  ${msg}`);
    const api = await signIn(base, user, workspace);
    const tools = await indexTools(api);
    await markReadOnlyTools(api, tools, say);
    await applyChain(api, tools, say);
    await saveScripts(api, workspace.serverId, tools, SCRIPTS, say);
  }
  console.log('\nDone. Next: node harness/cli.mjs check (in the kit).');
}

main().catch((err) => {
  console.error(`\nSeed failed: ${err.message}`);
  process.exit(1);
});
