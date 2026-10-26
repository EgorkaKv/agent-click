// locate(): resolve a target (id, text, {text, in}) to a click point in the viewport.
import type { ElementInfo, LocateResult, TargetSpec } from "../types.js";
import { type Cand, type Collection, collect } from "./collect.js";
import { buildInfo, isDisabled, placeholderOf } from "./info.js";
import { registry, type DeadPool } from "./registry.js";
import { resolveById, resolveScope, type Resolution } from "./resolve.js";
import { composedContains, norm } from "./util.js";
import {
  clipBox,
  fullyVisibleIn,
  isRendered,
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
    .map((c) => `[${registry.assign(c.el, c.fp, dead)}] ${describeCand(c)}`)
    .join(", ");
}

function failure(error: "not_found" | "ambiguous" | "stale" | "not_visible" | "disabled", message: string, cands: Cand[], dead: DeadPool): LocateResult {
  if (cands.length === 0) return { ok: false, error, message };
  const candidates: ElementInfo[] = cands.map((c) => buildInfo(c, registry.assign(c.el, c.fp, dead)));
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

function resolveTarget(target: TargetSpec, coll: Collection, dead: DeadPool): Resolution {
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
  const pool = coll.cands.filter(
    (c) => c.kind === "interactive" && c.inLayer && (!scope || composedContains(scope, c.el)),
  );
  return matchText(pool, text, dead);
}

export function locate(target: TargetSpec, opts: { scroll?: boolean } = {}): LocateResult {
  const scroll = opts.scroll ?? true;
  const coll = collect();
  const dead = registry.deadPool();

  const r = resolveTarget(target, coll, dead);
  if (!r.ok) {
    return failure(r.error, r.message, r.candidates ?? [], dead);
  }
  const cand = r.cand;
  const id = registry.assign(cand.el, cand.fp, dead);
  const label = `[${id}] ${describeCand(cand)}`;

  if (!isRendered(cand.el)) {
    return { ok: false, error: "not_visible", message: `${label} is not rendered` };
  }
  if (isDisabled(cand.el)) {
    return { ok: false, error: "disabled", message: `${label} is disabled` };
  }

  const geometry = () => {
    const off = offsetOf(cand.el);
    const rect = rectOf(cand.el, off);
    const clip = clipBox(cand.el, off);
    return { off, rect, clip, vis: visibleBox(rect, clip) };
  };
  let geo = geometry();
  // Scroll when the element is not fully inside its clipping area (viewport or scroll container).
  if (scroll && !(geo.vis && fullyVisibleIn(geo.rect, geo.clip))) {
    try {
      cand.el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" } as ScrollIntoViewOptions);
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
  const point = { x: (vis.x1 + vis.x2) / 2, y: (vis.y1 + vis.y2) / 2 };
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
