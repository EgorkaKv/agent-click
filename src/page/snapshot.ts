// snapshot(): the numbered element list the agent reads, plus messages, loading and offscreen summary.
import type { ElementInfo, OffscreenSummary, Snapshot, SnapshotOptions } from "../types.js";
import { type Cand, type Collection, collect } from "./collect.js";
import { buildInfo, valueOf } from "./info.js";
import { loadingState } from "./loading.js";
import { registry } from "./registry.js";
import { resolveScope } from "./resolve.js";
import {
  TOAST_RE,
  composedAncestors,
  composedContains,
  explicitRole,
  spacedText,
  styleOf,
  truncate,
} from "./util.js";
import { isRendered, occlusionOf } from "./visibility.js";

/** Longer texts are containers (a chat transcript is a live region), not messages. */
const MESSAGE_MAX_LEN = 300;

/**
 * Status, alert, live-region and toast texts. Sources that hold collected controls are
 * containers, not messages, and so are sources already listed as elements (an inline status
 * badge is an element, not a message). Of nested sources only the innermost is kept, and each
 * text is reported once.
 */
/** An inline status element already in the list (`<span role=status>id123</span>`), unlike a block toast. */
function isBadge(el: Element, listed: Set<Element>): boolean {
  return listed.has(el) && styleOf(el).display.startsWith("inline");
}

/** Input and picker widgets: their text is a value or a choice, not a message. */
const WIDGET_SEL =
  "input,select,textarea,[contenteditable]:not([contenteditable=false]),[role=combobox],[role=spinbutton],[role=textbox],[role=searchbox],[role=slider],[role=listbox],[role=grid]";

function messagesOf(coll: Collection, listed: Set<Element>): string[] {
  const withControls = new Set<Element>();
  const values = new Set<string>();
  for (const c of coll.cands) {
    if (c.kind !== "interactive") continue;
    for (const a of composedAncestors(c.el)) withControls.add(a);
    const v = valueOf(c.el);
    if (v) values.add(v);
  }
  const sources: { el: Element; text: string }[] = [];
  for (const { el } of coll.all) {
    const role = explicitRole(el);
    const live = el.getAttribute("aria-live");
    const isMessage = role === "alert" || role === "status" || (live !== null && live !== "off");
    // A toast-like class alone counts only when the element really floats over the page.
    const floats = ["fixed", "absolute"].includes(styleOf(el).position);
    const isToast = TOAST_RE.test(el.getAttribute("class") ?? "") && floats;
    if (!isMessage && !isToast) continue;
    const text = spacedText(el);
    if (!text || text.length > MESSAGE_MAX_LEN || withControls.has(el) || isBadge(el, listed)) continue;
    if (values.has(text) || el.closest(WIDGET_SEL)) continue;
    if (!isRendered(el)) continue;
    sources.push({ el, text: truncate(text, 200) });
  }
  // Descendants come after their ancestors in document order, so walking backwards meets the innermost first.
  const keep = new Set<number>();
  const seen = new Set<string>();
  for (let i = sources.length - 1; i >= 0; i--) {
    if (seen.has(sources[i].text)) continue;
    seen.add(sources[i].text);
    keep.add(i);
  }
  const out: string[] = [];
  for (let i = 0; i < sources.length && out.length < 5; i++) {
    if (keep.has(i)) out.push(sources[i].text);
  }
  return out;
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
    const info = buildInfo(c, registry.assign(c, dead));
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
    loading: loadingState(),
    elements,
    offscreen: opts.full ? [] : summarizeOffscreen(pool.filter((c) => !c.inViewport)),
    messages: messagesOf(coll, new Set(shown.map((c) => c.el))),
  };
  if (coll.layer) snap.layer = coll.layer.label;
  if (list.length > max) snap.truncated = true;
  return snap;
}
