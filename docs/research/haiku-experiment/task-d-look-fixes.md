# Task D — look fixes from a live run (`src/page/`)

Project: **agent-click**, an MCP server that lets an AI agent drive a real browser. `src/page/` is the
script injected into web pages; it builds the element list the agent reads (`window.__agentClick`,
contract `PageApi` in `src/types.ts`). The module was written by another agent; you have not seen it
before — read `src/page/snapshot.ts`, `src/page/util.ts`, `src/page/visibility.ts` and the parts of
`collect.ts` you need.

A live run on gemini.google.com showed three problems. Fix them.

## Ownership
Only `src/page/**`, `test/page/**`, `test/fixtures/page-*.html`. Do not edit `src/types.ts` or other modules.

## 1. New `PageApi.loading()` + false "loading"
- The contract now has `loading(): { busy: boolean; reasons: string[] }` — same result as
  `snapshot().loading` but **without collecting elements** (it is called every ~50 ms while waiting
  for the page to settle, so it must be cheap: query only candidate elements, e.g. by
  `[role=progressbar], [aria-busy=true]` and a class selector, not a full walk). Implement it and make
  `snapshot()` reuse it.
- False positives: Gemini showed `loading in page, loader in main` permanently. A class match on
  `loading|loader|spinner|skeleton|shimmer` alone is too broad (persistent wrappers like
  `.loader-container`, `.is-loading-done`). Count an element as a loading indicator only if it is
  visible AND either has `role=progressbar` / `aria-busy="true"`, OR matches the class regex AND is
  small (both sides ≤ 120 px — a spinner) or is a skeleton/shimmer block. Ignore elements with
  `aria-hidden="true"` and those with zero opacity.

## 2. Messages noise
Gemini's chat transcript is an `aria-live` region, so the whole model answer became a "message".
A message source (role=alert/status, aria-live, toast-like class) is skipped if its text is longer
than 300 chars or it contains collected interactive elements. Prefer the innermost matching element
(a toast inside a live region), and don't report the same text twice.

## 3. Occluder description
Buttons under a floating input panel were reported as `occluded by main`. `describeOccluder(hit)`
should describe the **nearest fixed or sticky ancestor-or-self of the hit element** first (e.g.
`div "Введите запрос для Gemini…" (fixed)` — role/tag plus a short accessible name or text ≤ 40
chars, plus `(fixed)`/`(sticky)`), and fall back to the landmark only if there is no fixed/sticky
ancestor.

## Tests — keep them few
The user does not want tests for the sake of tests. Add **one small fixture and a handful of
assertions** per item (e.g. a persistent `.loader-container` wrapper → not busy; a 24px `.spinner`
→ busy; a long aria-live region → no message, a short toast → message; a button under a fixed
panel → occludedBy mentions the panel). Do not rewrite existing tests beyond what your change breaks.

Run `npm run build:page && npx vitest run test/page` and `npx tsc -p tsconfig.json --noEmit`.
Final report, short: what changed (file by file), test counts, anything you were unsure about.
