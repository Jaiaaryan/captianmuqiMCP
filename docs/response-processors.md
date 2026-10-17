# Response processor chains

> Editing a tool's response before the model sees it: convert a currency, add
> VAT, clean a description, translate a status code.

[Back to README](../README.md)

---

A tool answers in the shape the upstream system happens to use. The price comes
back in USD when the workspace invoices in EUR. The amount is net when the
person asking wants gross. The description arrives full of newlines and double
spaces because somebody pasted it out of a Word document. The status is `2`.

None of that is wrong upstream, and none of it is what the agent needs. Today
each of those is fixed downstream: in the system prompt, again in every script,
again by every agent, on every call — or not at all, and the model guesses or
quietly reports a USD number as euros. A **response processor chain** fixes it
once, on the tool, for every client of that tool.

A chain is configuration, not code. It is stored on the tool as
`responseMapping.processors`, it is a list of steps, and each step names one
versioned processor from a fixed registry. There is no expression language and
nothing is executed: a processor is a pure function of one value and its
declared parameters.

- [Where a chain runs](#where-a-chain-runs)
- [A worked example](#a-worked-example)
- [The keys](#the-keys)
- [Write modes](#write-modes)
- [The processors](#the-processors)
- [When a step refuses a value](#when-a-step-refuses-a-value)
- [Versions](#versions)
- [Setting up a chain](#setting-up-a-chain)
- [What a processor may do](#what-a-processor-may-do)
- [Limits](#limits)
- [What a chain cannot do](#what-a-chain-cannot-do)
- [Troubleshooting](#troubleshooting)
- [Cloud and self-hosted](#cloud-and-self-hosted)

## Where a chain runs

```
upstream response  →  processor chain (edits)  →  response mapping (selects)  →  MCP client
                      responseMapping.processors   responseMapping.transform
```

The chain runs first, on what the upstream system actually answered, and the
[response mapping](tool-definition.md#3-response-mapping-optional) then shapes
what is left.

The difference is the whole reason both exist: a mapping can only **drop or
rename what is already there**, while a chain can **change a value**. No
`select` template and no JMESPath expression in a mapping turns 100 USD into
92 EUR; a chain does, and then the mapping can select the field the chain
wrote.

A tool with neither configured returns the upstream response untouched, the same
object by the same reference. A chain edits a private copy, so the response
object the connector produced is never mutated in place.

## A worked example

Three steps on a tool that returns `{ "items": [ … ] }`, where each item has
`price_usd` and a `description`:

```json
{ "version": 1,
  "steps": [
    { "id": "convert_to_eur", "processor": "number_scale@1", "each": "$.items[*]",
      "reads": "price_usd", "writes": "price_eur", "mode": "add",
      "params": { "factor": 0.92, "round": 2 } },
    { "id": "add_vat", "processor": "number_vat@1", "each": "$.items[*]",
      "reads": "price_eur", "writes": "price_eur_gross", "mode": "add",
      "params": { "rate": 0.19, "round": 2 } },
    { "id": "clean_description", "processor": "text_clean@1", "each": "$.items[*]",
      "reads": "description", "writes": "description", "mode": "replace" } ] }
```

What each step does:

- **`convert_to_eur`** runs `number_scale@1` over every element of
  `$.items[*]`. It reads each element's `price_usd`, multiplies it by `0.92`,
  rounds to 2 decimals, and writes the result to a **new** field `price_eur`
  (`mode: "add"` — the field must not exist yet).
- **`add_vat`** runs `number_vat@1` over the same elements. It reads
  `price_eur` — the field the previous step wrote — multiplies by `1 + 0.19`,
  rounds to 2 decimals and adds `price_eur_gross`.
- **`clean_description`** runs `text_clean@1` over the same elements, reads
  `description`, collapses every run of whitespace into one space, trims the
  ends, and writes the result back over `description` (`mode: "replace"` — the
  field must already exist).

Two things follow from the order.

**Steps run in sequence, over the document as the previous step left it.** That
is why `add_vat` can read `price_eur`: at that point it exists. Reverse the two
steps and `add_vat` fails, because `price_eur` is not there yet.

**Each step rounds on its own**, so the gross price is computed from the
*rounded* net price rather than from the full-precision product — the way an
invoice does it, where the net line is a published number and the tax is
charged on it. If you want the gross figure derived from the unrounded
conversion instead, leave `round` off the first step and round at the end with
`number_round@1`.

## The keys

The chain object, stored under `responseMapping.processors`:

| Key | Default | Meaning |
|-----|---------|---------|
| `steps` | — | The steps, in order. Required. |
| `version` | — | Config format version. Only `1` exists; any other value is rejected. |
| `enabled` | `true` | `false` keeps the chain on the tool without running it. |
| `onError` | `"fail"` | `fail`: a refused value fails the tool call. `passthrough`: return the unedited response and log the reason. See [When a step refuses a value](#when-a-step-refuses-a-value). |

One step:

| Key | Default | Meaning |
|-----|---------|---------|
| `id` | — | Name of the step: letters, digits, `-` and `_`, unique within the chain, at most 64 characters. It appears in every error and in the step-by-step preview, so name it after the intent (`convert_to_eur`), not after the processor. |
| `processor` | — | A registry entry: `number_scale@1` (that version) or `number_scale` (the newest version — see [Versions](#versions)). |
| `each` | — | The collection the step runs over, as a path into the response (`$.items[*]`). Every element gets the step. Omit it to run the step once on the whole response — or, when the response is itself a top-level array, once per element of it. |
| `reads` | — | The field the processor reads, relative to each element (`price_usd`, `pricing.net`). It must address exactly one value: no wildcards. |
| `writes` | — | The field the result is written to, relative to each element. Object keys only — no wildcards and no array indices. A nested path (`pricing.gross`) is allowed, and the intermediate objects are created when the mode permits it. |
| `mode` | `upsert` | `add`, `replace` or `upsert`. See [Write modes](#write-modes). |
| `params` | — | The processor's parameters, checked against its declared contract. An unknown parameter name is rejected at save time, not ignored at call time. |
| `onMissing` | `fail` | What to do when `reads` is not present on an element: `fail` the call, or `skip` that element and leave it alone. |

Paths in `each` and `reads` accept `$.a.b`, `a[0].b`, `a[*].b` and
`a['weird.key']`; a leading `$.` is optional. The segments `__proto__`,
`constructor` and `prototype` are refused.

`each` pointing at a collection means its elements: `each: "$.items"` behaves
like `each: "$.items[*]"`. A path that already picked its elements with `[*]` or
`[3]` is taken as final.

## Write modes

The mode is not a convenience. It is a statement of intent that the chain
enforces on every call, so the configuration keeps telling the truth after the
upstream API changes.

| Mode | The target field | Fails when |
|------|------------------|------------|
| `add` | Must not exist yet | The field is already there |
| `replace` | Must already exist | The field is not there |
| `upsert` | Either. The default | — |

A step written as `add` says "this field is mine, I am introducing it". The day
the upstream API starts returning a `price_eur` of its own, that step fails
loudly instead of silently overwriting a real value from the vendor with a
conversion of your own — which is exactly the kind of thing nobody notices for
a quarter. A step written as `replace` says "I am correcting a field that
exists", and tells you when the field disappears. `upsert` says you do not care,
and is the right choice when you genuinely do not.

## The processors

Every processor a step may name. `GET /api/processors` returns the same list at
runtime, including descriptions, and is what the dashboard and an agent read
before writing a chain.

| Processor | Reads | Writes | Parameters |
|-----------|-------|--------|------------|
| `number_scale@1` | number | number | `factor` (number, **required**) — what the value is multiplied by, `0.92` for USD → EUR. `round` (integer, 0–10) — decimal places; omit to keep full precision. |
| `number_offset@1` | number | number | `amount` (number, **required**) — added to the value, for a flat fee or handling charge. `round` (integer, 0–10). |
| `number_vat@1` | number (net) | number (gross) | `rate` (number, **required**, 0–1) — the tax rate as a fraction, `0.19` for 19%; the result is `value × (1 + rate)`. The upper bound of 1 is there to refuse the common typo of `19` for 19% when the chain is saved; a markup above 100% is a `number_scale` factor, which is deliberately unbounded. `round` (integer, 0–10). |
| `number_round@1` | number | number | `decimals` (integer, default `2`, 0–10) — decimal places to keep. |
| `text_clean@1` | string | string | `trim` (boolean, default `true`) — remove leading and trailing whitespace. `collapseWhitespace` (boolean, default `true`) — replace every run of whitespace, newlines and tabs included, with a single space. |
| `text_truncate@1` | string | string | `maxLength` (integer, **required**, 1–100000) — longest result, including the ellipsis. `ellipsis` (string, default `…`) — appended when the text had to be cut. |
| `value_map@1` | any | any | `map` (object, **required**) — lookup table whose keys are the incoming value as a string, for turning upstream status codes into words (`"2"` → `"shipped"`). `fallback` (string) — used when the value is not in the table; without it an unmapped value fails the step. |

Notes that are easy to get wrong:

- `round` on the numeric processors has **no default**. Omit it and the result
  keeps full floating-point precision, fractions of a cent included.
- Rounding is half **away from zero**, so `-0.005` at two decimals becomes
  `-0.01`, the way an invoice rounds rather than the way `Math.round` does.
- `text_clean@1` collapses before it trims, so a value that was nothing but
  whitespace ends up as the empty string rather than as a single space.
- `text_truncate@1` counts the ellipsis inside `maxLength`. An `ellipsis` at
  least as long as `maxLength` is dropped and the text is simply cut.
- `value_map@1` compares the incoming value as a string, and a non-string value
  by its JSON form, so `2` and `"2"` both match the key `"2"` but `true`
  matches `"true"`.

## When a step refuses a value

A half-edited response is worse than none. A document in which some prices were
converted and others were not is a document no model can reason about and no
operator can spot, so the chain refuses to produce one.

When any step refuses a value, the tool call fails with a message that names
the step and the JSON path of the offending value:

```
step convert_to_eur: $.items[0].price_usd is not a number
```

and the half-edited copy is thrown away. The call carries the error; the model
never receives a partially converted document. The same sentence shape covers
the other refusals:

| Message | Means |
|---------|-------|
| `$.items[0].price_usd is not a number` | The processor reads a number and got something else. |
| `$.items[0].name is not a string` | A text processor got a non-string. |
| `$.items[0].price_usd is missing` | `reads` is not present on that element and `onMissing` is `fail`. |
| `$.items[0].state has no entry in the map ("7")` | `value_map@1` without a `fallback` met an unmapped value. |
| `$.items[0].price_eur already exists, and the mode is "add" — use "replace" or "upsert"` | The upstream response now has the field the step meant to introduce. |
| `$.items[0].price_eur does not exist, and the mode is "replace" — use "add" or "upsert"` | The field the step meant to correct is gone. |

Two opt-outs, for two different situations:

- **`onMissing: "skip"`**, on a step, for a field that is genuinely optional.
  That element is left alone and counted as `skipped` in the preview; the rest
  of the collection is still edited.
- **`onError: "passthrough"`**, on the chain, when a working tool must never
  break. The unedited response is returned, the mapping still runs on it, and
  the reason is carried out to the log as a warning. Use it knowing the trade:
  the client gets prices in the original currency with no sign in the response
  that anything was skipped.

A chain is validated against the registry **before** it can be stored, from the
dashboard, the REST API and the MCP tool alike. An unknown processor, a
misspelled parameter, a duplicate step id or an unparseable path is a `400` at
save time rather than a surprise on the next call.

## Versions

A step names a version: `number_scale@1`. The version belongs to the
processor's behaviour, not only to its parameters — if the rounding rule or the
treatment of an edge case ever changes, that ships as `number_scale@2`
alongside version 1, and every stored chain that said `@1` keeps returning the
numbers it returned yesterday.

Naming a processor without a version (`number_scale`) resolves to the newest
version at call time. **Pin the version** in anything you store. An invoice
total that changes because a registry entry was improved is a support case, not
an improvement.

## Setting up a chain

Three ways in, all writing the same `responseMapping.processors` object, all
validated by the same check.

### In the dashboard

The tool editor has a response processor panel next to **Response Mapping**:
add steps, pick a processor, fill in its parameters, and preview the chain
**step by step** against the tool's most recent real response — what each step
touched, how many elements it wrote to and skipped, how large the document was
after it, and a sample element. If a step refuses a value you get the same
`step …: $… ` sentence, with the failing step and path, before the chain is
stored anywhere.

### Over the REST API

The registry is per installation and needs nothing but a signed-in user:

| Route | Does |
|-------|------|
| `GET /api/processors` | Every processor with its version, input and output types and parameters, the three write modes, and the chain limits. |
| `POST /api/processors/validate` | Checks a `processors` object against the registry and returns `{ valid }` or the first problem. No tool involved, so a chain can be checked while it is being written. |
| `POST /api/processors/dry-run` | Runs a `processors` chain over a `sample` response from the request body and returns the result, what each step touched and the before/after byte sizes. No tool and no connector, so a chain can be worked out from a pasted response before a tool is picked. |

The per-tool routes are under `/api/connectors/:connectorId/tools/:toolId` and
need write access to the connector:

| Route | Does |
|-------|------|
| `GET :toolId/response-mapping` | The stored `transform` and `processors` (either may be null), `active` / `processorsActive`, and whether a recent real response is available to preview against (`sampleAvailable`, `sampleCapturedAt`). |
| `PATCH :toolId/response-mapping` | Stores `transform` and/or `processors`, leaving `cacheTtl` and `followUp` alone. `processors: null` removes the chain; **omitting** `processors` leaves the stored chain as it is, because the dashboard edits the two in separate panels and a mapping save must not drop a chain the other panel owns. |
| `POST :toolId/preview-mapping` | Runs the chain and then the transform against a sample and returns `raw`, `mapped`, the byte sizes, `processorSteps`, and `processorError` or `mappingError` separately — what the client would really receive. |
| `POST :toolId/preview-processors` | The step-by-step view: runs **only** the chain and returns the result after every step, so what each step did is visible on its own. On a refusal: `error`, `failedStep` and `failedPath`. |

Both preview routes use the request's `sample` when there is one, and otherwise
the most recent real response recorded for that tool (`sampleSource` says
which). With neither they answer `ok: false` and ask you to run the tool once.
Nothing is stored by either.

Storing a chain clears the tool's advertised `outputSchema`, because that schema
described the previous shape of the response.

### From an agent over MCP

An agent that may already change the connector through the dashboard — its
owner, or an admin of the organization — is offered four tools on its own MCP
server. Nobody else sees them, so no call has to be refused on authority
grounds. A pure API-key session, which has no user, can edit nothing.

| Tool | Does |
|------|------|
| `response_chain_processors` | Lists the processors with what each reads, writes and takes, the chain shape, the write modes, the limits and a worked example. Read-only. |
| `response_chain_get` | Shows the chain currently stored on a named tool of this server, whether it is active, whether this caller may change it, and whether a recorded response is available. Read-only. |
| `response_chain_preview` | Tries a chain on a tool without storing it: the response after every step, the size after each, and on a refusal the step and the JSON path. Uses the tool's most recent real response unless a `sample` is passed. Read-only — this is where an agent iterates. |
| `response_chain_set` | Stores the chain on the tool. From the next call that tool's response is edited for **every** client, not only for this session. `steps: null` removes the chain. |

A realistic run, on a tool called `shop_list_items` that returns USD prices and
messy descriptions:

1. The agent calls `response_chain_processors` and finds `number_scale`,
   `number_vat` and `text_clean`, with their parameters.
2. It calls `response_chain_get { toolName: "shop_list_items" }`: no chain
   stored, `editable: true`, and a response was recorded earlier, so there is
   something to preview against.
3. It calls `response_chain_preview` with the three steps of the worked example
   above. The reply is `ok: false`:
   `step clean_description: $.items[7].description is missing` — one item in
   the recorded response has no description at all.
4. The description is genuinely optional, so the agent previews again with
   `onMissing: "skip"` on that step. This time the preview returns the edited
   items with `price_eur` and `price_eur_gross`, and the trace reports 12
   elements written and 1 skipped for `clean_description`.
5. It calls `response_chain_set` with the steps it just previewed. The reply
   confirms the stored chain and says that every client of the tool now
   receives the edited response.

Steps 3 and 4 are the point of the preview: the iteration happens against a
real recorded response, and nothing is stored until it is right.

If several connectors on the server have a tool of that name, the MCP tools
refuse to guess and send you to the dashboard, where the connector is
unambiguous.

## What a processor may do

A processor is a pure function from one value and its declared parameters to one
value. That is the entire capability, and it is what makes a chain safe to run
on every call and safe to let an agent write.

A processor **cannot**:

- evaluate an expression or execute code — there is no expression language here,
  and a step is data;
- read another field of the element, or anything else in the response;
- call a tool, the MCP server, or any other processor;
- reach the network or the file system;
- see connector credentials;
- keep state between the elements of a collection, or between calls.

Around that:

- A chain is checked against the registry before it is stored, so what runs on
  the next call is a chain whose processors, parameters and paths were all
  resolved at save time.
- `each`, `reads` and `writes` are parsed by a hand-written scanner with no
  backtracking, and the segments `__proto__`, `constructor` and `prototype` are
  refused, so neither an operator-written path nor an upstream key can reach
  `Object.prototype`.
- The chain edits a private copy of the response, so a failure cannot leave a
  partially edited object behind for anything else to read.
- `response_chain_set` is offered only to a caller who may already change the
  connector's configuration, and only for tools of that MCP server that
  survived the caller's role filter.

## Limits

Bounded work, so that neither a pathological response nor a careless chain can
pin a worker. These are fixed in the code, not configurable, and
`GET /api/processors` reports them.

| Limit | Value |
|-------|-------|
| Steps in one chain | 20 |
| Elements one step may run over | 100,000 |
| Characters in a path (`each`, `reads`, `writes`) | 200 |
| Segments in a path | 16 |
| Characters in a step `id` | 64 |

Exceeding the element cap fails the call the same way a refused value does:
`step <id>: the response has more than 100000 elements to process`.

## What a chain cannot do

A chain edits **one tool's own answer**. It cannot:

- join or combine two tools' responses;
- fetch anything — another endpoint, a rate from a currency API, a lookup table
  from a file;
- filter, sort, group or aggregate a collection (the response mapping's
  `include`, `exclude`, `select` and JMESPath `expression` cover selecting and
  reshaping);
- decide anything conditionally beyond `value_map@1`'s lookup table.

That is what [code mode](sandbox-code-mode.md) is for. A script calls tools and
computes an answer across them; a chain edits one tool's answer in place. They
are two halves of the same idea at different levels, and the cheap one is worth
trying first: a chain is declarative, needs no sandbox, and runs on every call
for every client without an agent in the loop.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| The chain seems to do nothing: the response is unchanged and no error is raised | `enabled: false` on the chain, or `each` matches nothing — check the path against a real response with `POST :toolId/preview-processors`, which reports `targets: 0` for a step that found no elements. A step that found elements but wrote to none shows `written: 0`. |
| Every call to the tool now fails | The upstream response sometimes omits the field, or returns it as a different type. The error names the step and the exact path; set `onMissing: "skip"` on that step when the field is genuinely optional, or narrow `each` to the elements that carry it. |
| A step with `mode: "add"` started failing with "already exists" | The upstream API now returns that field itself. Decide which value is the right one: keep theirs and remove the step, or take yours and switch the step to `replace` or `upsert`. The failure is the mode doing its job. |
| `value_map@1` fails on a value that was fine last week | A new upstream status code. Add it to `map`, or give the step a `fallback` so an unknown code becomes a known placeholder instead of failing the call. |
| A later step cannot find what an earlier one wrote | The steps are in the wrong order, or the second step's `each` resolves to different elements than the first's. Steps see the document as the previous step left it, and only that. |
| The preview says no sample is available | No response has been recorded for the tool yet. Run it once (**Test** on the tool, or from a connected client), or pass a `sample` in the request body. |

## Cloud and self-hosted

Response processor chains behave the same in both deployment modes: the same
registry, the same limits, the same validation, the same storage on the tool.
Nothing in the feature reads `DEPLOYMENT_MODE`, and it needs no extra service.

One environment variable affects it. `PROCESSOR_CHAIN_MCP_TOOLS=false` stops
the four `response_chain_*` MCP tools from being offered, so chains can only be
written by a person — through the dashboard or the REST API. Anything other
than exactly `false` leaves them on. It is read on the host, so no tool
argument and no REST field can turn it on or off.
