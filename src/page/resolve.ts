// Resolution of ids and scopes to elements, with fingerprint-based recovery of dead ids.
import type { LocateError } from "../types.js";
import type { Cand, Collection } from "./collect.js";
import { makeCandFor } from "./collect.js";
import { CONTAINER_SEL, SCOPE_SEL, accName } from "./context.js";
import { registry } from "./registry.js";
import { composedAncestors, explicitRole, norm, textOf } from "./util.js";
import { isRendered } from "./visibility.js";

export type Resolution =
  | { ok: true; cand: Cand }
  | { ok: false; error: LocateError; message: string; candidates?: Cand[] };

/**
 * Element behind a registry id. A live element is used as is. A dead one is
 * looked up by fingerprint in the current collection: exactly one unknown match
 * rebinds the id, none is stale, several are ambiguous.
 */
export function resolveById(coll: Collection, id: number): Resolution {
  const entry = registry.entry(id);
  if (!entry) return { ok: false, error: "stale", message: `unknown element id ${id}` };
  const el = entry.ref.deref();
  if (el?.isConnected) {
    const cand = coll.cands.find((c) => c.el === el) ?? makeCandFor(el, coll);
    return { ok: true, cand };
  }
  const matches = coll.cands.filter((c) => c.fp === entry.fp && !registry.isKnownAlive(c.el));
  if (matches.length === 1) {
    registry.rebind(id, matches[0].el, entry.fp);
    return { ok: true, cand: matches[0] };
  }
  if (matches.length === 0) {
    return { ok: false, error: "stale", message: `element [${id}] is no longer on the page` };
  }
  return {
    ok: false,
    error: "ambiguous",
    message: `element [${id}] was replaced by ${matches.length} elements`,
    candidates: matches.slice(0, 8),
  };
}

/** Scope element for a snapshot/hasText/{in}: an id, or a named dialog/section/... or a heading. */
export function resolveScope(q: number | string, coll: Collection): Element | null {
  if (typeof q === "number") {
    const r = resolveById(coll, q);
    return r.ok ? r.cand.el : null;
  }
  const nq = norm(q);
  if (!nq) return null;
  let named: Element | null = null;
  let namedExact = false;
  let heading: Element | null = null;
  for (const { el } of coll.all) {
    if (el.matches(SCOPE_SEL)) {
      if (!isRendered(el)) continue;
      const n = norm(accName(el, coll.cache));
      if (!n || !n.includes(nq)) continue;
      const exact = n === nq;
      if (!named || (exact && !namedExact)) {
        named = el;
        namedExact = exact;
      }
    } else if (!heading && (/^h[1-6]$/.test(el.localName) || explicitRole(el) === "heading")) {
      if (norm(textOf(el)).includes(nq) && isRendered(el)) heading = el;
    }
  }
  if (named) return named;
  if (heading) {
    for (const a of composedAncestors(heading)) if (a.matches(SCOPE_SEL) || a.matches(CONTAINER_SEL)) return a;
    return heading.parentElement ?? heading;
  }
  return null;
}
