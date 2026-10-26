// snapshot(): the numbered element list the agent reads, plus messages, loading and offscreen summary.
import type { ElementInfo, OffscreenSummary, Snapshot, SnapshotOptions } from "../types.js";
import { type Cand, type Walked, type Collection, collect } from "./collect.js";
import { contextPath } from "./context.js";
import { buildInfo } from "./info.js";
import { registry } from "./registry.js";
import { resolveScope } from "./resolve.js";
import { LOADING_RE, TOAST_RE, composedContains, explicitRole, textOf, truncate } from "./util.js";
import { isRendered, occlusionOf } from "./visibility.js";

function messagesOf(all: Walked[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const { el } of all) {
    if (out.length >= 5) break;
    const role = explicitRole(el);
    const live = el.getAttribute("aria-live");
    const isMessage = role === "alert" || role === "status" || (live !== null && live !== "off");
    const isToast = TOAST_RE.test(el.getAttribute("class") ?? "");
    if (!isMessage && !isToast) continue;
    const text = truncate(textOf(el), 200);
    if (!text || seen.has(text) || !isRendered(el)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function loadingOf(coll: Collection): { busy: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const { el } of coll.all) {
    if (reasons.length >= 5) break;
    let word: string | null = null;
    if (explicitRole(el) === "progressbar") word = "progressbar";
    else if (el.getAttribute("aria-busy") === "true") word = "busy";
    else {
      const m = LOADING_RE.exec(el.getAttribute("class") ?? "");
      if (m) word = m[0].toLowerCase();
    }
    if (!word || !isRendered(el)) continue;
    const ctx = contextPath(el, coll.cache);
    reasons.push(`${word} in ${ctx.length ? ctx[ctx.length - 1] : "page"}`);
  }
  return { busy: reasons.length > 0, reasons };
}

/**
 * Counts of elements above/below their clipping area (viewport or scroll container),
 * grouped by their outermost context label.
 */
function summarizeOffscreen(offs: Cand[]): OffscreenSummary[] {
  const map = new Map<string, OffscreenSummary>();
  for (const c of offs) {
    const r = c.rect;
    let direction: "above" | "below" | null = null;
    if (r.y + r.h <= c.clip.y1) direction = "above";
    else if (r.y >= c.clip.y2) direction = "below";
    if (!direction) continue;
    const context = c.ctx[0] ?? "page";
    const key = `${direction}|${context}`;
    const entry = map.get(key);
    if (entry) entry.count++;
    else map.set(key, { direction, context, count: 1 });
  }
  return [...map.values()];
}

export function snapshot(opts: SnapshotOptions = {}): Snapshot {
  const coll = collect();
  let scopeEl: Element | null = null;
  if (opts.scope !== undefined) {
    scopeEl = resolveScope(opts.scope, coll);
    if (!scopeEl) throw new Error(`scope not found: ${String(opts.scope)}`);
  }
  const pool = coll.cands.filter((c) => c.inLayer && (!scopeEl || composedContains(scopeEl, c.el)));
  const list = opts.full ? pool : pool.filter((c) => c.inViewport);
  const max = opts.maxElements ?? 150;
  const shown = list.slice(0, max);

  const dead = registry.deadPool();
  const elements: ElementInfo[] = shown.map((c) => {
    const info = buildInfo(c, registry.assign(c.el, c.fp, dead));
    if (c.kind === "interactive" && c.inViewport) {
      const occluded = occlusionOf(c.el, c.off, c.visible);
      if (occluded) info.occludedBy = occluded;
    }
    return info;
  });

  const de = document.documentElement;
  const snap: Snapshot = {
    url: location.href,
    title: document.title,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    scroll: {
      x: window.scrollX,
      y: window.scrollY,
      maxY: Math.max(0, de.scrollHeight - window.innerHeight),
    },
    loading: loadingOf(coll),
    elements,
    offscreen: opts.full ? [] : summarizeOffscreen(pool.filter((c) => !c.inViewport)),
    messages: messagesOf(coll.all),
  };
  if (coll.layer) snap.layer = coll.layer.label;
  if (list.length > max) snap.truncated = true;
  return snap;
}
