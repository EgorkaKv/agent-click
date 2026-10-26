# Task B — rendering (`src/render/`)

You are implementing one module of **agent-click**, an MCP server that lets an AI agent drive a real
browser like a human: it sees a numbered list of page elements plus a screenshot with the same numbers
drawn on it, and says "click 17". Your module turns data into what the agent sees: the text of a
snapshot, the diff after an action, and the numbered marks on the screenshot. It is pure Node code —
no browser needed. Read `src/types.ts` first: `Snapshot`, `ElementInfo`, `SnapshotDiff` are your
inputs/outputs.

## Ownership
- You own and may create/edit only: `src/render/**`, `test/render/**`.
- Do **not** edit `src/types.ts`, `package.json`, configs, or other modules. If the contract seems wrong,
  work within it and describe the problem in your final report.
- No new npm dependencies. Available: `sharp` (images).

## 1. `src/render/format.ts`

`export function formatSnapshot(s: Snapshot, opts?: { pendingRequests?: number }): string`

Output for the agent (an LLM). Must be compact and unambiguous. Example (exact layout is the spec):

```
Page: App Store Connect — Flowr · appstoreconnect.apple.com/apps/123/distribution
Viewport 1280×800 · scroll 0/2400 · ⏳ loading (2 requests, spinner in section "Build")
Layer: dialog "Add phase" (page below is blocked)

[dialog "Add phase"]
  [40] combobox "Type" = "" ⚠ "Select an option"
  [41] textbox "Duration" = "3"
  [42] combobox "Unit" = "Months" (12 options)
  [43] button "Apply" (disabled)
  [44] button "Cancel"
Messages: "Your changes have been saved"
```

and without a dialog:

```
Page: Ads Manager · adsmanager.facebook.com/adsmanager/manage/campaigns
Viewport 1280×800 · scroll 0/2400 · ✓ settled

[header]
  [3] combobox "Ad account" = "Rostemo (act_1234…)"
[main › tablist]
  [30] tab "Description" (selected)
  [31] tab "Media" (12 inside)
[main › section "Review info" › group "Contact"]
  [50] heading(2) "Contact"
  [51] textbox "First name" = "Yehor" (id contactFirstName)
  [52] textbox "Phone" = "" placeholder "+48…"
  [53] checkbox "Agree" ☑
  [54] text "FAILED"
[main › footer]
  [60] button "Save" (disabled, occluded by footer (sticky))
↓ below: section "Version" (8), section "Build" (3)
```

Rules:
- Line 1: `Page: <title> · <url without scheme, without query; truncate to 100 chars>`.
- Line 2: viewport, `scroll <y>/<maxY>`, then `✓ settled` or `⏳ loading (<reasons>)` where reasons
  = `<n> requests` (if `opts.pendingRequests` > 0) + `s.loading.reasons`. Loading if
  `s.loading.busy` or pending requests > 0.
- Line 3 only if `s.layer`: `Layer: <layer> (page below is blocked)`.
- Empty line, then elements **grouped by context**: consecutive elements with the same `context`
  array share a header line `[a › b › c]` (no context → `[page]`); element lines indented 2 spaces.
  A context change starts a new header (even if it was seen earlier).
- Element line: `[id] role "name"`, then, in this order and only if present:
  - `(level)` right after role for headings: `heading(2)`;
  - ` = "value"` for value-bearing roles (textbox, searchbox, combobox, spinbutton, slider, and any
    element with `value` defined) — show `= ""` for empty textboxes;
  - checkbox/radio/switch: ` ☑` / ` ☐` / ` ◩` (mixed) instead of value;
  - ` placeholder "…"` if value is empty and placeholder exists;
  - parenthesized flags, comma-separated: `disabled`, `selected`, `expanded`/`collapsed`
    (if `expanded` is defined), `pressed`, `required`, `readonly`, `focused`, `invalid`,
    `<n> options` (optionsCount), `<n> inside` (hiddenCount), `<hint>`, `occluded by <x>`;
  - ` ⚠ "<error>"` if `error`.
  - Empty name → omit the quotes: `[7] button`.
- After elements: offscreen summary lines: `↑ above: …` and `↓ below: …`, items
  `<context> (<count>)` joined with `, `.
- `Messages: "<m1>" · "<m2>"` if any.
- `… list truncated (<n> shown), use scope or full` if `s.truncated`.
- No trailing spaces; lines joined with `\n`.

## 2. `src/render/diff.ts`

`export function diffSnapshots(before: Snapshot, after: Snapshot): SnapshotDiff`
- Match elements by `id`. `added` = in after only, `removed` = in before only.
- `changed`: same id, compare `name`, `value`, `role`, `error`, `occludedBy`, `inViewport`, each key of
  `state` (union of keys; `undefined` ≡ `false`). `fields` lists changed field names
  (`"value"`, `"state.checked"`, …). `rect` is **not** compared.
- `urlChanged` if url differs (ignoring `#hash`-only changes? no — any change counts).
- `layerChanged` if `layer` differs.
- `newMessages`: messages in after that were not in before.
- `significant` = urlChanged || layerChanged || (added + removed) / max(before.elements.length, 1) >
  `SIGNIFICANT_RATIO` (export const, 0.3) || added.length >= `SIGNIFICANT_ADDED` (export const, 10).

`export function formatDiff(d: SnapshotDiff): string`
- Lines, in order: `→ url <from> → <to>` (urls shortened like in format), `→ opened <layer>` /
  `→ closed <layer>` / `→ layer <from> → <to>`, then `+ <element line>` for added (≤ 30, then
  `+ … <n> more`), `- [id] role "name"` for removed (≤ 15, then `- … <n> more`), `~ [id] role "name":
  <field> <before> → <after>; …` for changed (values quoted, checked as ☑/☐), then
  `Messages: …` for new messages.
- Reuse the element-line formatter from `format.ts` (export it as `formatElement`).
- Nothing changed → `no visible change`.

## 3. `src/render/marks.ts`

`export async function drawMarks(image: Buffer, elements: ElementInfo[], opts: { scale: number;
format?: "jpeg" | "png"; quality?: number }): Promise<Buffer>`
- `image` is a screenshot (PNG or JPEG). `scale` = image pixels per CSS pixel (rects are in CSS px).
- Draw marks only for `kind === "interactive"`, `inViewport`, and not `occludedBy`.
- For each: a 2 px outline around the rect, and a label badge with the id number (bold, white text,
  ~13 px font at scale 1 — scale it, colored rounded rectangle). Colors cycle through a palette of 6
  high-contrast colors by id; outline uses the same color.
- **Labels must not cover the element they belong to, nor each other**: implement and export a pure
  function `placeLabels(items: { id: number; rect: Rect; w: number; h: number }[], bounds: { w:
  number; h: number }): { id: number; x: number; y: number }[]` — candidate positions in order:
  outside top-left (above the rect), outside top-right, outside bottom-left, outside left, inside
  top-left. Take the first candidate that is within bounds and does not intersect any already placed
  label; if none fit, use inside top-left anyway. Label width depends on the digit count.
- Render via one SVG overlay composited with `sharp`. Output JPEG quality 75 by default.
- `export async function resizeForBudget(image: Buffer, maxWidth = 1280): Promise<{ image: Buffer;
  factor: number }>` — downscale if wider (keep aspect), return the factor so callers can compute
  `scale`.

## Tests (`test/render/*.test.ts`, vitest)
Look at `test/smoke.test.ts` for style. No browser needed. Cover at least:
1. `formatSnapshot`: both examples above reproduced exactly from hand-built `Snapshot` objects
   (write them as fixtures in the test), grouping, empty name, truncated, messages, offscreen.
2. `diffSnapshots` + `formatDiff`: added/removed/changed, state changes, url and layer changes,
   significance thresholds, no change.
3. `placeLabels`: no label overlaps another; no label overlaps its own element when there is space;
   labels stay inside bounds; dense grid of 50 small elements.
4. `drawMarks`: on a generated 800×600 image the output has the expected size and pixels at a label
   position differ from the source; occluded / text elements are not drawn; `resizeForBudget`.

## Done criteria
- `npx vitest run test/render` passes (run only your folder: other agents run tests in parallel); `npx tsc -p tsconfig.json --noEmit` shows no errors in
  `src/render/**` (errors in other modules are not yours — other agents work in parallel).
- Final report (your last message), concise: what is implemented; what is not or simplified and why;
  problems with the contract or spec; test counts.
