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
| `use` | yes | `scale@1`, `offset@1`, `vat@1`, `round@1`, `clean_text@1`, `truncate@1`, `map@1` or `script@1`. |
| `each` | no | A path such as `$.items[*]`. The step then runs once per matching element, and `reads` and `writes` are relative to that element. A path that ends on an array without `[*]` (`$.items`) means its elements too. Omitted, or `"$"`: the step runs on the whole response, or on each element when the response itself is an array. |
| `reads` | yes | Where to take the value from, relative to the element. `$` means the whole element (or the whole response); `script@1` only. |
| `writes` | yes | Where to put the result, relative to the element. `$` replaces the whole element (or the whole response); `script@1` only. Missing objects along the path are created. |
| `mode` | yes | `add`, `replace` or `upsert`. See [Write modes](#write-modes). |
| `onMissing` | no | `fail` (default) or `skip`. What to do when `reads` finds nothing. |
| `params` | no | The built-in's parameters. |
| `code` | `script@1` only | The script body. |

Paths use the same syntax as Response Mapping: keys, `['odd key']`, `[n]`,
`[*]`. `each` may use all of them; `reads` must address exactly one value (no
`[*]`), and `writes` must be a path of object keys (no `[*]`, no `[n]`).

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
- A path that does not parse, `[*]` in `reads` or `writes`, `[n]` in `writes`,
  and `$` in `reads` or `writes` of a built-in step. (`each: "$"` is accepted
  and means the same as leaving `each` out.)
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
| `scale@1` | `factor` (number, required); `round` (0 to 10, optional) | `value x factor` |
| `offset@1` | `amount` (number, required); `round` (0 to 10, optional) | `value + amount` |
| `vat@1` | `rate` (0 to 1, required); `round` (0 to 10, optional) | `value x (1 + rate)`. A rate of 19 % is `0.19`. |
| `round@1` | `decimals` (integer 0 to 10, default `2`) | `value` rounded to `decimals` places |
| `clean_text@1` | `trim`, `collapseWhitespace` (booleans, both default `true`) | The text, cleaned |
| `truncate@1` | `maxLength` (integer 1 to 100000, required); `ellipsis` (default `…`) | The text, shortened to at most `maxLength` characters |
| `map@1` | `map` (object, required); `fallback` (optional) | The mapped value |

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
| `response` | Another name for `value`. It reads naturally in a whole-response script (no `each`, `reads: "$"`), where the two are the whole response; in a per-element step it is the element's value too, not the whole response. |

Each call gets a fresh context, so nothing a script leaves on the global object
reaches the next element. One isolate is reused for all elements of a step.

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

In **Connectors**, open a connector and press **Edit** on a tool. The
**Response Processing** panel sits above Response Mapping.

With no steps it is one line: the title, an **On / Off** dropdown and
**+ Step**. Adding the first step switches the chain on. With steps the panel
shows:

- **A header** with the **On / Off** dropdown (`enabled`), a status chip and,
  on the right, the **On error** dropdown: **Fail** or **Pass through**
  (`onError`). The chip reads `N steps` when the server accepted the chain,
  the offending step's id (or `#n` when it has none) when a step is invalid,
  `…` while the check is running, `—` when the check could not be reached and
  `no sample` after a preview that found no recorded response. With the chain
  switched off there is no chip; the steps stay visible, dimmed.
- **One row per step.** The first line holds the step's `id` (a text field),
  the **processor** dropdown (the seven built-ins under *Built-in*, **Script**
  under *Script*), the **each** picker (placeholder `$.items[*]`), the
  **reads → writes** pickers, the **mode** dropdown (`add`, `replace`,
  `upsert`) and the `⋯` menu. Changing the processor of a step resets its
  parameters to the new processor's defaults.
- **The second line** of a built-in step has one field per parameter, built
  from the contract: number fields (with the contract's bounds), a
  `true / false` dropdown for booleans, a text field for strings and a JSON
  one-liner for objects (`map`). A script step has a code editor instead, a
  syntax mark (a check when the code parses, `✗ syntax` with the message on
  hover when not) and a `{} params` button that opens a JSON one-liner for the
  script's `params`. The row's problems, if any, are listed at the end of the
  line.
- **The `⋯` menu** of each step: **Duplicate** (inserted below, with a fresh
  id), **Move up**, **Move down**, an **On missing** group with **fail** and
  **skip** (`onMissing`; a `skip` label appears on the row while it is set) and
  **Delete**.
- **A footer** with **+ Step** and **Preview `⌘↵`**. **+ Step** offers the
  seven built-ins and three script templates: **Convert** (a rate in
  `params`), **Clean** (trim and collapse whitespace) and **Filter** (a
  whole-response script, `reads` and `writes` set to `$`, mode `replace`). It
  is disabled at 20 steps. A new step gets an id derived from the processor
  (`scale`, `scale_2`, …), mode `add` and the default parameters, and focus
  moves to its **reads** picker.

**Path pickers.** When the tool has a recorded response, `each`, `reads` and
`writes` open a tree of that response instead of a plain text field. `each`
lists objects and arrays as absolute paths (`$.items[*]`); `reads` and `writes`
list the fields of the first element of the step's `each`, relative to it, with
each field's type and a short preview of its value. `reads` can descend into
arrays (`lines[0].qty`), `writes` cannot. For a script step the first entry is
`$`, the whole element. The text box at the top of the tree accepts a path the
sample does not contain, for example a new field to `add`. Without a recorded
response the pickers are plain text fields.

| Key (in a path picker) | Does |
|------------------------|------|
| `↑` / `↓` | Move through the tree |
| `→` | Expand the node, or move to its first child |
| `←` | Collapse the node, or move to its parent |
| `Home` / `End` | First / last node |
| `↵` | Take the highlighted node, or the typed path when nothing is highlighted |
| `Esc` / `Tab` | Close without changing the value |

**Code editor.** A script's code is edited in Monaco (loaded on demand; a plain
text area stands in until it is ready). It offers completions for `value`,
`response` and `params`, typed from the recorded response and the step's `each`
and `reads`: with `each: "$.items[*]"` and `reads: "price_usd"`, `value` is a
`number`, and the fields of the response complete after `response.`. The editor
grows from 6 to 20 lines and shows line numbers past 20. A top-level `return`
is not flagged, since the code is a function body. (`response` is the whole
document the chain is working on, both in the editor and at run time, see
[Scripts](#scripts).)

**Checks.** The panel first checks locally for an empty or duplicate id, an
empty `reads` or `writes`, and empty or oversized code; such a row is marked
and **Update Tool** stays disabled until it is fixed. When those pass and the
chain is on, it is sent to `POST /api/response-processing/validate` 400 ms
after the last change. The answer only updates the chip and marks the
offending row; the same validation runs again when the tool is saved, and an
invalid chain is refused there with `Invalid response mapping: …`.

**Preview** runs the chain as it is in the editor (switched on, even if the
dropdown says Off) against the tool's most recent recorded response. It needs a
saved tool with at least one successful call recorded in the audit log (a real
call through MCP; the editor's **Test** button does not record one); otherwise
the chip reads `no sample`. It makes no call to the upstream API and stores nothing. It lists
every step with how many elements it wrote and skipped and the size of the
response after it, followed by what changed in the first element (added fields,
`before → after` for changed ones, removed fields struck through; at most 8
lines per step). On a refusal it shows the failing step, the path and the reason
in one line. Clicking a step in the result, or the failure line, focuses that
step's row.

| Shortcut (in the panel) | Does |
|-------------------------|------|
| `⌘↵` (`Ctrl+↵`) | Run the preview, also from inside the code editor and a path picker |
| `Esc` | Close the preview result; in an open dropdown, menu or picker, close it |
| `⌥↑` / `⌥↓` | Move the step that holds the focus up or down; the focus stays on the same field |

**Delete** removes the step at once and offers **Undo** for 5 seconds. After
that the step is gone from the editor; as with every change in the tool editor,
nothing is stored until you press **Update Tool**.

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
| `GET /api/response-processing/builtins` | `{ builtins, modes, limits }`: the contract of every built-in (`use`, `name`, `version`, `title`, `input`, `output`, `params` with `type`, `required`, `default`, `min`, `max`), the write modes and `limits: { maxSteps, script: { timeoutMs, memoryMb, maxCodeBytes, maxResultBytes } }`. |
| `POST /api/response-processing/validate` | Body `{ chain }`. Answers `{ valid: true }` or `{ valid: false, problem }`, with the same rules as a tool save. |
| `POST /api/response-processing/dry-run` | Body `{ chain, sample }`. Runs the chain on the sample, always traced. Answers `{ ok, result?, steps: [{ id, wrote, skipped, bytes, sample? }], error?, failedStep?, failedPath? }`; `steps[].sample` is the first element after that step. An invalid chain answers `ok: false` with the validation problem as `error`. |
| `GET /api/response-processing/tools/:toolId` | The stored chain (`chain`, or `null`) and `sampleAvailable`. When a response has been recorded, also `sampleCapturedAt`, `sample` (that response, cut down for the editor) and `sampleTruncated` (whether anything was cut). |
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
          "use": "scale@1",
          "each": "$.items[*]",
          "reads": "price_usd",
          "writes": "price_eur",
          "mode": "add",
          "params": { "factor": 0.92, "round": 2 }
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
the same limits, the same storage. Nothing in it depends on `DEPLOYMENT_MODE`,
and it needs no extra configuration or service, because scripts run in an
isolate inside the backend.
