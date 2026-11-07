// Shared contracts between modules. Changing a type here changes the contract
// for every module, so keep it in sync with docs/api-draft.md.
//
// Coordinates are CSS pixels relative to the top-left of the viewport
// (the same space as getBoundingClientRect and Input.dispatchMouseEvent).

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ElementState {
  disabled?: boolean;
  checked?: boolean | "mixed";
  selected?: boolean;
  expanded?: boolean;
  pressed?: boolean;
  invalid?: boolean;
  required?: boolean;
  readonly?: boolean;
  focused?: boolean;
}

export interface ElementInfo {
  /** Stable number (D-9 е). Never reused within a page lifetime. */
  id: number;
  /** "interactive" = can be acted on; "text" = short meaningful text (heading, status, label-value, cell). */
  kind: "interactive" | "text";
  /** ARIA role: button, link, textbox, combobox, checkbox, radio, switch, tab, menuitem, option,
   *  slider, searchbox, spinbutton, heading, status, cell, text, generic... */
  role: string;
  /** Accessible name, whitespace-collapsed, max 80 chars (truncated with "…"). May be "". */
  name: string;
  /** Heading level for role=heading. */
  level?: number;
  /** Current value: input/textarea value, selected option text of a select, combobox display text. */
  value?: string;
  placeholder?: string;
  /** Distinguishing attribute when several elements in the same context share role+name,
   *  e.g. "id contactFirstName" or "name phone". */
  hint?: string;
  state: ElementState;
  rect: Rect;
  /** True if at least part of rect is inside the viewport. */
  inViewport: boolean;
  /** Short description of the element covering this one's center, e.g. 'footer (sticky)'. */
  occludedBy?: string;
  /** Context path, outermost first, max 3 entries, e.g. ['dialog "Добавить фазу"', 'group "Контакты"']. */
  context: string[];
  /** Number of options for native select / listbox. */
  optionsCount?: number;
  /** Validation message tied to the field (aria-errormessage, aria-describedby with error, :invalid validationMessage). */
  error?: string;
  /** For role=tab that is not selected: number of interactive elements in its (hidden) panel, if known. */
  hiddenCount?: number;
}

export interface OffscreenSummary {
  direction: "above" | "below";
  /** Context label, e.g. 'section "Версия"'. */
  context: string;
  count: number;
}

export interface Snapshot {
  url: string;
  title: string;
  viewport: { w: number; h: number };
  scroll: { x: number; y: number; maxY: number };
  /** Active modal layer, e.g. 'dialog "Добавить фазу"'. When set, elements outside it are excluded. */
  layer?: string;
  /** Page-side loading signals: visible spinners, skeletons, aria-busy. Network is added by the server. */
  loading: { busy: boolean; reasons: string[] };
  /** Elements in reading order (top-to-bottom, left-to-right within a context). */
  elements: ElementInfo[];
  offscreen: OffscreenSummary[];
  /** Toasts, banners, role=alert/status texts, max 5, each max 200 chars. */
  messages: string[];
  /** True if elements were cut by maxElements. */
  truncated?: boolean;
}

/** How the agent points at an element. */
export type TargetSpec = number | string | { text: string; in?: string | number };

export type LocateError = "not_found" | "ambiguous" | "stale" | "not_visible" | "disabled";

export type LocateResult =
  | {
      ok: true;
      id: number;
      /** Click point (center of the visible part of the element), after scrolling into view. */
      point: { x: number; y: number };
      info: ElementInfo;
      occludedBy?: string;
    }
  | {
      ok: false;
      error: LocateError;
      message: string;
      /** For ambiguous/not_found: up to 8 closest candidates. */
      candidates?: ElementInfo[];
    };

export interface SnapshotOptions {
  /** Include elements outside the viewport as a full list instead of the offscreen summary. */
  full?: boolean;
  /** Restrict to a container: element id or text of a dialog/section/heading. */
  scope?: number | string;
  /** Cap on elements returned (default 150). */
  maxElements?: number;
}

/**
 * API installed by dist/page.js as window.__agentClick. All methods are synchronous
 * and return JSON-serializable values (called via Runtime.evaluate / page.evaluate).
 */
export interface LocateOptions {
  scroll?: boolean;
  /** The element is only a reference point (scroll container): disabled is fine. */
  anyState?: boolean;
  /** Headings and texts too, not only interactive elements (scroll to a section). */
  anyKind?: boolean;
  /** Scroll it to the middle even when visible (it is under a fixed header). */
  center?: boolean;
}

export interface PageApi {
  version: string;
  snapshot(opts?: SnapshotOptions): Snapshot;
  /** Resolve a target, scroll it into view if needed (block: "center"), return the click point. */
  locate(target: TargetSpec, opts?: LocateOptions): LocateResult;
  /** Fresh info for a known id, or null if it cannot be resolved (even by fingerprint). */
  describe(id: number): ElementInfo | null;
  /** Focus the element and select its whole content (inputs, textareas, contenteditable). */
  focusAndSelectAll(id: number): boolean;
  /** Focus the field with the caret at the end of its content. */
  focusAtEnd(id: number): boolean;
  /** Set value via the native setter + input/change events (fallback when typing does not work). */
  setNativeValue(id: number, value: string): boolean;
  /** Native <select>: choose option by visible text (exact, then case-insensitive substring). */
  selectNativeOption(id: number, text: string): { ok: boolean; value?: string; options?: string[] };
  /** Does visible text (in the active layer, or in scope) contain the string? Case-insensitive. */
  hasText(text: string, scope?: number | string): boolean;
  /** Visible options of an open listbox/menu (role=option/menuitem) with ids. */
  openOptions(): ElementInfo[];
  /** Mutation counter, increased by a MutationObserver on document (for settle detection). */
  mutationCount(): number;
  /** Same as snapshot().loading, without collecting elements. Called every ~50 ms while settling. */
  loading(): { busy: boolean; reasons: string[] };
  /** Readable text of a scope (default: modal layer, main or body); tables as `| a | b |` rows. Throws if scope not found. */
  read(scope?: number | string, maxChars?: number): { text: string; truncated: boolean };
}

// ---- Server side ----

export interface NetworkEvent {
  method: string;
  /** URL without query string, origin shortened if same as page: "/v20.0/act_1/adsets". */
  url: string;
  /** HTTP status, or 0 if failed without response. */
  status: number;
  /** For status >= 400 or failure: first 300 chars of the response body / error text. */
  error?: string;
  /** Another site than the page (only reported when it failed); does not fail the step. */
  thirdParty?: boolean;
  /** Cancelled by the page itself (net::ERR_ABORTED, e.g. an SPA navigating away); does not fail the step. */
  cancelled?: boolean;
}

export interface SettleResult {
  settled: boolean;
  waitedMs: number;
  /** Why not settled when the timeout hit: "2 requests", "DOM mutating", ... */
  pending: string[];
}

export interface SnapshotDiff {
  urlChanged?: { from: string; to: string };
  layerChanged?: { from?: string; to?: string };
  added: ElementInfo[];
  removed: ElementInfo[];
  changed: { before: ElementInfo; after: ElementInfo; fields: string[] }[];
  newMessages: string[];
  /** Heuristic: big enough change to auto-attach a screenshot (D-6, D-9 з). */
  significant: boolean;
}

export type Step =
  | { click: TargetSpec }
  | { dblclick: TargetSpec }
  | { hover: TargetSpec }
  | { fill: Record<string, string> }
  | { select: [TargetSpec, string] }
  | { check: [TargetSpec, boolean] }
  | { press: string }
  | { scroll: { in?: TargetSpec; to: "top" | "bottom" | number | TargetSpec } }
  | { wait_for: { text?: string; gone?: string; url?: string }; timeout?: number }
  | { expect: { text?: string; in?: TargetSpec; url?: string } };

export interface StepResult {
  ok: boolean;
  /** One-line semantic description: 'click [17] button "Далее"'. */
  summary: string;
  /** Effect / warning / error detail: '→ opened dialog "…"', 'requested "199.99" → actual "244.99"'. */
  detail?: string;
  warning?: boolean;
  network: NetworkEvent[];
}
