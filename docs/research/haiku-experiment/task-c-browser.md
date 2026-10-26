# Task C — browser layer (`src/browser/`)

You are implementing one module of **agent-click**, an MCP server that lets an AI agent drive the
user's real, already running browser (Brave/Chrome) like a human, over the Chrome DevTools Protocol
(CDP) using `puppeteer-core`. Your module: connecting to the browser, tracking network requests,
detecting when the page has settled after an action, and sending trusted mouse/keyboard input.
Read `src/types.ts` first: `NetworkEvent` and `SettleResult` are your outputs.

## Ownership
- You own and may create/edit only: `src/browser/**`, `test/browser/**`, `test/fixtures/browser-*.html`.
- Do **not** edit `src/types.ts`, `package.json`, configs, or other modules. If the contract seems wrong,
  work within it and describe the problem in your final report.
- No new npm dependencies. Available: `puppeteer-core` (types `Browser`, `Page`, `CDPSession`).
- **Never connect to or launch the user's real browser profile in tests.** Use the test harness only.

## 1. `src/browser/connect.ts`

How the user's browser exposes CDP: the user enabled remote debugging in `brave://inspect/#remote-debugging`.
The browser then writes the file `<User Data dir>/DevToolsActivePort` with two lines: the port and the
browser websocket path (e.g. `9222` and `/devtools/browser/<uuid>`). Each new connection makes the
browser show an "Allow" prompt to the user, so connecting may take up to a minute.

- `export function defaultUserDataDirs(): string[]` — candidates in order: env
  `AGENT_CLICK_USER_DATA_DIR` (if set, only it), then on Windows `%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data`,
  `%LOCALAPPDATA%\Google\Chrome\User Data`; on macOS/Linux the usual Brave/Chrome locations.
- `export function readDevToolsActivePort(userDataDir: string): { port: number; path: string } | null`
- `export async function connectBrowser(opts?: { userDataDir?: string; timeoutMs?: number /* 60000 */ }): Promise<Browser>`
  — find the first dir with the file, `puppeteer.connect({ browserWSEndpoint: "ws://127.0.0.1:<port><path>", defaultViewport: null, protocolTimeout: 30000 })`.
  Errors must be actionable, thrown as `Error` with a clear message:
  - no file anywhere → tell the user to open `brave://inspect/#remote-debugging` and enable
    "Allow remote debugging for this browser instance";
  - connection refused → the file is stale, the browser is probably not running;
  - timeout → "Approve the remote debugging prompt (Allow) in the browser window and retry".

## 2. `src/browser/network.ts`

`export class NetworkRecorder` — attached to a **page-level** `CDPSession` (`page.createCDPSession()`).
- `constructor(cdp: CDPSession, getPageUrl: () => string)`; `async start()` sends `Network.enable`
  and subscribes to `Network.requestWillBeSent`, `responseReceived`, `loadingFinished`, `loadingFailed`.
  `dispose()` unsubscribes.
- `inflight(): number` — requests in progress, **excluding**: WebSocket, EventSource, `type` Ping/
  Other beacons, telemetry (`isTelemetry`), media, and any request in flight for > 10 s (long-poll).
- `pendingDescriptions(): string[]` — e.g. `GET /api/items`, ≤ 5.
- `mark(): number` — returns a sequence number; `mutationsSince(mark): NetworkEvent[]` — finished or
  failed **mutating** requests (POST/PUT/PATCH/DELETE) that started after the mark, excluding
  telemetry, in start order.
- For mutating requests with status ≥ 400 or failure, fetch the body (`Network.getResponseBody` at
  `loadingFinished`) and put its first 300 chars into `error` (failure → `errorText`).
- URL shortening (`NetworkEvent.url`): drop query and hash; if the origin equals the page's origin,
  drop the origin (`/v20.0/act_1/adsets`), otherwise keep host+path (`graph.facebook.com/v20.0/…`).
- `export function isTelemetry(url: string): boolean` — known analytics/telemetry hosts
  (google-analytics, googletagmanager, doubleclick, facebook.com/tr, connect.facebook.net, sentry,
  segment, mixpanel, amplitude, hotjar, clarity.ms, datadoghq / browser-intake, newrelic / nr-data,
  posthog, intercom, fullstory, bugsnag, …) and generic paths like `/collect`, `/beacon`, `/log`,
  `/logging`, `/track`, `/telemetry`, `/rum`, `/ping`. Keep the list in one exported array.
  Must NOT match normal API paths like `/api/items` or `graph.facebook.com/v20.0/act_1/adsets`.

## 3. `src/browser/settle.ts`

```ts
export interface SettleProbe {
  inflight(): number;
  pendingDescriptions(): string[];
  mutationCount(): Promise<number>;   // DOM mutation counter from the page
  busyReasons(): Promise<string[]>;   // visible spinners etc. from the page; [] if none
}
export async function waitForSettle(probe: SettleProbe, opts?: {
  quietNetworkMs?: number; // 300
  quietDomMs?: number;     // 200
  timeoutMs?: number;      // 5000
  pollMs?: number;         // 50
}): Promise<SettleResult>
```
- Poll every `pollMs`. Settled when: inflight was 0 continuously for `quietNetworkMs`, the mutation
  count did not change for `quietDomMs`, and `busyReasons()` is empty. Never return before
  `max(quietNetworkMs, quietDomMs)` has passed (a click's requests start asynchronously).
- On timeout: `settled: false`, `pending` = e.g. `["2 requests: GET /api/a, POST /api/b", "DOM mutating",
  "spinner in …"]`.
- If a probe call throws (page navigated, context destroyed): treat as "not quiet" and keep polling
  (navigation is a normal effect of a click); give up only at the timeout.
- No fixed sleeps beyond the polling interval.

## 4. `src/browser/input.ts`

Trusted input via CDP `Input.*` on a page-level `CDPSession`:
- `click(cdp, point: {x,y}, opts?: { button?: "left"|"right"|"middle"; clickCount?: 1|2 })` —
  `mouseMoved` → `mousePressed` → `mouseReleased`; double click = press/release with clickCount 1,
  then press/release with clickCount 2.
- `hover(cdp, point)` — `mouseMoved`.
- `insertText(cdp, text)` — `Input.insertText`.
- `press(cdp, combo: string)` — `"Enter"`, `"Tab"`, `"Escape"`, `"Backspace"`, `"Delete"`,
  `"ArrowDown"`… `"PageDown"`, `"Home"`, `"End"`, `"Space"`, single characters, and combos like
  `"Control+A"`, `"Shift+Tab"`, `"Meta+Enter"`. `keyDown`/`keyUp` (`rawKeyDown` for non-printable)
  with correct `key`, `code`, `windowsVirtualKeyCode`, `modifiers` bitmask (Alt=1, Ctrl=2, Meta=4,
  Shift=8), and `text` for printable keys and Enter (`"\r"`). Modifier keys themselves are pressed
  down before and released after. Unknown key → throw.
- `enableFocusEmulation(cdp)` — `Emulation.setFocusEmulationEnabled({ enabled: true })` so the page
  behaves as focused even when the window is in the background.

## Tests (`test/browser/*.test.ts`, vitest)
Use `test/helpers/browser.ts` (`launchTestBrowser`) — a separate headless Brave with a temp profile.
Look at `test/smoke.test.ts` for style. Cover at least:
1. connect: launch a test browser with `--remote-debugging-port=0` in its own temp `userDataDir`
   (puppeteer `launch` with `args`), check that `readDevToolsActivePort(thatDir)` reads it and
   `connectBrowser({ userDataDir: thatDir })` connects; missing file → actionable error. (You may add
   your own launch helper inside `test/browser/`.)
2. network: a fixture page that sends `fetch` POST to a local `http.createServer` started in the test
   (one returns 200, one 409 with a JSON body) — `mutationsSince` reports both, 409 with the body
   snippet; GET is not in mutations; `inflight` counts a slow request; telemetry excluded;
   `isTelemetry` unit cases (positive and negative).
3. settle: unit tests with a fake probe (quiet immediately → returns after ~max quiet window;
   requests ending later → waits; never quiet → `settled:false` with pending; throwing probe);
   one real-browser test: a click that triggers a 500 ms fetch + DOM update → settled after it.
4. input: fixture page records events (`isTrusted`, `clientX/Y`, `detail`, key, modifiers): click
   lands at the point and `isTrusted === true`; dblclick fires `dblclick`; `press("Control+A")`,
   `press("Enter")` in an input; `insertText` with Cyrillic text.

## Done criteria
- `npx vitest run test/browser` passes (run only your folder: other agents run tests in parallel); `npx tsc -p tsconfig.json --noEmit` shows no errors in
  `src/browser/**` (errors in other modules are not yours — other agents work in parallel).
- Final report (your last message), concise: what is implemented; what is not or simplified and why;
  problems with the contract or spec; test counts.
