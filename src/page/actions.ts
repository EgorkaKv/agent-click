// Page-side actions used by the step executor: focus, native value setters, select options, text search.
import type { ElementInfo } from "../types.js";
import { collect, findLayer, walkAll } from "./collect.js";
import { buildInfo } from "./info.js";
import { resolveById, resolveScope } from "./resolve.js";
import { registry } from "./registry.js";
import { collapse, norm } from "./util.js";

function resolveElement(id: number): Element | null {
  const r = resolveById(collect(), id);
  return r.ok ? r.cand.el : null;
}

function dispatch(el: Element, types: string[]): void {
  const win = el.ownerDocument.defaultView!;
  for (const type of types) el.dispatchEvent(new win.Event(type, { bubbles: true }));
}

export function focusAndSelectAll(id: number): boolean {
  const el = resolveElement(id);
  if (!el) return false;
  (el as HTMLElement).focus?.();
  if (el.localName === "input" || el.localName === "textarea") {
    try {
      (el as HTMLInputElement).select();
    } catch {
      /* input types without selection support */
    }
    return true;
  }
  const doc = el.ownerDocument;
  const sel = doc.defaultView?.getSelection();
  if (sel && el.getAttribute("contenteditable") !== null) {
    const range = doc.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  return true;
}

/** Focus with the caret at the end, as after typing: keys go where a human left off. */
export function focusAtEnd(id: number): boolean {
  const el = resolveElement(id);
  if (!el) return false;
  (el as HTMLElement).focus?.();
  if (el.localName === "input" || el.localName === "textarea") {
    const f = el as HTMLInputElement;
    try {
      f.setSelectionRange(f.value.length, f.value.length);
    } catch {
      /* input types without selection support */
    }
    return true;
  }
  const sel = el.ownerDocument.defaultView?.getSelection();
  if (sel && el.getAttribute("contenteditable") !== null) {
    sel.selectAllChildren(el);
    sel.collapseToEnd();
  }
  return true;
}

export function setNativeValue(id: number, value: string): boolean {
  const el = resolveElement(id);
  if (!el) return false;
  const win = el.ownerDocument.defaultView!;
  let proto: object;
  if (el.localName === "input") proto = win.HTMLInputElement.prototype;
  else if (el.localName === "textarea") proto = win.HTMLTextAreaElement.prototype;
  else return false;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (!setter) return false;
  setter.call(el, value);
  dispatch(el, ["input", "change"]);
  return true;
}

export function selectNativeOption(
  id: number,
  text: string,
): { ok: boolean; value?: string; options?: string[] } {
  const el = resolveElement(id);
  if (!el || el.localName !== "select") return { ok: false, options: [] };
  const select = el as HTMLSelectElement;
  const opts = Array.from(select.options);
  const wanted = collapse(text);
  let idx = opts.findIndex((o) => collapse(o.text) === wanted);
  if (idx < 0) {
    const lw = wanted.toLowerCase();
    idx = opts.findIndex((o) => collapse(o.text).toLowerCase().includes(lw));
  }
  if (idx < 0) {
    return { ok: false, options: opts.slice(0, 30).map((o) => collapse(o.text)) };
  }
  select.selectedIndex = idx;
  dispatch(el, ["input", "change"]);
  return { ok: true, value: opts[idx].value };
}

export function hasText(text: string, scope?: number | string): boolean {
  let root: Element | null;
  if (scope !== undefined) {
    root = resolveScope(scope, collect());
    if (!root) return false;
  } else {
    root = findLayer(walkAll())?.el ?? document.body;
  }
  if (!root) return false;
  const visible = (root as HTMLElement).innerText ?? root.textContent ?? "";
  return norm(visible).includes(norm(text));
}

/** Visible options of an open listbox or menu, with ids. */
export function openOptions(): ElementInfo[] {
  const coll = collect();
  const dead = registry.deadPool();
  return coll.cands
    .filter((c) => c.role === "option" || c.role.startsWith("menuitem"))
    .map((c) => buildInfo(c, registry.assign(c, dead)));
}
