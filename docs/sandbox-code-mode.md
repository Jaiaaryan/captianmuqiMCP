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
- [Saved scripts](#saved-scripts)
- [Limits and configuration](#limits-and-configuration)
- [Errors](#errors)
- [What is stored](#what-is-stored)
- [Cloud and self-hosted](#cloud-and-self-hosted)

## Tools

Four tools are added to the server's tool list, after the connector tools. A
connector tool that already uses one of these names keeps its name and the code
mode tool of that name is not registered.

| Tool | Does |
|------|------|
| `sandbox_run_script` | Runs `code`, or a saved script given as `scriptName`. Optional `args` (exposed to the script as `args`) and `timeoutMs` (1000 to 30000). Provide exactly one of `code` and `scriptName`. |
| `sandbox_create_script` | Saves a named script for this MCP server. The code is syntax-checked, not executed. |
| `sandbox_edit_script` | Changes a saved script's code and/or description. Only the script's author can do this. The version goes up when the code changes. |
| `sandbox_list_scripts` | Lists the saved scripts with version, owner flag (`ownedByYou`) and last run. |

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
- Each call is scoped to the connector that owns the tool, so two connectors with
  a tool of the same name do not collide.
- Every connector call is audited as a normal tool invocation.

A script can call write tools if the caller can, so `sandbox_run_script` is not
annotated as read-only (`readOnlyHint: false`, `openWorldHint: true`).

## Saved scripts

A saved script belongs to one MCP server. Names are lowercase, start with a
letter and are 2 to 64 characters of `a-z`, `0-9`, `_` or `-`; a name is unique
per server.

A saved script runs with the authority of **whoever runs it**, not of whoever
wrote it. To keep a user with fewer permissions from planting code that a more
privileged user's agent then runs, only a script's author can edit it. Anyone
else saves their own copy under a new name. When a saved script runs, the result
includes `script: { name, version, ownedByYou }` so the caller can see whose code
ran.

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
| `SANDBOX_MAX_CONNECTOR_CALLS` | `50` | `tools.*` calls in one run. |
| `SANDBOX_MAX_CONNECTOR_BYTES` | `67108864` | Total size of the connector results pulled into one run. |
| `SANDBOX_MAX_CONCURRENT` | `4` | Runs in flight at once per organization; more fail with `BUSY`. |

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
| `TOOL_ERROR` | A tool call failed, or its arguments were not an object. |
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

Runs are not pruned automatically; they are removed together with their MCP
server or organization. A failure to store a run is logged and never turns a
finished run into an error for the caller.

Saved scripts are stored in `sandbox_scripts`. Every query on both tables is
filtered by `organizationId`, and both tables are in the optional row-level
security script, which is off by default (see
[Row-level security](operations/row-level-security.md)).

## Cloud and self-hosted

Code mode behaves the same in both deployment modes: the same tools, the same
limits, the same storage. Nothing in it depends on `DEPLOYMENT_MODE`, and it needs
no extra service, because the isolate runs inside the backend.
