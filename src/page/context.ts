// Accessible names and context paths ("dialog "X" > section "Y" > row "Z"").
import { computeAccessibleName } from "dom-accessibility-api";
import { collapse, composedAncestors, explicitRole, parentAcross, textOf, truncate } from "./util.js";

/** Per-collection memo: names and labels are expensive and stable within one pass. */
export class Cache {
  readonly names = new WeakMap<Element, string>();
  readonly labels = new WeakMap<Element, string | null>();
  readonly headings = new WeakMap<Element, Element[]>();
  /** Labels of an element's composed ancestors, outermost first (shared, never mutated). */
  readonly paths = new WeakMap<Element, string[]>();
}

export const CONTAINER_SEL =
  "section,article,main,form,dialog,aside,nav,header,footer,fieldset,[role=region],[role=main],[role=dialog],[role=alertdialog],[role=tabpanel],[role=group],[role=form]";
/** Elements that scope a set of controls (used by scope resolution). */
export const SCOPE_SEL =
  "dialog,[role=dialog],[role=alertdialog],section,[role=region],fieldset,[role=group],[role=radiogroup],[role=tabpanel]";
const HEADING_SEL = "h1,h2,h3,h4,h5,h6,[role=heading]";

export function accName(el: Element, cache?: Cache): string {
  const hit = cache?.names.get(el);
  if (hit !== undefined) return hit;
  let n = "";
  try {
    n = collapse(computeAccessibleName(el));
  } catch {
    n = "";
  }
  cache?.names.set(el, n);
  return n;
}

function rowLabel(tr: Element): string {
  const cell = Array.from(tr.children).find((c) =>
    c.matches("td,th,[role=cell],[role=gridcell],[role=columnheader],[role=rowheader]"),
  );
  const t = cell ? truncate(textOf(cell), 40) : "";
  return t ? `row "${t}"` : "row";
}

function computeLabel(a: Element, cache: Cache, landmarksOnly: boolean): string | null {
  const tag = a.localName;
  const role = explicitRole(a);
  const named = (prefix: string): string => {
    const n = accName(a, cache);
    return n ? `${prefix} "${truncate(n, 60)}"` : prefix;
  };
  if (tag === "dialog" || role === "dialog" || role === "alertdialog") return named("dialog");
  if (tag === "header" || role === "banner") return "header";
  if (tag === "footer" || role === "contentinfo") return "footer";
  if (tag === "nav" || role === "navigation") return named("nav");
  if (tag === "main" || role === "main") return "main";
  if (tag === "aside" || role === "complementary") return "aside";
  if (landmarksOnly) return null;

  const namedOnly = (prefix: string): string | null => {
    const n = accName(a, cache);
    return n ? `${prefix} "${truncate(n, 60)}"` : null;
  };
  if (tag === "form" || role === "form") return namedOnly("form");
  if (tag === "section" || role === "region") return namedOnly("section");
  if (tag === "fieldset") {
    const legend = a.querySelector(":scope > legend");
    const t = legend ? truncate(textOf(legend), 60) : "";
    return t ? `group "${t}"` : null;
  }
  if (role === "group" || role === "radiogroup") return namedOnly("group");
  if (role === "tabpanel") return named("tabpanel");
  if (tag === "tr" || role === "row") return rowLabel(a);
  return null;
}

/** Label of an ancestor used in context paths. landmarksOnly limits it to header/nav/main/... */
export function labelOf(a: Element, cache: Cache, landmarksOnly = false): string | null {
  if (landmarksOnly) return computeLabel(a, cache, true);
  if (cache.labels.has(a)) return cache.labels.get(a) ?? null;
  const v = computeLabel(a, cache, false);
  cache.labels.set(a, v);
  return v;
}

function nearestHeading(el: Element, cache: Cache): string | null {
  let container: Element | null = null;
  for (const a of composedAncestors(el)) {
    if (a.matches(CONTAINER_SEL)) {
      container = a;
      break;
    }
  }
  container ??= el.ownerDocument.body ?? el.ownerDocument.documentElement;
  let heads = cache.headings.get(container);
  if (!heads) {
    heads = Array.from(container.querySelectorAll(HEADING_SEL));
    cache.headings.set(container, heads);
  }
  let best: Element | null = null;
  for (const h of heads) {
    if (h.contains(el)) continue;
    if (el.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_PRECEDING) {
      if (textOf(h)) best = h;
    } else {
      break; // document order: the first following heading ends the search
    }
  }
  return best ? truncate(textOf(best), 60) : null;
}

/**
 * Context path of an element, outermost first, at most 3 entries
 * (outermost + the two innermost). Falls back to the nearest preceding heading
 * of the same container when there is no dialog/section/group/tabpanel label.
 */
/** Labels of el's composed ancestors, outermost first; memoized so each ancestor is labelled once. */
function ancestorLabels(el: Element, cache: Cache): string[] {
  const hit = cache.paths.get(el);
  if (hit) return hit;
  const parent = parentAcross(el);
  let labels: string[] = [];
  if (parent && parent.nodeType === 1) {
    const p = parent as Element;
    labels = ancestorLabels(p, cache);
    const own = labelOf(p, cache);
    if (own) labels = [...labels, own];
  }
  cache.paths.set(el, labels);
  return labels;
}

export function contextPath(el: Element, cache: Cache): string[] {
  let labels = ancestorLabels(el, cache);
  if (!labels.some((l) => /^(dialog|section|group|tabpanel)\b/.test(l))) {
    labels = [...labels];
    const h = nearestHeading(el, cache);
    if (h) labels.push(`section "${h}"`);
  }
  if (labels.length <= 3) return labels;
  return [labels[0], labels[labels.length - 2], labels[labels.length - 1]];
}
