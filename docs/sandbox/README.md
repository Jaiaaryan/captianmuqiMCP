# Code mode for AnythingMCP: review notes

Written for the Codebound hackathon brief *"Sandbox for AI Agents in AnythingMCP"*
(KOCH Freiburg GmbH). This page says what was there, what was added, how it helps, and
where it is still limited. Every number below comes from a run on this branch; the ones
that are estimates say so.

**Reference docs:** [sandbox-code-mode.md](../sandbox-code-mode.md) (how to use and
configure it) · [demo and benchmark](../../scripts/sandbox-demo/README.md) ·
[end-to-end checks](../../scripts/sandbox-e2e/README.md)

---

## In one minute

- **The problem (from the brief):** about 1 in 8 tool calls returns more than 50 KB, the
  biggest 44 MB. All of it goes through the model, which is slow, expensive, and often
  does not fit at all.
- **What was built:** an agent can send a short JavaScript script instead. It runs in an
  isolated V8 sandbox *inside* AnythingMCP, next to the connectors. The script calls the
  same tools, filters and sums the data there, and **only the small answer goes back to
  the model**.
- **Does it work:** on a real running stack, a question over 150,000 orders was answered
  by **one call returning 354 bytes** instead of 77 calls and 7.3 MB; a 44 MB response
  was reduced to a **34-byte** answer. The answers equal an independently computed ground
  truth.
- **Is it safe:** 81 end-to-end checks pass (two customers, 18 escape attempts, limits,
  roles, secrets, audit), plus a 20-case isolation suite you can run from the dashboard.
  Scripts are **read-only by default**. One honest limit: the isolate is a V8 boundary
  inside the backend process, not an operating-system boundary (see
  [Security](#security-what-is-and-is-not-guaranteed)).
- **Can you see it:** yes, a new **Code mode** page in the dashboard
  ([screenshots](#screenshots)).
- **Scripts know their connectors:** each saved script records the connectors and tools it
  uses, shows them as a pin with a tooltip, can be filtered by connector, is offered to an agent
  only on a server that has all of them, and may call only the tools it declared
  ([details](#scripts-and-their-connectors)).

---

## What the brief asks, and where it is answered

> *"A working script can be created, edited, and executed within the sandbox, with no
> access to other customers' data, the internet, or the host."*

| Requirement | How it is met | Evidence |
|---|---|---|
| **Create** a script | `sandbox_create_script` (MCP), `POST /api/sandbox/servers/:id/scripts`, or the *New script* button. The code is syntax-checked on save. | [04](#4-a-script-that-uses-two-connectors) · e2e group `scripts` |
| **Edit** a script | `sandbox_edit_script`, `PATCH /api/sandbox/scripts/:id`, *Edit* in the page. Only the author can edit; the version goes up. | e2e `scripts` · unit tests |
| **Execute** a script | `sandbox_run_script` (MCP), `POST .../run`, *Run* in the page. Runs in a fresh isolate with limits on time, memory, calls and bytes. | [03](#3-run-it-the-data-flow-line) · e2e `core`, `limits`, `deadlines` |
| **No other customers' data** | Tenant and user come from the authenticated session on the host; a script cannot choose them. Every query filters by `organizationId`. Two customers with *same-named tools* are kept apart. | e2e group `tenant` (10 checks) |
| **No internet** | The isolate has no `fetch`, sockets, timers or modules. The only way out is `tools.<name>`, which goes through the gateway's normal connector path. | isolation suite · e2e `isolation` |
| **No host access** | No `require`, `process`, file system or environment inside the isolate; credentials never enter it. 18 attempts to escape (constructor chains, prototype tricks, `import()`, `WebAssembly`, …) all fail. | [10](#10-the-isolation-suite) · e2e `isolation`, `secrets` |

---

## What existed, what was added

**Starting point.** AnythingMCP is an open-source gateway that turns APIs and databases
into MCP tools. Commit `0e24d7f` (yours) had already added the core of code mode: the
`isolated-vm` runtime, the four MCP tools, saved scripts with their tables and
migration, limits, errors, and about 1,700 lines of tests.

**Added on top, in six steps** (about 7,700 lines changed in the first five, 60 files):

| Commit | What it added |
|---|---|
| `d74f237` | Documentation of the feature and its `SANDBOX_*` settings. |
| `f94fce4` | The **REST API** under `/api/sandbox` that the dashboard uses; the **live isolation suite** (20 cases); one shared rule for "which tools can this caller see" so MCP and REST cannot disagree. |
| `721da23` | **Security hardening** (see below). |
| `9927761` | An opt-in **`maxRows`** setting for database connectors, a **150,000-order demo** with ground truth, a **benchmark**, and the **75-check end-to-end suite**. |
| `79e4465` | The **dashboard page** and its Playwright test. |
| later | **Scripts and their connectors**: organization-wide scripts that declare the connectors and tools they use (see [below](#scripts-and-their-connectors)). |

### The hardening, in plain words

These came from a security review of the first version. Each has tests.

1. **Read-only by default.** A script can only call tools that cannot change data
   (GET/HEAD, GraphQL queries, read-only database connectors, provable `SELECT`).
   Writes fail with `WRITE_NOT_ALLOWED` before the connector is touched. An operator can
   switch writes on with `SANDBOX_ALLOW_WRITES=true`; no agent or script can.
2. **Arguments are validated on the host** against each tool's input schema, like a
   direct call, so a script cannot send a shape the tool never accepted.
3. **Access is re-checked for every run**, so a role change applies to the next script,
   not the next session.
4. **A deadline for every connector call** (and for the whole run), so a slow upstream
   cannot hold the isolate; **cancellation** if the client disconnects.
5. **A size cap on each connector response** *before* it is copied into the sandbox.
6. **Audit link:** every connector call a script makes is logged as a normal tool call
   and carries the **run ID**, so you can go from a run to its calls and back.
7. **Per-user run history:** a run keeps a preview of what the connectors returned, so
   non-admins see only their own runs.

---

## Scripts and their connectors

A follow-up, built to this brief: *scripts record which connectors and tools they use; show it
on the cards and in the opened script; the same when an agent or a person creates one; filter the
list by connector; and expose a script to an agent only if the MCP server has all the connectors it
uses.*

| Asked for | Done |
|---|---|
| Store the connectors a script operates on, several allowed | A script declares its connectors; a new table `sandbox_script_tools` holds one row per connector and tool |
| Store which tools of each connector it uses | Same table; a saved script can call **only the tools it declared** (enforced at run time, so the record cannot understate what it does) |
| Show it on the card as a pin, tools in a tooltip, and in the opened script | A pin with the connector count on each card (hover or keyboard focus opens a tooltip with the tools); a *Connectors & tools* block in the opened script ([02](#2-hover-a-pin-the-connectors-and-tools), [01](#1-saved-scripts)) |
| Same when a script is created, by an agent or by hand | A person ticks connectors and tools in the editor ([04](#4-a-script-that-uses-two-connectors)); an agent passes `tools: [...]` to `sandbox_create_script` / `sandbox_edit_script`; and on every save the host also reads the code and adds the tools it calls |
| Filter the list by connector, checkboxes, in a pop-up | **Filter** opens a pop-up with a checkbox per connector; *Apply* filters ([06](#6-the-filter-pop-up), [07](#7-after-apply)); several ticked connectors show scripts that use **any** of them |
| Expose a script to an agent if and only if the server has all its connectors | `sandbox_list_scripts` lists only such scripts; `sandbox_run_script` and `sandbox_edit_script` answer "not found" for the others; the dashboard marks them *Not on this server* and refuses to run them (REST `409`) |

Decisions taken with you: scripts became **organization-wide** (they were per server, which made the last
rule meaningless); declarations are **checked and enforced**, not just labels; the filter is **any-of**.

Behaviour worth knowing:

- A connector or tool that does not exist, or belongs to another customer, **cannot be declared**.
- If a **connector is deleted**, scripts that used it keep needing it: they show it as *removed* and are
  offered on no server.
- Upgrading an existing installation migrates its scripts (duplicate names get a short suffix; each
  script's tools are read from its code once). Tested on the real database and on an empty one.
- Code that picks a tool by a **computed name** (`tools[kind]`) cannot be read from the text; the save
  says so and the tool has to be declared by hand.
- **Limits:** if two connectors of one server have a tool of the same name, only the first can be called from
  a script (as before).

---

## How it works

```
 AI agent ──MCP──▶ AnythingMCP gateway
                      │  sandbox_run_script(code)
                      ▼
              ┌─────────────────────┐     tools.erp_orders_list({...})
              │  V8 isolate         │ ───────────────────────────────┐
              │  your script        │                                │ host checks: caller's tools,
              │  no fs / net / env  │ ◀──────── rows (copied in) ────┘ read-only, args, size, time
              └─────────────────────┘
                      │  small JSON answer
                      ▼
                 back to the model       (the rows never left the gateway)
```

The script is the body of an async function with `tools.<name>(args)`, `args`, a few
`util` helpers and `console.log`. Example (the demo's first question):

```js
const res = await tools.erp_orders_export({ from, to });
const late = res.rows.filter((o) => o.delivered_at && o.delivered_at > o.promised_at);
return { delayedOrders: late.length, revenue: util.sum(late, (o) => o.total) };
```

---

## How it improves things: measured

Demo: an ERP database with **150,000 orders and 450,000 order lines** (29 MB), exposed
through a read-only database connector, as it would be in AnythingMCP. Three questions,
each answered three ways against the running gateway (median of 3 runs;
[`last-benchmark.json`](../../scripts/sandbox-demo/last-benchmark.json)):

| | Conventional (every row via the model) | Raw SQL by the agent | **Code mode** |
|---|---|---|---|
| **Q1** delayed orders last month + revenue | 1 call, 192 KB, ~49,000 tokens | 1 call, 104 B | **1 call, 354 B, ~89 tokens** |
| **Q2** revenue by category, last quarter | **77 calls, 7.3 MB, ~1.9 M tokens** (does not fit a 200k window) | 1 call, 605 B | **1 call, 535 B, ~134 tokens** |
| **Q3** top 10 customers by delay days | 10 calls, 2.1 MB, ~549,000 tokens (does not fit) | 1 call, 1.2 KB | **1 call, 1.1 KB, ~287 tokens** |
| Bytes to the model vs conventional | | | **−99.82% / −99.99% / −99.95%** |

The 44 MB case from the brief (dashboard *Benchmark* tab, [screenshot 12](#12-the-44-mb-case)):
the raw call puts **57 MB (~15 million estimated tokens)** in front of the model; the
script returns **34 bytes** after pulling 45 MB inside the gateway: **about 1.8 million
times smaller**.

**How to read this honestly**

- *Measured:* number of calls, bytes of MCP response text that reach the model, wall
  time, and whether each answer equals the ground truth (all do).
- *Estimated:* tokens, as bytes ÷ 4. No tokenizer and no language model was run, so how
  well a model reads the conventional pages is **not** measured.
- Against an agent that can aggregate in SQL, code mode's answers are equally small, and
  it is **slower** (84 to 546 ms against 38 to 101 ms) because rows cross the bridge.
  Its niche is data sources that cannot aggregate (REST, SOAP, OData) and logic that
  spans several connectors, which is most of what AnythingMCP connects.
- There was **no live LLM run** in these tests. Calls were made by scripts that stand in
  for the agent. The MCP surface itself is covered by the integration tests, which use
  the official MCP client against the real server.

---

## Screenshots

Taken from the real dashboard against the real stack by
[`scripts/sandbox-demo/screenshots.mjs`](../../scripts/sandbox-demo/screenshots.mjs).
The script fails on any browser console error, and none occurred.

### 1. Saved scripts
The scripts of the organization, a pin on each card with its connector count (amber when the
selected server lacks one), and the opened script's *Connectors & tools*.

![Scripts tab](screenshots/01-scripts.png)

### 2. Hover a pin: the connectors and tools
The tooltip lists each connector and the tools the script calls. It also opens from the keyboard.

![Pin tooltip](screenshots/02-pin-tooltip.png)

### 3. Run it: the data-flow line
The line that matters: *pulled 1.17 MB from the connectors, returned 79 B to the model.*
Answer: 922 delayed orders, which equals the ground truth.

![A script run](screenshots/03-script-run.png)

### 4. A script that uses two connectors
Written in the page, with the connectors and tools ticked in *Connectors & tools*.

![New script with the picker](screenshots/04-new-script-picker.png)

### 5. Saved, but this server cannot run it
The demo server has the ERP but not the shop, so the page says which connector is missing and does not
offer *Run*. An agent on this server is not offered the script either.

![Needs a connector this server lacks](screenshots/05-script-needs-a-connector.png)

### 6. The filter pop-up
A checkbox per connector, with how many scripts use it. Nothing changes until *Apply*.

![Filter pop-up](screenshots/06-filter-dialog.png)

### 7. After Apply
Only scripts that use a ticked connector are listed; the chip and the count on *Filter* show it is on.

![Filtered list](screenshots/07-filtered.png)

### 8. On a server that has both connectors, it runs
The same script on a server with both connectors: it runs, and both tools are reported.

![Two connectors run](screenshots/08-two-connectors-run.png)

### 9. Run history
Every run is recorded with code, arguments, result preview and connector calls.

![Runs tab](screenshots/09-runs.png)

### 10. The isolation suite
The "judges' screen": 20 attempts to leave, exhaust or bypass the sandbox, each passing
only if it is stopped **for the right reason**.

![Isolation tests](screenshots/10-isolation.png)

### 11. Benchmark
One raw tool call against a script that answers the same question.

![Benchmark](screenshots/11-benchmark.png)

### 12. The 44 MB case

![Benchmark at 44 MB](screenshots/12-benchmark-44mb.png)

### 13. A viewer is read-only
Viewers can read scripts but cannot run or change them.

![Viewer](screenshots/13-viewer-read-only.png)

### 14. On a phone

![Phone, scripts](screenshots/14-phone-scripts.png)

![Phone, isolation tests](screenshots/15-phone-isolation.png)

---

## Security: what is and is not guaranteed

| Concern | Stopped by | Layer |
|---|---|---|
| Reading host files, environment, secrets | No `require`/`process`/fs/env in the isolate; credentials never enter it | V8 isolate |
| Internet or internal network | No `fetch`/sockets/timers; only `tools.*` leaves | V8 isolate |
| Another customer's data | Tenant/user fixed on the host from the session; `organizationId` on every query | Application |
| A tool the caller may not call | Caller's own role-filtered list, re-read every run, re-checked every call | Application |
| Changing data | Read-only policy checked on every call | Application |
| Loops, memory, floods | Wall clock, heap cap, call/byte caps, per-call timeout, per-org concurrency, output cap | Isolate + application |
| **A bug in V8/`isolated-vm` that escapes the isolate** | **Not prevented by this feature** | OS / infrastructure |

The last row is the main limit. The isolate shares the backend's process and user. For
hostile script authors, run the backend in a locked-down container or VM (non-root,
read-only file system, only the network and database access it needs) and keep Node and
`isolated-vm` current. `SANDBOX_ENABLED=false` removes the feature.

Also known: the existing audit logger redacts credentials that come from environment
variables but **not** a token written literally into a connector's configuration. That
predates this work and applies to every tool call; it is noted in the docs.

---

## How it was checked

All on this branch; commands run from the repository root unless stated.

| Check | Result |
|---|---|
| Backend unit + integration tests (`npx jest` in `packages/backend`) | **20,092 passed, 0 failed** (1,449 live-only tests skipped) |
| Backend `tsc --noEmit` and `eslint` (no `--fix`) | no errors; the 14 lint warnings are in older files ([details](#final-results)) |
| Sandbox-related suites on **Node 22** (this machine, `isolated-vm` built from source) | 10 suites, **276 / 276** |
| The same on **Node 24.22 and 26.12** (glibc) with `isolated-vm`'s shipped prebuilds | **276 / 276** each |
| The same on **Alpine 3.22 / musl, Node 24.22 and 26.12** (a chroot, official musl Node builds) | **253 / 253** each ¹ |
| Real-stack end-to-end ([`scripts/sandbox-e2e`](../../scripts/sandbox-e2e)): real JWT guard, roles, Postgres, local mock upstreams | **81 / 81** (6 new for connectors and tools) |
| Isolation suite, live, from the dashboard | **20 / 20** |
| Frontend `tsc`, `eslint` and the whole Playwright suite (`next dev`, mocked API) | `tsc` clean; no `eslint` warnings in the new files (26 existing ones elsewhere); Playwright **202 / 202**, 14 of them in `tests/e2e/sandbox.spec.ts` |
| Screenshot run against the real stack | 15 pictures, no console errors |

¹ 253 rather than 276: the one spec left out tests the SQLite driver (`better-sqlite3`),
whose binary in this workspace is built for glibc. It passes on glibc Node 24 and 26.

### Runtimes tested

- `isolated-vm` 7 declares **Node ≥ 24**. This workspace runs Node 22 (the repository's
  own minimum is 22.12); the suites pass there too, with a locally compiled binary.
- The package ships prebuilt binaries for Node 24 (ABI 137) and 26 (ABI 147), for glibc
  **and musl**, x86-64 and arm64. The project's `Dockerfile` uses `node:26-alpine`, which
  is the musl/ABI-147 combination tested above.
- These runtime runs were made **before** the connectors-and-tools change. That change is TypeScript
  and a SQL migration, with no native code, and was tested on Node 22 only; it was not repeated on
  Node 24/26 or Alpine.
- **Not tested:** arm64 (no machine for it), and the actual `docker build` (no Docker
  daemon in this environment; the Alpine chroot stands in for the musl part). The musl
  check ran the sandbox suites, not the entire application.

The end-to-end checks, by group (the 75 of the first version plus `connectors` 6): `core` 3, `scripts` 2, `read-only` 5, `isolation` 18,
`limits` 13, `deadlines` 4, `tenant` 10, `roles` 7, `secrets` 4, `audit` 4, `big` 5.

### Final results

Run on this branch with Node 22.22, in `packages/backend`:

| Command | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | exit 0, no errors |
| `npx eslint "{src,apps,libs,test}/**/*.ts"` (no `--fix`, as in CI) | 0 errors, 14 warnings, **none in files this work added or changed** (they are in `sso.service.spec.ts`, `users.controller.ts`, `app.module.ts` line 1 and similar, all older) |
| `npx jest` (whole backend) | **670 suites passed, 4 skipped; 20,092 tests passed, 1,449 skipped, 0 failed.** The skipped tests are the live-service specs that need `RUN_<NAME>_LIVE=1` and real credentials |

Nothing failed, and no failure was left out. The skipped live specs were not run.

---

## Differences from the plan, and decisions taken

The implementation plan (`CODEBOUND_SPEC.md`) and a later security review were followed
where possible. Where this branch differs:

| Plan said | What was done | Why |
|---|---|---|
| Audit rows with `toolId: 'sandbox_run_script'` | Runs are in `sandbox_runs`; their **ID is stored on each connector call's audit row** (`clientInfo.sandboxRunId`) | `toolId` is a required foreign key to a real tool; `sandbox_run_script` is not a row in that table |
| Run history for the organization | **Per user** (admins see all) | A run keeps a preview of connector results; one user must not read another's, whose tool access may differ |
| Demo seed as a Prisma script (`prisma/seed-sandbox-demo.ts`) | A REST-driven script (`scripts/sandbox-demo/seed.mjs`) | The running gateway registers tools live, and it works on any instance |
| Docs file name | `docs/sandbox-code-mode.md` | Matches the existing docs |
| A script belongs to one MCP server | A script belongs to the **organization** and declares its connectors and tools | You asked that a server offer a script only if it has all the script's connectors; that is only meaningful if a script is not tied to one server |
| Benchmark may call any tool | The raw call is **read-only tools only** | A benchmark must not change data |
| A big "−99.8% bytes" number on the benchmark | Shown as a **factor** ("1.8 million× smaller") once the gap passes 10×; the percentages stay beside it | Past 99.9% a percentage reads "−100%" and says nothing |
| Benchmark card compares the answer with the ground truth | Only the command-line benchmark (`benchmark.mjs`) does; the dashboard card shows both paths' numbers and the script's answer | The dashboard works on any tool and question, and has no ground truth for an arbitrary one |

Decisions taken with your guidance: **first make it work correctly; scale is out of
scope and documented as limits** · **read-only by default**, with write policy left as an
operator setting until you see how AnythingMCP wants to organise it.

---

## Limits: what to know before scaling

Documented in [Known limits](../sandbox-code-mode.md#known-limits). In short:

- Isolates run **inside the backend process**, sharing its CPU and memory; there is no
  worker pool and no separate service.
- Concurrency is capped **per organization** (default 4). There is **no instance-wide
  cap**.
- A large response costs **several times its size** in host memory while it runs (the
  44 MB test raised the backend's resident memory by about 190 MB).
- Each backend instance enforces its own limits; there is no distribution of runs.
- Only SQLite streams database results; the other drivers load the whole result before
  `maxRows` cuts it, so bound the query too.
- Runs are not pruned and keep result previews.
- Tokens are estimated (bytes ÷ 4).
- Not done: a global concurrency cap, run pruning, shared-toolset registration, and a
  `sandbox_describe_tools` tool. They were optional in the plan and do not affect the
  brief's metric.

---

## Try it yourself

```bash
./setup.sh                                  # Local development; see AGENTS.md
# start the backend on :4000 and the frontend on :3000 (npm run dev)
node scripts/sandbox-demo/generate-db.mjs   # the 150,000-order database + ground truth
AMCP_EMAIL=you@example.com AMCP_PASSWORD='...' \
  node scripts/sandbox-demo/seed.mjs        # connector, 5 tools, server "koch-demo", 3 saved scripts
node scripts/sandbox-demo/benchmark.mjs     # the three questions, three ways
```

Then open **Code mode** in the sidebar (Build), choose `koch-demo`, and open *Scripts*,
*Isolation tests* or *Benchmark*. To connect a real agent, use
`http://localhost:4000/mcp/<serverId>` with the API key printed by the seed; it will see
`sandbox_run_script` and its three companions next to the data tools.

To redo the pictures: `node scripts/sandbox-demo/screenshots.mjs` (needs the same
admin login; see the header of that file). To redo the end-to-end checks, follow
[`scripts/sandbox-e2e/README.md`](../../scripts/sandbox-e2e/README.md), on a throwaway
database.

---

## Where things are

| Area | Location |
|---|---|
| Runtime, bridge, limits, errors | `packages/backend/src/sandbox/` |
| REST API | `sandbox-api.controller.ts` (+ `.module.ts`) |
| Isolation suite | `sandbox/isolation-suite.ts` |
| One rule for "tools this caller sees", read-only classification | `packages/backend/src/mcp-server/visible-tools.ts` |
| `maxRows` | `packages/backend/src/connectors/engines/database.engine.ts` |
| Dashboard page | `packages/frontend/src/app/sandbox/` |
| Demo, benchmark, screenshots | `scripts/sandbox-demo/` |
| End-to-end checks | `scripts/sandbox-e2e/` |
| User documentation | `docs/sandbox-code-mode.md` |
