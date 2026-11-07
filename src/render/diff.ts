import type { ElementInfo, Snapshot, SnapshotDiff } from "../types.js";
import { briefElement, formatElement, quoted, shortUrl } from "./format.js";

export const SIGNIFICANT_RATIO = 0.3;
export const SIGNIFICANT_ADDED = 10;

const MAX_ADDED = 30;
const MAX_REMOVED = 15;
const MAX_CHANGED = 30;
/** This many elements with the same occluder change are summarized in one line. */
const OVERLAY_MIN = 3;
const SCROLLED_NAMES = 3;
/** Common text this long around a changed name is replaced with "…". */
const NAME_CONTEXT_MIN = 12;
/** Name-only changes shown one per line; the rest are counted (a calendar re-pricing 18 days). */
const MAX_RENAMED = 6;

const SCALAR_FIELDS = ["name", "value", "role", "error", "occludedBy", "inViewport"] as const;

function stateKeys(a: ElementInfo, b: ElementInfo): string[] {
  const keys = new Set<string>([...Object.keys(a.state), ...Object.keys(b.state)]);
  return [...keys];
}

/** Returns the list of changed field names between two elements with the same id. */
function changedFields(before: ElementInfo, after: ElementInfo): string[] {
  const fields: string[] = [];
  for (const f of SCALAR_FIELDS) {
    if (before[f] !== after[f]) fields.push(f);
  }
  for (const k of stateKeys(before, after)) {
    // undefined is treated as false for state flags
    const a = (before.state as Record<string, unknown>)[k] ?? false;
    const b = (after.state as Record<string, unknown>)[k] ?? false;
    if (a !== b) fields.push(`state.${k}`);
  }
  return fields;
}

function fieldRaw(el: ElementInfo, field: string): unknown {
  if (field.startsWith("state.")) {
    return (el.state as Record<string, unknown>)[field.slice(6)] ?? false;
  }
  return el[field as keyof ElementInfo];
}

function formatFieldValue(field: string, v: unknown): string {
  if (field === "state.checked") {
    return v === "mixed" ? "◩" : v ? "☑" : "☐";
  }
  if (field.startsWith("state.")) return v ? "on" : "off";
  if (field === "value") return quoted(String(v ?? ""));
  if (field === "error") {
    return v === undefined ? "none" : quoted(String(v));
  }
  if (field === "occludedBy") return v === undefined ? "none" : String(v);
  return String(v);
}

/** Only the differing middle of two names: "Sat, 5 Dec, 113 $, lowest" → "Sat, 5 Dec, 201 $" gives "…113 $, lowest" → "…201 $". */
export function nameChange(a: string, b: string): string {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  // Cut on a word boundary so a number is not split ("113" vs "201" sharing nothing is fine, "1 13" is not).
  while (p > 0 && /\S/.test(a[p - 1])) p--;
  while (q > 0 && /\S/.test(a[a.length - q])) q--;
  const head = p >= NAME_CONTEXT_MIN ? "…" : "";
  const tail = q >= NAME_CONTEXT_MIN ? "…" : "";
  const cut = (s: string) => s.slice(head ? p : 0, tail ? s.length - q : s.length).trim();
  return `${quoted(head + cut(a) + tail)} → ${quoted(head + cut(b) + tail)}`;
}

/** Same role, name and context: a node the page re-created, not a new element. */
function sameKey(e: ElementInfo): string {
  return `${e.role}|${e.name}|${e.context.join(">")}`;
}

export function diffSnapshots(before: Snapshot, after: Snapshot): SnapshotDiff {
  const beforeById = new Map(before.elements.map((e) => [e.id, e] as const));
  const afterById = new Map(after.elements.map((e) => [e.id, e] as const));

  const added = after.elements.filter((e) => !beforeById.has(e.id));
  const removed = before.elements.filter((e) => !afterById.has(e.id));

  const changed: SnapshotDiff["changed"] = [];
  for (const a of after.elements) {
    const b = beforeById.get(a.id);
    if (!b) continue;
    const fields = changedFields(b, a);
    if (fields.length) changed.push({ before: b, after: a, fields });
  }

  const diff: SnapshotDiff = {
    added,
    removed,
    changed,
    newMessages: [],
    significant: false,
  };

  if (before.url !== after.url) diff.urlChanged = { from: before.url, to: after.url };
  if (before.layer !== after.layer) diff.layerChanged = { from: before.layer, to: after.layer };

  const oldMessages = new Set(before.messages);
  diff.newMessages = after.messages.filter((m) => !oldMessages.has(m));

  const ratio = (added.length + removed.length) / Math.max(before.elements.length, 1);
  diff.significant =
    diff.urlChanged !== undefined ||
    diff.layerChanged !== undefined ||
    ratio > SIGNIFICANT_RATIO ||
    added.length >= SIGNIFICANT_ADDED;

  return diff;
}

/** "[40]–[53]" for consecutive numbers, else the first few. */
function idRange(ids: number[]): string {
  const sorted = [...ids].sort((a, b) => a - b);
  if (sorted[sorted.length - 1] - sorted[0] === sorted.length - 1) return sorted.length > 1 ? `[${sorted[0]}]–[${sorted[sorted.length - 1]}]` : `[${sorted[0]}]`;
  return sorted.slice(0, 8).map((i) => `[${i}]`).join(" ") + (sorted.length > 8 ? " …" : "");
}

/** `scrolled`: the view moved, so elements that are gone most likely left the rendered area (virtualized lists). */
export function formatDiff(d: SnapshotDiff, opts: { scrolled?: boolean } = {}): string {
  const lines: string[] = [];

  if (d.urlChanged) {
    lines.push(`→ url ${shortUrl(d.urlChanged.from)} → ${shortUrl(d.urlChanged.to)}`);
  }
  if (d.layerChanged) {
    const { from, to } = d.layerChanged;
    if (!from && to) lines.push(`→ opened ${to}`);
    else if (from && !to) lines.push(`→ closed ${from}`);
    else if (from && to) lines.push(`→ layer ${from} → ${to}`);
  }

  // The page re-created nodes with the same content (a re-rendered list): one line with the new numbers.
  const gone = new Map<string, ElementInfo[]>();
  for (const el of d.removed) gone.set(sameKey(el), [...(gone.get(sameKey(el)) ?? []), el]);
  const recreated: ElementInfo[] = [];
  const reused = new Set<ElementInfo>();
  for (const el of d.added) {
    const old = gone.get(sameKey(el))?.shift();
    if (!old) continue;
    recreated.push(el);
    reused.add(old);
  }
  let added = d.added.filter((e) => !recreated.includes(e));
  const removedAll = d.removed.filter((e) => !reused.has(e));
  if (recreated.length) {
    const ids = recreated.map((e) => e.id);
    lines.push(`↻ ${recreated.length} re-rendered with the same content, new numbers ${idRange(ids)}`);
  }

  // After a dialog closes, the page under it is listed again: it was there before, nothing new.
  if (d.layerChanged?.from && !d.layerChanged.to && added.length > SCROLLED_NAMES) {
    lines.push(`↩ ${added.length} elements of the page are visible again (use look to list them)`);
    added = [];
  }

  // The mirror case: a dialog opened, the page under it is no longer listed. It is still there.
  let removed = removedAll;
  if (d.layerChanged?.to && removed.length > SCROLLED_NAMES) {
    lines.push(`↧ ${removed.length} elements of the page are under ${d.layerChanged.to} now`);
    removed = [];
  }

  for (const el of added.slice(0, MAX_ADDED)) lines.push(`+ ${formatElement(el)}`);
  if (added.length > MAX_ADDED) lines.push(`+ … ${added.length - MAX_ADDED} more`);

  // A closed dialog's elements are gone, not scrolled away.
  if (opts.scrolled && !d.layerChanged && removed.length) {
    const names = removed.slice(0, SCROLLED_NAMES).map(briefElement).join(", ");
    lines.push(`↕ ${removed.length} out of view after scrolling: ${names}${removed.length > SCROLLED_NAMES ? ", …" : ""}`);
  } else {
    for (const el of removed.slice(0, MAX_REMOVED)) lines.push(`- ${briefElement(el)}`);
    if (removed.length > MAX_REMOVED) lines.push(`- … ${removed.length - MAX_REMOVED} more`);
  }

  // A modal or loading overlay changes occludedBy of the whole background: one line per overlay.
  const overlay = new Map<string, number>();
  for (const c of d.changed) {
    if (!c.fields.includes("occludedBy")) continue;
    const key = c.after.occludedBy ? `now covered by ${c.after.occludedBy}` : `no longer covered by ${c.before.occludedBy}`;
    overlay.set(key, (overlay.get(key) ?? 0) + 1);
  }
  const collapsed = new Set([...overlay].filter(([, n]) => n >= OVERLAY_MIN).map(([k]) => k));
  for (const k of collapsed) lines.push(`~ ${overlay.get(k)} elements ${k}`);
  const changed = d.changed
    .map((c) => {
      const key = c.after.occludedBy ? `now covered by ${c.after.occludedBy}` : `no longer covered by ${c.before.occludedBy}`;
      return collapsed.has(key) ? { ...c, fields: c.fields.filter((f) => f !== "occludedBy") } : c;
    })
    .filter((c) => c.fields.length > 0);

  let shown = 0;
  let renamed = 0;
  let hidden = 0;
  for (const c of changed) {
    const onlyName = c.fields.length === 1 && c.fields[0] === "name";
    if (shown >= MAX_CHANGED || (onlyName && ++renamed > MAX_RENAMED)) {
      hidden++;
      continue;
    }
    shown++;
    const parts = c.fields.map((f) =>
      f === "name"
        ? `name ${nameChange(c.before.name, c.after.name)}`
        : `${f} ${formatFieldValue(f, fieldRaw(c.before, f))} → ${formatFieldValue(f, fieldRaw(c.after, f))}`,
    );
    lines.push(`~ ${briefElement(c.after)}: ${parts.join("; ")}`);
  }
  if (hidden) lines.push(`~ … ${hidden} more changed`);

  if (d.newMessages.length) {
    lines.push(`Messages: ${d.newMessages.map(quoted).join(" · ")}`);
  }

  if (lines.length === 0) return "no visible change";
  return lines.join("\n");
}
