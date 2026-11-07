// Geometry, visibility and occlusion. Coordinates are top-level viewport CSS px;
// an "offset" is the position of a document's viewport origin in top-level coords
// (non-zero only inside same-origin iframes).
import type { Rect } from "../types.js";
import { composedAncestors, composedContains, explicitRole, isRelated, Pt, styleOf, textOf, truncate } from "./util.js";
import { accName, labelOf, Cache } from "./context.js";

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const px = (v: string): number => parseFloat(v) || 0;

export function rectOf(el: Element, off: Pt): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left + off.x, y: r.top + off.y, w: r.width, h: r.height };
}

export function safeContentDocument(el: Element): Document | null {
  try {
    return (el as HTMLIFrameElement).contentDocument ?? null;
  } catch {
    return null;
  }
}

/** Position of an iframe's content box, in the coordinates of its parent document. */
function frameBox(frame: Element): Pt {
  const r = frame.getBoundingClientRect();
  const cs = styleOf(frame);
  return {
    x: r.left + px(cs.borderLeftWidth) + px(cs.paddingLeft),
    y: r.top + px(cs.borderTopWidth) + px(cs.paddingTop),
  };
}

/** Offset of a frame's content origin given the offset of the frame's parent document. */
export function frameContentOffset(frame: Element, parentOff: Pt): Pt {
  const b = frameBox(frame);
  return { x: parentOff.x + b.x, y: parentOff.y + b.y };
}

/** Offset of the document that contains el, relative to the top-level viewport. */
export function offsetOf(el: Element): Pt {
  const chain: Element[] = [];
  let doc: Document | null = el.ownerDocument;
  while (doc) {
    const fe: Element | null = doc.defaultView?.frameElement ?? null;
    if (!fe) break;
    chain.push(fe);
    doc = fe.ownerDocument;
  }
  let off: Pt = { x: 0, y: 0 };
  for (let i = chain.length - 1; i >= 0; i--) off = frameContentOffset(chain[i], off);
  return off;
}

function checkVis(el: Element): boolean {
  const withCheck = el as Element & { checkVisibility?: (o: object) => boolean };
  if (typeof withCheck.checkVisibility === "function") {
    return withCheck.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  }
  const cs = styleOf(el);
  return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
}

function isToggleInput(el: Element): boolean {
  if (el.localName !== "input") return false;
  const type = (el as HTMLInputElement).type;
  return type === "checkbox" || type === "radio";
}

/** Box of at least 3x3 px: a control that small (or transparent) is clicked through its label. */
function hasSize(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width >= 3 && r.height >= 3;
}

/**
 * The element whose box a control is clicked through. A checkbox or radio that is transparent
 * (opacity 0, the custom-control pattern) or tiny is clicked through its rendered label, which
 * toggles it. Otherwise the element itself if it is rendered, else null.
 */
export function clickTarget(el: Element): Element | null {
  if (isToggleInput(el) && (!isRendered(el) || !hasSize(el))) {
    for (const lb of Array.from((el as HTMLInputElement).labels ?? [])) {
      if (isRendered(lb) && hasSize(lb)) return lb;
    }
  }
  return isRendered(el) ? el : null;
}

function isHiddenNode(n: Element): boolean {
  return n.hasAttribute("inert") || n.getAttribute("aria-hidden") === "true";
}

/** Inside an inert or aria-hidden="true" subtree (composed, across shadow and frames). */
export function hiddenByAncestor(el: Element): boolean {
  if (isHiddenNode(el)) return true;
  for (const a of composedAncestors(el)) if (isHiddenNode(a)) return true;
  return false;
}

/** Non-empty box and visible by CSS, and not in an inert/aria-hidden subtree. */
export function isRendered(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  if (!checkVis(el)) return false;
  return !hiddenByAncestor(el);
}

export function rectBox(r: Rect): Box {
  return { x1: r.x, y1: r.y, x2: r.x + r.w, y2: r.y + r.h };
}

export function intersectBox(a: Box, b: Box): Box {
  return {
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
    x2: Math.min(a.x2, b.x2),
    y2: Math.min(a.y2, b.y2),
  };
}

export function isEmptyBox(b: Box): boolean {
  return b.x2 <= b.x1 || b.y2 <= b.y1;
}

function viewportBox(): Box {
  return { x1: 0, y1: 0, x2: window.innerWidth, y2: window.innerHeight };
}

/**
 * Area in which content of el can be seen, in top-level coords: the viewport intersected
 * with the padding box of every ancestor whose overflow is not visible (scroll containers,
 * crossing shadow roots and same-origin frames), and with the content box of each iframe.
 * May be empty.
 */
export function clipBox(el: Element, off: Pt): Box {
  let box = viewportBox();
  const offsets = new Map<Document, Pt>([[el.ownerDocument, off]]);
  for (const a of composedAncestors(el)) {
    const cs = styleOf(a);
    const isFrame = a.localName === "iframe";
    if (!isFrame && cs.overflowX === "visible" && cs.overflowY === "visible") continue;
    if (overflowIsViewports(a)) continue;
    let o = offsets.get(a.ownerDocument);
    if (!o) {
      o = offsetOf(a);
      offsets.set(a.ownerDocument, o);
    }
    const r = a.getBoundingClientRect();
    let x1 = r.left + o.x + px(cs.borderLeftWidth);
    let y1 = r.top + o.y + px(cs.borderTopWidth);
    let x2 = r.right + o.x - px(cs.borderRightWidth);
    let y2 = r.bottom + o.y - px(cs.borderBottomWidth);
    if (isFrame) {
      x1 += px(cs.paddingLeft);
      y1 += px(cs.paddingTop);
      x2 -= px(cs.paddingRight);
      y2 -= px(cs.paddingBottom);
    }
    box = intersectBox(box, { x1, y1, x2, y2 });
    if (isEmptyBox(box)) break;
  }
  return box;
}

/**
 * The root's overflow belongs to the viewport, and so does the body's when the root's is
 * visible (CSS overflow propagation): such an element clips nothing beyond the viewport.
 */
function overflowIsViewports(a: Element): boolean {
  const doc = a.ownerDocument;
  if (a === doc.documentElement) return true;
  if (a !== doc.body) return false;
  const root = styleOf(doc.documentElement);
  return root.overflowX === "visible" && root.overflowY === "visible";
}

/** Visible part of a rect within a clip box, or null if nothing is visible. */
export function visibleBox(r: Rect, clip: Box): Box | null {
  const b = intersectBox(rectBox(r), clip);
  return isEmptyBox(b) ? null : b;
}

/** True if the whole rect lies inside the clip box (with half a pixel of tolerance). */
export function fullyVisibleIn(r: Rect, clip: Box): boolean {
  return (
    r.x >= clip.x1 - 0.5 &&
    r.y >= clip.y1 - 0.5 &&
    r.x + r.w <= clip.x2 + 0.5 &&
    r.y + r.h <= clip.y2 + 0.5
  );
}

/** Focused element, following open shadow roots and same-origin iframes. */
export function deepActive(): Element | null {
  let a: Element | null = document.activeElement;
  for (let i = 0; i < 32 && a; i++) {
    if (a.shadowRoot?.activeElement) {
      a = a.shadowRoot.activeElement;
      continue;
    }
    if (a.localName === "iframe") {
      const cd = safeContentDocument(a);
      if (cd?.activeElement) {
        a = cd.activeElement;
        continue;
      }
    }
    break;
  }
  return a;
}

/** Topmost element at a point of doc's viewport, descending into open shadow roots and frames. */
export function deepHit(doc: Document, x: number, y: number): Element | null {
  let hit: Element | null = doc.elementFromPoint(x, y);
  for (let guard = 0; hit && guard < 32; guard++) {
    const sr = hit.shadowRoot;
    if (sr) {
      const inner = sr.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
      continue;
    }
    if (hit.localName === "iframe") {
      const cd = safeContentDocument(hit);
      if (!cd) break;
      const b = frameBox(hit);
      const inner = cd.elementFromPoint(x - b.x, y - b.y);
      if (!inner) break;
      hit = inner;
      x -= b.x;
      y -= b.y;
      continue;
    }
    break;
  }
  return hit;
}

function isSticky(n: Element): boolean {
  const p = styleOf(n).position;
  return p === "fixed" || p === "sticky";
}

/**
 * Short description of the element that covers `hit`: its nearest fixed or sticky
 * ancestor-or-self (e.g. `div "Введите запрос…" (fixed)`), else the nearest landmark.
 */
export function describeOccluder(hit: Element): string {
  const chain = [hit, ...composedAncestors(hit)];
  const floating = chain.find(isSticky);
  if (floating) {
    const suffix = ` (${styleOf(floating).position})`;
    const landmark = labelOf(floating, new Cache(), true);
    if (landmark) return landmark + suffix;
    const nm = accName(floating) || textOf(floating);
    const named = nm ? ` "${truncate(nm, 40)}"` : "";
    return `${explicitRole(floating) ?? floating.localName}${named}${suffix}`;
  }
  const cache = new Cache();
  for (const n of chain) {
    const landmark = labelOf(n, cache, true);
    if (landmark) return landmark;
  }
  return hit.localName;
}

/**
 * True if hit lies inside one of el's labels (wrapping or `for=`). A custom control with
 * opacity 0 is drawn by its label, so the label's text is part of the control, not an occluder.
 */
function inOwnLabel(el: Element, hit: Element): boolean {
  for (const lb of Array.from((el as HTMLInputElement).labels ?? [])) {
    if (composedContains(lb, hit)) return true;
  }
  return false;
}

/** null if the point is not covered by something unrelated to el. */
export function occluderAt(el: Element, off: Pt, p: Pt): string | null {
  const hit = deepHit(el.ownerDocument, p.x - off.x, p.y - off.y);
  if (!hit || isRelated(el, hit) || inOwnLabel(el, hit)) return null;
  return describeOccluder(hit);
}

/** Occlusion of an element, sampling the center and two points inside its visible box. Never occludedBy for clipped content. */
export function occlusionOf(el: Element, off: Pt, v: Box | null): string | undefined {
  if (!v) return undefined;
  const cy = (v.y1 + v.y2) / 2;
  const w = v.x2 - v.x1;
  const pts = [
    { x: (v.x1 + v.x2) / 2, y: cy },
    { x: v.x1 + w * 0.25, y: cy },
    { x: v.x1 + w * 0.75, y: cy },
  ];
  let first: string | undefined;
  for (const p of pts) {
    const o = occluderAt(el, off, p);
    if (o === null) return undefined;
    first ??= o;
  }
  return first;
}
