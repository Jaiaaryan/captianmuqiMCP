# Response Processing

Response Processing edits a tool's response **before** its
[Response Mapping](tool-definition.md#3-response-mapping-optional) selects from
it. Use it when the API returns the right data in the wrong shape: a price in
dollars that the agent needs in euros, a net price that needs VAT, a text field
with stray whitespace, a list with rows the agent should never see.

Each tool has its own chain of steps. A step reads one value, computes a new one
and writes it back. There are seven built-in steps and one scripted step
(`script@1`) for everything else.

```
connector  ->  Response Processing  ->  Response Mapping  ->  model
 (upstream)     (this page)              (select / exclude)
```

The chain runs on the raw upstream response. Whatever it produces is what
Response Mapping sees, so `select`, `exclude` and `include` paths refer to the
**processed** shape, including fields a step added. The audit log still records
the full upstream response.

A tool without a chain, or with the chain switched off, behaves exactly as
before.

- [Stored keys](#stored-keys)
- [Steps](#steps)
- [Write modes](#write-modes)
- [Validation](#validation)
- [Built-in steps](#built-in-steps)
- [Scripts](#scripts)
- [When a step refuses](#when-a-step-refuses)
- [Dashboard](#dashboard)
- [REST API](#rest-api)
- [Worked example](#worked-example)
- [Cloud and self-hosted](#cloud-and-self-hosted)

## Stored keys

The chain is stored in the tool's `responseMapping`, under `responseProcessing`,
next to `transform` and `cacheTtl`. It is saved with the tool editor's normal
**Update Tool** button, which sends the whole `responseMapping` through the tool
update route (`PUT /api/connectors/:connectorId/tools/:toolId`). A chain without
steps is not stored at all: the editor leaves the key out.

```json
{
  "responseMapping": {
    "responseProcessing": {
      "version": 1,
      "enabled": true,
      "onError": "fail",
      "steps": [ ]
    }
  }
}
```

| Key | Description |
|-----|-------------|
| `version` | Always `1`. |
| `enabled` | `true` or `false`; `false` keeps the chain stored without running it. |
| `onError` | `fail` or `passthrough` (the editor starts with `fail`). See [When a step refuses](#when-a-step-refuses). |
| `steps` | The steps, run in order. At most 20. |

All four keys are required.

Storing a chain is your statement that **the tool's response now has the new
shape**. When a tool update changes `responseProcessing` (added, removed or
edited in any way), the tool's advertised `outputSchema` is dropped, exactly as
it is when `transform` changes, because it described the old shape. The next
successful **Test** of the tool infers a new one from the processed (and
mapped) response. An update that sends the same chain again keeps the schema.
If you maintain the `outputSchema` by hand, set it again after changing the
chain.

## Steps

| Key | Required | Description |
|-----|----------|-------------|
| `id` | yes | Names the step in errors and in the preview. Letters, digits, `_` and `-`, starting with a letter or digit, at most 64 characters. Unique within the chain. |
| `use` | yes | `currency@1`, `scale@1`, `offset@1`, `vat@1`, `round@1`, `clean_text@1`, `truncate@1`, `map@1` or `script@1`; or a [pipe](#pipes): a list of built-ins. |
| `each` | no | A path such as `$.items[*]`. The step then runs once per matching element, and `reads` and `writes` are relative to that element. `[*]` walks the elements of an array and the values of an object (`$.prices[*]`). A path that ends on an array without `[*]` (`$.items`) means its elements too. Omitted, or `"$"`: the step runs on the whole response, or on each element when the response itself is an array. |
| `reads` | yes | Where to take the value from, relative to the element. `$` means the whole element (or the whole response). |
| `writes` | yes | Where to put the result, relative to the element. `$` replaces the whole element (or the whole response); with mode `add` it is refused at run time (the element always exists). Missing objects along the path are created. |
| `mode` | yes | `add`, `replace` or `upsert`. See [Write modes](#write-modes). |
| `onMissing` | no | `fail` (default) or `skip`. What to do when `reads` finds nothing. |
| `params` | no | The built-in's parameters. For a pipe, a list with one entry per processor in `use`. |
| `code` | `script@1` only | The script body. |

Paths use the same syntax as Response Mapping: keys, `['odd key']`, `[n]`,
`[*]`. `each` may use all of them; `reads` must address exactly one value (no
`[*]`), and `writes` must be a path of object keys (no `[*]`, no `[n]`).

### Pipes

`use` may list built-ins to apply one after the other to the value `reads`
found; the last result is written. `params` is then a list aligned with `use`
by index (omit it when every processor has defaults):

```json
{
  "id": "convert_to_eur",
  "use": ["scale@1", "round@1"],
  "each": "$.items[*]",
  "reads": "price_usd",
  "writes": "price_eur",
  "mode": "add",
  "params": [{ "factor": 0.92 }, { "decimals": 2 }]
}
```

A pipe holds 1 to 8 built-ins; `script@1` cannot be part of one (a script can
call the built-ins itself, see [Scripts](#scripts)). Each entry of `params` is
validated against its own processor (`step convert_to_eur: round@1:
params.decimals must be an integer between 0 and 10`), and a refusal at run
time names the processor that refused: `step convert_to_eur:
$.items[3].price_usd is not a number (round@1)`. A single `use` string with a
`params` object stays valid and means the same as before.

## Write modes

| Mode | Target (`writes`) | Use it to |
|------|-------------------|-----------|
| `add` | must **not** exist | Create a new field, for example `price_eur` next to `price_usd`. |
| `replace` | must exist | Change a field in place, for example tidy `description`. |
| `upsert` | may or may not exist | Write the field whichever way it arrives. |

The mode is a statement of intent, and a step that contradicts it refuses
instead of guessing. If the supplier starts sending `price_eur` itself, an `add`
step stops with an error rather than silently overwriting the supplier's value.
If a field disappears from the response, a `replace` step stops rather than
creating a field nobody asked for. Pick `upsert` only when you do not care.

`writes: "$"` always targets something that exists (the element itself), so it
cannot be combined with `add`: such a step refuses on its first element with
`already exists, and the mode is "add"`. Use `replace` or `upsert` for a script
that returns a whole new element or response.

## Validation

A chain is checked strictly, without running it, whenever a tool is created
(`POST /api/connectors/:connectorId/tools`, also in bulk) or updated
(`PUT .../tools/:toolId`), and by the editor's live check
(`POST /api/response-processing/validate`). The first problem refuses the save
with `400 Bad Request` and the message `Invalid response mapping: <problem>`,
for example:

```
Invalid response mapping: step x: params.decimals must be an integer between 0 and 10
```

What is refused:

- **Unknown keys**, on the chain (anything but `version`, `enabled`, `onError`,
  `steps`) and on a step (anything but the keys in the table above). A typo
  such as `onmissing` is an error, not a silently ignored field.
- `version` other than `1`, `enabled` that is not a boolean, an `onError` other
  than `fail` or `passthrough`, more than 20 steps, a step `id` that is
  malformed or used twice.
- A `use` that is not one of the eight processors.
- A path that does not parse, `[*]` in `reads` or `writes`, and `[n]` in
  `writes`. (`$` is accepted in `reads` and `writes` of every processor;
  `each: "$"` means the same as leaving `each` out.)
- A `mode` other than `add`, `replace`, `upsert`; an `onMissing` other than
  `fail`, `skip`.
- For a built-in: `code`, an unknown parameter (`unknown param "factr"
  (scale@1 accepts: factor, round)`), a missing required one, or a value of the
  wrong type or outside its bounds.
- For `script@1`: missing or empty `code`, `code` over 16 KB, `params` that are
  not JSON, and a syntax error (`step <id>: Unexpected token ')' (line 3)`).
  The code is compiled, never run.

Problems that depend on the data (a value that is not a number, a field that is
missing, an `add` onto an existing field) cannot be known at save time; they
show up in the [preview](#dashboard) and at call time.

## Built-in steps

| Step | Parameters | Result |
|------|------------|--------|
| `currency@1` | `rate` (number greater than 0), or `from` and `to` (ISO 4217 codes, 3 upper-case letters); at least one of the two. Both: `rate` wins | `value x rate`, always rounded to 2 decimals (money). Without `rate`, the rate is `from → to` in the [exchange-rate table](#exchange-rates) at run time |
| `scale@1` | `factor` (number, required); `round` (0 to 10, optional) | `value x factor` |
| `offset@1` | `amount` (number, required); `round` (0 to 10, optional) | `value + amount` |
| `vat@1` | `rate` (0 to 1, required); `round` (0 to 10, optional) | `value x (1 + rate)`. A rate of 19 % is `0.19`. |
| `round@1` | `decimals` (integer 0 to 10, default `2`) | `value` rounded to `decimals` places |
| `clean_text@1` | `trim`, `collapseWhitespace` (booleans, both default `true`) | The text, cleaned |
| `truncate@1` | `maxLength` (integer 1 to 100000, required); `ellipsis` (default `…`) | The text, shortened to at most `maxLength` characters |
| `map@1` | `map` (object, required); `fallback` (optional) | The mapped value |

`currency`, `scale`, `offset`, `vat` and `round` read a number, or an array/object of numbers: each value one level deep, same shape back (`step convert: $.prices['A-10339'] is not a number` names the entry that is not a number).

### Exchange rates

A `currency@1` step with `from` and `to` and no `rate` is **live**: each run
looks the pair up in the backend's table of euro reference rates (base EUR,
units of each currency per 1 EUR; `rate(from, to) = rates[to] / rates[from]`,
EUR being 1). A step with a `rate` is **manual**: the table is not consulted.
`{ "rate": 0.92 }` alone keeps working exactly as before. A pair the table does
not have fails the step: `step convert: no rate for USD→XAU`.

**The chain never calls the network.** A run uses whichever table is in effect
at that moment, read once per response. The backend keeps the table fresh
from the ECB daily feed
(`https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml`) out of band:
on the first need after boot and whenever the table is older than 24 hours
(5 s timeout, one fetch at a time, 15 minutes between attempts after a
failure), plus an hourly check. Every successful fetch is stored in site
settings (key `rp.rates`, `{ base, asOf, source, rates, updatedAt, updatedBy }`).
The effective table is, in order: the last fetch of this backend, the stored
one, then the snapshot shipped in the code
(`src/response-processing/rates-snapshot.ts`, ECB rates of 2026-10-17).

- `RP_RATES_AUTO=false` turns the automatic fetches off: an air-gapped install
  lives on the snapshot or the last stored table; an admin can still refresh.
- `RP_RATES_URL` replaces the feed URL (an operator-controlled mirror in the
  same ECB XML format). HTTPS only, same-host redirects only, 256 KB at most.
  The URL is fixed by the operator, not by a user, so it does not go through
  the connector SSRF allowlist (`SSRF_ALLOWED_HOSTS`).

In the editor, a Currency step reads `from [USD] to [EUR] rate [0.9200]`
(USD→EUR for a new step). Picking a pair fills the rate from the table and
stores only the pair, with the note `ECB · <date>` (the table's reference
date); typing a rate stores it and the note says `manual`; the `×` beside the
rate goes back to the table, and Esc in the rate field restores what it held.
Admins get a refresh button at the end of the row (`POST rates/refresh`); after
a failed refresh it turns red with the failure code as its tooltip.

Things that are easy to get wrong:

- **`round` has no default on `scale`, `offset` and `vat`.** Leave it out and the
  result keeps all its decimals (`54.67 x 0.92` is `50.3` after `round: 2`, and
  `50.2964` before). Only `round@1` defaults to 2 decimals.
- **Rounding is half away from zero**: `2.5` becomes `3` and `-2.5` becomes
  `-3`, not the banker's `2` and `-2`.
- **`clean_text@1` collapses first, then trims**, so `"  a   b  "` becomes
  `"a b"`.
- **`truncate@1` counts the ellipsis.** With `maxLength: 10` the result is nine
  characters of text plus `…`, never eleven characters. Text that already fits
  is left alone.
- **`map@1` compares as text.** The value is turned into its string form (`7`
  becomes `"7"`, `true` becomes `"true"`) and looked up in `map`, so write the
  keys as strings. Without a `fallback`, a value with no entry refuses; with
  one, the fallback is written instead.
- The numeric steps refuse a value that is not a number, such as `"n/a"`, and
  `clean_text@1` and `truncate@1` refuse a value that is not a string.
  Convert such values with a script first.
- `GET /api/response-processing/builtins` returns these contracts (type,
  bounds, defaults) as data; the editor builds its parameter fields from it.

## Scripts

`script@1` covers what the built-ins cannot: conditions, filtering rows,
combining fields. `code` is required, at most 16 KB.

`code` is the **body of a function**. `return` gives the result, which is
written to `writes`. There are two forms.

Per value, with `each` and a field to read and write:

```json
{
  "id": "clean_description",
  "use": "script@1",
  "each": "$.items[*]",
  "reads": "description",
  "writes": "description",
  "mode": "replace",
  "code": "return String(value).trim().replace(/\\s+/g, ' ');"
}
```

Whole response, with `reads` and `writes` both `$`:

```json
{
  "id": "keep_small_moq",
  "use": "script@1",
  "reads": "$",
  "writes": "$",
  "mode": "replace",
  "code": "return { ...response, items: response.items.filter((i) => i.moq <= 100) };"
}
```

**Available to the script**

| Name | Is |
|------|----|
| `value` | The value read by `reads` (with `reads: "$"`, the whole element or the whole response). |
| `params` | The step's `params` object (`null` without one). |
| `response` | The whole document the chain is working on, as it stands before this step. In a whole-response script (no `each`, `reads: "$"`) it is the same as `value`; in a per-element step it is still the whole response, so a script can look around the element. |
| `builtins` | The built-in processors as plain functions, frozen: `builtins.currency(value, { rate })` (or `rate`), `builtins.scale(value, { factor, round? })`, `builtins.offset(value, { amount, round? })`, `builtins.vat(value, { rate, round? })`, `builtins.round(value, decimals = 2)` (or `{ decimals }`), `builtins.clean_text(value, { trim?, collapseWhitespace? })`, `builtins.truncate(value, maxLength)` (or `{ maxLength, ellipsis? }`), `builtins.map(value, { map, fallback? })`. Same rounding and refusals as the steps: a wrong input throws `builtins.scale: value is not a number`. |

Each call gets a fresh context, so nothing a script leaves on the global object
reaches the next element. One isolate is reused for all elements of a step.
`builtins` is defined from source code inside each context, not handed in from
the backend, so it gives the script no way out of the isolate.

**Not available**: network, filesystem, timers, `require`, `process`,
`console`, the connector's tools and variables. A script cannot call anything
and cannot see credentials.

| Limit | Value |
|-------|-------|
| Memory | 32 MB per step |
| Time | 250 ms per call |
| Time, all scripts of one response | 2000 ms. A step over many elements runs the script once per element; once the scripts of a response have used 2 s together, the next call refuses. |
| Result | at most 1 MB, and it must be JSON |
| Code | at most 16 KB |

`GET /api/response-processing/builtins` reports the per-call limits under
`limits.script`; the 2000 ms budget per response is fixed.

The script is synchronous and runs in an isolate (`isolated-vm`) with nothing
shared with the backend.

**The code is stored in the tool's `responseMapping`.** Anyone who can edit the
tool can read it. Keep secrets out of scripts; there is nothing in the isolate
they could be used for anyway.

## When a step refuses

A step refuses instead of passing bad data on. The error names the step, the
path and the reason:

```
step convert_to_eur: $.items[3].price_usd is not a number
```

| Sentence | Cause |
|----------|-------|
| `step <id>: <path> is not a number` | A numeric step read a value that is not a number (`is not a string` for the text steps). |
| `step <id>: <path> is missing` | `reads` found nothing, or the `each` path does not exist, and `onMissing` is `fail`. |
| `step <id>: <path> is not an object, so nothing can be written under it` | `writes` runs through a value that is not an object. |
| `step <id>: <path> already exists, and the mode is "add"` | The target is already there. |
| `step <id>: <path> does not exist, and the mode is "replace"` | The target is not there. |
| `step <id>: <path> has no entry in the map ("7")` | `map@1` met a value without an entry and no `fallback`. The value is shown in quotes. |
| `step <id>: <path> script timed out (250 ms)` | One script call ran too long. |
| `step <id>: <path> script budget exceeded (2000 ms per response)` | The scripts of this response used their shared budget. |
| `step <id>: <path> script threw: <message>` | The script raised an error (`out of memory (limit 32 MB)` when it ran out of memory). |
| `step <id>: <path> script returned a non-JSON value` | `undefined`, a function, a symbol, `NaN`, a `Date` or another non-JSON value. |
| `step <id>: <path> script result too large (<n> bytes, limit 1048576)` | The result is over 1 MB. |

What happens next depends on `onError`:

| `onError` | Behavior |
|-----------|----------|
| `fail` | The tool call fails with `Response processing failed: ` and the sentence above. **No half-edited response is returned**: the agent gets the error or the complete result, never something in between. |
| `passthrough` | The raw response is returned as if there were no chain, and the reason is written to the log. Use it when a missing enrichment is better than a failed call. |

**`onMissing: "skip"`** turns "reads found nothing" from a refusal into a
no-op: the step does nothing for that element and the rest of the chain
continues. It covers only a missing read. A value of the wrong type, an `add`
onto an existing field and the other refusals still stop the chain.

## Dashboard

In **Connectors**, open a connector and press **Edit** on a tool. Response
Processing appears twice: as a **summary** on the connector page, below the
request fields and above Response Mapping, and as a **sheet** where the chain
is edited. Both show the same editor state; nothing is stored until you press
**Update Tool**.

**Summary (on the page).** A header row (the title, an **On / Off** switch, the
status, **On error** and **Open `⌘.`**) and one line per step: number, `id`,
the Input and where it writes (`items[*].price_usd → price_eur`; the Input
alone when the step writes where it reads, `prices[*]`), the processor (a pipe
reads `Scale › Round`) and the mode. An invalid step has a thin blue outline
and names the failing field (`✗ input`). Below the steps: **+ Step** and **Preview**. Clicking a step opens
the sheet on that step, expanded and scrolled into view; **+ Step** adds the
step and opens the sheet on it; **Preview** opens the sheet and runs the
preview. On narrow pages the paths are left out. With no
steps the summary is the header alone: the title, the switch and **+ Step**.

**Sheet.** It slides in from the right over the page (`min(1480px, 96vw)` wide,
the full width at 480 px and below), dims the page and keeps the focus inside
until it is closed. Closing never discards anything: the editor keeps the
chain, the sample, the preview and the collapsed cards. While it is open the
URL carries `#processing`, so a reload with the tool editor open brings it
back. Its header holds the breadcrumb (connector › tool › Response
Processing), the switch (`enabled`; adding the first step switches it on), the
status, an `unsaved` chip while the chain differs from the saved tool, **On
error** (**Fail** or **Pass through**, `onError`), **+ Step**, **Preview `⌘↵`**
and **Close `Esc`**. The status is `✓ N steps` once the server accepted the
chain, `✗ <step id>` for the first invalid step (the problem on hover), `…`
while the check runs and `—` when it could not be reached.

The sheet's layout follows its own width, not the window's:

| Sheet body width | Layout |
|------------------|--------|
| 1100 px and more | Steps on the left, the response tree on the right (it stays in view while you scroll) |
| 481–1100 px | One column, the tree under the steps with its header pinned at the top; **Input** and `writes` side by side, the type label and the note (`new field`, `= input`) under the value |
| 480 px and less | **Input** and `writes` stacked; the header takes two lines, **+ Step** and **Preview** become icons |

Below 720 px of sheet width **On error** moves into the header's `⋯` menu and
the key hints and the Close label are left out.

**Step cards.** One card per step. The title row holds a caret, the step's
number and its `id` (editable, never cut), the **processor** dropdown (the
seven built-ins and **Script**), the **mode** dropdown (`add`, `replace`,
`upsert`) and the `⋯` menu (**Duplicate**, **Move up**, **Move down**,
**Params** for a script, **On missing** `fail` / `skip`, **Delete**). Click the
title row to collapse a card to one line (number, id, the paths as in the
summary, processor, mode); `⌥`-click collapses or expands all. Collapsed cards stay
collapsed for the tool until the browser tab is closed; a new step is added
expanded. An invalid card has a thin blue outline.

Below the title: two path fields, **Input** and `writes`, then the
parameters of the built-in (number fields with the contract's bounds,
`true / false` dropdowns, text and JSON fields), the [pipe](#pipes) of built-ins
or, for a script, the code editor.

- **Input** is what the step works on: one path from the response, without
  `$.`. Beside it, in blue, its type in TypeScript-style notation (see the
  table below). No label without a sample or when the sample does not have
  the path. A new built-in step starts with an empty Input (`pick a field`).
- **`writes`** is relative to the element and follows the Input (`= input`)
  until it is given its own path; a path the element does not have is a `new
  field`. When the elements are scalars (`prices[*]` over numbers) nothing can
  be written under them: `writes` is the Input itself, the field is hidden and
  `= input` stays.
- **The mode follows `writes`**: `add` for a new field, `replace` for the Input
  or a field that exists, `upsert` when the sample cannot tell. A mode you pick
  yourself stays until a path change flips `writes` between a new field and an
  existing one; then it is derived again.

The Input is stored as `each` + `reads`, split at its last `[*]`. The type
label is `<element type>[<count>]` when the Input walks elements (`mixed` when
they differ), else the value's type: a scalar by name, a whole array
`array[<length>]`, a whole object `object{<keys>}`:

| Input | `each` | `reads` | Type label |
|-------|--------|---------|------------|
| `items[*].price_usd` | `$.items[*]` | `price_usd` | `number[30]` |
| `items[*]` | `$.items[*]` | `$` | `object[30]` |
| `prices[*]` | `$.prices[*]` | `$` | `number[99]` |
| `items` | (none) | `$.items` | `array[30]` |
| `prices` | (none) | `$.prices` | `object{99}` |
| `total` | (none) | `$.total` | `number` |
| `$` | (none) | `$` | `object{2}` |

A stored chain is shown the same way and saved unchanged until a path is
edited.

- **A pipe** shows its built-ins as chips (`Σ scale 0.92 › Σ round 2`): click a
  chip to edit its parameters or remove it, `+` adds a built-in (also after the
  parameters of a single built-in, which turns the step into a pipe).

**Picking from the response.** Click a path field and the response tree picks
for it: the field gets a blue ring and `pick in response →`. For the **Input**
every row can be picked: an array gives its elements (`items[*]`), an object
its values (`prices[*]`), a value its full path (`items[*].price_usd`,
`prices['A-10339']`, `total`) and the tree's header the whole response (`$`).
For `writes` only the fields of the current element stay bright (the whole
element too for a script), the element is highlighted and the rest is dimmed.
An object whose values are objects shows a `[*]` row with their merged keys
while the Input is picked, or while a step works on its values. Click a row to
fill the field; `Esc` leaves without a change. Typing in a path field offers
the keys of the current level (`.` goes one level down, arrays are offered as
`key[*].`); raw paths (`['odd.key']`, `[0]`, `prices[*]`) are accepted as
typed.

**The response tree** shows the tool's most recent recorded response as a
nested tree (type, key, a sample value or `N items` / `N keys`, with array
lengths from before the sample was cut). Fields written by the steps appear in
green with the step's number (`price_eur · 01`) and can be picked by later
steps. Hovering a row shows `+`: it adds a step with that row as its Input
(a list row: its elements; **Scale** for a number, **Clean text** for a
string, a script otherwise).

- **Run** opens a small form with the tool's parameters (filled from the
  recorded call) and calls the tool through the editor's test route with
  `recordSample: true`: the response becomes the tool's recorded sample.
- **Paste** takes JSON for the tree and the preview without storing anything
  (`pasted`).
- Without a recorded response the tree shows `no sample`, **Run** and **Paste
  JSON**.

**Code editor.** A script is edited in Monaco (loaded on demand; a text area
stands in until it is ready). It completes `value`, `response`, `params` and
`builtins`, typed from the sample and the step's Input; the hover
on `value` names its type and the helpers. A syntax error shows `✗ syntax`
(the message on hover). The editor never reads the system clipboard: paste-as
and drop-into are off, a plain paste needs no permission.

**Checks.** The panel first checks locally for an empty or duplicate id, an
empty Input, and empty or oversized code; such a card is outlined and
**Update Tool** stays disabled until it is fixed. When those pass and the
chain is on, it is sent to `POST /api/response-processing/validate` 400 ms
after the last change; the answer updates the status and outlines the
offending card. The same validation runs again when the tool is saved, and an
invalid chain is refused there with `Invalid response mapping: …`.

**Preview** (`⌘↵`) runs the chain as it is in the editor (switched on, even when
the switch says Off) against the recorded response, or the pasted one. It makes
no upstream call and stores nothing. The result is drawn into the tree: one row
per step with what it wrote, skipped and the size after it; new fields in
green, changed values as `old → new`. A refusal is one red row with the step,
the path and the reason; clicking a step row focuses that step.

| Shortcut | Does |
|----------|------|
| `⌘.` (`Ctrl+.`) | Open or close the sheet, from anywhere on the connector page while a tool editor is open |
| `⌘↵` (`Ctrl+↵`) | In the sheet: run the preview, also from the code editor and a path field |
| `⌘S` (`Ctrl+S`) | Save the tool (Update Tool), from the page or the sheet while a tool editor is open; nothing while the form is invalid or a save is running |
| `Esc` | In the sheet: leave pick mode or close the completion list, then close the preview, then close the sheet |
| `Tab` | In an empty script field: accept the example (`return value;`) |
| `⌥↑` / `⌥↓` | Move the step that holds the focus up or down; the focus stays on the same field |
| `⌥`-click on a card title | Collapse or expand all cards |

**Delete** removes the step at once and offers **Undo** (under the steps) for 5
seconds. As with every change in the tool editor, nothing is stored until you
close the sheet and press **Update Tool**.

## REST API

All routes need a signed-in user (the dashboard JWT) and are scoped to the
caller's active organization. The routes under `/tools/:toolId` also require
that the tool's connector belongs to that organization; a tool of another
organization answers `404 Tool not found`.

The `POST` routes answer `200 OK` (not `201`): they compute, they create
nothing. They run scripts, so a **viewer** gets `403 Forbidden` on them; the
`GET` routes are open to every role. A malformed body (no `chain` object, no
`sample`) is a `400`; a well-formed body with an invalid chain is a normal
answer with the problem in it.

| Route | Does |
|-------|------|
| `GET /api/response-processing/builtins` | `{ builtins, modes, limits }`: the contract of every built-in (`use`, `name`, `version`, `title`, `input`, `output`, `params` with `type`, `required`, `default`, `min`, `max`, `exclusiveMin`, `pattern`, and `requiresOneOf` when one of several param sets is needed, as for `currency@1`: `[["rate"], ["from", "to"]]`), the write modes and `limits: { maxSteps, script: { timeoutMs, memoryMb, maxCodeBytes, maxResultBytes } }`. |
| `GET /api/response-processing/rates` | The [exchange-rate table](#exchange-rates): `{ base: "EUR", asOf, source: "ECB", currencies (base first, then A–Z), rates, status: "live" \| "cached" \| "snapshot", auto, fetchedAt?, nextRefreshAt?, error? }`. `error` is the last fetch failure as a short code: `timeout`, `http_503`, `parse`, `network`, `too_large`, `redirect`, `url`, or `disabled` (`RP_RATES_AUTO=false` and nothing fetched). |
| `POST /api/response-processing/rates/refresh` | **Admin only**, at most 2 per minute. Fetches the feed now and answers like `GET rates`; a failed fetch is still `200`, with `error` set and the previous table kept. Stores the new table with `updatedBy` = the admin's user id. |
| `POST /api/response-processing/validate` | Body `{ chain }`. Answers `{ valid: true }` or `{ valid: false, problem }`, with the same rules as a tool save. |
| `POST /api/response-processing/dry-run` | Body `{ chain, sample }`. Runs the chain on the sample, always traced. Answers `{ ok, result?, steps: [{ id, wrote, skipped, bytes, sample? }], error?, failedStep?, failedPath? }`; `steps[].sample` is the first element after that step. An invalid chain answers `ok: false` with the validation problem as `error`. |
| `GET /api/response-processing/tools/:toolId` | The stored chain (`chain`, or `null`) and `sampleAvailable`. When a response has been recorded, also `sampleCapturedAt`, `sample` (that response, cut down for the editor), `sampleTruncated` (whether anything was cut), `sampleLengths` (the length of every array before the cut, by path: `{ "$.items": 30, "$.items[*].tiers": 3 }`) and `sampleInput` (the arguments of the recorded call). |
| `POST /api/response-processing/tools/:toolId/preview` | Body `{ chain?, sample? }`. A dry run, with the stored chain and the most recent recorded response as defaults. The answer has the dry-run fields plus `sampleSource` (`request` or `recorded`) and, for a recorded sample, `sampleCapturedAt`. Without a chain it answers `{ ok: false, error: "no chain" }`, without a sample `{ ok: false, error: "no sample" }`. |

**The sample in `GET tools/:toolId`** is the most recent successful call
recorded for the tool, as the upstream sent it (before any processing or
mapping). It feeds the editor's path pickers and code completions, so it is cut
to at most 64 KB: arrays to their first 3 elements, nesting to depth 8, strings
to 1024 characters. When that is still too large, tighter passes follow (one
array element and at most 200 keys per object with strings of 256 characters,
then depth 6 / 100 keys / 64 characters, depth 4 / 50 / 32, depth 2 / 20 / 16);
the first that fits wins, and when none does `sample` is `null`. Objects and
arrays below the depth limit become `{}` and `[]`, so their type stays visible.
Preview and dry runs use the full recorded response, never this cut.

**Recording a sample from the editor.** `POST
/api/connectors/:connectorId/tools/:toolId/test` takes an optional
`recordSample: true`. A successful run is then stored the way a real call is
(a successful invocation with the raw upstream response, bounded to 64 KB, and
its arguments), so it becomes the tool's most recent recorded response for
`GET tools/:toolId`, the preview and the Response Mapping preview; the answer
carries `sampleRecorded: true` (or `false` when storing failed, which never
fails the test). Without the flag a test stores nothing, as before. The row
also appears in the audit log, with `clientInfo.source:
"response-processing-sample"`.

There is no route to save a chain. It is part of `responseMapping`, saved with
the tool through `POST /api/connectors/:connectorId/tools` (and `/bulk`) or
`PUT /api/connectors/:connectorId/tools/:toolId`, which validate it as
described in [Validation](#validation) and answer `400` with
`Invalid response mapping: <problem>` when it is invalid. The `PUT` replaces the
whole `responseMapping`, so send `transform`, `cacheTtl` and the other keys
along with the chain.

## Worked example

The tool `mock_supplier_list_offers` returns prices in US dollars and a
description with stray whitespace. The agent needs euros, with and without
19 % VAT, and a clean description.

```json
{
  "responseMapping": {
    "responseProcessing": {
      "version": 1,
      "enabled": true,
      "onError": "fail",
      "steps": [
        {
          "id": "convert_to_eur",
          "use": "currency@1",
          "each": "$.items[*]",
          "reads": "price_usd",
          "writes": "price_eur",
          "mode": "add",
          "params": { "rate": 0.92 }
        },
        {
          "id": "add_vat",
          "use": "vat@1",
          "each": "$.items[*]",
          "reads": "price_eur",
          "writes": "price_eur_gross",
          "mode": "add",
          "params": { "rate": 0.19, "round": 2 }
        },
        {
          "id": "clean_description",
          "use": "clean_text@1",
          "each": "$.items[*]",
          "reads": "description",
          "writes": "description",
          "mode": "replace",
          "params": { "trim": true, "collapseWhitespace": true }
        }
      ]
    }
  }
}
```

An item as the supplier sends it, and as the agent receives it:

```json
{ "price_usd": 54.67, "description": "  Black Screw   60mm" }
```

```json
{
  "price_usd": 54.67,
  "price_eur": 50.3,
  "price_eur_gross": 59.86,
  "description": "Black Screw 60mm"
}
```

`54.67 x 0.92` is `50.2964`, rounded to `50.3`; `50.3 x 1.19` is `59.857`,
rounded to `59.86`. The VAT step reads the **rounded** `price_eur`, because that
is the value the chain holds at that point.

If the fourth item has `"price_usd": "n/a"`, the call fails with

```
step convert_to_eur: $.items[3].price_usd is not a number
```

and nothing is returned. With `"onError": "passthrough"` the agent would get the
untouched response instead.

The `clean_description` step can also be written as a script; the result is the
same:

```json
{
  "id": "clean_description",
  "use": "script@1",
  "each": "$.items[*]",
  "reads": "description",
  "writes": "description",
  "mode": "replace",
  "code": "return String(value).trim().replace(/\\s+/g, ' ');"
}
```

After the chain, Response Mapping works on the new shape, so a `select` can use
`$.items[*].price_eur_gross`. Saving the chain drops the tool's `outputSchema`;
the next successful **Test** infers a new one that includes the two new fields.

## Cloud and self-hosted

Response Processing behaves the same in both deployment modes: the same steps,
the same limits, the same storage, the same summary and sheet in the dashboard. Nothing in it depends on `DEPLOYMENT_MODE`,
and it needs no extra configuration or service, because scripts run in an
isolate inside the backend. The exchange-rate table is the same too: both fetch
the ECB feed by themselves unless `RP_RATES_AUTO=false`.
