// find: a few matching elements instead of the whole page (D-15). Local text matching over the
// full snapshot; the agent supplies the meaning by choosing the words.
import { formatElement } from "../render/format.js";
import type { ElementInfo, Snapshot } from "../types.js";

export const FIND_LIMIT = 10;

export interface FindOptions {
  role?: string;
  /** Scope as given by the agent, for the header only (the snapshot is already scoped). */
  in?: string | number;
  limit?: number;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

/** 0 = name equals the query, 1 = name starts with it, 2 = all words in the name, 3 = in value/placeholder/hint; null = no match. */
function score(el: ElementInfo, q: string, words: string[]): number | null {
  const name = norm(el.name);
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (words.every((w) => name.includes(w))) return 2;
  const rest = norm([el.name, el.value ?? "", el.placeholder ?? "", el.hint ?? ""].join(" "));
  return words.every((w) => rest.includes(w)) ? 3 : null;
}

/** Matching elements of the snapshot, best first, as text lines with their context and position. */
export function findIn(snap: Snapshot, query: string, opts: FindOptions = {}): { text: string; count: number } {
  const q = norm(query);
  const words = q.split(" ").filter(Boolean);
  const roles = opts.role ? new Set(opts.role.split("|").map((r) => r.trim())) : null;
  const hits: { el: ElementInfo; score: number; order: number }[] = [];
  snap.elements.forEach((el, order) => {
    if (roles && !roles.has(el.role)) return;
    const s = score(el, q, words);
    if (s !== null) hits.push({ el, score: s, order });
  });
  hits.sort((a, b) => a.score - b.score || a.order - b.order);

  const limit = opts.limit ?? FIND_LIMIT;
  const shown = hits.slice(0, limit);
  const where = (el: ElementInfo) => {
    if (el.inViewport) return "";
    return el.rect.y < 0 ? " ↑ above" : " ↓ below";
  };
  const lines = shown.map(({ el }) => `${formatElement(el)}${el.context.length ? ` — ${el.context.join(" › ")}` : ""}${where(el)}`);
  const scope = opts.in !== undefined ? ` in ${JSON.stringify(opts.in)}` : "";
  const role = opts.role ? ` (${opts.role})` : "";
  const head = `${hits.length} match${hits.length === 1 ? "" : "es"} for ${JSON.stringify(query)}${role}${scope}${hits.length > limit ? `, first ${limit}` : ""}`;
  return { text: [head + (lines.length ? ":" : ""), ...lines].join("\n"), count: hits.length };
}
