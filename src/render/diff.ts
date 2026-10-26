import type { ElementInfo, Snapshot, SnapshotDiff } from "../types.js";
import { briefElement, formatElement, quoted, shortUrl } from "./format.js";

export const SIGNIFICANT_RATIO = 0.3;
export const SIGNIFICANT_ADDED = 10;

const MAX_ADDED = 30;
const MAX_REMOVED = 15;
const MAX_CHANGED = 30;

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
  if (field === "name" || field === "value" || field === "error") {
    return v === undefined ? "none" : quoted(String(v));
  }
  if (field === "occludedBy") return v === undefined ? "none" : String(v);
  return String(v);
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

export function formatDiff(d: SnapshotDiff): string {
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

  for (const el of d.added.slice(0, MAX_ADDED)) lines.push(`+ ${formatElement(el)}`);
  if (d.added.length > MAX_ADDED) lines.push(`+ … ${d.added.length - MAX_ADDED} more`);

  for (const el of d.removed.slice(0, MAX_REMOVED)) lines.push(`- ${briefElement(el)}`);
  if (d.removed.length > MAX_REMOVED) lines.push(`- … ${d.removed.length - MAX_REMOVED} more`);

  for (const c of d.changed.slice(0, MAX_CHANGED)) {
    const parts = c.fields.map(
      (f) =>
        `${f} ${formatFieldValue(f, fieldRaw(c.before, f))} → ${formatFieldValue(f, fieldRaw(c.after, f))}`,
    );
    lines.push(`~ ${briefElement(c.after)}: ${parts.join("; ")}`);
  }
  if (d.changed.length > MAX_CHANGED) lines.push(`~ … ${d.changed.length - MAX_CHANGED} more`);

  if (d.newMessages.length) {
    lines.push(`Messages: ${d.newMessages.map(quoted).join(" · ")}`);
  }

  if (lines.length === 0) return "no visible change";
  return lines.join("\n");
}
