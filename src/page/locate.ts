// locate(): resolve a target (id, text, {text, in}) to a click point in the viewport.
import type { ElementInfo, LocateOptions, LocateResult, TargetSpec } from "../types.js";
import { type Cand, type Collection, collect } from "./collect.js";
import { buildInfo, isDisabled, placeholderOf } from "./info.js";
import { registry, type DeadPool } from "./registry.js";
import { resolveById, resolveScope, type Resolution } from "./resolve.js";
import { composedContains, norm, type Pt } from "./util.js";
import {
  type Box,
  clickTarget,
  clipBox,
  fullyVisibleIn,
  occluderAt,
  offsetOf,
  rectOf,
  visibleBox,
} from "./visibility.js";

function describeCand(c: Cand): string {
  const last = c.ctx[c.ctx.length - 1];
  return `${c.role} "${c.name}"${last ? ` in ${last}` : ""}`;
}

/** "[12] button "Save" in dialog "Edit", [40] ..." (assigns ids to the listed elements). */
function listing(cands: Cand[], dead: DeadPool): string {
  return cands
    .map((c) => `[${registry.assign(c, dead)}] ${describeCand(c)}`)
    .join(", ");
}

function failure(error: "not_found" | "ambiguous" | "stale" | "not_visible" | "disabled", message: string, cands: Cand[], dead: DeadPool): LocateResult {
  if (cands.length === 0) return { ok: false, error, message };
  const candidates: ElementInfo[] = cands.map((c) => buildInfo(c, registry.assign(c, dead)));
  return { ok: false, error, message, candidates };
}

function matchText(pool: Cand[], query: string, dead: DeadPool): Resolution {
  const q = norm(query);
  const tiers: Array<(c: Cand) => boolean> = [
    (c) => norm(c.name) === q,
    (c) => norm(c.name).includes(q),
    (c) => {
      const p = placeholderOf(c.el);
      return !!p && norm(p) === q;
    },
    (c) => {
      const p = placeholderOf(c.el);
      return !!p && norm(p).includes(q);
    },
  ];
  if (q) {
    for (const t of tiers) {
      const m = pool.filter(t);
      if (m.length === 1) return { ok: true, cand: m[0] };
      if (m.length > 1) {
        const shown = m.slice(0, 8);
        return {
          ok: false,
          error: "ambiguous",
          message: `${m.length} elements match "${query}": ${listing(shown, dead)}${m.length > 8 ? ", ..." : ""}`,
          candidates: shown,
        };
      }
    }
  }
  const words = new Set(q.split(" ").filter(Boolean));
  const similar = pool.filter((c) => norm(c.name).split(" ").some((w) => words.has(w))).slice(0, 8);
  return {
    ok: false,
    error: "not_found",
    message:
      `no interactive element matches "${query}"` +
      (similar.length ? `; similar: ${listing(similar, dead)}` : ""),
    candidates: similar,
  };
}

function resolveTarget(target: TargetSpec, coll: Collection, dead: DeadPool, anyKind = false): Resolution {
  if (typeof target === "number") return resolveById(coll, target);
  let text: string;
  let scope: Element | null = null;
  if (typeof target === "string") {
    text = target;
  } else {
    text = target.text;
    if (target.in !== undefined) {
      scope = resolveScope(target.in, coll);
      if (!scope) {
        return { ok: false, error: "not_found", message: `no dialog, section or heading matches ${JSON.stringify(target.in)}` };
      }
    }
  }
  const inScope = (c: Cand) => c.inLayer && (!scope || composedContains(scope, c.el));
  if (anyKind) {
    // Scrolling to a section: its heading first ("Бюджет и график" is also a button's text).
    const byHeading = matchText(coll.cands.filter((c) => c.role === "heading" && inScope(c)), text, dead);
    if (byHeading.ok) return byHeading;
    return matchText(coll.cands.filter(inScope), text, dead);
  }
  return matchText(coll.cands.filter((c) => c.kind === "interactive" && inScope(c)), text, dead);
}

/**
 * A link wrapped over two lines: the middle of its bounding box falls between the lines, on the
 * text around it. Click the middle of its largest visible line fragment instead.
 */
function fragmentCenter(el: Element, off: Pt, vis: Box): Pt | null {
  const parts = [...el.getClientRects()];
  if (parts.length < 2) return null;
  let best: Box | null = null;
  let area = 0;
  for (const r of parts) {
    const b = { x1: Math.max(r.left + off.x, vis.x1), y1: Math.max(r.top + off.y, vis.y1), x2: Math.min(r.right + off.x, vis.x2), y2: Math.min(r.bottom + off.y, vis.y2) };
    const a = (b.x2 - b.x1) * (b.y2 - b.y1);
    if (b.x2 > b.x1 && b.y2 > b.y1 && a > area) [best, area] = [b, a];
  }
  return best && { x: (best.x1 + best.x2) / 2, y: (best.y1 + best.y2) / 2 };
}

export function locate(target: TargetSpec, opts: LocateOptions = {}): LocateResult {
  const scroll = opts.scroll ?? true;
  const coll = collect();
  const dead = registry.deadPool();

  const r = resolveTarget(target, coll, dead, opts.anyKind);
  if (!r.ok) {
    return failure(r.error, r.message, r.candidates ?? [], dead);
  }
  const cand = r.cand;
  const id = registry.assign(cand, dead);
  const label = `[${id}] ${describeCand(cand)}`;

  // A transparent checkbox or radio is clicked through its label: its box is the label's.
  const clickEl = clickTarget(cand.el);
  if (!clickEl) {
    return { ok: false, error: "not_visible", message: `${label} is not rendered` };
  }
  // anyState: the element is only a reference point (scroll container), not something to act on.
  if (!opts.anyState && isDisabled(cand.el)) {
    return { ok: false, error: "disabled", message: `${label} is disabled` };
  }

  const geometry = () => {
    const off = offsetOf(clickEl);
    const rect = rectOf(clickEl, off);
    const clip = clipBox(clickEl, off);
    return { off, rect, clip, vis: visibleBox(rect, clip) };
  };
  let geo = geometry();
  // Scroll when the element is not fully inside its clipping area (viewport or scroll container).
  // center: visible, but under a fixed header or bottom bar; the middle of its scroller is clear.
  if (scroll && (opts.center || !(geo.vis && fullyVisibleIn(geo.rect, geo.clip)))) {
    try {
      clickEl.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" } as ScrollIntoViewOptions);
    } catch {
      /* element without layout box: handled below */
    }
    geo = geometry();
  }
  const vis = geo.vis;
  if (!vis) {
    return {
      ok: false,
      error: "not_visible",
      message: `${label} is outside the viewport${scroll ? " and could not be scrolled into view" : ""}`,
    };
  }
  const point = fragmentCenter(clickEl, geo.off, vis) ?? { x: (vis.x1 + vis.x2) / 2, y: (vis.y1 + vis.y2) / 2 };
  const occludedBy = occluderAt(cand.el, geo.off, point);
  const moved: Cand = { ...cand, off: geo.off, rect: geo.rect, clip: geo.clip, visible: vis, inViewport: true };
  return {
    ok: true,
    id,
    point,
    info: buildInfo(moved, id),
    ...(occludedBy ? { occludedBy } : {}),
  };
}
