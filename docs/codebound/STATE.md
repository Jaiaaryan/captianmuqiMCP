# CODEBOUND work on this branch — state map

Read this before touching anything under code mode, Response Processing, Flow,
the demo mode or the attack cards. It replaces exploring: every file, contract,
account and verification command is here. Keep it current when you change
one of them.

## What exists (branch `claude/dazzling-volta-4s880q`)

| Feature | Backend | Frontend | Docs |
|---|---|---|---|
| Response Processing (P1/P2) | `src/response-processing/` (builtins, chain, script-runner, service, controller); hook in `connectors/response-transform.util.ts`; validation on save in `connectors/tools.controller.ts` | `components/tool-editor/response-processing-{panel,step-row,model,styles}`, `path-picker.tsx`, `code-field.tsx`, `status-chip.tsx`, `icon.tsx`, `kbd.tsx`; mounted from `tool-editor/index.tsx` above Response Mapping | `docs/response-processing.md` |
| Scripts as tools (F1) | `SandboxScript.parameters`; `sandbox/script-parameters.util.ts`; `sandbox-tools.ts` emits one tool per script with parameters; `mcp-endpoint.controller.ts` reads them per request | `app/sandbox/script-parameters.tsx` under the code editor | `docs/sandbox-code-mode.md` "Scripts as tools" |
| Level 3 scripts (F5) | `SandboxScript.capabilities {env,http}`; `sandbox/script-http.ts` (origin allowlist → SSRF guard, no redirects), `sandbox/secret-mask.ts` (`***` everywhere); bridge in `sandbox.service.ts` between the `Level 3` markers | — (REST only) | `docs/sandbox-code-mode.md` "Level 3" |
| Refusal audit (A1/A2/A11) | `audit/audit.service.ts logRefusal`, `GET /api/audit/refusals`; called from `sandbox.service.ts refuse()` and `mcp-endpoint.controller.ts` (`toolExecutor.auditRefusedCall`) | Audit Log page shows REFUSED invocations | `docs/sandbox-code-mode.md` "Audit of refusals" |
| Attack cards A1–A13 | — | — | `scripts/codebound-cards/` (`run.mjs`, README) |
| Flow view | `src/flow/` (`GET /api/flow?serverId&since`) | `app/flow/`, `components/flow/` (React Flow 12 + dagre in `layout.worker.ts`) | — |
| Code mode editor | — | `components/code/` (Monaco self-hosted, `monaco-setup/theme/impl/field`, `dts-from-sample`, `dts-from-tools`, `rp-snippets`); `app/sandbox/use-sandbox-data.ts` (fetch once, tabs stay mounted) | — |
| Demo mode | `src/demo/` (config, in-process mock systems on 127.0.0.1:4190, idempotent seeder, `GET /api/public/demo`) | `app/login/demo-accounts.tsx` | `docs/demo-mode.md` |

## Contracts to code against

- Stored chain: `McpTool.responseMapping.responseProcessing = { version:1, enabled, onError:'fail'|'passthrough', steps:[{ id, use:'scale@1'|'offset@1'|'vat@1'|'round@1'|'clean_text@1'|'truncate@1'|'map@1'|'script@1', each?, reads, writes, mode:'add'|'replace'|'upsert', onMissing?, params?, code? }] }`. Script globals: `value` (what `reads` resolved to), `params`, `response` (the whole document). Limits: 32 MB, 250 ms per call, 2000 ms per response, result ≤ 1 MB, code ≤ 16 KB. Error sentence: `step <id>: $.items[3].price_usd is not a number`.
- Script parameters: JSON Schema object `{ type:'object', properties:{name:{type,description?,enum?,items?}}, required:[] }`; `{properties:{}}` = a tool with no parameters; `null` = not a tool. Names inferred from `args.x` / `args['x']` / destructuring.
- Capabilities: `{ env?: boolean, http?: boolean }`, author-only, REST only, never for inline code. `env` = declared connectors' variables; `http.fetch(url,{method,headers,body})` → `{status, headers, text, json?}`, GET/HEAD only unless `SANDBOX_ALLOW_WRITES=true`.
- Flow graph: `packages/frontend/src/components/flow/types.ts` (node ids `agent | server:<id> | connector:<id> | tool:<id> | processing:<toolId> | mapping:<toolId> | script:<id>`).
- Demo: `GET /api/public/demo → { enabled:false } | { enabled:true, accounts:[{email,password,name,role,workspace}], mcp:{A,B} }`. Self-hosted only.

## UI rules (the user's, binding)

Square corners. Grayscale skeleton (`--bg --surface --surface-2 --surface-3 --text --text-2 --text-3`); semantic colour ONLY for state (`--t-danger-*` fail/invalid/error, `--t-warn-*` skip/pass-through/not-in-sample, `--t-success-*` on/valid/added, `--brand` the one primary action). No boxes/borders; inputs show a 1px `--border-strong` bottom line, hover `--surface-2`, focus `--surface-3`. Dropdowns for everything selectable (`AppSelect` with `groups`, `ActionMenu` flat variant). Icons: lucide only, through the 14px `Icon` wrapper (`components/tool-editor/icon.tsx`); never Unicode glyphs. Zero explanatory prose in the UI (nouns, verbs, numbers, codes, paths). Dropdown trees instead of typed paths; raw paths only behind `⋯ → Advanced paths`.

## Local test bed

- Backend http://localhost:4001 (`npm run dev` in packages/backend, Node 22 at `~/.nvm/versions/node/v22.22.3/bin`, log `/tmp/amcp-backend.log`), frontend http://localhost:3001 (`npx next dev --port 3001`), Postgres `amcp-dev-postgres` on 5433. `.env` at the worktree root (gitignored): `SSRF_ALLOWED_HOSTS=localhost`, `SANDBOX_MAX_CONNECTOR_CALLS=200`, `CODEBOUND_HOST_CANARY`.
- Kit: `/tmp/codebound-kit-src/codebound-kit` (mocks via `docker-compose -f compose/mocks.yml up -d`, ports 4101–4104/4180, outside 4199/4181). State and logins in `.codebound/state.json` (alice/carol/bob; workspace A server id, tool ids, keys). Login API is throttled 5/min: log in once per script. Kit users' emails are unverified: in the UI click "Skip for now".
- Dev-server note: `next dev` compiles a route on first visit (10–18 s with Monaco); later loads are 70–150 ms.

## Verify (what "done" means)

```bash
# backend (packages/backend)
npx tsc --noEmit -p tsconfig.json && npm run lint:check && npx jest <paths you touched>
# frontend (packages/frontend)
npx tsc --noEmit -p tsconfig.json && npm run lint
# e2e against the live dev server with system Chrome (config OUTSIDE the repo)
npx playwright test -c /tmp/pw.config.ts response-processing sandbox login-demo
# kit (in /tmp/codebound-kit-src/codebound-kit)
node harness/cli.mjs check            # expect Must 6/6 · Should 1/1 · scans 3/3
# attack cards (worktree root)
node scripts/codebound-cards/run.mjs  # expect A1–A11, A13 PASS; A12 N/A
```
Full backend jest (~6 min) only before a commit, not per task.

## Deploy

amcp.flowerchatting.com deploys from THIS branch (`.github/workflows/deploy-self.yml`; server allowlist `/etc/amcp-deploy/captianmuqimcp.conf BRANCHES=claude/dazzling-volta-4s880q`). Previews are disabled. Push over SSH (`git@github.com:Jaiaaryan/captianmuqiMCP.git`); the HTTPS token lacks the `workflow` scope. First image build compiles isolated-vm and bundles Monaco (~15 min). The user commits and pushes; agents never do.
