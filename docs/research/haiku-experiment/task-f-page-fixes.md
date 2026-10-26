# Task F — look fixes from a walk through Meta Ads and Perplexity (`src/page/`)

Project: **agent-click**, an MCP server that lets an AI agent drive a real browser. `src/page/` is the
script injected into web pages; it builds the element list the agent reads (`window.__agentClick`,
contract `PageApi` in `src/types.ts`). You have not seen it before — read `src/page/context.ts`,
`src/page/util.ts`, `src/page/loading.ts`, `src/page/snapshot.ts` and the parts of `collect.ts` you need.

## Ownership
Only `src/page/**`, `test/page/**`, `test/fixtures/page-*.html`. Do not edit `src/types.ts` or other modules
(another engineer edits them at the same time).

## 1. Wrong section from the nearest-heading fallback
Meta Business Suite: links of the **left sidebar** ("Поиск", "Справка") were put under
`section "Оповещения"` — a heading in the main column that merely precedes them in document order.
In `nearestHeading` (context.ts) accept a preceding heading only if it is visually above the element
(`heading.bottom <= el.top + 4`) and horizontally overlaps it (column check). Otherwise no fallback.

## 2. Junk in names
- Zero-width characters: names like `"Меню ​"` and `button "​"` (U+200B). `collapse()` should drop
  U+200B–U+200D, U+2060 and U+FEFF; a name that becomes empty is empty (the existing unnamed-control
  fallback then applies).
- Machine tokens: `link "Все объявления status_before_click:selected"`. Drop tokens that look like
  `snake_case_identifier:value` (regex on whole tokens, at least one `_` before the colon) from names.

## 3. Duplicate loading reasons
Header showed `progressbar in section "Объявления", progressbar in section "Объявления"`.
In `loadingState()` merge equal reasons into one with a count: `progressbar ×2 in section "Объявления"`.

## 4. Perplexity
- A text field `[34] textbox = ""` showed no name and no placeholder, although the page shows the
  placeholder "Задайте уточняющий вопрос". It is likely a `contenteditable` (or textarea) whose
  placeholder is rendered by a sibling/child element or `data-placeholder` / `aria-placeholder`.
  Use `aria-placeholder`, `data-placeholder` and a `placeholder` attribute on contenteditable as the
  placeholder.
- `Messages: "Yehor KvasenkoБесплатный план"` — a profile button text glued without a space was taken
  as a message. (a) Message text must join block-level children with a space (textContent glues
  them). (b) A message source matched only by a toast-like class (no role=alert/status, no aria-live)
  must be `position: fixed` or `absolute` (a toast floats); otherwise it is not a message.

## Tests — keep them few
The user does not want tests for the sake of tests. One small fixture (`test/fixtures/page-real2.html`)
and a handful of assertions per item. Do not rewrite existing tests beyond what your change breaks.
Run tests from the project root: `npm run build:page && npx vitest run test/page`. If vitest fails to
start, say so with the exact error and the command you ran — don't silently work around it.
Typecheck: `npx tsc -p tsconfig.json --noEmit`.
Final report, short: what changed (file by file), test counts, anything you were unsure about.
