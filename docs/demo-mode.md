# Demo mode

Demo mode turns a **self-hosted** AnythingMCP instance into a public demo. When
it is turned on it builds a complete, reproducible workspace (the CODEBOUND
hackathon test bed) against four built-in mock business systems, and publishes
the demo sign-ins so the login page can offer them with one click. It is a
runtime switch: the "Demo" pill on every page (for a workspace admin) or
`PUT /api/demo/control`; `DEMO_MODE=true` is only its initial default.

It is meant for a throwaway instance whose only purpose is to be tried out.
**Never turn it on for an instance with real users, connectors or data**: the
demo passwords are public by design.

- [Turning it on](#turning-it-on)
- [The switch](#the-switch)
- [What it creates](#what-it-creates)
- [The accounts](#the-accounts)
- [The mock systems](#the-mock-systems)
- [The login page](#the-login-page)
- [Security boundaries](#security-boundaries)
- [Reset](#reset)
- [The demo control](#the-demo-control)
- [Resetting the demo](#resetting-the-demo)
- [Cloud and self-hosted](#cloud-and-self-hosted)

## Turning it on

| Variable | Description |
|----------|-------------|
| `DEMO_MODE` | The switch's **initial default**. Exactly `true` turns demo mode on at a boot where the site setting `demo.enabled` does not exist yet (and stores `true` in it). Once the setting exists, it wins: `DEMO_MODE` is not read again. Unset or anything else leaves the instance unchanged. |
| `SSRF_ALLOWED_HOSTS` | Must let the connectors reach `127.0.0.1`, for example `SSRF_ALLOWED_HOSTS=127.0.0.1` (the admin SSRF allowlist works too). Demo mode checks the effective outbound policy before it starts: with `DEMO_MODE=true` the backend **refuses to start** with a clear error if it blocks the mocks; when only the stored setting asks for demo mode, it stays off for that boot and the log says why; the switch answers `409` with the same message. |
| `DEMO_PASSWORD_SEED` | Optional. Every secret of the demo (the three passwords, the seven mock credentials) is derived from this value with HMAC-SHA256. Default: derived from `JWT_SECRET`, so the passwords are stable for one instance but cannot be guessed from the code. Change it to rotate the passwords. |
| `DEMO_MOCK_PORT` | Optional. Loopback port of the mock systems, default `4191`. (Not 4190: browsers and Node's `fetch()` refuse that port.) |
| `SANDBOX_MAX_CONNECTOR_CALLS` | Default `500` is enough: the `stuck_orders` script makes about 62 connector calls in one run. Set it explicitly only if you change it elsewhere; the attack card A10 names this number. |

```bash
DEMO_MODE=true
SSRF_ALLOWED_HOSTS=127.0.0.1
```

Or leave `DEMO_MODE` unset and turn demo mode on from the pill (see
[the switch](#the-switch)).

Each time demo mode starts (at a boot while it is on, or from the switch) the
log says, in one line, what the seed created or put back, for example `Demo
workspace ready: 2 workspaces, 3 users; created nothing; updated nothing.` It
never logs a password, key or credential.

## The switch

The live state is the site setting `demo.enabled` (`true` / `false`), cached in
memory by the backend; every demo route, the public endpoint and the mocks
follow it without a restart.

`GET /api/demo/control` (any signed-in user):

```json
{ "available": true, "enabled": false, "canToggle": true, "canReset": false }
```

`available` is `false` on Cloud. `canToggle`: the caller is an ADMIN of any
workspace. `canReset`: demo mode is on and the caller is an ADMIN of a demo
workspace. While demo mode is on the answer also carries `status`, the payload
of `GET /api/demo/status`.

`PUT /api/demo/control { "enabled": true | false }` (an ADMIN of any workspace;
`403` otherwise, `404` on Cloud before authentication) answers with the same
payload. It runs **at most once every 5 seconds per backend instance** (`429`
inside that window, and while a toggle is still running). Every change writes a
security event `DEMO_MODE_CHANGED` with `{ enabled, userId }` in the caller's
workspace.

| | Turning it ON | Turning it OFF |
|---|---|---|
| Mock systems | Started on `127.0.0.1:<DEMO_MOCK_PORT>` (if not already running) | Stopped; the port is closed and the request log dropped |
| Seed | Runs (idempotent, without `force`): what is missing is created, what differs is written back, including the three demo passwords | Nothing runs |
| Data | — | **Nothing is deleted.** The demo workspaces, users, connectors, scripts, runs and logs stay |
| Setting | `demo.enabled = true`, after the seed succeeded | `demo.enabled = false`, first |
| `GET /api/public/demo` | `{ enabled: true, … }` | `{ enabled: false }`; the login page offers no demo sign-ins |
| `/api/demo/status`, `/api/demo/reset` | Available | `404` |

Turning it on fails without changing anything when the outbound policy blocks
the mocks (`409`), or stops the mocks again and stays off when the seed fails
(`503`).

**Off is not a clean-up.** The demo accounts can still sign in afterwards, with
the passwords they had (which were public while demo mode was on): turn demo
mode off and the instance keeps three known logins, two of them workspace
admins. To get rid of them, use [Reset](#reset) while it is on (it only puts
things back), or delete the demo workspaces and users (see
[Resetting the demo](#resetting-the-demo)), or change their passwords.

**It reuses what it finds.** The seed matches by name, so it takes over
workspaces named `Alpha (CODEBOUND workspace A)` and `Beta (CODEBOUND workspace
B)`, the users `alice`/`carol`/`bob@…codebound.test`, and connectors named
`Mock ERP`, `Mock Supplier`, `Mock Carrier`, `Mock Payroll` in them: it rewrites
their passwords and their connector variables to the built-in mocks. On a
database where the kit's own `codebound setup` ran, turning demo mode on
repoints the kit's connectors away from the kit's mocks; run the kit's setup
again afterwards (or put the variables back) to use the kit.

## What it creates

The seed runs each time demo mode is turned on, and on every boot while it is
on. It is idempotent: everything is matched by a
natural key (email, workspace name, connector name, server slug, role name,
script name, key name), created when missing and written only when it differs.
A restart creates nothing new. A database on which the kit's own
`codebound setup` already ran is reused, not duplicated. Whatever a visitor
changed in these objects (a password, a script, a connector variable, a revoked
key) is put back on the next boot or the next time demo mode is turned on;
anything a visitor *added* is left alone.

| Object | Workspace A, "Alpha (CODEBOUND workspace A)" | Workspace B, "Beta (CODEBOUND workspace B)" |
|--------|----------------------------------------------|---------------------------------------------|
| Users | alice (ADMIN), carol (VIEWER, MCP role Staff) | bob (ADMIN) |
| Connectors | Mock ERP, Mock Supplier, Mock Carrier, Mock Payroll | Mock ERP, Mock Supplier, Mock Carrier |
| MCP roles | HR (the payroll tool), Staff (every other tool) | none |
| MCP server | `codebound` ("CODEBOUND") with every connector | `codebound` ("CODEBOUND") with every connector |
| MCP keys | `demo-alice`, `demo-carol`, scoped to A's server | `demo-bob`, scoped to B's server |
| Saved scripts | `price_drift_check`, `catalogue_total`, `stuck_orders`, `supplier_account` (Level 3), owned by alice | none |

In both workspaces `mock_supplier_get_prices` carries the annotation
`readOnlyHint: true` (a price lookup sent as POST), and
`mock_supplier_list_offers` has a [Response Processing](response-processing.md)
chain: `currency@1` (USD to EUR, rate 0.92) then `vat@1` (19 %) then
`clean_text@1` on the descriptions, each over `$.items[*]`, `onError: fail`.
The `broken` offers category carries a price of `"n/a"`, so that call fails with
an error naming `price_usd`.

The scripts have typed parameters, so the CODEBOUND server offers each as an MCP
tool of its own: `price_drift_check {threshold}`, `catalogue_total {category}`,
`stuck_orders {days, as_of}` and `supplier_account {}`. The last one has the
Level 3 capabilities `env` and `http`: it reads the supplier's variables and
calls `/v1/account`, which no tool exposes.

The data is the kit's: deterministic per workspace, so the answers match the
kit's `expected/*.json` (for example `price_drift_check {threshold: 5}` returns
four rows in workspace A).

The demo users count as seats like anyone else. On the Community edition (three
users) a demo user is not created if no seat is left; the boot log says so, and
that account is not published.

## The accounts

| Email | Password | Role | MCP roles | Workspace |
|-------|----------|------|-----------|-----------|
| `alice@alpha.codebound.test` | `Cb-<10 hex>-A!` | ADMIN | none (an admin may call every tool) | A |
| `carol@alpha.codebound.test` | `Cb-<10 hex>-C!` | VIEWER | Staff (every tool but payroll) | A |
| `bob@beta.codebound.test` | `Cb-<10 hex>-B!` | ADMIN | none | B |

The ten hex characters are `HMAC-SHA256(seed, "password:<email>")`, cut to ten
(with a digit guaranteed, so the password meets the sign-up policy). The users
are created with a verified email address and sign in to their own workspace.
Passwords are re-set each time demo mode is turned on and on every boot while
it is on (not when it is turned off).

## The mock systems

One in-process HTTP server, bound to `127.0.0.1:<DEMO_MOCK_PORT>`, serves all
four systems under a path prefix:

| System | Base URL the connector uses | Credential |
|--------|-----------------------------|------------|
| ERP | `http://127.0.0.1:4191/erp` | `Authorization: Bearer cbk_erp_<ws>_<hex>` |
| Supplier | `http://127.0.0.1:4191/supplier` | `X-Api-Key: cbk_supplier_<ws>_<hex>` |
| Carrier | `http://127.0.0.1:4191/carrier` | `Authorization: Bearer cbk_carrier_<ws>_<hex>` |
| Payroll | `http://127.0.0.1:4191/payroll` | `Authorization: Bearer cbk_payroll_a_<hex>` (A only) |

The credential decides the tenant, as in the kit: a request with workspace A's
credential gets A's data wherever it comes from. The credentials are the kit's
canary format and are stored only in each connector's (encrypted) variables.

`GET /__health` and `GET /__log?since=<seq>` on the same port return the state
and the request log (service, method, path, query, tenant, status; never a
credential), bounded to the last 5,000 requests. The server answers loopback
clients only and stops when demo mode is turned off, or with the backend.

Unlike the kit, the four systems share one origin. A Level 3 script's
`http.fetch` is bound to the origins of the connectors it declares, so in demo
mode a script that declares one mock connector may address the others' paths;
it still has only the credentials of the connectors it declares, and the mocks
answer `401` without the right one.

## The login page

`GET /api/public/demo` needs no authentication and is rate-limited like every
other route (100 requests per minute per client). It is never cached
(`Cache-Control: no-store`).

```json
{ "enabled": false }
```

in normal operation, and in demo mode:

```json
{
  "enabled": true,
  "accounts": [
    {
      "email": "alice@alpha.codebound.test",
      "password": "Cb-…-A!",
      "name": "Alice (Alpha admin)",
      "role": "ADMIN",
      "mcpRoles": [],
      "workspace": "A",
      "workspaceName": "Alpha (CODEBOUND workspace A)"
    }
  ],
  "mcp": { "A": "/mcp/<server id of A>", "B": "/mcp/<server id of B>" }
}
```

Returning the passwords is deliberate: the endpoint publishes them only while
demo mode is on, on a self-hosted instance. MCP keys are never returned; a
signed-in user creates or reads their own as usual.

## Security boundaries

- **Public passwords.** Anyone can sign in as alice, an ADMIN of workspace A,
  or bob, an ADMIN of workspace B, and do anything an admin can there,
  including changing the password until the next restart, and turning demo
  mode off and on (any workspace admin may use the switch). Run the demo on its
  own instance and database, restart it regularly, and keep nothing on it you
  would mind losing.
- **Loopback allowlisted.** `SSRF_ALLOWED_HOSTS=127.0.0.1` lets every
  connector of the instance reach any port on its loopback interface, not only
  the mocks. In the container image that is the backend and frontend
  themselves, which a visitor can reach from outside anyway; do not run other
  services on the same loopback interface as a demo instance.
- **Loopback-only mocks.** The mock systems listen on `127.0.0.1` only and hold
  nothing but generated data.
- **Any admin holds the switch.** The switch is instance-wide and any ADMIN of
  any workspace may flip it, like the other instance settings. On an instance
  with more than one tenant that means any tenant's admin can publish three
  demo logins; keep demo mode to instances made for it.
- **Off keeps the logins.** See [the switch](#the-switch): turning it off stops
  publishing the passwords, not the accounts.
- **Never on Cloud.** With `DEPLOYMENT_MODE=cloud` the flag and the setting are
  ignored and the boot log says demo mode was refused; nothing listens, the
  endpoint returns `{ "enabled": false }`, `GET /api/demo/control` says
  `available: false` and `PUT` answers `404`.

## Reset

`POST /api/demo/reset` puts the two demo workspaces back to their seeded state
without a restart. It exists only while demo mode is on: otherwise (and on
Cloud) the route answers `404`, before authentication, like a route that does
not exist, and it is left out of the API docs.

It needs a signed-in user who is an **ADMIN of one of the demo workspaces**
(alice or bob): `401` without a session, `403` for anyone else (carol, or an
admin of another workspace). It runs **at most once every 10 seconds per
backend instance**; a call inside that window answers `429`. The window starts
when a reset starts, so two concurrent calls cannot both run.

What it deletes, in both demo workspaces only (every query is bound to their
two organization ids; no other organization is touched):

| Deleted | Scope |
|---------|-------|
| Code mode runs | every `sandbox_runs` row of the two workspaces |
| Tool calls | every `tool_invocations` row of the two workspaces, and rows without an organization that belong to one of their tools |
| Refused calls | the refusal rows among those, and the `TOOL_REFUSED` security events |
| Security events | every other security event of the two workspaces (sign-ins, key changes, ...) |
| Saved scripts | every script the seed does not define: all of workspace B's, and those of workspace A not named `price_drift_check`, `catalogue_total`, `stuck_orders` or `supplier_account` |
| Memberships | a demo user's membership of the *other* demo workspace (bob invited alice into B); memberships in other organizations stay |
| Mock request log | emptied (the sequence keeps counting, so a `since` cursor stays valid) |

What it writes back, by running the seed with `force` (which writes even where
nothing differs): the three demo users' passwords (re-hashed), verified email,
home workspace and membership role; the four seeded scripts' code, parameters,
capabilities and declared tools (re-created if deleted; their last-run summary
is cleared with the runs); the tool annotations; the Response Processing chain
of `mock_supplier_list_offers` in both workspaces. Everything else the seed
owns (connectors, roles, servers, keys) is put back as on a boot.

```json
{
  "ok": true,
  "reset": {
    "runs": 117, "invocations": 1632, "refusals": 16, "securityEvents": 0,
    "scriptsRemoved": 2, "scriptsRestored": 4, "chainsRestored": 2,
    "membershipsRemoved": 1, "mockRequests": 2
  },
  "at": "2026-10-17T22:44:08.845Z"
}
```

`GET /api/demo/status` (any signed-in user, while demo mode is on, `404` otherwise)
returns what the demo control shows: `enabled`, `lastResetAt` (this instance's
last reset), `mock: { port, requests }` (requests since boot or the last reset),
`workspaces: [{ id, name, letter, serverId }]`, the demo accounts with their
passwords (the same disclosure as `GET /api/public/demo`) and
`currentWorkspace`, the letter of the caller's workspace or `null`.

## The demo control

Every signed-in user sees a small "Demo" pill in the bottom-right corner of
every page except the sign-in page, whether demo mode is on or off: it holds
the switch. It is an opaque card like the rest of the UI (no blur): a flask,
"Demo" and a dot, green while demo mode is on and grey while it is off. It
reads `GET /api/demo/control` once per page load and after every action, and
renders nothing where demo mode does not exist (`available: false`, Cloud).

- **Moving it.** Drag it anywhere; on release it snaps to the nearest left or
  right edge, keeps its height, and remembers the spot in the browser
  (`localStorage` key `amcp.demo.pill`). A press without movement opens it, as
  do Enter and Space when it has keyboard focus; Esc or a click outside closes
  the panel.
- **The panel** (280 px, above the pill, on the same edge): the current demo
  workspace; **Demo mode** with an On/Off switch (enabled for a workspace
  admin, disabled while a toggle runs and after a `403`); the three accounts,
  each with **Switch** (signs in as that account and reloads `/`); the MCP
  endpoints of A and B with copy buttons; **Reset data** for demo admins, with
  an inline confirm, then the counts (`runs · invocations · scripts`) for five
  seconds; the mock systems' request count; **Hide 1h**, which hides the pill
  in this browser for an hour.
- While demo mode is off the accounts, endpoints and reset are shown dimmed and
  disabled; the switch is the only live control.

## Resetting the demo

The [reset](#reset) above (or the demo control's **Reset data**) is the quick
way.

A restart (while demo mode is on), or turning demo mode off and on again, also
puts the demo objects back as described above. For a clean slate,
delete the two demo workspaces (signed in as their admins, alice and bob) and
the three demo users, or drop the database, and restart: the seed
builds everything again. Changing `DEMO_PASSWORD_SEED` rotates the passwords and
mock credentials on the next boot (or the next time demo mode is turned on); the MCP keys stay (delete the `demo-*` keys
to get new ones).

## Cloud and self-hosted

| | Self-hosted | Cloud |
|---|---|---|
| Demo mode | A runtime switch (`demo.enabled`); `DEMO_MODE=true` is its initial default | Never; `DEMO_MODE=true` is logged once as refused |
| `GET /api/public/demo` | `{ enabled: true, … }` while on, else `{ enabled: false }` | Always `{ enabled: false }` |
| `GET /api/demo/control` | `available: true` | `available: false` |
| `PUT /api/demo/control` | Any workspace ADMIN, one per 5 s | Always `404` |
| `POST /api/demo/reset`, `GET /api/demo/status` | While on; `404` otherwise | Always `404` |
| Demo control (pill) | Shown to every signed-in user | Never shown |
