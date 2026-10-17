# CODEBOUND: provisioning the test bed

The CODEBOUND kit (`codebound-kit`) builds two workspaces with four mock systems and then **checks**
what the AnythingMCP under test offers. It does not create the scripts it calls: "how they get there
is up to you". `seed.mjs` is how they get there. Run it between the kit's `setup` and `check`.

## Order

```bash
# 1. The kit's mock systems (Docker: `npm run mocks` in the kit; without Docker see the note below)
# 2. This backend, with the mock hosts allowed for the SSRF guard
#      host mode:   SSRF_ALLOWED_HOSTS=localhost            (and DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY)
#      docker mode: docker compose -f docker-compose.yml -f <kit>/compose/anythingmcp.override.yml up -d --build
# 3. The kit's setup, on an EMPTY database
cd ../codebound-kit && npm run setup -- --url http://localhost:4000 --mode host      # or --mode docker

# 4. This repository: put the scripts and the processing chain on the test bed
cd ../captianmuqiMCP && node scripts/codebound/seed.mjs --kit ../codebound-kit

# 5. The kit's checks, then the attack cards
cd ../codebound-kit && npm run check
cd ../captianmuqiMCP && node scripts/codebound-cards/run.mjs --kit ../codebound-kit
```

`seed.mjs` can be run again at any time: what exists is updated, nothing is duplicated. It needs only
Node 22 and the kit's `.codebound/state.json`. It signs in as each workspace's administrator (alice in
A, bob in B) through the normal REST API, so it does nothing a person could not do in the dashboard.

## What it sets up, and which check it is for

| Check | What the seed provides | Where it lives |
|---|---|---|
| P1, P2 | A [Response Processing](../../docs/response-processing.md) chain on `mock_supplier_list_offers`: `scale@1` (USD to EUR, 0.92), `vat@1` (0.19), `clean_text@1`, rounding to two decimals after each step. A price that is not a number stops the call with an error that names the path (`$.items[3].price_usd`). | `OFFER_CHAIN` in `scripts.mjs` |
| F1 to F4 | Three saved scripts with typed parameters, each offered to agents as a tool of its own name: `price_drift_check(threshold)`, `catalogue_total(category)`, `stuck_orders(days, as_of)`. | `SCRIPTS` in `scripts.mjs` |
| F5 | `supplier_account()`, a Level 3 script (`capabilities: { env, http }`): it reads the connector's variables and calls `GET /v1/account` directly, on the connector's own host only. The key is masked in everything the run returns. | `SCRIPTS` in `scripts.mjs` |
| F2 | The supplier's price lookup is a `POST`, so it is marked as a read-only tool (`PATCH .../tools/:id/annotations`). Scripts are read-only by default, and this is the existing way to say that one POST is a lookup. Every other POST stays a write. | `READ_ONLY_POST_TOOLS` |
| S1 to S3 | Nothing to seed. No credential is in any output, log or database row (the connector variables themselves are the one place the kit excludes). | |
| A1 to A13 | Nothing to seed; `scripts/codebound-cards/run.mjs` runs them. | [`../codebound-cards`](../codebound-cards/README.md) |

The connectors and tools a script calls are found from its code when it is saved, so the scripts list
no connector by hand (the Level 3 script, which calls no tool, names one tool to declare its connector).

## Settings that matter

| Setting | Why |
|---|---|
| `SSRF_ALLOWED_HOSTS` | The mock hosts are private addresses. The kit's override file sets it for Docker; in host mode use `localhost`. The outside host must **not** be listed. |
| `SANDBOX_MAX_CONNECTOR_CALLS` (default 500) | `stuck_orders` looks up each of 60 shipped orders at the carrier, so a run needs about 62 calls. |
| `SANDBOX_ALLOW_WRITES` (default off) | Not needed: nothing here writes. |

## Running without Docker

The kit starts its mocks in Docker, but they are plain Node: from the kit directory,
`MODE=mocks DATA_DIR=/tmp/cb-a node mocks/server.mjs` and `MODE=outside DATA_DIR=/tmp/cb-b node mocks/server.mjs`
start the same servers on the same ports. The kit's secret scan S3 reads the database through
`docker exec`; without Docker, dump the database with `pg_dump` (everything except `connectors`, then
`connectors` without `env_vars`) and search it for the credentials in `.codebound/state.json`.
