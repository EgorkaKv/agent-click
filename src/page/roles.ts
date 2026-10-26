// Role and interactivity rules. Roles follow ARIA where an explicit role exists and
// fall back to the implicit role of the element.
import { explicitRole, isContentEditable } from "./util.js";

export const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "combobox",
  "textbox",
  "searchbox",
  "spinbutton",
  "slider",
  "treeitem",
]);

/** Native interactive elements. Also used to find inner controls of a panel. */
export const STATIC_SEL =
  'a[href], button, input:not([type="hidden"]), select, textarea, summary, [contenteditable]:not([contenteditable="false"])';

/** Interactive by tag, role or tabindex >= 0 (not the cursor heuristic). */
export function isStaticInteractive(el: Element): boolean {
  if (el.matches(STATIC_SEL)) return true;
  const r = explicitRole(el);
  if (r && INTERACTIVE_ROLES.has(r)) return true;
  const ti = el.getAttribute("tabindex");
  return ti !== null && /^\s*\d+\s*$/.test(ti);
}

function inputRole(type: string): string {
  switch (type) {
    case "checkbox":
      return "checkbox";
    case "radio":
      return "radio";
    case "range":
      return "slider";
    case "search":
      return "searchbox";
    case "number":
      return "spinbutton";
    case "button":
    case "submit":
    case "reset":
    case "image":
    case "file":
      return "button";
    default:
      return "textbox";
  }
}

/** Role of an element: explicit ARIA role first, then the implicit role of the tag. */
export function roleOf(el: Element): string {
  const ex = explicitRole(el);
  if (ex && ex !== "presentation" && ex !== "none") return ex;
  switch (el.localName) {
    case "a":
      return "link";
    case "button":
    case "summary":
      return "button";
    case "select": {
      const s = el as HTMLSelectElement;
      return s.multiple || s.size > 1 ? "listbox" : "combobox";
    }
    case "textarea":
      return "textbox";
    case "option":
      return "option";
    case "input":
      return inputRole((el as HTMLInputElement).type);
    case "td":
      return "cell";
    case "th":
    case "dt":
    case "dd":
      return "text";
  }
  if (/^h[1-6]$/.test(el.localName)) return "heading";
  if (isContentEditable(el)) return "textbox";
  return "generic";
}
