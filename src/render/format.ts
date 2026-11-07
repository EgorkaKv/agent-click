import type { ElementInfo, Snapshot } from "../types.js";

const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);
const CHECK_ROLES = new Set(["checkbox", "radio", "switch"]);
const MAX_URL = 100;

/**
 * Wraps text in double quotes for the agent output. Backslashes and quotes are escaped
 * (\\ and \"), newlines become a space, so the line stays parseable.
 */
export function quoted(s: string): string {
  // Inner quotes stay as they are: escaped, they cost tokens and read as part of the name.
  const flat = s.replace(/\r\n|\r|\n/g, " ");
  return `"${flat}"`;
}

/** "https://a.com/x?q=1#h" -> "a.com/x", truncated to 100 chars. */
export function shortUrl(url: string): string {
  let s = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const cut = s.search(/[?#]/);
  if (cut >= 0) s = s.slice(0, cut);
  if (s.length > MAX_URL) s = s.slice(0, MAX_URL - 1) + "…";
  return s;
}

function checkMark(checked: boolean | "mixed" | undefined): string {
  if (checked === "mixed") return "◩";
  return checked ? "☑" : "☐";
}

/** Role with heading level, e.g. "heading(2)". */
export function roleLabel(el: ElementInfo): string {
  if (el.role === "heading" && el.level !== undefined) return `heading(${el.level})`;
  return el.role;
}

/** Short reference used in diffs: [id] role "name". */
export function briefElement(el: ElementInfo): string {
  const name = el.name ? ` ${quoted(el.name)}` : "";
  return `[${el.id}] ${roleLabel(el)}${name}`;
}

/** Full element line (no indentation), in the format described in docs/api-draft.md. */
export function formatElement(el: ElementInfo): string {
  let line = briefElement(el);

  if (CHECK_ROLES.has(el.role)) {
    line += ` ${checkMark(el.state.checked)}`;
  } else if (VALUE_ROLES.has(el.role) || el.value !== undefined) {
    line += ` = ${quoted(el.value ?? "")}`;
  }

  if (!el.value && el.placeholder) {
    line += ` placeholder ${quoted(el.placeholder)}`;
  }

  const flags: string[] = [];
  const s = el.state;
  if (s.disabled) flags.push("disabled");
  if (s.selected) flags.push("selected");
  if (s.expanded !== undefined) flags.push(s.expanded ? "expanded" : "collapsed");
  if (s.pressed) flags.push("pressed");
  if (s.required) flags.push("required");
  if (s.readonly) flags.push("readonly");
  if (s.focused) flags.push("focused");
  if (s.invalid) flags.push("invalid");
  if (el.optionsCount !== undefined) flags.push(`${el.optionsCount} options`);
  if (el.hiddenCount !== undefined) flags.push(`${el.hiddenCount} inside`);
  if (el.hint) flags.push(el.hint);
  if (el.occludedBy) flags.push(`occluded by ${el.occludedBy}`);
  if (flags.length) line += ` (${flags.join(", ")})`;

  if (el.error) line += ` ⚠ ${quoted(el.error)}`;

  return line.trimEnd();
}

function contextKey(ctx: string[]): string {
  return ctx.join("\u0000");
}

export function formatSnapshot(s: Snapshot, opts?: { pendingRequests?: number }): string {
  const pending = opts?.pendingRequests ?? 0;
  const loading = s.loading.busy || pending > 0;

  const header: string[] = [];
  header.push(`Page: ${s.title} · ${shortUrl(s.url)}`);

  let status = `scroll ${Math.round(s.scroll.y)}/${Math.round(s.scroll.maxY)}`;
  status = `Viewport ${s.viewport.w}×${s.viewport.h} · ${status} · `;
  if (loading) {
    const reasons: string[] = [];
    if (pending > 0) reasons.push(`${pending} requests`);
    reasons.push(...s.loading.reasons);
    status += reasons.length ? `⏳ loading (${reasons.join(", ")})` : "⏳ loading";
  } else {
    status += "✓ settled";
  }
  header.push(status);

  if (s.layer) header.push(`Layer: ${s.layer} (page below is blocked)`);

  const body: string[] = [];

  let lastKey: string | null = null;
  for (const el of s.elements) {
    const key = contextKey(el.context);
    if (key !== lastKey) {
      body.push(el.context.length ? `[${el.context.join(" › ")}]` : "[page]");
      lastKey = key;
    }
    body.push(`  ${formatElement(el)}`);
  }

  const above = s.offscreen.filter((o) => o.direction === "above");
  const below = s.offscreen.filter((o) => o.direction === "below");
  const fmtOff = (list: typeof s.offscreen) =>
    list.map((o) => `${o.context} (${o.count})`).join(", ");
  if (above.length) body.push(`↑ above: ${fmtOff(above)}`);
  if (below.length) body.push(`↓ below: ${fmtOff(below)}`);

  if (s.messages.length) {
    body.push(`Messages: ${s.messages.map(quoted).join(" · ")}`);
  }
  if (s.truncated) {
    body.push(`… list truncated (${s.elements.length} shown), use scope or full`);
  }

  const out = [...header];
  if (body.length) out.push("", ...body);
  return out.join("\n");
}
