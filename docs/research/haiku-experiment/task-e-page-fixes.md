# Task E — look fixes from the first real session (`src/page/`)

Project: **agent-click**, an MCP server that lets an AI agent drive a real browser. `src/page/` is the
script injected into web pages; it builds the element list the agent reads (`window.__agentClick`,
contract `PageApi` in `src/types.ts`). You have not seen it before — read `src/page/resolve.ts`,
`src/page/context.ts`, `src/page/info.ts`, `src/page/snapshot.ts` and the parts of `collect.ts` you need.

A real session (RevenueCat, AppsFlyer, Meta developers) showed four problems. Fix them.

## Ownership
Only `src/page/**`, `test/page/**`, `test/fixtures/page-*.html`. Do not edit `src/types.ts` or other modules.

## 1. `scope` by landmark
`look({scope: "main"})` → `scope not found`, although the output shows groups like `[main › section "X"]`.
`resolveScope(string)` (resolve.ts) only matches named dialogs/sections/groups and headings.
Also accept:
- a landmark word: `main`, `nav`, `header`, `footer`, `aside`, `form` (tag or ARIA role) → the outermost
  rendered one of that kind (pages nest `main` inside `main`);
- a label exactly as printed in the output: `section "Production"`, `nav "Side navigation"`,
  `dialog "Confirm"` → kind + name match.
Existing behaviour (plain name substring, heading fallback) stays.

## 2. Unnamed controls
AppsFlyer printed `[20] clickable` with no name for a toggle under heading "Activate partner", and
`[23] textbox = "2480843132394718"` with no name, whose visible label "Facebook App Id" sits in a
sibling `div` (not a `<label>`). The agent had to read them through raw JS.
- A control with an empty accessible name gets a name from nearby visible text: walk up at most 3
  ancestors; the first ancestor whose text (minus the control's own text/value) is non-empty and
  ≤ 60 chars, and that contains no other collected interactive element, gives the name. Keep it simple.
- A clickable wrapper whose only real control is a hidden `input[type=checkbox]` (or that contains a
  `role=switch`/`checkbox` that is not collected itself) should be reported as `checkbox`/`switch` with
  its checked state, not as `clickable`.

## 3. Numeric headings as section names
KPI cards use headings like `0`, `$0`, `43`, `12.5%`, so the output had `[main › section "$0"]`.
In the nearest-heading fallback of `contextPath` (context.ts) and in the heading fallback of
`resolveScope`, skip headings whose text has no letters.

## 4. Badge in Messages
`status "id6792269704"` (a `role=status` badge) was listed as an element AND as
`Messages: "id6792269704"`. A message source that is itself in the element list must not be repeated
in `messages`.

## Tests — keep them few
The user does not want tests for the sake of tests. One small fixture (`test/fixtures/page-real1.html`)
and a handful of assertions per item. Do not rewrite existing tests beyond what your change breaks.
Tests launch their own headless browser (see `test/page/helpers.ts`); never connect to any other browser.

Run `npm run build:page && npx vitest run test/page` and `npx tsc -p tsconfig.json --noEmit`.
Final report, short: what changed (file by file), test counts, anything you were unsure about.
