# Flow

The Flow page (`/flow`, sidebar **Build → Flow**) draws how data moves through
the workspace: the agent calls an MCP server, the server offers tools, each
tool calls its connector, the response may pass through Response Processing
and a mapping, and saved scripts call tools. Every node and edge carries the
call statistics of the chosen window.

It behaves the same on Cloud and self-hosted. Every query is bound to your
organization.

## Toolbar

| Control | Values | Default |
|---|---|---|
| Server | `All servers · <n>`, or one MCP server | All servers |
| Window | `1h`, `24h`, `7d` | `24h` |
| Fit (`f`) | fits the view to the graph | — |
| Status | `<nodes> nodes · <edges> edges · <window>` | — |

The server is kept in the URL (`/flow?server=<id>`; no parameter = all
servers). With all servers, one Agent node fans out to every server; each
connector, tool, processing chain, mapping and script appears once, and each
server gets its own `server → tool` edges with its own counts.

The view moves only on **Fit** and when the server changes. Reloading after an
edit, a new window or a replay never re-fits or re-lays out a graph whose nodes
and edges are unchanged.

## Nodes and edges

| Node id | Kind | Shows |
|---|---|---|
| `agent` | Agent | calls into the server(s) |
| `server:<id>` | MCP server | connectors, calls |
| `tool:<id>` | Tool | `ro`/`rw`, calls, errors |
| `processing:<toolId>` | Response Processing chain | on/off, valid, steps, bytes |
| `mapping:<toolId>` | Response mapping | mode |
| `connector:<id>` | Connector | auth type, calls |
| `script:<id>` | Saved script | version, declared tools, runs |

| Edge | Meaning | Line |
|---|---|---|
| `mcp` | agent → server | solid 1.5 |
| `tool` | server → tool (offered) | solid |
| `http` | tool → connector (the request leaves) | solid |
| `processing`, `mapping` | raw response → chain → mapping | dotted |
| `script-use` | script → tool (declared) | dashed |
| `script-call` | script → tool (observed in the window) | thin |

Edge colour is the state of that edge in the window:

| State | Colour | Animation |
|---|---|---|
| no calls | `--text-3` | none |
| every call succeeded | `--t-success-fg` | yes |
| some calls failed | `--t-warn-fg` | yes |
| every call failed or was refused | `--t-danger-fg` | yes |
| the whole window is empty | `--border` | none |

The animation is a directional gradient (faint at the source, full at the
target) with dashes moving along the path, CSS only. Its speed has three
buckets by calls: under 10, under 100, 100 and more. With
`prefers-reduced-motion: reduce` edges keep their colour and do not move.

## Editing in place

Click a node: the drawer on the right shows the statistics, the fields below,
the node's facts, and **Open →** (the owning page). Every field saves on blur
(names) or on toggle (switches), shows a check when saved and the API's
sentence when not, and reloads the graph. Viewers see the values only.

| Node | Fields |
|---|---|
| Connector | name, enabled, base URL (read-only) |
| MCP server | name; one switch per connector of the workspace (attach / detach) |
| Tool, processing, mapping | Response Processing on/off (`responseMapping.responseProcessing.enabled`, nothing else changes), steps, **Edit →** (`/connectors/<id>#processing`) |
| Script | tool (offered as an MCP tool: `parameters` set, `{properties:{}}` when it reads none; off: `null`; switching back on restores the previous schema), `env`, `http` (Level 3 capabilities) |

Names: Enter saves, Esc restores the last saved name, an empty name is never
sent. Only the script's author can switch `tool`; the author or an
administrator can switch `env` / `http`; viewers do not see the capabilities.

## Replay

The timeline at the bottom left plays the window's calls in time order:

`[Play/Pause] [scrubber] [1× 4× 16×] <time> · <event>/<events>`

- Play walks the events; each pause is the real gap between two calls, at
  most 2 s, divided by the speed. Each event lights the edges it travelled
  (agent → server → tool → connector, then processing → mapping when present;
  a script run lights the tools it called) and the nodes count up. A refused
  call stops at the tool; a processing failure stops before the mapping.
- The replay stops at the last event with the final counts. Play again from
  the end starts over.
- The scrubber jumps to any event; the graph shows the counts as of then.
- Keys (focus in the timeline): Space play/pause, ←/→ one event, Home/End.
- An empty window shows `0 events` and the control is disabled.

Source: `GET /api/flow/events?serverId&since&until&limit` (no `serverId` = all
servers; `since` is `1h`/`24h`/`7d` or an ISO time, at most 7 days before
`until`; `limit` ≤ 2000, the most recent are kept and `truncated` is true).
Each event: `{ ts, kind: 'tool'|'script'|'processing', serverId, connectorId?,
toolId?, scriptId?, status: 'ok'|'error'|'refused', durationMs, count?, tools? }`.
No payloads and no error messages.

## Ask

The bar at the bottom right answers questions about the graph:

`[✦] <question> [⏎]`

- The placeholder rotates every 6 s through five questions built from the
  current graph (the selected node first). **Tab** in the empty input takes
  the placeholder.
- **Enter** sends; **Esc** collapses the thread; **⌘K** / **Ctrl+K** focuses
  the bar from anywhere on the page. Questions are capped at 500 characters.
- Answers open a thread above the bar (question right, answer left, model
  under it). The thread lives in the page per server and is not stored.
- `LLM off` (input disabled, **Settings →**) when the workspace has no LLM.

`POST /api/flow/ask { serverId: string|null, window, nodeId?, question }` →
`{ answer, model, usage? }`. The server builds the context itself: the graph
of that window trimmed to ids, kinds, labels and counts (at most 8 KB), the
selected node, and the last 10 errors of the window with their age. Context
and question pass through the Knowledge Graph's PII redaction
(`knowledge-graph/redact.ts`) before they leave. The model is told to answer
in the language of the question, in at most 120 words, naming node ids, and
never to invent data. 10 questions per minute per user (429 above).
Questions and answers are not logged or stored. `GET /api/flow/ask` →
`{ enabled, model? }`.

### Requirements

The Ask bar uses the Knowledge Graph's LLM settings. It answers only when all
of these hold, otherwise `409 { code: 'LLM_OFF' }`:

1. `KG_LLM_ENABLED=true` in the backend environment.
2. A provider is configured, one of:
   - `KG_LLM_BASE_URL=<OpenAI-compatible base URL>` (local models: Ollama,
     LM Studio; `KG_LLM_API_KEY` optional), or
   - `KG_LLM_PROVIDER=openai` with `OPENAI_API_KEY`, or
   - `KG_LLM_PROVIDER=openrouter` with `OPENROUTER_API_KEY`, or
   - `KG_LLM_PROVIDER=anthropic` with `ANTHROPIC_API_KEY`.

   `KG_LLM_MODEL` picks the model (defaults: `gpt-4o-mini`, Anthropic
   `claude-haiku-4-5`, custom `qwen2.5`).
3. The workspace has the Knowledge Graph on and its AI switch on
   (**Settings → Organization → Knowledge Graph**, administrators).

## Limits

| Limit | Value |
|---|---|
| Servers drawn with All servers | 100 |
| Tools drawn | 500 most called (`truncated` on the server node) |
| Saved scripts read | 500 |
| Script runs aggregated | 2000 most recent |
| Replay events | 2000 most recent of the window |
| Ask context | 8 KB graph + 2 KB node + 10 errors |
| Ask question | 500 characters |
| Ask rate | 10 per minute per user |

## Files

Backend `packages/backend/src/flow/` (`flow.service.ts` graph, events and
recent errors; `flow-ask.service.ts`; `flow.controller.ts`; `flow.dto.ts`).
Frontend `packages/frontend/src/app/flow/page.tsx` and
`packages/frontend/src/components/flow/`. E2E `tests/e2e/flow.spec.ts`.
