# Task A — in-page script (`src/page/`)

You are implementing one module of **agent-click**, an MCP server that lets an AI agent drive a real
browser like a human: it sees a numbered list of elements (and a screenshot with the same numbers)
and says "click 17" or "click 'Next'". Your module is the JavaScript that runs **inside the web page**
and turns the DOM into that list. Read `src/types.ts` first: it is the contract you implement
(`PageApi`, `Snapshot`, `ElementInfo`, `LocateResult`, `TargetSpec`, `SnapshotOptions`).

## Ownership

- You own and may create/edit only: `src/page/**`, `test/page/**`, `test/fixtures/page-*.html`.
- Do **not** edit `src/types.ts`, `package.json`, configs, or other modules. If the contract seems wrong
  or insufficient, do not change it — work within it and describe the problem in your final report.
- No new npm dependencies. Available: `dom-accessibility-api` (use `computeAccessibleName`, `getRole`).

## Build and runtime

- `src/page/index.ts` is bundled by `npm run build:page` (esbuild, IIFE, target chrome120) into
  `dist/page.js`. The server injects that file with `page.evaluate(source)` — possibly many times
  into the same document.
- `index.ts` must install `window.__agentClick: PageApi`. Installation is **idempotent**: if
  `window.__agentClick?.version === VERSION`, do nothing (the id registry must survive re-injection).
- All `PageApi` methods are synchronous and return JSON-serializable data (no DOM nodes).
- Split code into sensible files, e.g. `registry.ts`, `collect.ts`, `context.ts`, `visibility.ts`,
  `locate.ts`, `text.ts`.

## Requirements

### 1. What is collected (`kind: "interactive"`)
- `a[href]`, `button`, `input` (except `type=hidden`), `select`, `textarea`, `summary`,
  `[contenteditable]` (not `"false"`), elements with an interactive ARIA role (button, link, checkbox,
  radio, switch, tab, menuitem, menuitemcheckbox, menuitemradio, option, combobox, textbox, searchbox,
  spinbutton, slider, treeitem), `[tabindex]` with value ≥ 0.
- Heuristic for framework "div buttons": an element whose computed `cursor` is `pointer` and whose
  parent's cursor is **not** `pointer` (the top of a pointer chain). Role for these if they have no
  ARIA role: `"clickable"`.
- **Nested duplicates**: if a collected element contains exactly one other collected interactive
  element and has no other meaningful text of its own, keep only the inner one. A `<label>` that is
  the label of a collected input is not collected itself.
- Skip elements that are not rendered: zero-size rect, `checkVisibility({ opacityProperty: true,
  visibilityProperty: true })` false, or inside an `inert` subtree / `aria-hidden="true"` subtree.

### 2. Short meaningful text (`kind: "text"`)
Collected only if visible and not inside a collected interactive element:
- headings (`h1`–`h6`, `role=heading`), with `level`;
- `role=status` / `role=alert` elements (also go to `messages`, see §9);
- badge-like leaves: an element whose own text (trimmed) is 1–40 chars, has no element children with
  text, and is visually distinct from its parent (different background color, or non-zero
  border-radius with a non-transparent background). role `"status"` if its text looks like a status
  word, otherwise `"text"`. Keep it simple; do not over-engineer;
- `dt`/`dd` pairs and `th`; cells (`td`, `role=cell`) of a table row that contains an interactive
  element (role `"cell"`).
- Text longer than 120 chars is skipped (except headings, which are truncated to 80).

### 3. Element fields
- `role`/`name` via `dom-accessibility-api`; name whitespace-collapsed, truncated to 80 chars with `…`.
- `value`: input/textarea value (password → `"••••"`), selected option text of a `<select>`,
  combobox → input value or its text, contenteditable → text (≤ 80 chars). Not set for
  checkbox/radio (use `state.checked`).
- `state`: disabled (incl. `aria-disabled`, disabled fieldset), checked (`aria-checked="mixed"` →
  `"mixed"`), selected, expanded, pressed, invalid, required, readonly, focused
  (`document.activeElement`, deep through shadow roots). Only set keys that are true / meaningful.
- `placeholder`, `optionsCount` (native select: options count; listbox: role=option children),
  `error` (from `aria-errormessage` target text, or `aria-describedby` target text when
  `aria-invalid=true`).
- `hint`: when ≥ 2 elements in the same context share role+name, set `hint` on each to the first
  available of `id X`, `name X`, `placeholder X`.
- `rect`: viewport CSS px (`getBoundingClientRect`, plus iframe offsets, see §8). `inViewport`.

### 4. Visibility, occlusion, layers
- **Occlusion**: for interactive elements in the viewport, `elementFromPoint` at the center of the
  visible part (fall back to 2 more points inside the rect). If the hit is neither the element, nor
  its descendant, nor its ancestor → `occludedBy` = short description of the occluder: closest
  landmark or fixed/sticky ancestor of the hit, e.g. `'footer (sticky)'`, `'div "Accept cookies"'`.
- **Layer**: if a modal is open — a visible `dialog` matching `:modal`, or a visible element with
  `aria-modal="true"` — the topmost one (last in DOM order) is the active layer. `snapshot.layer =
  'dialog "<accessible name>"'` and **only elements inside it** are returned (but still keep `banner`
  /header elements out too — inside a modal only the modal matters). Non-modal `role=dialog`
  (popovers, menus) does not create a layer.

### 5. Context path (`context: string[]`)
Walk ancestors (crossing shadow roots and same-origin iframes) and collect labels, outermost first:
- dialog / alertdialog → `dialog "Name"`;
- landmarks: `header`/banner → `header`, `nav` → `nav "Name"` (or `nav`), `main` → `main`,
  `aside` → `aside`, `footer`/contentinfo → `footer`, `form` with an accessible name → `form "Name"`,
  `section`/`region` with an accessible name → `section "Name"`;
- `fieldset` → `group "<legend>"`, `role=group|radiogroup` with a name → `group "Name"`;
- `role=tabpanel` → `tabpanel "Name"`;
- table row → `row "<text of first cell, ≤ 40 chars>"`.
- If the element has no section/group/dialog label at all, use the nearest preceding heading in the
  same container: `section "<heading text>"`.
- Max 3 entries: if more, keep the outermost one and the innermost two.

### 6. Stable ids (registry) — most important
- Counter starts at 1, ids are **never reused**.
- `WeakMap<Element, number>` + `Map<number, { ref: WeakRef<Element>, fp: Fingerprint }>`.
- Fingerprint = role + name + context (joined) + ordinal among elements with the same
  role+name+context in the most recent collection.
- On every collection: element known in WeakMap → same id. Unknown element → look for a **dead**
  entry (`ref.deref()` undefined or `!isConnected`) with an equal fingerprint → reuse that id and
  rebind the ref. Otherwise → new id.
  This is the whole point: React re-creates a node (wizard step, conditional render) and the agent
  still sees the same number.
- `describe(id)` / `locate(id)`: if the ref is alive and connected → use it. If dead → run a
  collection and find elements with the same fingerprint: exactly 1 → rebind and use; 0 → `stale`;
  > 1 → `ambiguous`.

### 7. `locate(target, { scroll = true })`
- `number` → registry (§6).
- `string` → among **interactive** elements of the active layer (whole page, not just viewport):
  normalize (trim, collapse whitespace, case-insensitive). Exact name match → if 1, ok; if > 1,
  `ambiguous` with candidates. If 0 exact → substring match on name, then on placeholder, same rule.
  If still 0 → `not_found` with up to 8 candidates sharing at least one word with the query.
- `{ text, in }` → resolve the scope (number → that element; string → dialog/section/region/
  fieldset/group/tabpanel whose name contains it, or a heading whose text contains it → its closest
  sectioning ancestor), then match inside it as above.
- Disabled target → `{ ok: false, error: "disabled" }`.
- If `scroll` and the element is not fully in the viewport → `scrollIntoView({ block: "center",
  inline: "nearest", behavior: "instant" })` (also inside scrollable containers, which
  `scrollIntoView` handles), then recompute. Not visible after that → `not_visible`.
- `point` = center of the visible part of the rect (clipped to viewport), in top-level viewport
  coords. Include `occludedBy` if occluded at that point.
- `message`: one human-readable sentence, e.g. `2 elements match "Save": [12] button "Save" in
  dialog "Edit", [40] button "Save" in footer`.

### 8. Shadow DOM and iframes
- Traverse open shadow roots (`el.shadowRoot`).
- Traverse same-origin iframes (`iframe.contentDocument` accessible); rects of inner elements are
  offset by the iframe's content box position so they are in top-level viewport coordinates.
- Cross-origin iframes: skip silently.

### 9. Snapshot extras
- `messages`: visible texts of `role=alert`, `role=status`, `[aria-live]` regions (non-empty), and
  visible elements whose class matches `/toast|snackbar|notification|alert/i`; deduped, ≤ 5, each
  ≤ 200 chars.
- `loading`: visible `role=progressbar`, `[aria-busy="true"]`, or elements whose class matches
  `/spinner|loader|loading|skeleton|shimmer/i` → `busy: true`, reasons like `spinner in section
  "Build"` (use the context path), ≤ 5 reasons.
- `offscreen` (when not `full`): elements outside the viewport grouped by their first context entry
  (or `page`), with direction above/below and count.
- `elements`: document order; only in-viewport ones unless `full`. Cap `maxElements` (default 150) →
  `truncated: true`.
- `scope` option: restrict collection to the scope container (resolution as in §7).
- `scroll`: `window.scrollX/scrollY`, `maxY = scrollHeight - innerHeight`.

### 10. Other PageApi methods
- `focusAndSelectAll(id)`: focus; inputs/textareas → `select()`; contenteditable → select all
  contents with a Range. Returns false if not resolvable.
- `setNativeValue(id, value)`: native setter from `HTMLInputElement.prototype` /
  `HTMLTextAreaElement.prototype` (`Object.getOwnPropertyDescriptor(...).set.call(el, value)`), then
  dispatch bubbling `input` and `change`.
- `selectNativeOption(id, text)`: exact option text, else case-insensitive substring; set
  `selectedIndex`, dispatch `input` + `change`; on failure return `{ ok: false, options: [...] }`
  (≤ 30 option texts).
- `hasText(text, scope?)`: case-insensitive search in visible text (`innerText`) of the active layer or
  scope.
- `openOptions()`: visible `role=option` / `menuitem*` elements (registered, with ids).
- `mutationCount()`: a `MutationObserver` on `document` (subtree, childList, attributes,
  characterData) started at install time increments a counter.

### 11. Performance
- One pass over the DOM. Call `getComputedStyle` only where needed (candidates, cursor heuristic).
- Target: `snapshot()` < 50 ms on a page with ~3000 elements. Add a test that generates such a page
  and asserts < 150 ms (headless margin).

## Tests

Use the existing harness `test/helpers/browser.ts` (`launchTestBrowser`, `openFixture`) — it starts a
separate headless Brave with a temp profile. Look at `test/smoke.test.ts` for style. Write fixture
pages `test/fixtures/page-*.html` and tests `test/page/*.test.ts`. Run `npm run build:page && npx vitest run test/page` (rebuild
`dist/page.js` first; run only your folder, other agents test in parallel). Cover at least:
1. basic form: labels, values, placeholder, states, select optionsCount, password masking;
2. context: dialog, landmarks, fieldset, section by heading, table row; max 3 entries;
3. modal layer: `<dialog>.showModal()` → only dialog elements + `layer` set;
4. occlusion by a fixed footer;
5. **re-render**: element replaced by an identical new node (`el.replaceWith(clone)`) keeps its id;
   a new different element gets a new id; ids are never reused;
6. locate by text: exact, ambiguous (candidates), substring, not_found, `{text, in}`, disabled;
   scrolling an offscreen element into view;
7. cursor:pointer div collected, nested duplicates removed;
8. shadow DOM and same-origin iframe (`srcdoc`) elements with correct top-level rects;
9. messages and loading; offscreen summary; hint for same-named fields;
10. setNativeValue / selectNativeOption / hasText / mutationCount;
11. performance.

## Done criteria
- `npm run build:page && npx vitest run test/page` passes, `npx tsc -p tsconfig.json --noEmit` shows no errors in
  `src/page/**` (errors in other modules are not yours — other agents work in parallel).
- Final report (your last message), concise:
  1. what is implemented, file by file;
  2. what is **not** implemented or simplified, and why;
  3. any problems with the contract (`src/types.ts`) or this spec;
  4. test results (counts) and the measured snapshot time.
