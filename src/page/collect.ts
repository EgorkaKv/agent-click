// One pass over the page (light DOM, open shadow roots, same-origin iframes) that
// produces every candidate element: interactive ones, plus short meaningful text.
import type { Rect } from "../types.js";
import { Cache, accName, contextPath } from "./context.js";
import { INTERACTIVE_ROLES, STATIC_SEL, isStaticInteractive, roleOf } from "./roles.js";
import {
  FORM_TAGS,
  Pt,
  STATUS_WORD_RE,
  SVG_NS,
  blockParts,
  cleanName,
  collapse,
  composedAncestors,
  composedContains,
  explicitRole,
  parentAcross,
  spacedText,
  styleOf,
  textOf,
  truncate,
} from "./util.js";
import {
  type Box,
  clipBox,
  frameContentOffset,
  isRendered,
  offsetOf,
  rectOf,
  safeContentDocument,
  visibleBox,
} from "./visibility.js";

export interface Cand {
  el: Element;
  /** Offset of el's document origin in top-level viewport coords. */
  off: Pt;
  kind: "interactive" | "text";
  role: string;
  name: string;
  level?: number;
  rect: Rect;
  /** Area where the element can be seen: viewport and scroll-container clips. */
  clip: Box;
  /** Visible part of rect inside clip, or null when fully clipped (then not in viewport). */
  visible: Box | null;
  inViewport: boolean;
  /** Inside the active modal layer (or no layer is open). */
  inLayer: boolean;
  ctx: string[];
  /** role|name|context: the fingerprint without the ordinal. */
  base: string;
  /** Control whose checked state is reported when el is a wrapper (a clickable toggle). */
  proxy?: Element;
  /** base|ordinal, from the collection that produced this candidate. "" if not from a collection. */
  fp: string;
  hint?: string;
}

export interface Walked {
  el: Element;
  off: Pt;
}

export interface Layer {
  el: Element;
  label: string;
}

export interface Collection {
  /** Every element in the page, in document order. */
  all: Walked[];
  /** Rendered candidates, whole page (not limited to the viewport), document order. */
  cands: Cand[];
  layer: Layer | null;
  cache: Cache;
}

const SKIP_TAGS = new Set([
  "html", "head", "body", "script", "style", "link", "meta", "title",
  "noscript", "template", "base", "br", "wbr",
]);

function isSvgChild(el: Element): boolean {
  return el.namespaceURI === SVG_NS && el.localName !== "svg" && el.localName !== "a";
}

/** Every element of a root, descending into open shadow roots and same-origin iframes. */
function walkRoot(root: Document | ShadowRoot, off: Pt, out: Walked[]): void {
  for (const el of root.querySelectorAll("*")) {
    out.push({ el, off });
    if (el.shadowRoot) walkRoot(el.shadowRoot, off, out);
    if (el.localName === "iframe") {
      const cd = safeContentDocument(el);
      if (cd?.documentElement) walkRoot(cd, frameContentOffset(el, off), out);
    }
  }
}

export function walkAll(): Walked[] {
  const out: Walked[] = [];
  walkRoot(document, { x: 0, y: 0 }, out);
  return out;
}

function isModal(el: Element): boolean {
  if (el.localName === "dialog") {
    try {
      if (el.matches(":modal")) return true;
    } catch {
      /* :modal unsupported */
    }
  }
  return el.getAttribute("aria-modal") === "true";
}

/** The topmost visible modal (last in document order), if any. */
export function findLayer(all: Walked[]): Layer | null {
  let top: Element | null = null;
  for (const { el } of all) {
    if (isModal(el) && isRendered(el)) top = el;
  }
  if (!top) return null;
  const n = accName(top);
  return { el: top, label: n ? `dialog "${truncate(n, 60)}"` : "dialog" };
}

function hasOwnText(a: Element, inner: Element): boolean {
  const walker = a.ownerDocument.createTreeWalker(a, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (inner.contains(n)) continue;
    if ((n.textContent ?? "").trim()) return true;
  }
  return false;
}

function levelOf(el: Element): number | undefined {
  const al = Number(el.getAttribute("aria-level"));
  if (al > 0) return al;
  const m = /^h([1-6])$/.exec(el.localName);
  if (m) return Number(m[1]);
  return el.getAttribute("role") === "heading" ? 2 : undefined;
}

/** Visually distinct leaf with 1-40 chars of text: a badge, tag or pill. */
function isBadge(el: Element, textSet: Set<Element>): boolean {
  if (el.childElementCount > 4) return false;
  const cs = styleOf(el);
  const bg = cs.backgroundColor;
  if (bg === "transparent" || /^rgba\(.*,\s*0\)$/.test(bg)) return false;
  const txt = textOf(el);
  if (txt.length < 1 || txt.length > 40) return false;
  for (const c of Array.from(el.children)) if (textOf(c)) return false;
  const parent = parentAcross(el);
  if (!parent || parent.nodeType !== 1) return false;
  for (const a of composedAncestors(el)) if (textSet.has(a)) return false;
  const radius = parseFloat(cs.borderTopLeftRadius) || 0;
  return bg !== styleOf(parent as Element).backgroundColor || radius > 0;
}

/** Text role for a non-interactive element, or null. */
function classifyText(el: Element, interAnc: Set<Element>, textSet: Set<Element>): string | null {
  const tag = el.localName;
  const ex = explicitRole(el);
  if (/^h[1-6]$/.test(tag) || ex === "heading") return "heading";
  if (ex === "status" || ex === "alert") {
    const len = textOf(el).length;
    return len > 0 && len <= 120 ? ex : null;
  }
  if (tag === "dt" || tag === "dd" || tag === "th") {
    const len = textOf(el).length;
    return len > 0 && len <= 120 ? "text" : null;
  }
  if (tag === "td" || ex === "cell") {
    const row = el.closest("tr,[role=row]");
    if (!row || !interAnc.has(row) || interAnc.has(el)) return null;
    const len = textOf(el).length;
    return len > 0 && len <= 120 ? "cell" : null;
  }
  if (isBadge(el, textSet)) return STATUS_WORD_RE.test(textOf(el)) ? "status" : "text";
  return null;
}

function hintOf(el: Element): string | undefined {
  if (el.id) return `id ${el.id}`;
  const name = el.getAttribute("name");
  if (name) return `name ${name}`;
  const ph = el.getAttribute("placeholder");
  if (ph) return `placeholder ${collapse(ph)}`;
  return undefined;
}

export function nameFor(el: Element, cache: Cache): string {
  const labelled = el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby");
  // An option or menu item keeps its description line: "title — description".
  const role = roleOf(el);
  if ((role === "option" || role.startsWith("menuitem")) && !labelled) {
    const parts = blockParts(el);
    if (parts.length > 0) return truncate(cleanName(parts.join(" — ")), 80);
  }
  // Fast path: a leaf non-form element without label attributes is named by its text,
  // which is what the accessible-name computation would return (or "" -> text fallback).
  if (
    el.childElementCount === 0 &&
    !FORM_TAGS.has(el.localName) &&
    el.localName !== "img" &&
    !el.hasAttribute("alt") &&
    !labelled &&
    !el.hasAttribute("title")
  ) {
    return truncate(cleanName(textOf(el)), 80);
  }
  let n = accName(el, cache);
  if (!n && !FORM_TAGS.has(el.localName)) n = cleanName(spacedText(el, true));
  return truncate(n, 80);
}

/** Candidate for one element (no fingerprint ordinal yet). */
export function buildCand(
  el: Element,
  off: Pt,
  kind: "interactive" | "text",
  role: string,
  cache: Cache,
): Cand {
  const name = nameFor(el, cache);
  const ctx = contextPath(el, cache);
  const rect = rectOf(el, off);
  const clip = clipBox(el, off);
  const visible = visibleBox(rect, clip);
  return {
    el,
    off,
    kind,
    role,
    name,
    level: role === "heading" ? levelOf(el) : undefined,
    rect,
    clip,
    visible,
    inViewport: visible !== null,
    inLayer: true,
    ctx,
    base: `${role}|${name}|${ctx.join(" > ")}`,
    fp: "",
  };
}

/** Candidate for an element that is not part of a collection (describe/locate of a known id). */
export function makeCandFor(el: Element, coll: Collection): Cand {
  const off = offsetOf(el);
  const kind = isStaticInteractive(el) ? "interactive" : "text";
  const c = buildCand(el, off, kind, roleOf(el), coll.cache);
  c.inLayer = !coll.layer || composedContains(coll.layer.el, el);
  return c;
}

/** Role and inner control of a clickable wrapper that holds a checkbox or switch not collected itself. */
function innerToggle(el: Element, S1: Set<Element>): { el: Element; role: "checkbox" | "switch" } | null {
  for (const x of el.querySelectorAll('input[type=checkbox],[role=switch],[role=checkbox]')) {
    if (S1.has(x)) continue;
    const isSwitch = explicitRole(x) === "switch" || explicitRole(el) === "switch";
    return { el: x, role: isSwitch ? "switch" : "checkbox" };
  }
  return null;
}

/**
 * Name of an unnamed control from the visible text of a nearby ancestor: at most 3 levels up,
 * the first one with 1-60 chars of text (minus the control's own text and value) that holds
 * no other collected interactive element. "" if none.
 */
function nearbyName(el: Element, interCount: Map<Element, number>): string {
  const own = [textOf(el), (el as HTMLInputElement).value ?? ""].filter(Boolean);
  let up = 0;
  for (const a of composedAncestors(el)) {
    if (++up > 3) break;
    if ((interCount.get(a) ?? 0) > 1) continue; // el itself is counted once
    let text = spacedText(a, true);
    for (const s of own) text = text.split(s).join(" ");
    text = cleanName(text);
    if (text && text.length <= 60) return text;
  }
  return "";
}

export function collect(): Collection {
  const all = walkAll();
  const cache = new Cache();
  const layer = findLayer(all);

  const cursors = new Map<Element, string>();
  const cursorOf = (el: Element): string => {
    let c = cursors.get(el);
    if (c === undefined) {
      c = styleOf(el).cursor;
      cursors.set(el, c);
    }
    return c;
  };

  // 1. Interactive by tag/role/tabindex, plus "clickable" tops of cursor:pointer chains.
  const S = new Set<Element>();
  const clickable = new Set<Element>();
  // Collected only because of tabindex (no interactive tag or role): a container candidate.
  const tabOnly = new Set<Element>();
  for (const { el } of all) {
    if (SKIP_TAGS.has(el.localName) || isSvgChild(el)) continue;
    if (isStaticInteractive(el)) {
      S.add(el);
      const ex = explicitRole(el);
      if (!el.matches(STATIC_SEL) && !(ex && INTERACTIVE_ROLES.has(ex))) tabOnly.add(el);
      continue;
    }
    if (explicitRole(el) || cursorOf(el) !== "pointer") continue;
    const parent = parentAcross(el);
    if (parent && parent.nodeType === 1 && cursorOf(parent as Element) === "pointer") continue;
    S.add(el);
    clickable.add(el);
  }

  // 2. Rendered only; a <label> that labels a control is not collected itself.
  const S1 = new Set<Element>();
  for (const el of S) {
    if (el.localName === "label" && (el as HTMLLabelElement).control) continue;
    if (isRendered(el)) S1.add(el);
  }

  // 3. Containers. Collected elements that wrap other collected interactive elements:
  //    - tabindex-only element with any collected descendant: a scroll region, dropped;
  //    - cursor:pointer element with two or more: a container, dropped;
  //    - otherwise an element whose only collected descendant is one other interactive
  //      element and which has no text of its own is dropped (keep the inner one).
  const inner = new Map<Element, Element[]>();
  for (const x of S1) {
    for (const a of composedAncestors(x)) {
      if (!S1.has(a)) continue;
      const list = inner.get(a);
      if (list) list.push(x);
      else inner.set(a, [x]);
    }
  }
  for (const [a, ds] of inner) {
    if (tabOnly.has(a)) S1.delete(a);
    else if (clickable.has(a) && ds.length >= 2) S1.delete(a);
    else if (ds.length === 1 && !hasOwnText(a, ds[0])) S1.delete(a);
  }

  // 4. Ancestors of interactive elements (rows with controls, containers).
  const interAnc = new Set<Element>();
  const interCount = new Map<Element, number>();
  for (const x of S1)
    for (const a of composedAncestors(x)) {
      interAnc.add(a);
      interCount.set(a, (interCount.get(a) ?? 0) + 1);
    }

  // 5. Short meaningful text outside interactive elements.
  const textSet = new Set<Element>();
  const textRole = new Map<Element, string>();
  for (const { el } of all) {
    if (S1.has(el) || SKIP_TAGS.has(el.localName) || isSvgChild(el)) continue;
    const role = classifyText(el, interAnc, textSet);
    if (!role || !isRendered(el)) continue;
    let inside = false;
    for (const a of composedAncestors(el)) {
      if (S1.has(a)) {
        inside = true;
        break;
      }
    }
    if (inside) continue;
    textSet.add(el);
    textRole.set(el, role);
  }

  // 6. Candidates in document order, then fingerprints and hints.
  const cands: Cand[] = [];
  for (const { el, off } of all) {
    let kind: "interactive" | "text";
    let role: string;
    let proxy: Element | undefined;
    if (S1.has(el)) {
      kind = "interactive";
      role = roleOf(el);
      if (clickable.has(el)) {
        const inner = innerToggle(el, S1);
        if (inner) {
          role = inner.role;
          proxy = inner.el;
        } else {
          role = "clickable";
        }
      }
    } else if (textSet.has(el)) {
      kind = "text";
      role = textRole.get(el)!;
    } else {
      continue;
    }
    const c = buildCand(el, off, kind, role, cache);
    if (proxy) c.proxy = proxy;
    if (kind === "interactive" && !c.name) {
      const name = nearbyName(el, interCount);
      if (name) {
        c.name = name;
        c.base = `${role}|${name}|${c.ctx.join(" > ")}`;
      }
    }
    if (kind === "text" && !c.name) continue;
    cands.push(c);
  }

  const total = new Map<string, number>();
  for (const c of cands) total.set(c.base, (total.get(c.base) ?? 0) + 1);
  const seen = new Map<string, number>();
  const layerEl = layer?.el ?? null;
  for (const c of cands) {
    const n = seen.get(c.base) ?? 0;
    seen.set(c.base, n + 1);
    c.fp = `${c.base}|${n}`;
    c.inLayer = !layerEl || composedContains(layerEl, c.el);
    if ((total.get(c.base) ?? 0) > 1) c.hint = hintOf(c.el);
  }

  return { all, cands, layer, cache };
}
