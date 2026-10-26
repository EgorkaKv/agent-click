// Executes act(steps): resolve target → trusted input → settle → verify effect → report.
// Stops at the first failed step (api-draft principle 2: no silent success).
import * as input from "../browser/input.js";
import { diffSnapshots, formatDiff } from "../render/diff.js";
import { formatElement } from "../render/format.js";
import type { ElementInfo, LocateResult, Snapshot, Step, StepResult, TargetSpec } from "../types.js";
import type { Session } from "./session.js";
import { withEvents, type ImageMode, type ToolOutput, type View } from "./view.js";

const WAIT_DEFAULT_MS = 10_000;

class StepError extends Error {}

export async function act(session: Session, view: View, steps: Step[], screenshot?: ImageMode | boolean): Promise<ToolOutput> {
  const start = await view.snapshot();
  const results: StepResult[] = [];
  for (const step of steps) {
    const res = await runStep(session, view, step);
    results.push(res);
    if (!res.ok) break;
  }

  const settle = await session.settle(1000);
  const end = await view.snapshot();
  const diff = diffSnapshots(view.last ?? start, end);
  view.last = end;

  const lines = results.map(formatResult);
  const done = results.filter((r) => r.ok).length;
  if (done < steps.length) lines.push(`  stopped: ${done} of ${steps.length} done`);
  if (!settle.settled) lines.push(`⏳ still loading: ${settle.pending.join("; ")}`);
  lines.push("", "Changes:", formatDiff(diff));
  const image = view.wantsImage(screenshot, diff) ? await view.image(end) : undefined;
  return { text: withEvents(lines.join("\n"), session), image };
}

function formatResult(r: StepResult): string {
  const head = `${r.ok ? (r.warning ? "⚠" : "✓") : "✗"} ${r.summary}${r.detail ? ` ${r.detail}` : ""}`;
  const net = r.network.map((n) => `    ${n.method} ${n.url} → ${n.status || "failed"}${n.error ? ` ${n.error}` : ""}`);
  return [head, ...net].join("\n");
}

async function runStep(session: Session, view: View, step: Step): Promise<StepResult> {
  const { network } = await session.current();
  const mark = network.mark();
  const ctx: StepCtx = { session, view, summary: describeStep(step) };
  try {
    const detail = await execute(ctx, step);
    await network.drain();
    const net = network.mutationsSince(mark);
    const failed = net.find((n) => n.status === 0 || n.status >= 400);
    return { ok: !failed, summary: ctx.summary, detail: failed ? `${detail ?? ""} — request failed`.trim() : detail, warning: ctx.warning, network: net };
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

async function execute(ctx: StepCtx, step: Step): Promise<string | undefined> {
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

async function locate(ctx: StepCtx, target: TargetSpec): Promise<Extract<LocateResult, { ok: true }>> {
  const res = await ctx.session.call("locate", target, { scroll: true });
  if (res.ok) {
    ctx.summary = `${ctx.summary.split(" ")[0]} ${formatElement(res.info)}`;
    return res;
  }
  const cands = res.candidates?.length ? `\n${res.candidates.map((c) => `      ${formatElement(c)}`).join("\n")}` : "";
  throw new StepError(`${res.error}: ${res.message}${cands}`);
}

function isTextField(info: ElementInfo): boolean {
  return ["textbox", "searchbox", "spinbutton", "combobox"].includes(info.role);
}

// ---- steps ----

async function clickLike(ctx: StepCtx, target: TargetSpec, kind: "click" | "dblclick" | "hover"): Promise<string | undefined> {
  const { cdp, network } = await ctx.session.current();
  const loc = await locate(ctx, target);
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
  const anyChange =
    after.url !== urlBefore ||
    diff.added.length + diff.removed.length + diff.changed.length + diff.newMessages.length > 0 ||
    network.mutationsSince(mark).length > 0 ||
    (await ctx.session.call("describe", loc.id))?.state.focused;
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
    else await input.insertText(cdp, value);
    let actual = (await ctx.session.call("describe", loc.id))?.value ?? "";
    if (actual !== value && !isMasked(actual)) {
      // Typing did not stick (controlled input that ignores insertText): native setter fallback.
      await ctx.session.call("setNativeValue", loc.id, value);
      actual = (await ctx.session.call("describe", loc.id))?.value ?? "";
    }
    // Commit: many forms reformat or validate on blur ("50" → "50,00").
    await (await ctx.session.current()).page.evaluate("document.activeElement && document.activeElement.blur()");
    await ctx.session.settle();
    const committed = (await ctx.session.call("describe", loc.id))?.value ?? actual;
    const label = `[${loc.id}] ${JSON.stringify(loc.info.name)}`;
    if (committed === value || isMasked(committed)) out.push(`${label} = ${JSON.stringify(value)}`);
    else {
      ctx.warning = true;
      out.push(`${label}: requested ${JSON.stringify(value)} → actual ${JSON.stringify(committed)}`);
    }
  }
  ctx.summary = "fill";
  return out.join("; ");
}

function isMasked(v: string): boolean {
  return v.length > 0 && /^•+$/.test(v);
}

async function select(ctx: StepCtx, target: TargetSpec, text: string): Promise<string | undefined> {
  const { cdp } = await ctx.session.current();
  const loc = await locate(ctx, target);
  const native = await ctx.session.call("selectNativeOption", loc.id, text);
  if (native.ok) {
    await ctx.session.settle();
    return `= ${JSON.stringify(native.value)}`;
  }
  if (native.options?.length) throw new StepError(`no option "${text}"; options: ${native.options.join(" | ")}`);

  // Custom dropdown: open, find the option (typing to filter if needed), click it, verify.
  for (let attempt = 0; attempt < 2; attempt++) {
    await input.click(cdp, (await locate(ctx, loc.id)).point);
    await ctx.session.settle();
    let option = pickOption(await ctx.session.call("openOptions"), text);
    if (!option && isTextField(loc.info)) {
      await input.insertText(cdp, text);
      await ctx.session.settle();
      option = pickOption(await ctx.session.call("openOptions"), text);
    }
    if (!option) {
      const opts = await ctx.session.call("openOptions");
      if (attempt === 1) throw new StepError(`no option "${text}"${opts.length ? `; visible options: ${opts.map((o) => o.name).join(" | ")}` : "; the list did not open"}`);
      await input.press(cdp, "Escape");
      continue;
    }
    const optLoc = await ctx.session.call("locate", option.id, { scroll: true });
    if (!optLoc.ok) continue;
    await input.click(cdp, optLoc.point);
    await ctx.session.settle();
    const value = (await ctx.session.call("describe", loc.id))?.value ?? "";
    if (value.toLowerCase().includes(text.toLowerCase())) return `= ${JSON.stringify(value)}`;
    if (attempt === 1) {
      ctx.warning = true;
      return `clicked option ${JSON.stringify(option.name)}, field shows ${JSON.stringify(value)}`;
    }
  }
  throw new StepError(`could not select "${text}"`);
}

function pickOption(options: ElementInfo[], text: string): ElementInfo | undefined {
  const t = text.trim().toLowerCase();
  return options.find((o) => o.name.trim().toLowerCase() === t) ?? options.find((o) => o.name.toLowerCase().includes(t));
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

async function press(ctx: StepCtx, combo: string): Promise<string | undefined> {
  const { cdp } = await ctx.session.current();
  await input.press(cdp, combo);
  await ctx.session.settle();
  return undefined;
}

async function scroll(ctx: StepCtx, spec: { in?: TargetSpec; to: "top" | "bottom" | number | TargetSpec }): Promise<string | undefined> {
  const { cdp, page } = await ctx.session.current();
  const { to } = spec;
  if (typeof to !== "number" && to !== "top" && to !== "bottom") {
    await locate(ctx, to); // locate scrolls the target into view
    return undefined;
  }
  if (spec.in === undefined) {
    const js = to === "top" ? "window.scrollTo(0, 0)" : to === "bottom" ? "window.scrollTo(0, document.documentElement.scrollHeight)" : `window.scrollBy(0, ${to})`;
    await page.evaluate(js);
  } else {
    const loc = await locate(ctx, spec.in);
    const deltaY = to === "top" ? -1e6 : to === "bottom" ? 1e6 : to;
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: loc.point.x, y: loc.point.y, deltaX: 0, deltaY });
  }
  await ctx.session.settle();
  return undefined;
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
