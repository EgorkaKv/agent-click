// DOM helpers shared by the in-page modules. Read-only; nothing here mutates the page.

export interface Pt {
  x: number;
  y: number;
}

export const SVG_NS = "http://www.w3.org/2000/svg";
export const FORM_TAGS = new Set(["input", "select", "textarea"]);
export const TOAST_RE = /toast|snackbar|notification|alert/i;
export const LOADING_RE = /spinner|loader|loading|skeleton|shimmer/i;
/** Words that look like a status badge rather than a plain label. */
export const STATUS_WORD_RE =
  /^(active|inactive|draft|pending|paid|unpaid|done|completed?|failed|errors?|success|warning|new|open|closed|approved|rejected|live|paused|running|stopped|enabled|disabled|archived|overdue|in progress|ok|online|offline|активно|активен|неактивно|черновик|ожидает|ожидание|оплачено|не оплачено|готово|выполнено|ошибка|успешно|в работе|на паузе|архив|отклонено|одобрено|новый|открыт|закрыт)$/i;

/** Zero-width characters: ZWSP, ZWNJ, ZWJ, word joiner, BOM. */
const ZERO_WIDTH_RE = /[​-‍⁠﻿]/g;
/**
 * Machine tokens such as "status_before_click:selected" (snake_case identifier, colon, value).
 * Matched anywhere, since an inline node can glue one onto the text before it.
 */
const MACHINE_TOKEN_RE = /[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+:[A-Za-z0-9_.-]+/g;

export function collapse(s: string): string {
  return s.replace(ZERO_WIDTH_RE, "").replace(/\s+/g, " ").trim();
}

/**
 * A name without machine tokens (state keys that leaked into visible text) and without an
 * exact repetition ("X X" or "XX" -> "X"; a visually hidden copy of the same text).
 */
export function cleanName(s: string): string {
  return dropRepeat(collapse(s.replace(MACHINE_TOKEN_RE, " ")));
}

/** "A B B" -> "A B", "AAAA" -> "AA", "Текст Текст" -> "Текст". Only a repeated tail or a doubled whole. */
export function dropRepeat(s: string): string {
  const n = s.length;
  if (n >= 8 && n % 2 === 0 && s.slice(0, n / 2) === s.slice(n / 2)) return s.slice(0, n / 2).trim();
  const t = s.split(" ");
  for (let k = Math.floor(t.length / 2); k >= 1; k--) {
    const tail = t.slice(t.length - k).join(" ");
    const before = t.slice(t.length - 2 * k, t.length - k).join(" ");
    if (before === tail) return t.slice(0, t.length - k).join(" ");
  }
  return s;
}

/** Visually hidden (sr-only, clipped to 1px): its text is for assistive tech, not for the screen. */
export function isVisuallyHidden(el: Element): boolean {
  const s = styleOf(el);
  if (s.clip === "rect(0px, 0px, 0px, 0px)" || /inset\(50%\)/.test(s.clipPath)) return true;
  const w = parseFloat(s.width);
  const h = parseFloat(s.height);
  return s.overflow === "hidden" && (w <= 1 || h <= 1);
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

export function norm(s: string): string {
  return collapse(s).toLowerCase();
}

export function textOf(el: Element): string {
  return collapse(el.textContent ?? "");
}

/**
 * Text of el with a space at every block-level boundary, so "Name" + "Plan" in two blocks
 * reads "Name Plan" (textContent would glue them).
 */
export function spacedText(el: Element, skipHidden = false): string {
  let out = "";
  const walk = (n: Node): void => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === 3) {
        out += c.textContent ?? "";
      } else if (c.nodeType === 1) {
        if (skipHidden && isVisuallyHidden(c as Element)) continue;
        const d = styleOf(c as Element).display;
        const block = d !== "contents" && !d.startsWith("inline");
        if (block) out += " ";
        walk(c);
        if (block) out += " ";
      }
    }
  };
  walk(el);
  return collapse(out);
}

/**
 * The text of el split at block-level boundaries: a list item's title and its description line
 * come out as separate parts. Visually hidden copies are skipped, repeated parts kept once.
 */
export function blockParts(el: Element): string[] {
  const parts: string[] = [];
  let cur = "";
  const flush = (): void => {
    const t = collapse(cur);
    if (t && !parts.includes(t)) parts.push(t);
    cur = "";
  };
  const walk = (n: Node): void => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === 3) {
        cur += c.textContent ?? "";
      } else if (c.nodeType === 1) {
        if (isVisuallyHidden(c as Element)) continue;
        const d = styleOf(c as Element).display;
        const block = d !== "contents" && !d.startsWith("inline");
        if (block) flush();
        walk(c);
        if (block) flush();
      }
    }
  };
  walk(el);
  flush();
  return parts;
}

/** First token of the role attribute, lower-cased, or null. */
export function explicitRole(el: Element): string | null {
  const r = el.getAttribute("role");
  if (!r) return null;
  return r.trim().split(/\s+/)[0]?.toLowerCase() || null;
}

export function matchesSafe(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

export function isContentEditable(el: Element): boolean {
  const v = el.getAttribute("contenteditable");
  return v !== null && v.toLowerCase() !== "false";
}

export function idsOf(attr: string): string[] {
  return attr.split(/\s+/).filter(Boolean);
}

/** getElementById that works for elements in shadow roots and detached subtrees. */
export function byId(el: Element, id: string): Element | null {
  const root = el.getRootNode() as Partial<DocumentFragment>;
  const hit = typeof root.getElementById === "function" ? root.getElementById(id) : null;
  return hit ?? el.ownerDocument.getElementById(id);
}

/**
 * Parent that crosses shadow boundaries (shadow root -> host) and iframe
 * boundaries (document -> frame element, same-origin only).
 */
export function parentAcross(n: Node): Node | null {
  const p = n.parentNode;
  if (!p) return null;
  if (p.nodeType === 11) return (p as ShadowRoot).host ?? null;
  if (p.nodeType === 9) return (p as Document).defaultView?.frameElement ?? null;
  return p;
}

export function* composedAncestors(el: Element): Generator<Element> {
  let n = parentAcross(el);
  while (n) {
    if (n.nodeType === 1) yield n as Element;
    n = parentAcross(n);
  }
}

/** True if el is anc or a (composed) descendant of anc. */
export function composedContains(anc: Element, el: Element): boolean {
  if (anc === el) return true;
  for (const a of composedAncestors(el)) if (a === anc) return true;
  return false;
}

export function isRelated(a: Element, b: Element): boolean {
  return composedContains(a, b) || composedContains(b, a);
}

// getComputedStyle returns a live object, so one per element stays correct across DOM changes.
const styles = new WeakMap<Element, CSSStyleDeclaration>();

export function styleOf(el: Element): CSSStyleDeclaration {
  let s = styles.get(el);
  if (!s) {
    s = el.ownerDocument.defaultView!.getComputedStyle(el);
    styles.set(el, s);
  }
  return s;
}
