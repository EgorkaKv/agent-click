# Task G — look fixes from a Meta Ads Manager session (`src/page/`)

Project: **agent-click**, an MCP server that lets an AI agent drive a real browser. `src/page/` is the
script injected into web pages; it builds the element list the agent reads (`window.__agentClick`,
contract `PageApi` in `src/types.ts`). You have not seen it before — read `src/page/registry.ts`,
`src/page/context.ts`, `src/page/resolve.ts`, `src/page/util.ts` and the parts of `collect.ts`,
`info.ts`, `snapshot.ts` you need. Bug list with context: `docs/research/live-session-2.md` (#7, 11, 12, 21–23).

## Ownership
Only `src/page/**`, `test/page/**`, `test/fixtures/page-*.html`. Do not edit `src/types.ts`,
`src/core/**`, `src/render/**` (another engineer edits them at the same time).

## 1. A number moved to another object (registry)
Ads Manager table: `[462] link "PL+UA 18-35 Instagram (Android)"` became
`name → "agent-click test — Flowr iOS"` after switching the table tab. React reused the same DOM
node for a different row; the id stayed. Clicking the old number would hit another object.
Rule: for a link, a table row/cell control, option or tab, a **name change** means a different
object — the element gets a new id (the old id is dead). Fields (textbox, combobox, checkbox …) and
buttons whose label toggles (e.g. "Show"/"Hide", "Включено") keep their id. Keep it simple: one
predicate by role.

## 2. `scope` by heading text returns only the heading
`look`/`read` with `scope: "Бюджет и график"` (a heading text) returned just the heading. The scope
must be the container the heading titles: walk up from the heading to the nearest ancestor that
contains more than the heading (other elements/text besides it), stop at landmarks/dialogs/body.

## 3. Context shifted by one
In a review panel each block was put under the **previous** block's heading:
`[section "Название группы объявлений"] [433] "Место получения конверсий…"`; in the editor
`[section "Бюджет и график"] heading "Аудитория"`. A heading must never be inside its own
predecessor's section, and an element directly after heading X belongs to X, not to the heading
before X. Find why (likely the section container is resolved from a wrapper that holds several
heading+content pairs) and fix it.

## 4. Names
- Glued text: `"Название группы объявленийPL+UA 18-35 Instagram (Android)ID: …"`,
  `"Настройки рекламы не установленыНастройки рекламы не установлены"`. Names built from text
  content must join block-level children with a space (there is `spacedText` in util.ts) and drop
  an exact repetition (`X X` → `X`; the second case is one text duplicated in a visually hidden node —
  skip visually-hidden / sr-only duplicates if that is the cause).
- Options lose their second line: `option "flowr: Self-Care Planner"` without
  "Не подключено к вашему рекламному аккаунту". For `option`/`menuitem` keep the secondary text
  (description line) after ` — `, truncated as usual.
- `status_before_click:selected` still appears in link names although `cleanName` exists — some
  name path does not use it. Make every name go through it.
- `Messages: "19:35"` — the text of a time field/picker was taken as a message. A message must not be
  a form control's value or live inside an input/picker widget.

## Tests — keep them few
The user does not want tests for the sake of tests. One small fixture (`test/fixtures/page-real3.html`)
and a handful of assertions per item. Do not rewrite existing tests beyond what your change breaks.
Run tests from the project root: `npm run build:page && npx vitest run test/page`. If vitest fails to
start, say so with the exact error and the command you ran.
Typecheck: `npx tsc -p tsconfig.json --noEmit`.
Final report, short: what changed (file by file), test counts, anything you were unsure about.
