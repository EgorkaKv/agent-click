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

export function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
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
