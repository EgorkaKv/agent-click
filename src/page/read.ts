// Text of a page area for reading (read tool): headings, paragraphs, tables as rows, field values.
// Unlike snapshot, nothing is numbered or filtered by importance; hidden content is skipped.
import { collect } from "./collect.js";
import { accName } from "./context.js";
import { resolveScope } from "./resolve.js";
import { collapse, explicitRole, styleOf } from "./util.js";

const BLOCK = /^(block|flex|grid|list-item|table|flow-root)/;
const SKIP = new Set(["script", "style", "noscript", "template", "svg", "canvas", "iframe", "head"]);

function hidden(el: Element): boolean {
  if (el.getAttribute("aria-hidden") === "true") return true;
  const s = styleOf(el);
  return s.display === "none" || s.visibility === "hidden" || s.contentVisibility === "hidden";
}

function cellText(el: Element): string {
  const out: string[] = [];
  walk(el, out);
  return collapse(out.join(" ")).replace(/\|/g, "/");
}

function tableLines(table: Element): string[] {
  const rows = table.querySelectorAll("tr, [role=row]");
  const lines: string[] = [];
  for (const row of rows) {
    if (row.closest("table, [role=table], [role=grid], [role=treegrid]") !== table || hidden(row)) continue;
    const cells = Array.from(row.children).filter((c) => !hidden(c));
    const texts = cells.map(cellText);
    if (texts.some(Boolean)) lines.push(`| ${texts.join(" | ")} |`);
  }
  return lines;
}

function fieldText(el: Element): string | null {
  const tag = el.localName;
  const role = explicitRole(el);
  // A <label>/aria-labelledby text is already in the flow next to the field; repeat only other names.
  const labelled = ((el as HTMLInputElement).labels?.length ?? 0) > 0 || el.hasAttribute("aria-labelledby");
  const name = labelled ? "" : accName(el);
  const label = name ? `${name}: ` : "";
  if (tag === "input") {
    const input = el as HTMLInputElement;
    if (input.type === "hidden") return "";
    if (input.type === "checkbox" || input.type === "radio") return `${input.checked ? "☑" : "☐"}${name ? ` ${name}` : ""}`;
    if (["button", "submit", "reset"].includes(input.type)) return null;
    return `[${label}${input.type === "password" ? "••••" : input.value}]`;
  }
  if (tag === "textarea") return `[${label}${(el as HTMLTextAreaElement).value}]`;
  if (tag === "select") {
    const sel = el as HTMLSelectElement;
    return `[${label}${Array.from(sel.selectedOptions, (o) => o.text).join(", ")}]`;
  }
  if (role === "checkbox" || role === "switch" || role === "radio") {
    return `${el.getAttribute("aria-checked") === "true" ? "☑" : "☐"}${name ? ` ${name}` : ""}`;
  }
  return null;
}

/** Displays that make a box of their own: a list item's fragments are its children of these displays. */
const BOX_FRAGMENT = /^(block|flex|grid|list-item|table|flow-root|inline-block|inline-flex|inline-grid|inline-table)/;
/** Controls and structure that a list item must keep as they are (not flattened to one line). */
const LI_STRUCTURED = "input,select,textarea,table,h1,h2,h3,h4,h5,h6,[role=heading],[role=checkbox],[role=radio],[role=switch]";

/** Text of a node with a space at every element boundary, so adjacent elements never glue. */
function flatText(node: Element): string {
  const out: string[] = [];
  const add = (n: Node): void => {
    if (n.nodeType === Node.TEXT_NODE) {
      out.push(n.textContent ?? "");
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as Element;
    if (SKIP.has(el.localName) || hidden(el)) return;
    out.push(" ");
    for (const c of (el.shadowRoot ?? el).childNodes) add(c);
    out.push(" ");
  };
  add(node);
  return collapse(out.join(""));
}

/**
 * Fragments of a list item: the text of each box-level child, found by descending through boxes
 * that hold boxes. Inline content between boxes joins into one fragment.
 */
function fragments(el: Element, out: string[]): void {
  let buf = "";
  const flush = (): void => {
    const t = collapse(buf);
    if (t) out.push(t);
    buf = "";
  };
  for (const child of Array.from((el.shadowRoot ?? el).childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      buf += child.textContent ?? "";
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const c = child as Element;
    if (SKIP.has(c.localName) || hidden(c)) continue;
    if (!BOX_FRAGMENT.test(styleOf(c).display)) {
      buf += ` ${flatText(c)} `;
      continue;
    }
    flush();
    const holdsBoxes = Array.from(c.querySelectorAll("*")).some((d) => BOX_FRAGMENT.test(styleOf(d).display));
    if (holdsBoxes) fragments(c, out);
    else {
      const t = flatText(c);
      if (t) out.push(t);
    }
  }
  flush();
}

function walk(node: Node, out: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    out.push(node.textContent ?? "");
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  if (SKIP.has(el.localName) || hidden(el)) return;
  const field = fieldText(el);
  if (field !== null) {
    out.push(` ${field} `);
    return;
  }
  const role = explicitRole(el);
  if (el.localName === "table" || role === "table" || role === "grid" || role === "treegrid") {
    out.push("\n", ...tableLines(el).map((l) => `${l}\n`));
    return;
  }
  const heading = /^h([1-6])$/.exec(el.localName)?.[1] ?? (role === "heading" ? el.getAttribute("aria-level") ?? "2" : null);
  if (heading) {
    out.push(`\n${"#".repeat(Number(heading))} ${collapse(el.textContent ?? "")}\n`);
    return;
  }
  if (el.localName === "br") {
    out.push("\n");
    return;
  }
  if (el.localName === "li" && !el.querySelector(LI_STRUCTURED)) {
    const parts: string[] = [];
    fragments(el, parts);
    if (parts.length) out.push(`\n- ${parts.join(" · ")}\n`);
    return;
  }
  const block = BLOCK.test(styleOf(el).display);
  if (block) out.push("\n");
  if (el.localName === "li") out.push("- ");
  for (const child of (el.shadowRoot ?? el).childNodes) walk(child, out);
  if (block) out.push("\n");
}

/**
 * Readable text of the scope (id, dialog/section name, landmark; default: the modal layer if one
 * is open, else main, else body). Lines are collapsed, tables become `| a | b |` rows.
 */
export function read(scope?: number | string, maxChars = 20_000): { text: string; truncated: boolean } {
  const coll = collect();
  let root: Element | null;
  if (scope !== undefined) {
    root = resolveScope(scope, coll);
    if (!root) throw new Error(`scope not found: ${String(scope)}`);
  } else {
    root = coll.layer?.el ?? document.querySelector("main, [role=main]") ?? document.body;
  }
  const out: string[] = [];
  walk(root, out);
  const lines = out
    .join("")
    .split("\n")
    .map((l) => (l.startsWith("| ") ? l.trim() : collapse(l)))
    .filter(Boolean);
  const text = lines.join("\n");
  return text.length > maxChars ? { text: text.slice(0, maxChars), truncated: true } : { text, truncated: false };
}
