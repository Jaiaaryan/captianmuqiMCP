# CODEBOUND attack cards (A1-A13)

A runnable port of the kit's attack cards (`cards/CARDS.md` in the CODEBOUND
kit) to the AnythingMCP script API. Plain Node ESM, no dependencies, Node 22 or
later.

## Run

Prerequisites: the kit's `codebound setup` has run against this instance (it
writes `.codebound/state.json` with the users alice, carol and bob, their MCP
keys and passwords, workspaces A and B, the canaries and the mock URLs), the
kit's mocks are up (mock log on `127.0.0.1:4180`, outside host log on
`127.0.0.1:4181`), and the backend is running.

```bash
node scripts/codebound-cards/run.mjs                      # every card
node scripts/codebound-cards/run.mjs --card A1 --card A5  # some cards
node scripts/codebound-cards/run.mjs --card A1,A2,A11 --verbose
```

Options:

| Option | Default | Meaning |
|---|---|---|
| `--kit <dir>` | `/tmp/codebound-kit-src/codebound-kit` | Kit directory holding `.codebound/state.json` |
| `--url <url>` | `state.url` (env `AMCP_URL` overrides) | AnythingMCP backend |
| `--backend-log <file>` | `/tmp/amcp-backend.log` | Backend log searched for the A13 canary |
| `--mock-admin <url>` | `http://127.0.0.1:4180` | Mock log |
| `--outside-admin <url>` | `http://127.0.0.1:4181` | Outside host log |
| `--card <id>` | all | Repeatable, or comma-separated |
| `--verbose` | off | Print evidence as each card runs |

The output is a table `card · ran (ping seq) · verdict · evidence`. The exit
code is 1 when a knock-out card (A1, A2, A3, A5, A6, A7) fails or did not run.

The suite calls tools through the per-server MCP endpoint
(`/mcp/<serverId>` with `X-API-Key`), exactly as an agent would. It logs in
over REST once per user that needs a dashboard token (bob, and alice for A7
and A11); login is limited to 5 per minute, and the runner waits out a 429.

## How every card runs

1. **Proof that it ran.** The card calls `mock_erp_ping { nonce }` as its user
   and finds that nonce in the mock log. The `ran` column shows the log
   sequence number and the tenant the mock saw. A card whose ping is missing
   from the log fails.
2. **The attack**, through `tools/call` and `sandbox_run_script`.
3. **The verdict**, with the evidence it is based on.

Cards that need a Level 3 script (one with `env` or `http`) create a temporary
saved script in bob's workspace B over REST
(`POST /api/sandbox/servers/<serverId>/scripts`), bound to the Mock ERP only
(`uses: [{ connectorId: <B erp>, tools: ["mock_erp_ping"] }]`), run it by name
over MCP, and delete it afterwards. When the instance refuses the
capabilities, the card says so and judges the inline run only ("blocked by
construction").

## The cards

| Card | Who | What the card does | Passes when |
|---|---|---|---|
| A1 | bob @ B | `tools/call mock_payroll_list_salaries` (a tool of workspace A only), and a script `return await tools.mock_payroll_list_salaries({})` | Both are refused, no payroll request reaches the mock, and B's audit log (`GET /api/audit/refusals` as bob) has a refusal row for each: the direct one (no run id) and the script one (with the run id the script returned) |
| A2 | bob @ B | The same with A's internal tool id (`state.workspaces.A.toolIds`) as the name, and `tools['<id>']` in a script | Same as A1 |
| A3 | bob @ B | Inline script `typeof env`; then a saved ERP-only script with `env` that returns `Object.keys(env)` | Inline: `absent`. Bound: only the ERP's variables, no supplier, carrier, payroll or host variable, and no canary value of another connector in the output |
| A4 | bob @ B | `http.fetch('http://169.254.169.254/latest/meta-data/')` inline and from a saved ERP-only script with `http` | Inline has no `http` (blocked by construction), and the bound script gets an error |
| A5 | bob @ B | `http.fetch` to the outside host by name and by IP, inline and from a saved ERP-only script; the bound script also tries the carrier mock | Every request is refused, the outside host log (`:4181`) gets no new entry, and the carrier mock gets no request |
| A6 | bob @ B | `typeof process/require/Deno/Bun`, `globalThis.CODEBOUND_HOST_CANARY`, a `Function`-constructor escape, `import('fs')`, and `http.fetch('file://<hostFilePath>')` | Everything is undefined or refused, and neither host canary (`canaries.hostEnv`, `canaries.hostFile`) appears in any output |
| A7 | alice @ A, then bob @ B | alice's script probes for filesystem APIs and leaves a marker on its global object, and alice saves a script holding the marker; bob's script looks for the marker, bob lists and tries to run alice's script | No filesystem API exists (no filesystem by construction), bob sees no marker and cannot see or run A's script. alice's script is deleted afterwards |
| A8 | bob @ B | `while (true) {}` with a 3 s limit | `TIMEOUT`, and the next call works |
| A9 | bob @ B | Allocates arrays until something breaks | `MEMORY_LIMIT` or `TIMEOUT`, and the next call works |
| A10 | bob @ B | Calls `mock_erp_ping` up to 1,000,000 times in a loop | `CONNECTOR_CALL_LIMIT` naming the limit, no more pings than the limit reach the mock, and the next call works |
| A11 | carol @ A | As A1, as carol, whose role (Staff) forbids payroll | Same as A1, in A's audit log (read as alice); the Audit Log page's table (`GET /api/audit/invocations`) is also checked for a `REFUSED` payroll row |
| A12 | | Host scripts | Not applicable: no Host scripts are built (in either deployment mode) |
| A13 | bob @ B | Inline `env.MOCK_ERP_TOKEN`; then a saved ERP-only script with `env` that returns and logs the token | Output and log lines show `***`, and the canary `canaries.connectors.B.erp` is in neither the stored runs (`GET /api/sandbox/servers/<id>/runs`) nor the backend log written during the card. Without injection the verdict is "no injection, nothing to mask" |

## Where refusals are recorded

A refusal is written to the audit log of the caller's workspace by
`AuditService.logRefusal`: a `tool_invocations` row (status `ERROR`, error
`REFUSED <code>: <reason>`) when the tool exists in the caller's workspace, or
otherwise a `TOOL_REFUSED` security event. `GET /api/audit/refusals` lists
both. See "Audit of refusals" in `docs/sandbox-code-mode.md`.

A direct `tools/call` for a tool that is not registered for the caller is
answered by the MCP SDK inside the endpoint controller, before the executor
runs. That refusal is audited only once the controller calls
`DynamicMcpTools.auditRefusedCall(body, handles, invocationContext)` after it
registers the tool set; until then the A1, A2 and A11 cards fail on "direct
refusal NOT in audit log".
