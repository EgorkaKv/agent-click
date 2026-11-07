// Executes act(steps): resolve target → trusted input → settle → verify effect → report.
// Stops at the first failed step (api-draft principle 2: no silent success).
import * as input from "../browser/input.js";
import { diffSnapshots, formatDiff } from "../render/diff.js";
import { briefElement, formatElement } from "../render/format.js";
import type { ElementInfo, LocateOptions, LocateResult, Snapshot, SnapshotDiff, Step, StepResult, TargetSpec } from "../types.js";
import type { Session } from "./session.js";
import { phase } from "./trace.js";
import { NO_SCREENSHOT, withEvents, type ImageMode, type ToolOutput, type View } from "./view.js";

const WAIT_DEFAULT_MS = 10_000;

class StepError extends Error {}

export async function act(session: Session, view: View, steps: Step[], screenshot?: ImageMode | boolean): Promise<ToolOutput> {
  const start = await view.snapshot();
  const results: StepResult[] = [];
  session.forgetNewTabs(); // only tabs opened by these steps are followed
  for (const step of steps) {
    const res = await phase(`step ${Object.keys(step)[0]}`, () => runStep(session, view, step));
    results.push(res);
    if (!res.ok) break;
    // A new tab takes over, like in the browser; later steps were planned for the old page.
    if (session.hasNewTab()) return inNewTab(session, view, results, steps.length, screenshot);
  }

  const settle = await session.settle(1000);
  const end = await view.snapshot();
  const base = view.last ?? start;
  const diff = withoutFocusNoise(diffSnapshots(base, end));
  view.last = end;

  const lines = results.map(formatResult);
  const done = results.filter((r) => r.ok).length;
  if (done < steps.length) lines.push(`  stopped: ${done} of ${steps.length} done`);
  if (!settle.settled) lines.push(`⏳ still loading: ${settle.pending.join("; ")}`);
  // Another page: its state says more than a list of everything that disappeared from the old one.
  if (diff.urlChanged && newPage(diff.urlChanged.from, diff.urlChanged.to)) {
    const out = await view.look({ image: imageMode(screenshot), settled: settle.settled });
    lines.push("", `Now on ${end.url}:`, out.text);
    return { text: lines.join("\n"), image: out.image };
  }
  lines.push("", "Changes:", formatDiff(diff, { scrolled: base.scroll.y !== end.scroll.y || results.some((r) => r.summary.startsWith("scroll")) }));
  const want = view.wantsImage(screenshot, diff);
  const image = want ? await view.image(end) : undefined;
  if (want && !image) lines.push(NO_SCREENSHOT);
  return { text: withEvents(lines.join("\n"), session), image };
}

function imageMode(screenshot?: ImageMode | boolean): ImageMode {
  return screenshot === true ? "always" : screenshot === false ? "never" : (screenshot ?? "auto");
}

/** A different path (not just a hash or query change within the same view). */
function newPage(from: string, to: string): boolean {
  try {
    const a = new URL(from);
    const b = new URL(to);
    return a.origin !== b.origin || a.pathname !== b.pathname;
  } catch {
    return from !== to;
  }
}

async function inNewTab(session: Session, view: View, results: StepResult[], total: number, screenshot?: ImageMode | boolean): Promise<ToolOutput> {
  const page = await session.followNewTab();
  const lines = results.map(formatResult);
  if (results.length < total) lines.push(`  stopped: ${results.length} of ${total} done — the rest was meant for the old tab`);
  if (!page) return { text: withEvents([...lines, "", "A new tab opened but could not be attached; use tabs."].join("\n"), session) };
  view.reset();
  const settle = await session.settle(5000);
  const out = await view.look({ image: imageMode(screenshot), settled: settle.settled });
  lines.push("", "Now in the new tab (tabs to go back):", out.text);
  return { text: lines.join("\n"), image: out.image };
}

/** Focus moving around is a side effect of every click; the agent does not need it in the diff. */
function withoutFocusNoise(diff: SnapshotDiff): SnapshotDiff {
  const changed = diff.changed
    .map((c) => ({ ...c, fields: c.fields.filter((f) => f !== "state.focused") }))
    .filter((c) => c.fields.length > 0);
  return { ...diff, changed };
}

function formatResult(r: StepResult): string {
  const sep = r.detail && !/^[→=(]/.test(r.detail) ? " — " : " ";
  const head = `${r.ok ? (r.warning ? "⚠" : "✓") : "✗"} ${r.summary}${r.detail ? `${sep}${r.detail}` : ""}`;
  // SPAs send dozens of identical calls per click (POST /api/graphql/): one line per distinct request.
  const groups = new Map<string, number>();
  for (const n of r.network) {
    const status = n.cancelled ? "cancelled by the page" : `${n.status || "failed"}${n.error ? ` ${n.error}` : ""}`;
    const line = `${n.method} ${n.url} → ${status}${n.thirdParty ? " (third-party, ignored)" : ""}`;
    groups.set(line, (groups.get(line) ?? 0) + 1);
  }
  const lines = [...groups].map(([line, count]) => `    ${count > 1 ? line.replace(" → ", ` ×${count} → `) : line}`);
  // Failures first so a cut never hides them.
  lines.sort((a, b) => Number(/→ (failed|[45]\d\d)/.test(b)) - Number(/→ (failed|[45]\d\d)/.test(a)));
  const net = lines.length > MAX_NET_LINES ? [...lines.slice(0, MAX_NET_LINES), `    … ${lines.length - MAX_NET_LINES} more`] : lines;
  return [head, ...net].join("\n");
}

const MAX_NET_LINES = 6;

async function runStep(session: Session, view: View, step: Step): Promise<StepResult> {
  const { network } = await session.current();
  const mark = network.mark();
  const ctx: StepCtx = { session, view, summary: describeStep(step) };
  try {
    const detail = await execute(ctx, step);
    await network.drain();
    const net = network.mutationsSince(mark);
    const failed = net.find((n) => !n.thirdParty && !n.cancelled && (n.status === 0 || n.status >= 400));
    return { ok: !failed, summary: ctx.summary, detail: failed ? (detail ? `${detail}; request failed` : "request failed") : detail, warning: ctx.warning, network: net };
  } catch (e) {
    const msg = e instanceof StepError ? e.message : `error: ${(e as Error).message}`;
    await network.drain().catch(() => {});
    return { ok: false, summary: ctx.summary, detail: msg, network: network.mutationsSince(mark) };
  }
}

interface StepCtx {
  session: Session;
  view: View;
  summary: string;
  warning?: boolean;
}

function describeStep(step: Step): string {
  const [kind, arg] = Object.entries(step)[0] as [string, unknown];
  return `${kind} ${JSON.stringify(arg)}`;
}

/** Steps after which a human's focus is still in the field they just filled. */
const KEEPS_FOCUS = ["fill", "press", "wait_for", "expect"];

async function execute(ctx: StepCtx, step: Step): Promise<string | undefined> {
  if (!KEEPS_FOCUS.some((k) => k in step)) ctx.view.lastFilled = undefined;
  if ("click" in step) return clickLike(ctx, step.click, "click");
  if ("dblclick" in step) return clickLike(ctx, step.dblclick, "dblclick");
  if ("hover" in step) return clickLike(ctx, step.hover, "hover");
  if ("fill" in step) return fill(ctx, step.fill);
  if ("select" in step) return select(ctx, step.select[0], step.select[1]);
  if ("check" in step) return check(ctx, step.check[0], step.check[1]);
  if ("press" in step) return press(ctx, step.press);
  if ("scroll" in step) return scroll(ctx, step.scroll);
  if ("wait_for" in step) return waitFor(ctx, step.wait_for, step.timeout ?? WAIT_DEFAULT_MS);
  if ("expect" in step) return expectStep(ctx, step.expect);
  throw new StepError(`unknown step ${JSON.stringify(step)}`);
}

// ---- target resolution ----

/** A target named by text may still be rendering (calendar, list after a click): look again for this long. */
const LOCATE_RETRY_MS = 1500;

async function locate(ctx: StepCtx, target: TargetSpec, opts: LocateOptions = {}): Promise<Extract<LocateResult, { ok: true }>> {
  const deadline = Date.now() + LOCATE_RETRY_MS;
  let res = await ctx.session.call("locate", target, { scroll: true, ...opts });
  while (!res.ok && res.error === "not_found" && typeof target !== "number" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    res = await ctx.session.call("locate", target, { scroll: true, ...opts });
  }
  if (res.ok) {
    ctx.summary = `${ctx.summary.split(" ")[0]} ${briefElement(res.info)}`;
    return res;
  }
  const cands = res.candidates?.length ? `\n${res.candidates.map((c) => `      ${formatElement(c)}`).join("\n")}` : "";
  // Long lists and forms drop rows that scrolled away; the number comes back when they are rendered again.
  const hint = / is not rendered$/.test(res.message) ? " (likely dropped while off-screen: scroll its list back, or target it by text)" : "";
  throw new StepError(`${res.error}: ${res.message}${hint}${cands}`);
}

function isTextField(info: ElementInfo): boolean {
  return ["textbox", "searchbox", "spinbutton", "combobox"].includes(info.role);
}

// ---- steps ----

async function clickLike(ctx: StepCtx, target: TargetSpec, kind: "click" | "dblclick" | "hover"): Promise<string | undefined> {
  const { cdp, network } = await ctx.session.current();
  let loc = await locate(ctx, target);
  // A human scrolls a bit when the target hides under a sticky header or a bottom bar.
  if (loc.occludedBy && /\((fixed|sticky)\)/.test(loc.occludedBy)) loc = await locate(ctx, loc.id, { center: true });
  if (loc.occludedBy) throw new StepError(`occluded by ${loc.occludedBy}: close or scroll it away first`);
  const before = await ctx.view.snapshot();
  const mark = network.mark();
  const urlBefore = before.url;
  if (kind === "hover") await input.hover(cdp, loc.point);
  else await input.click(cdp, loc.point, { clickCount: kind === "dblclick" ? 2 : 1 });
  await ctx.session.settle();
  if (kind === "hover") return undefined;

  const after = await ctx.view.snapshot().catch(() => undefined);
  if (!after) return "→ page is navigating";
  const diff = diffSnapshots(before, after);
  // Focus moving to the clicked button is not an effect; focusing a text field is.
  const changed = diff.changed.filter((c) => c.fields.some((f) => f !== "state.focused"));
  if (ctx.session.hasNewTab()) return "→ opened a new tab";
  const anyChange =
    after.url !== urlBefore ||
    diff.added.length + diff.removed.length + changed.length + diff.newMessages.length > 0 ||
    network.mutationsSince(mark).some((n) => !n.thirdParty) ||
    (isTextField(loc.info) && (await ctx.session.call("describe", loc.id))?.state.focused);
  if (!anyChange) throw new StepError("no visible change after the click");
  return effectSummary(before, after);
}

function effectSummary(before: Snapshot, after: Snapshot): string | undefined {
  if (after.url !== before.url) return `→ ${after.url}`;
  if (after.layer !== before.layer) return after.layer ? `→ opened ${after.layer}` : `→ closed ${before.layer}`;
  return undefined;
}

async function fill(ctx: StepCtx, fields: Record<string, string>): Promise<string | undefined> {
  const { cdp } = await ctx.session.current();
  const out: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    const target: TargetSpec = /^\d+$/.test(key) ? Number(key) : key;
    const loc = await locate(ctx, target);
    if (loc.occludedBy) throw new StepError(`[${loc.id}] occluded by ${loc.occludedBy}`);
    if (!(await ctx.session.call("focusAndSelectAll", loc.id))) throw new StepError(`[${loc.id}] cannot be focused`);
    if (value === "") await input.press(cdp, "Delete");
    // Autocomplete fields often react to key events only, not to inserted text.
    else if (wantsKeys(loc.info, value)) await input.typeText(cdp, value);
    else await input.insertText(cdp, value);
    let actual = (await ctx.session.call("describe", loc.id))?.value ?? "";
    if (actual !== value && !isMasked(actual)) {
      // Typing did not stick (controlled input that ignores insertText): native setter fallback.
      await ctx.session.call("setNativeValue", loc.id, value);
      actual = (await ctx.session.call("describe", loc.id))?.value ?? "";
    }
    const typed = wantsKeys(loc.info, value);
    let committed = await commit(ctx, loc.id, typed, actual);
    if (!typed && !matches(committed, value) && value !== "" && value.length <= TYPED_MAX) {
      // A controlled field (Meta budget) follows key events only: inserted text is reverted on blur
      // or mixed with the old value ("20,00" + "0,50" → "200,50"). Retype as a human would.
      if (await ctx.session.call("focusAndSelectAll", loc.id)) {
        await input.press(cdp, "Control+A");
        await input.typeText(cdp, value);
        committed = await commit(ctx, loc.id, false, committed);
      }
    }
    ctx.view.lastFilled = loc.id;
    const label = `[${loc.id}] ${JSON.stringify(loc.info.name)}`;
    if (committed === value || isMasked(committed) || sameText(committed, value)) out.push(`${label} = ${JSON.stringify(value)}`);
    else if (sameNumber(committed, value)) out.push(`${label} = ${JSON.stringify(committed)}`);
    else {
      ctx.warning = true;
      out.push(`${label}: requested ${JSON.stringify(value)} → actual ${JSON.stringify(committed)}`);
    }
  }
  ctx.summary = "fill";
  return out.join("; ");
}

/**
 * Commit: many forms reformat or validate on blur ("50" → "50,00"). An autocomplete keeps
 * focus: blur would close the suggestions the agent is about to pick from.
 */
async function commit(ctx: StepCtx, id: number, keepFocus: boolean, fallback: string): Promise<string> {
  if (!keepFocus) await (await ctx.session.current()).page.evaluate("document.activeElement && document.activeElement.blur()");
  await ctx.session.settle();
  return (await ctx.session.call("describe", id))?.value ?? fallback;
}

function matches(actual: string, value: string): boolean {
  return actual === value || isMasked(actual) || sameText(actual, value) || sameNumber(actual, value);
}

/** The page script shortens long values with "…"; a matching prefix is the same text. */
function sameText(actual: string, value: string): boolean {
  return actual.endsWith("…") && value.startsWith(actual.slice(0, -1));
}

function isMasked(v: string): boolean {
  return v.length > 0 && /^•+$/.test(v);
}

/** "10" and "10,00" / "1 000.00" are the same amount; a page formatting it is not a warning. */
function sameNumber(a: string, b: string): boolean {
  const num = (s: string) => (/^[\d\s., ]+$/.test(s) ? Number(s.replace(/[\s ]/g, "").replace(",", ".")) : NaN);
  const x = num(a);
  return !Number.isNaN(x) && x === num(b);
}

/** Longer texts are inserted at once: key by key costs two CDP calls per character. */
const TYPED_MAX = 60;

function wantsKeys(info: ElementInfo, value: string): boolean {
  return (info.role === "combobox" || info.role === "searchbox") && value.length <= TYPED_MAX;
}

/** Whether the focused element (through open shadow roots) takes typed text. */
const FOCUSED_TEXT_FIELD = `(() => {
  let a = document.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  if (!a) return false;
  if (a.isContentEditable || a.localName === "textarea") return true;
  return a.localName === "input" && /^(text|search|email|url|tel|number|)$/.test(a.type || "");
})()`;

async function select(ctx: StepCtx, target: TargetSpec, text: string): Promise<string | undefined> {
  const { cdp, page } = await ctx.session.current();
  const loc = await locate(ctx, target);
  const native = await ctx.session.call("selectNativeOption", loc.id, text);
  if (native.ok) {
    await ctx.session.settle();
    return `= ${JSON.stringify(native.value)}`;
  }
  if (native.options?.length) throw new StepError(`no option "${text}"; options: ${native.options.join(" | ")}`);

  // Custom dropdown: open, find the option (typing to filter, scrolling a virtualized list), click.
  // No Escape on failure: when the list did not open, Escape goes to the page (in Ads Manager it
  // closes the editor and offers to publish the drafts).
  await input.click(cdp, loc.point);
  await ctx.session.settle();
  let opts = await waitOptions(ctx, text);
  let option = pickOption(opts, text);
  const focusedField = !option && (await page.evaluate(FOCUSED_TEXT_FIELD));
  if (!option && (focusedField || isTextField(loc.info))) {
    // The click may have opened a dialog with its own search field (Google Flights): type where the focus is.
    if (focusedField) await input.press(cdp, "Control+A"); // replace the text, never append to it
    else await ctx.session.call("focusAndSelectAll", loc.id);
    await input.typeText(cdp, text);
    await ctx.session.settle();
    opts = await waitOptions(ctx, text);
    option = pickOption(opts, text);
  }
  if (!option && opts.length) option = await scrollToOption(ctx, opts, text);
  if (!option) {
    throw new StepError(`no option "${text}"${opts.length ? `; visible options: ${opts.map((o) => o.name).join(" | ")}` : "; the list did not open"}`);
  }
  const optLoc = await ctx.session.call("locate", option.id, { scroll: true });
  if (!optLoc.ok) throw new StepError(`option ${briefElement(option)}: ${optLoc.message}`);
  await input.click(cdp, optLoc.point);
  await ctx.session.settle();
  const value = (await ctx.session.call("describe", loc.id))?.value ?? "";
  if (value.toLowerCase().includes(text.toLowerCase())) return `= ${JSON.stringify(value)}`;
  ctx.warning = true;
  return `clicked option ${JSON.stringify(option.name)}, field shows ${JSON.stringify(value)}`;
}

/** Lists often open with a delay after the click or the typing: poll until the option shows up. */
const OPTIONS_WAIT_MS = 3000;

async function waitOptions(ctx: StepCtx, text: string): Promise<ElementInfo[]> {
  const deadline = Date.now() + OPTIONS_WAIT_MS;
  for (;;) {
    const opts = await ctx.session.call("openOptions");
    if (matching(opts, text).length || Date.now() > deadline) return opts;
    await new Promise((r) => setTimeout(r, 200));
  }
}

function matching(options: ElementInfo[], text: string): ElementInfo[] {
  const t = text.trim().toLowerCase();
  const exact = options.filter((o) => o.name.trim().toLowerCase() === t);
  return exact.length ? exact : options.filter((o) => o.name.toLowerCase().includes(t));
}

/** The one option matching the text; several matches are an error, as for any target. */
function pickOption(options: ElementInfo[], text: string): ElementInfo | undefined {
  const found = matching(options, text);
  if (found.length > 1) {
    throw new StepError(`ambiguous option "${text}", matches:\n${found.map((o) => `      ${formatElement(o)}`).join("\n")}`);
  }
  return found[0];
}

/** Virtualized lists render only the visible options: scroll the list from the top until the option appears. */
async function scrollToOption(ctx: StepCtx, opts: ElementInfo[], text: string): Promise<ElementInfo | undefined> {
  const { page } = await ctx.session.current();
  // A point inside the list: the first option (the last one is often clipped by the list's edge).
  const first = opts[0];
  const at = await ctx.session.call("locate", first.id, { scroll: true });
  if (!at.ok) return undefined;
  const point = at.point;
  const step = (to: "top" | number) => page.evaluate(`(${scrollBy.toString()})(${JSON.stringify(to)}, ${JSON.stringify(point)})`) as Promise<ScrollOutcome>;
  if (!(await step("top")).what) return undefined;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150)); // let the list render the new rows
    const option = pickOption(await ctx.session.call("openOptions"), text);
    if (option) return option;
    if (!(await step(Math.max(100, first.rect.h * 4))).moved) return undefined;
  }
  return undefined;
}

async function check(ctx: StepCtx, target: TargetSpec, want: boolean): Promise<string | undefined> {
  const { cdp } = await ctx.session.current();
  const loc = await locate(ctx, target);
  if (!!loc.info.state.checked === want) return "(already)";
  if (loc.occludedBy) throw new StepError(`occluded by ${loc.occludedBy}`);
  await input.click(cdp, loc.point);
  await ctx.session.settle();
  const now = (await ctx.session.call("describe", loc.id))?.state.checked;
  if (!!now !== want) throw new StepError(`state is still ${now ? "checked" : "unchecked"}`);
  return want ? "☑" : "☐";
}

/** Keys meant to do something visible; a press with no effect fails like a click with none. */
const ACTION_KEYS = new Set(["Enter", "Space", " ", "Escape"]);

const NOTHING_FOCUSED = "!document.activeElement || document.activeElement === document.body";

async function press(ctx: StepCtx, combo: string): Promise<string | undefined> {
  const { cdp, network, page } = await ctx.session.current();
  // fill commits with blur; a human pressing Enter next would still be in the field.
  if (ctx.view.lastFilled !== undefined && (await page.evaluate(NOTHING_FOCUSED))) {
    await ctx.session.call("focusAtEnd", ctx.view.lastFilled);
  }
  const before = await ctx.view.snapshot();
  const mark = network.mark();
  await input.press(cdp, combo);
  await ctx.session.settle();
  const after = await ctx.view.snapshot().catch(() => undefined);
  if (!after) return "→ page is navigating";
  const diff = diffSnapshots(before, after);
  const anyChange =
    after.url !== before.url ||
    diff.added.length + diff.removed.length + diff.changed.length + diff.newMessages.length > 0 ||
    network.mutationsSince(mark).some((n) => !n.thirdParty) ||
    ctx.session.hasNewTab();
  if (anyChange) return effectSummary(before, after);
  if (ACTION_KEYS.has(combo)) throw new StepError(`no visible change after ${combo}`);
  // Arrows, Home, Shift+arrows in a text field move the caret or the selection: nothing to see, not a failure.
  if (await page.evaluate(FOCUSED_TEXT_FIELD)) return "(in text field)";
  ctx.warning = true;
  return "(no visible change)";
}

async function scroll(ctx: StepCtx, spec: { in?: TargetSpec; to?: "top" | "bottom" | TargetSpec; by?: number }): Promise<string | undefined> {
  const { page, cdp } = await ctx.session.current();
  const { to, by } = spec;
  if ((to === undefined) === (by === undefined)) throw new StepError('scroll needs either to ("top" | "bottom" | element) or by (pixels)');
  if (to !== undefined && to !== "top" && to !== "bottom") {
    const before = await page.evaluate(SCROLL_POSITIONS);
    const loc = await locate(ctx, to, { anyKind: true }); // locate scrolls the target into view, inner containers included
    const moved = before !== (await page.evaluate(SCROLL_POSITIONS));
    await ctx.session.settle();
    // Some pages scroll back (focus handling, virtualized forms): check where the element ended up.
    const now = await ctx.session.call("describe", loc.id);
    if (!now?.inViewport) throw new StepError(moved ? "scrolled to it, but the page moved it out of view again" : "nothing scrolled and the element is still out of view");
    return moved ? undefined : "(already in view)";
  }
  const amount = (by ?? to) as "top" | "bottom" | number;
  const before = await ctx.view.snapshot();
  // Like a human with the mouse over it: the given container, else the open dialog (the page
  // behind a modal does not scroll), else the document or the largest scrollable container.
  let point: { x: number; y: number } | null = null;
  if (spec.in !== undefined) point = (await locate(ctx, spec.in, { anyState: true })).point;
  else if (before.layer) point = layerPoint(before);
  const r = (await page.evaluate(`(${scrollBy.toString()})(${JSON.stringify(amount)}, ${JSON.stringify(point)})`)) as ScrollOutcome;
  if (!r.moved && r.what === null && point) {
    // No DOM scroll container: custom scrollers (calendars, canvases) listen to the wheel.
    const delta = amount === "top" ? -5000 : amount === "bottom" ? 5000 : amount;
    await input.wheel(cdp, point, delta);
  }
  await ctx.session.settle();
  const after = await ctx.view.snapshot();
  if (sameView(before, after)) {
    if (r.atEdge) return `(already at the ${typeof amount === "number" ? (amount < 0 ? "top" : "bottom") : amount} of ${r.what})`;
    if (r.what === null) throw new StepError(point ? `nothing scrolls at that point${before.layer ? ` (inside ${before.layer})` : ""}` : "nothing on the page scrolls");
    if (!r.moved) throw new StepError(`${r.what} did not scroll`);
    // Moved, but only plain text was there: not a failure, but the agent should not expect new controls.
    ctx.warning = true;
    return `(${r.what} scrolled, no listed element changed)`;
  }
  return r.what ? `(${r.what})` : undefined;
}

/** A point inside the open modal layer: the center of its first visible element. */
function layerPoint(snap: Snapshot): { x: number; y: number } | null {
  const el = snap.elements.find((e) => e.inViewport && !e.occludedBy);
  return el ? { x: el.rect.x + el.rect.w / 2, y: el.rect.y + el.rect.h / 2 } : null;
}

/** Same elements at the same places: nothing the agent could see changed. */
function sameView(a: Snapshot, b: Snapshot): boolean {
  const key = (s: Snapshot) => s.elements.filter((e) => e.inViewport).map((e) => `${e.id}:${e.rect.x},${e.rect.y}:${e.name}`).join("|");
  return a.scroll.y === b.scroll.y && key(a) === key(b);
}

interface ScrollOutcome {
  what: string | null;
  moved: boolean;
  atEdge: boolean;
}

/** All non-zero scroll offsets as a string, to tell whether anything moved. */
const SCROLL_POSITIONS = `(() => {
  const out = [scrollX, scrollY];
  for (const el of document.querySelectorAll("*")) if (el.scrollTop || el.scrollLeft) out.push(el.scrollTop, el.scrollLeft);
  return out.join(",");
})()`;

// Runs in the page (serialized with toString), so it must be self-contained.
function scrollBy(to: "top" | "bottom" | number, point: { x: number; y: number } | null): ScrollOutcome {
  const scrollable = (el: Element) => {
    const oy = getComputedStyle(el).overflowY;
    return (oy === "auto" || oy === "scroll" || oy === "overlay") && el.scrollHeight > el.clientHeight + 1;
  };
  let box: Element | null = null;
  let what = "page";
  if (point) {
    // The nearest scrollable ancestor that can still move that way: nested lists are common, and
    // the inner one is often already at its edge while the agent means the outer one.
    const up = to === "top" || (typeof to === "number" && to < 0);
    const canMove = (el: Element) => (up ? el.scrollTop > 0 : el.scrollTop < el.scrollHeight - el.clientHeight - 1);
    let first: Element | null = null;
    for (let el = document.elementFromPoint(point.x, point.y); el; el = el.parentElement) {
      if (el === document.body || el === document.documentElement) break;
      if (!scrollable(el)) continue;
      first ??= el;
      if (canMove(el)) {
        box = el;
        break;
      }
    }
    box ??= first;
    if (!box) return { what: null, moved: false, atEdge: false };
  } else if (document.documentElement.scrollHeight <= innerHeight + 1) {
    let best = 0;
    for (const el of document.querySelectorAll("*")) {
      if (!scrollable(el)) continue;
      const r = el.getBoundingClientRect();
      const area = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (area > best) {
        best = area;
        box = el;
      }
    }
    if (!box) return { what: null, moved: false, atEdge: false };
  }
  if (box) {
    const label = box.getAttribute("aria-label") || box.id || box.localName;
    what = `scroll container "${label.slice(0, 40)}"`;
  }
  const el = box ?? document.scrollingElement ?? document.documentElement;
  const before = el.scrollTop;
  const max = el.scrollHeight - el.clientHeight;
  const target = to === "top" ? 0 : to === "bottom" ? max : before + to;
  el.scrollTop = target;
  const moved = Math.abs(el.scrollTop - before) >= 1;
  return { what, moved, atEdge: !moved && (before <= 0 || before >= max - 1) };
}

async function waitFor(ctx: StepCtx, cond: { text?: string; gone?: string; url?: string }, timeout: number): Promise<string | undefined> {
  const { page } = await ctx.session.current();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ok =
      (cond.text === undefined || (await ctx.session.call("hasText", cond.text).catch(() => false))) &&
      (cond.gone === undefined || !(await ctx.session.call("hasText", cond.gone).catch(() => true))) &&
      (cond.url === undefined || page.url().includes(cond.url));
    if (ok) return undefined;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new StepError(`timeout after ${timeout} ms`);
}

async function expectStep(ctx: StepCtx, cond: { text?: string; in?: TargetSpec; url?: string }): Promise<string | undefined> {
  const { page } = await ctx.session.current();
  if (cond.url !== undefined && !page.url().includes(cond.url)) throw new StepError(`url is ${page.url()}`);
  if (cond.text !== undefined) {
    const scope = typeof cond.in === "object" ? cond.in.text : cond.in;
    if (!(await ctx.session.call("hasText", cond.text, scope))) throw new StepError(`text not found${scope !== undefined ? ` in ${JSON.stringify(scope)}` : ""}`);
  }
  return undefined;
}
