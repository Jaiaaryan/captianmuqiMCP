# Sandbox code mode

Code mode lets an AI agent run a short JavaScript snippet **inside AnythingMCP,
next to the data**, instead of pulling every row through the model. The script
calls the MCP server's own tools, filters and aggregates the result in place, and
only the small answer goes back to the model.

Use it when a tool would return a long list and the agent only needs a count, a
sum, a filtered subset, a join or a summary.

Code mode is served only on per-server endpoints (`/mcp/<serverId>`) that the
caller has authenticated to. The shared `/mcp` endpoint and the public
`/mcp/demo` server never offer it.

- [Tools](#tools)
- [What a script can use](#what-a-script-can-use)
- [Who a script runs as](#who-a-script-runs-as)
- [Read-only by default](#read-only-by-default)
- [Saved scripts](#saved-scripts)
- [Connectors and tools of a saved script](#connectors-and-tools-of-a-saved-script)
- [Scripts as tools](#scripts-as-tools)
- [Dashboard and REST API](#dashboard-and-rest-api)
- [Limits and configuration](#limits-and-configuration)
- [Errors](#errors)
- [What is stored](#what-is-stored)
- [Database connectors](#database-connectors)
- [Security model](#security-model)
- [Known limits](#known-limits)
- [Cloud and self-hosted](#cloud-and-self-hosted)

## Tools

Four tools are added to the server's tool list, after the connector tools, and
then one more for each [saved script with parameters](#scripts-as-tools). A
connector tool that already uses one of these names keeps its name and the code
mode tool of that name is not registered.

| Tool | Does |
|------|------|
| `sandbox_run_script` | Runs `code`, or a saved script given as `scriptName`. Optional `args` (exposed to the script as `args`) and `timeoutMs` (1000 to 30000). Provide exactly one of `code` and `scriptName`. |
| `sandbox_create_script` | Saves a named script for the organization. Optional `tools`: the names of the tools it calls. The code is syntax-checked, not executed. |
| `sandbox_edit_script` | Changes a saved script's code, description and/or declared `tools` (a new list replaces the old one). Only the script's author can do this. The version goes up when the code changes. |
| `sandbox_list_scripts` | Lists the saved scripts **this server can run**, with the connectors and tools each uses, version, owner flag (`ownedByYou`) and last run. |

The description of `sandbox_run_script` includes a signature list of the tools
the script may call, so the agent knows the names and parameters without a
second round trip.

## What a script can use

The script is the body of an async function: top-level `await` and `return` work,
and the returned value must be JSON.

`shop_list_orders` below stands for any tool of your server.

```js
const rows = await tools.shop_list_orders({ status: 'delayed', limit: 500 });
const byCarrier = util.groupBy(rows, (r) => r.carrier);
return Object.fromEntries(
  Object.entries(byCarrier).map(([carrier, list]) => [carrier, list.length]),
);
```

| Name | Meaning |
|------|---------|
| `tools.<name>(args)` | Calls one of the MCP server's tools and resolves to its result. `args` must be an object. |
| `tools.list()` | The names of the tools this script may call. |
| `tools.describe(name)` | The description, parameters and output schema of one tool. |
| `args` | The `args` object passed to `sandbox_run_script`. |
| `util.daysAgo(n)`, `util.startOfMonth(date?)`, `util.endOfMonth(date?)` | `YYYY-MM-DD` strings, in UTC. |
| `util.groupBy(rows, keyFn)`, `util.sum(rows, fn?)` | Small helpers for the common aggregations. |
| `console.log`, `info`, `warn`, `error`, `debug` | Collected into `meta.logs` of the result. |

Everything else is absent. The script runs in a bare V8 isolate with no
filesystem, network, `process`, `require`, timers, `Buffer` or WebAssembly, and
it never sees connector credentials: the only way out is `tools.<name>`.

The isolate runs inside the backend process, separated from it at the V8 level
(heap, globals, no shared objects). It is not a separate operating system process
or a container.

## Who a script runs as

A script calls tools with the **caller's own session**:

- The tenant (organization) and user come from the authenticated MCP session. A
  script cannot choose or change them.
- `tools.*` contains only the tools that survived the server's role filter for
  this caller, the same tools they would see in the normal tool list. A tool the
  caller cannot call directly cannot be called from a script either.
  A saved script is narrowed further, to the tools it declared (see
  [Connectors and tools of a saved script](#connectors-and-tools-of-a-saved-script)).
- Each call is scoped to the connector that owns the tool, so two connectors with
  a tool of the same name do not collide.
- The role allow-list is read again at the start of every run, so a role change
  takes effect on the next script, not on the next session.
- Arguments are checked against the tool's own input schema on the host before
  the connector is called, the same as for a direct call. Unknown fields are
  dropped.
- Every connector call is audited as a normal tool invocation, and carries the
  ID of the run that made it (see [What is stored](#what-is-stored)).

## Read-only by default

A script can call **read-only tools only**. This is a policy of the instance, not
something an agent or a script can ask for:

- A tool is read-only when its annotations say so: `GET` and `HEAD` on REST
  connectors, GraphQL queries, OData reads, and database tools whose connector has
  `readOnly: true` or whose SQL is provably a single `SELECT`. Anything else
  (a `POST`, a mutation, a database connector without `readOnly`, an unknown
  kind of connector) counts as a write.
- Write tools are left out of `tools.list()`, and the sandbox's description of the
  available tools does not show them. A script that calls one anyway, or asks
  `tools.describe` about it, gets `WRITE_NOT_ALLOWED`, raised before the connector is
  reached. A script can catch it and carry on reading.
- If a tool has an explicit `readOnlyHint` set by an administrator, that value
  wins over the derived one. Setting it to `true` on a tool that changes data
  lets scripts call it: treat it as a statement of trust.
- The agent can still call a write tool **directly**, outside a script, exactly as
  without code mode; role filters and the client's own confirmations apply.
- An operator can allow writes for the whole instance with
  `SANDBOX_ALLOW_WRITES=true`. It is read on the host at startup. It is not a tool
  argument, a REST field or a script input, so nothing an agent sends can turn it
  on. When it is on, `sandbox_run_script` is announced with `readOnlyHint: false`;
  when it is off, with `readOnlyHint: true` (and `openWorldHint: true` in both
  cases, because the tools it calls reach outside).

## Saved scripts

Saved scripts belong to the **organization**, not to one MCP server: write a script
once and every server that has the connectors it needs can offer it (see
[Connectors and tools of a saved script](#connectors-and-tools-of-a-saved-script)).
Names are lowercase, start with a letter and are 2 to 64 characters of `a-z`,
`0-9`, `_` or `-`; a name is unique per organization.

In the editor, `Tab` in an empty field (name, description, arguments, code) accepts its example; `Shift+Tab` and a field with text keep the usual `Tab`.

A saved script runs with the authority of **whoever runs it**, not of whoever
wrote it. To keep a user with fewer permissions from planting code that a more
privileged user's agent then runs, only a script's author can edit it. Anyone
else saves their own copy under a new name. When a saved script runs, the result
includes `script: { name, version, ownedByYou }` so the caller can see whose code
ran.

## Connectors and tools of a saved script

Every saved script records the connectors it uses and, for each, the tools of it it
calls. The record does three things.

- **It is shown.** On the Code mode page each script card has a pin with the number
  of connectors; hover or focus it for the connectors and their tools. The opened
  script lists them under *Connectors & tools*, and an agent sees them in
  `sandbox_list_scripts`.
- **It decides where the script is offered.** An MCP server offers a script to an
  agent **if and only if the server has every connector the script uses.** On a
  server that lacks one, the script is absent from `sandbox_list_scripts` and
  `sandbox_run_script { scriptName }` and `sandbox_edit_script` answer "not found". A
  script that uses no connector is offered everywhere. The dashboard still lists it,
  marked *Not on this server*, and cannot run it there (REST: `409`).
- **It limits the script.** A saved script can call **only the tools it declared**,
  of those its caller may call anyway. Calling another tool fails with
  `TOOL_NOT_ALLOWED` and a hint to declare it. This is what makes the record
  trustworthy. Code run inline declares nothing and can call every tool its caller
  may.

How the record is made:

- **By a person**, in the editor: *Connectors & tools* lists every connector of the
  organization; tick the tools the script calls (ticking a connector ticks all of
  its tools). The host checks that each connector belongs to the organization and
  has each tool.
- **By an agent**, with `tools: ["tool_name", …]` on `sandbox_create_script` or
  `sandbox_edit_script`, using the names in its tool list. The host finds the
  connector of each. A name that no connector has is an error.
- **From the code**, always: on every save the host reads the code, and adds each
  tool called as `tools.name(...)` or `tools['name']` that was not declared and can
  be matched to exactly one tool. The answer says what was added (`added`) and what
  could not be matched (`warnings`): a name that is on several connectors, a name no
  connector has, or a computed name such as `tools[kind]`, which cannot be read from
  the text and must be declared by hand. Comments and strings are ignored.

Saving a new list replaces the declared tools (and the code's calls are added
again); saving new code with no list keeps what was declared and adds new calls.

If a connector is **deleted**, the script keeps needing it: it shows the connector
as *removed* and is offered on no server, instead of quietly losing the dependency.
Re-creating a connector gives it a new identity, so declare the new one.

Limits: 20 connectors and 100 tools per script. When two connectors of one server
have a tool of the same name, only the first can be called from a script (the same
rule as for every script), so a saved script that needs the other one cannot use it.

## Scripts as tools

A saved script that reads its arguments becomes a tool of its own, so an agent can
call `stuck_orders { days: 30 }` directly instead of
`sandbox_run_script { scriptName: "stuck_orders", args: { days: 30 } }`.

- **The parameters come from the code.** A script that reads `args.days`,
  `args['as_of']` or `const { days, as_of = 'today' } = args` gets a parameter of
  that name for each. Comments and strings are ignored. On every save the host reads
  the code again: a newly found name is added as a required `string`, and a name the
  code no longer reads is dropped.
- **You set what they are.** In the editor, under the code, one table lists the
  parameters. Set each one's **type** (`string`, `number`, `integer`, `boolean`,
  `array`, `object`), whether it is **required** and a **description** the agent
  reads. What you set is kept when the code changes, as long as the code still reads
  the name. To keep a parameter the code does not read (for example one it reads
  through `args[name]`), mark it `"x-keep": true` in the REST `parameters`.
- **Where it is offered.** The script is listed as a tool **of its own name**, next
  to `sandbox_run_script`, on every server that has all the connectors the script
  uses (the same rule as `sandbox_list_scripts`). Its description is the script's
  description, or `Saved script <name> v<version>`. A connector tool or a
  `sandbox_*` tool of the same name keeps the name and the script is not listed as
  a tool (it can still be run with `sandbox_run_script`); rename the script.
- **Same authority, same policy.** A call runs exactly like
  `sandbox_run_script { scriptName, args }`: with the authority of the caller, with
  access checked again for that call, able to call only the tools the script
  declares, and recorded in the run history and the audit log with the run's id. The
  tool is labelled read-only while writes are off (the default), as the run tool is.
  The agent's arguments are checked against the parameters before the script runs.
- **The result is the script's own.** The tool returns what the script returns, as
  JSON text (and as structured content when it is an object), not the run's wrapper.
  A failed script comes back as a tool error with its `code` and `hint`.
- **Fresh on the next tool list.** The set is read from the database whenever a
  tool list is built, so a script saved a moment ago is in the next request's list
  (the default, stateless mode). With `MCP_STATEFUL_SESSIONS=true`, a session keeps
  the list it was created with until it reconciles: saving or deleting a script in
  the dashboard makes every live session reconcile and send
  `notifications/tools/list_changed`; a script saved by an agent with
  `sandbox_create_script` appears in other live sessions the next time one
  reconciles (a connector reload or a server's connector change does it) or when the
  client reconnects. Each tool's signature covers its description and parameters, so
  a changed script is registered again, and a deleted one is removed.

A script that reads no argument has no parameters and is run only by name. Saving
parameters or code that cannot be exposed (more than 20 parameters, for instance)
saves the script anyway and says why it is not offered as a tool. In the REST API,
`parameters: null` starts the parameters over from the code.

### Upgrading

The migration `sandbox_script_connectors` moves existing scripts to the
organization: where two servers of one organization had a script of the same name,
the older keeps it and the others get a short suffix from their id. Each script's
code is read once and the tools it calls on its old server are declared, so
existing scripts keep working. A script that picked tools by a computed name has to
be declared by hand.

## Dashboard and REST API

The dashboard has a **Code mode** page (under *Build*) with four tabs: *Scripts*
(read, write, save, run and delete), *Runs* (history), *Isolation tests* (the live
negative-test suite) and *Benchmark* (one raw tool call against a script that
answers the same question). Viewers can read scripts and the history but not run
or change anything.

On *Scripts*, the MCP server chosen at the top decides what can run. The list shows
the whole organization's scripts; a pin on each card shows how many connectors it
uses, with the tools in its tooltip, and a script the chosen server cannot run says
which connector it lacks. **Filter** opens a pop-up with a checkbox per connector;
after *Apply* only the scripts that use at least one ticked connector are listed.

On *Benchmark*, three type-to-filter fields fill the form:

- **Examples** lists ready questions for the chosen server. Four are offered only
  when the server has the CODEBOUND mock tools they call: *Four rows from 400*
  (price drift above 5 %, `mock_erp_list_articles` + `mock_supplier_get_prices`),
  *Count a catalogue* (`mock_supplier_list_catalogue`, every page), *Stuck orders*
  (`mock_erp_list_orders` + `mock_carrier_get_tracking`, 3 days before
  `2026-10-16T12:00:00Z`) and *Ping* (`mock_erp_ping`). Every tool whose name reads
  like a read (`list`, `get`, `search`, ...) gets a generic entry: the raw call with
  its required arguments, against a script that returns the size of the answer.
  Picking an entry fills the tool, both argument fields and the code; **Run** beside
  it fills and runs in one click.
- **Tool** picks the raw call by hand; the code becomes the generic script.
- **Script** loads a saved script: its code, example values for its declared
  parameters as script args, and, when it uses a read-only tool of the server, that
  tool as the raw call. The result names the script.

An empty argument field shows an example built from the tool's or the script's
schema; **Tab** in the empty field takes it.

The same operations are available over REST with the dashboard's JWT. All routes
are under `/api/sandbox`, scoped to the caller's active organization; a server of
another organization answers `404`, never `403`.

| Route | Does |
|-------|------|
| `POST /servers/:serverId/run` | Run `code` or a saved `scriptId` (exactly one), with optional `args` and `timeoutMs`. A failing script still answers `200` with `ok: false`; `409` means the server lacks a connector the saved script uses; `429` means the organization is at `SANDBOX_MAX_CONCURRENT`. Needs ADMIN or EDITOR. |
| `GET /servers/:serverId/scripts` | The organization's saved scripts (without code unless `includeCode=1`), each with `uses` (connectors and tools), `parameters` (the schema of the arguments it reads, or `null`), `inferredParameters` (the names its code reads now) and, for this server, `availableOnServer`, `missingConnectors` and `exposedAsTool` (it has parameters and the server can run it, so agents get it as a tool of its own name). Any role. |
| `POST /servers/:serverId/scripts` | Save a script, optionally with `uses: [{ connectorId, tools }]` and `parameters`. Tools called in the code are added; the answer has `added` and `warnings`. The code is syntax-checked, not run. The server only settles ambiguous tool names. Needs ADMIN or EDITOR. |
| `GET /scripts/:scriptId` | One script, with its code, `uses`, `parameters` and `inferredParameters`. |
| `PATCH /scripts/:scriptId` | Change code, description, `uses` (a new list replaces the old) and/or `parameters` (replaces the schema; the names the code reads are merged in; `null` starts over from the code). Author only. Needs ADMIN or EDITOR. |
| `DELETE /scripts/:scriptId` | Delete. Its author or an ADMIN. Answers `204`. |
| `GET /servers/:serverId/runs?limit=` | Recent runs. An ADMIN sees all of them; anyone else sees their own, because a run keeps a preview of what the connectors returned. |
| `POST /servers/:serverId/isolation-tests` | Runs the fixed negative-test suite against the live sandbox with synthetic tools. Touches no connector. Needs ADMIN or EDITOR. |
| `POST /servers/:serverId/benchmark` | Calls one read-only tool (`toolName`, `toolArgs`) once, as a model would see it, and runs a script (`code`, optional `args`) that answers the same question. Returns bytes, estimated tokens (bytes ÷ 4) and latency of both. Needs ADMIN or EDITOR. |

Closing the connection while a run is in flight cancels it: the isolate is
disposed and the run ends as `CANCELLED`.

## Limits and configuration

Each run is bounded. The environment variables set the defaults for the whole
instance and are read at startup, so changing one needs a restart. They are all
optional. For the numeric ones, an unset, empty, non-numeric or non-positive
value falls back to the default. `SANDBOX_ENABLED` turns code mode off only when
it is exactly `false`.

| Variable | Default | Limits |
|----------|---------|--------|
| `SANDBOX_ENABLED` | `true` | Set to `false` to stop offering the four tools. |
| `SANDBOX_MEMORY_MB` | `128` | V8 heap of one run. |
| `SANDBOX_TIMEOUT_MS` | `10000` | Wall clock for the whole run, including time spent waiting on connectors. |
| `SANDBOX_MAX_OUTPUT_BYTES` | `32768` | Size of the JSON the script returns. |
| `SANDBOX_MAX_CONNECTOR_CALLS` | `500` | `tools.*` calls in one run. |
| `SANDBOX_MAX_CONNECTOR_BYTES` | `67108864` | Total size of the connector results pulled into one run. |
| `SANDBOX_MAX_CONCURRENT` | `4` | Runs in flight at once per organization; more fail with `BUSY`. |
| `SANDBOX_CONNECTOR_TIMEOUT_MS` | `15000` | One connector call. It is also bounded by what is left of the run. |
| `SANDBOX_MAX_CONNECTOR_RESPONSE_BYTES` | `67108864` | One connector response, checked before it is copied into the isolate. |
| `SANDBOX_ALLOW_WRITES` | unset | Exactly `true` lets scripts call write tools. See [Read-only by default](#read-only-by-default). |

Fixed limits: 64 KiB of code, 100 log lines of at most 500 characters each.

`SANDBOX_TIMEOUT_MS` is the **default**, not a ceiling: a caller can pass
`timeoutMs` between 1000 and 30000 to `sandbox_run_script` for a single run.

## Errors

A failed run returns `ok: false` with `error: { code, message, hint, line, column }`
and the usual `meta`. `hint` says what to try next. `line` and `column` refer to
the agent's own code, not to any wrapper.

| Code | Meaning |
|------|---------|
| `SYNTAX_ERROR` | The code does not parse. |
| `RUNTIME_ERROR` | The script threw, returned something that is not JSON, or finished without a result. |
| `TIMEOUT` | The run exceeded its wall clock. |
| `MEMORY_LIMIT` | The run exceeded the heap limit. |
| `OUTPUT_TOO_LARGE` | The returned JSON is larger than `SANDBOX_MAX_OUTPUT_BYTES`. |
| `CODE_TOO_LARGE` | The code is larger than 64 KiB. |
| `TOOL_NOT_ALLOWED` | `tools.<name>` is not in the caller's tool list. |
| `TOOL_ERROR` | A tool call failed, or its arguments were not an object or did not fit the tool's input schema. |
| `WRITE_NOT_ALLOWED` | The tool changes data and writes are not allowed. |
| `CONNECTOR_TIMEOUT` | One connector call took longer than `SANDBOX_CONNECTOR_TIMEOUT_MS`. |
| `CANCELLED` | The caller went away before the script finished. |
| `CONNECTOR_CALL_LIMIT` | More than `SANDBOX_MAX_CONNECTOR_CALLS` calls. |
| `CONNECTOR_BYTES_LIMIT` | More than `SANDBOX_MAX_CONNECTOR_BYTES` of connector data. |
| `BUSY` | `SANDBOX_MAX_CONCURRENT` runs are already in flight for the organization. |

## What is stored

Every run is recorded in the `sandbox_runs` table, whether it came from a saved
script or inline code: the code (a snapshot, so the run stays explainable after
the script changes), the arguments and the result, each bounded to a preview (8
KiB and 16 KiB), the error if any, and the run's `meta` (duration, call counts,
bytes, tool names, log lines). The result preview can therefore contain data
that came from a connector.

Every connector call a script makes is also recorded as a normal tool invocation in
the audit log, and its `clientInfo` carries `sandboxRunId`: the ID of the
`sandbox_runs` row of that run. Starting from a run you can find every call it made,
and starting from an audit row you can find the script that made it. Credentials
that come from environment variables are redacted from the stored previews, as for
any tool call; a token written literally into a connector's configuration is not
(the same limitation as in the existing audit log).

**Audit of refusals.** A call the bridge refuses before anything runs
(`TOOL_NOT_ALLOWED`, `WRITE_NOT_ALLOWED`) is recorded in the audit log of the
caller's workspace, with the run's ID, the tool name, the code and the reason,
never the arguments. When the name resolves to a tool of the caller's own
workspace (for example a tool that the caller's role hides), it is a
`tool_invocations` row with status `ERROR`, an error starting with
`REFUSED <code>:` and a duration of 0, so it appears on the Audit Log page.
Otherwise, for a name that belongs to another workspace or to none, it is a
`TOOL_REFUSED` security event in the caller's workspace, because
`tool_invocations` needs a tool of that workspace. `GET /api/audit/refusals`
lists both kinds. A cross-workspace attempt is recorded only in the caller's
workspace, never in the workspace that owns the tool, and the log does not
say whether the name exists elsewhere. A refusal repeated within a minute is
not stored again (a `tool_invocations` row counts it in `repeat_count`), and one
caller can add at most 20 refusal rows per run, or per minute outside a run
(`REFUSAL_AUDIT_ROWS_PER_MINUTE`). The same behaviour applies in Cloud and
self-hosted deployments.

Runs are not pruned automatically; they are removed together with their MCP
server or organization. A failure to store a run is logged and never turns a
finished run into an error for the caller.

Saved scripts are stored in `sandbox_scripts` (with their `parameters` schema, a JSON column that is `NULL` when the script reads no argument), and the tools each declares in `sandbox_script_tools` (one row per connector and tool; the connector is kept by id and name, not as a foreign key, so that deleting a connector does not erase the dependency). Every query on these tables is
filtered by `organizationId`, and all three tables are in the optional row-level
security script, which is off by default (see
[Row-level security](operations/row-level-security.md)).

## Database connectors

Code mode is most useful on a database connector, because a query can return a
very large table.

- Give the connector `"readOnly": true` in its configuration. With it, every tool
  of the connector counts as a read and the engine refuses anything but a read.
  Without it, only a tool whose SQL is provably a single `SELECT` counts as a read;
  the others cannot be called from a script.
- A SQL tool returns at most **1000 rows** by default and reports
  `truncated: true` with the real `totalRows`. A connector can raise that with
  `"maxRows": N` in its configuration (up to 250,000; any other value falls back
  to 1000). SQLite streams the result, so memory follows the cap; the other drivers
  hand the full result to the backend before it is cut, so also bound the query
  (a date range, a `LIMIT`) on a very large table. For code mode, raise the cap far
  enough that one call can return the range the script needs, and make the script
  fail loudly on `truncated` rather than aggregate a partial list.
- A placeholder (`${name}` or `$name`) in a tool's SQL is filled from the call's
  arguments. An optional parameter that is left out and has no default stays in the
  SQL as literal text, so give each optional filter a JSON Schema `default` that
  matches everything (for example `"default": "0000-01-01"` for a lower date bound).

## Security model

What stops what, and which layer does it. Code mode adds an isolate and a policy
in front of the connectors; it does not add a new operating-system boundary.

| Concern | Enforced by | Layer |
|---------|-------------|-------|
| A script reads the host's files, environment or secrets | The isolate has no `require`, `process`, filesystem or global with secrets | V8 isolate |
| A script reaches the internet or the internal network | The isolate has no `fetch`, sockets or timers; the only way out is `tools.<name>` | V8 isolate |
| A script reads another customer's data | Tenant and user come from the authenticated session and are fixed on the host; every query filters by `organizationId`; a script cannot name another connector | Application |
| A script calls a tool its caller may not | The tool list is the caller's own, filtered by role and read again for each run; each call is re-checked | Application |
| A script changes data | Read-only policy checked on every call before the connector is reached | Application |
| A script loops, allocates or floods | Wall clock for the whole run, heap cap, call and byte caps, per-call timeout, per-organization concurrency cap, output cap | V8 isolate and application |
| Large results exhaust the host | Responses are size-checked before they are copied in; the total is capped | Application |
| A bug in V8 or in `isolated-vm` lets a script out of the isolate | **Not prevented by this feature.** The isolate shares the backend's process, user and network | Operating system / infrastructure |

The last row is the honest limit of the design: an escape from V8 would run with
the backend's own permissions. If your threat model includes hostile script
authors and a V8 zero-day, run the backend in a container or VM with a read-only
filesystem, a non-root user, no route to anything it should not reach, and its
own database credentials limited to what it needs, and keep Node and
`isolated-vm` up to date. `SANDBOX_ENABLED=false` removes the feature entirely.

The *Isolation tests* tab (and the `isolation-tests` endpoint) runs a fixed set of
attempts to escape, exhaust or bypass the sandbox and shows which layer stopped
each one. They use synthetic tools and touch no customer data.

## Known limits

Code mode is built to work correctly first; these are the limits to know before
scaling it.

- **In-process.** The isolates run inside the backend process, sharing its CPU and
  memory with everything else. There is no worker pool and no separate service.
  Running many heavy scripts at once slows the whole instance.
- **Concurrency is per organization.** `SANDBOX_MAX_CONCURRENT` caps one
  organization. There is no instance-wide cap, so many organizations running at
  once are bounded only by the host.
- **Memory is not only the heap.** A connector result is held in the backend,
  copied into the isolate and sometimes serialised again, so a very large payload
  can take several times its size in host memory for the duration of a run (the 44 MB test raised the backend's resident memory by about 190 MB).
  Tune `SANDBOX_MAX_CONNECTOR_BYTES` and `SANDBOX_MEMORY_MB` to the machine.
- **One process, one machine.** There is no distribution of runs across
  backends; each instance enforces its own limits.
- **Runs are not pruned** and keep result previews, which can contain connector
  data (see [What is stored](#what-is-stored)).
- **Tokens are estimated** in the benchmark as bytes ÷ 4; no tokenizer is used.
- **Runtime support.** `isolated-vm` 7 needs Node 24 or newer and ships prebuilt
  binaries for Node 24 and 26 on glibc and musl (Alpine) for x86-64 and arm64.
  The sandbox test suites pass on Node 24 and 26 on glibc and on Alpine; see
  [docs/sandbox/README.md](sandbox/README.md#runtimes-tested).

## Cloud and self-hosted

Code mode behaves the same in both deployment modes: the same tools, the same
limits, the same storage. Nothing in it depends on `DEPLOYMENT_MODE`, and it needs
no extra service, because the isolate runs inside the backend.

## Level 3: scripts with secrets

By default a script reaches the outside world only through the tools of its
connectors and never sees a credential. A **saved** script can opt in to two
more things, for the cases a tool does not cover (an endpoint no tool exposes,
a header the tool does not send):

```json
"capabilities": { "env": true, "http": true }
```

Set `capabilities` when saving the script (`POST /api/sandbox/servers/:serverId/scripts`)
or later (`PATCH /api/sandbox/scripts/:scriptId`). Only the script's author can
set it, like any other change, and an administrator can switch it on or off on
anyone's script in a request that changes nothing else. `null`, or both
switches off, is the default. **Inline code never gets either**: neither
`sandbox_run_script { code }`, nor the REST run with `code`, nor the benchmark.
In those runs, and in saved scripts without the capability,
`typeof env === 'undefined'` and `typeof http === 'undefined'`.

### `env`

A frozen object with the variables of the connectors the script declares under
*Connectors & tools*, by name, as stored on each connector (decrypted on the
server for the run). The variables of every other connector of the workspace
are not there at all. When two declared connectors have a variable of the same
name, the one of the connector that comes first by name wins.

```js
const r = await http.fetch(`${env.MOCK_SUPPLIER_URL}/v1/account`, {
  headers: { 'X-Api-Key': env.MOCK_SUPPLIER_API_KEY },
});
if (r.status !== 200) throw new Error(`account: HTTP ${r.status}`);
return { accountName: r.json.accountName, customerNo: r.json.customerNo };
```

### `http.fetch(url, { method, headers, body })`

Makes one request from the server and resolves to
`{ status, headers, text, json? }` (header names lower-cased, `set-cookie`
removed; `json` when the body parses). A request is refused, in this order, when:

1. the URL is not an absolute `http://` or `https://` URL, or carries user info
   (`HTTP_NOT_ALLOWED`);
2. its origin (scheme, host and port) is not the origin of the base URL of one of
   the declared connectors, with its `{{VAR}}` placeholders filled in
   (`HTTP_NOT_ALLOWED`, naming the origin). This is decided on the URL alone,
   before any DNS lookup or connection;
3. the method is not `GET` or `HEAD` and the instance does not allow writes
   (`SANDBOX_ALLOW_WRITES=true`, the same policy as write tools;
   `WRITE_NOT_ALLOWED`);
4. the run has used up its connector calls (`CONNECTOR_CALL_LIMIT`);
5. the outbound address policy refuses the host: private, loopback and
   link-local addresses, `169.254.169.254` among them, unless the host is in
   `SSRF_ALLOWED_HOSTS` or the administrator's allowlist (`HTTP_NOT_ALLOWED`).

The request then goes through the same SSRF-guarded client as connector calls,
which checks the address it actually connects to. Redirects are **not** followed:
a `3xx` comes back to the script with its `location` header, so a redirect cannot
lead it to another origin. Each request counts as a connector call, waits at most
`SANDBOX_CONNECTOR_TIMEOUT_MS` (and never past the run's own deadline), may
return at most `SANDBOX_MAX_CONNECTOR_RESPONSE_BYTES`, and its bytes count toward
`SANDBOX_MAX_CONNECTOR_BYTES`. The request body may be a string or a JSON value
(sent as `application/json`), up to 1 MB. A connector the caller's role does not
fully grant (any of the tools the script declares on it is withheld) gives the
run neither its variables nor its origin.

The run's `meta.httpCalls` lists each request as `{ origin, path, status, bytes }`,
never with its query string or headers; `status` is `0` when no answer came back.
These requests are not tool invocations, so they are recorded in the run (the
*Runs* tab, `sandbox_runs.meta`) and not in the audit log of tool calls.

### Masking

Every secret value of every declared connector, used by the script or not, is
replaced by `***` in everything the run hands back: the result, `console.log`
output, the error message, the run history (`sandbox_runs`) and the MCP tool's
answer. The URL-encoded, JSON-escaped and base64 forms of each secret are masked
too. A variable is a secret when its name says so (`*_KEY`, `*_TOKEN`,
`*PASSWORD*`, ...), when its value looks like a credential, when the adapter uses
it in a credential slot, or when the connector's authentication settings
reference it; base URLs are not. Values shorter than six characters are not
masked.

Masking guards against accidents (`return env.API_KEY`, an API that echoes the
key), not against a script written to smuggle a secret out by splitting or
transforming it. That is why only the script's author or an administrator can
give a script its connectors' secrets, and why the script then runs only the
code its author saved.

A Level 3 script with parameters is offered as a tool of its own name like any
other saved script (see [Scripts as tools](#scripts-as-tools)); its description
and schema are the script's own and contain no secret.
