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
