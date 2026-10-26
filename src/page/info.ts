// ElementInfo: the per-element data the agent sees (value, state, error, ...).
import type { ElementInfo, ElementState } from "../types.js";
import type { Cand } from "./collect.js";
import { STATIC_SEL } from "./roles.js";
import {
  byId,
  explicitRole,
  idsOf,
  matchesSafe,
  textOf,
  truncate,
  collapse,
  isContentEditable,
} from "./util.js";
import { deepActive, isRendered } from "./visibility.js";

const BUTTONISH = new Set(["button", "submit", "reset", "image", "file"]);

export function isDisabled(el: Element): boolean {
  return matchesSafe(el, ":disabled") || el.getAttribute("aria-disabled") === "true";
}

export function valueOf(el: Element): string | undefined {
  const tag = el.localName;
  if (tag === "input") {
    const input = el as HTMLInputElement;
    if (input.type === "checkbox" || input.type === "radio" || BUTTONISH.has(input.type)) return undefined;
    if (!input.value) return undefined;
    return input.type === "password" ? "••••" : truncate(input.value, 80);
  }
  if (tag === "textarea") {
    const v = (el as HTMLTextAreaElement).value;
    return v ? truncate(v, 80) : undefined;
  }
  if (tag === "select") {
    const s = el as HTMLSelectElement;
    const opt = s.options[s.selectedIndex];
    return opt ? truncate(collapse(opt.text), 80) : undefined;
  }
  if (isContentEditable(el) || explicitRole(el) === "combobox") {
    const v = textOf(el);
    return v ? truncate(v, 80) : undefined;
  }
  return undefined;
}

export function stateOf(el: Element): ElementState {
  const s: ElementState = {};
  const tag = el.localName;
  const input = tag === "input" ? (el as HTMLInputElement) : null;
  const attr = (n: string) => el.getAttribute(n);

  if (isDisabled(el)) s.disabled = true;
  if (input && (input.type === "checkbox" || input.type === "radio")) {
    if (input.checked) s.checked = true;
    else if (input.type === "checkbox" && input.indeterminate) s.checked = "mixed";
  }
  const ac = attr("aria-checked");
  if (ac === "true") s.checked = true;
  else if (ac === "mixed") s.checked = "mixed";

  if ((tag === "option" && (el as HTMLOptionElement).selected) || attr("aria-selected") === "true") {
    s.selected = true;
  }
  const details = tag === "summary" ? el.parentElement : null;
  if (attr("aria-expanded") === "true" || (details?.localName === "details" && (details as HTMLDetailsElement).open)) {
    s.expanded = true;
  }
  if (attr("aria-pressed") === "true") s.pressed = true;
  if (attr("aria-invalid") === "true" || matchesSafe(el, ":user-invalid")) s.invalid = true;
  if ((el as HTMLInputElement).required === true || attr("aria-required") === "true") s.required = true;
  if ((el as HTMLInputElement).readOnly === true || attr("aria-readonly") === "true") s.readonly = true;
  if (deepActive() === el) s.focused = true;
  return s;
}

/** Rich-text editors draw their placeholder through one of these attributes (no native attribute). */
const PLACEHOLDER_ATTRS = ["placeholder", "aria-placeholder", "data-placeholder"];

export function placeholderOf(el: Element): string | undefined {
  const isField =
    el.localName === "input" ||
    el.localName === "textarea" ||
    isContentEditable(el) ||
    explicitRole(el) === "textbox";
  if (!isField) return undefined;
  for (const attr of PLACEHOLDER_ATTRS) {
    const v = el.getAttribute(attr);
    const t = v ? collapse(v) : "";
    if (t) return t;
  }
  return undefined;
}

function optionsCountOf(el: Element): number | undefined {
  if (el.localName === "select") return (el as HTMLSelectElement).options.length;
  if (explicitRole(el) === "listbox") return el.querySelectorAll('[role="option"]').length;
  return undefined;
}

function errorOf(el: Element): string | undefined {
  const ae = el.getAttribute("aria-errormessage");
  if (ae) {
    for (const id of idsOf(ae)) {
      const t = byId(el, id);
      const text = t ? textOf(t) : "";
      if (text) return truncate(text, 200);
    }
  }
  if (el.getAttribute("aria-invalid") === "true") {
    const ad = el.getAttribute("aria-describedby");
    if (ad) {
      const parts: string[] = [];
      for (const id of idsOf(ad)) {
        const t = byId(el, id);
        const text = t ? textOf(t) : "";
        if (text) parts.push(text);
      }
      if (parts.length) return truncate(parts.join(" "), 200);
    }
  }
  if (matchesSafe(el, ":user-invalid")) {
    const vm = (el as HTMLInputElement).validationMessage;
    if (vm) return truncate(vm, 200);
  }
  return undefined;
}

/** For an unselected tab: how many interactive elements its hidden panel holds. */
function hiddenCountOf(el: Element): number | undefined {
  if (explicitRole(el) !== "tab" || el.getAttribute("aria-selected") === "true") return undefined;
  const ac = el.getAttribute("aria-controls");
  if (!ac) return undefined;
  for (const id of idsOf(ac)) {
    const panel = byId(el, id);
    if (panel && !isRendered(panel)) return panel.querySelectorAll(STATIC_SEL).length;
  }
  return undefined;
}

function roundRect(r: Cand["rect"]): Cand["rect"] {
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
}

export function buildInfo(c: Cand, id: number): ElementInfo {
  const el = c.el;
  const info: ElementInfo = {
    id,
    kind: c.kind,
    role: c.role,
    name: c.name,
    state: stateOf(c.proxy ?? el),
    rect: roundRect(c.rect),
    inViewport: c.inViewport,
    context: c.ctx,
  };
  if (c.level !== undefined) info.level = c.level;
  if (c.hint) info.hint = c.hint;
  const value = valueOf(el);
  if (value !== undefined) info.value = value;
  const ph = placeholderOf(el);
  if (ph) info.placeholder = ph;
  const count = optionsCountOf(el);
  if (count !== undefined) info.optionsCount = count;
  const err = errorOf(el);
  if (err) info.error = err;
  const hidden = hiddenCountOf(el);
  if (hidden !== undefined) info.hiddenCount = hidden;
  return info;
}
