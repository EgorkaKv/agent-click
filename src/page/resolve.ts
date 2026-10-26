// Resolution of ids and scopes to elements, with fingerprint-based recovery of dead ids.
import type { LocateError } from "../types.js";
import type { Cand, Collection } from "./collect.js";
import { makeCandFor } from "./collect.js";
import { HAS_LETTER, SCOPE_SEL, accName, labelOf } from "./context.js";
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

/** Landmark words accepted as scope, with the tags and ARIA roles they stand for. */
const LANDMARKS = new Map<string, { tags: string[]; roles: string[] }>([
  ["main", { tags: ["main"], roles: ["main"] }],
  ["nav", { tags: ["nav"], roles: ["navigation"] }],
  ["header", { tags: ["header"], roles: ["banner"] }],
  ["footer", { tags: ["footer"], roles: ["contentinfo"] }],
  ["aside", { tags: ["aside"], roles: ["complementary"] }],
  ["form", { tags: ["form"], roles: ["form"] }],
]);

/** Scope element for a snapshot/hasText/{in}: an id, a landmark, a label as printed, a name, or a heading. */
export function resolveScope(q: number | string, coll: Collection): Element | null {
  if (typeof q === "number") {
    const r = resolveById(coll, q);
    return r.ok ? r.cand.el : null;
  }
  const nq = norm(q);
  if (!nq) return null;
  const lm = landmarkScope(nq, coll);
  if (lm) return lm;
  const byLabel = labelScope(nq, coll);
  if (byLabel) return byLabel;
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
      if (norm(textOf(el)).includes(nq) && HAS_LETTER.test(textOf(el)) && isRendered(el)) heading = el;
    }
  }
  if (named) return named;
  if (heading) return headingScope(heading);
  return null;
}

/** Stops the walk up from a heading: beyond these is another region of the page. */
const BOUNDARY_SEL =
  "main,[role=main],dialog,[role=dialog],[role=alertdialog],body,html,header,footer,nav,aside,[role=banner],[role=contentinfo],[role=navigation],[role=complementary]";

/**
 * The container a heading titles: the nearest ancestor that holds more than the heading
 * (other text or controls). The walk stops at a landmark, dialog or body.
 */
function headingScope(h: Element): Element {
  for (const a of composedAncestors(h)) {
    if (hasContentBeside(a, h)) return a;
    if (a.matches(BOUNDARY_SEL)) break;
  }
  return h.parentElement ?? h;
}

/** Visible text or a control in a, outside the heading h. */
function hasContentBeside(a: Element, h: Element): boolean {
  const walker = a.ownerDocument.createTreeWalker(a, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (h.contains(n) || !(n.textContent ?? "").trim()) continue;
    const p = n.parentElement;
    if (p && isRendered(p)) return true;
  }
  for (const c of a.querySelectorAll("input,select,textarea,img,[role=switch],[role=checkbox]")) {
    if (h.contains(c) || c.contains(h)) continue;
    if (isRendered(c)) return true;
  }
  return false;
}

/** The outermost rendered landmark of the kind named by the word (document order: ancestors first). */
function landmarkScope(nq: string, coll: Collection): Element | null {
  const lm = LANDMARKS.get(nq);
  if (!lm) return null;
  for (const { el } of coll.all) {
    const ex = explicitRole(el);
    if (!lm.tags.includes(el.localName) && !(ex && lm.roles.includes(ex))) continue;
    if (isRendered(el)) return el;
  }
  return null;
}

/** A label exactly as the output prints it, e.g. section "Production" or nav "Side navigation". */
function labelScope(nq: string, coll: Collection): Element | null {
  if (!nq.endsWith('"')) return null;
  for (const { el } of coll.all) {
    const label = labelOf(el, coll.cache);
    if (label && norm(label) === nq && isRendered(el)) return el;
  }
  return null;
}
