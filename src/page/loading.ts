// Page-side loading signals: visible spinners, skeletons and aria-busy. Cheap by design:
// it queries candidate elements only (no full walk), because it is polled every ~50 ms.
import { Cache, contextPath } from "./context.js";
import { explicitRole, LOADING_RE } from "./util.js";
import { isRendered } from "./visibility.js";

const CANDIDATE_SEL =
  '[role~="progressbar"],[aria-busy="true"],[class*="spinner" i],[class*="loader" i],[class*="loading" i],[class*="skeleton" i],[class*="shimmer" i]';
/** A class such as "is-loading-done" describes a finished state, not an indicator. */
const DONE_RE = /(done|complete|finished|loaded)$/i;
const BLOCK_RE = /skeleton|shimmer/i;
/** A spinner is small; a larger class-matched box is a persistent wrapper. */
const SPINNER_MAX_PX = 120;
const MAX_REASONS = 5;

export interface LoadingState {
  busy: boolean;
  reasons: string[];
}

/** The class token that names an indicator ("spinner", "loader-container"), or null. */
function classWord(el: Element): string | null {
  for (const token of (el.getAttribute("class") ?? "").split(/\s+/)) {
    if (!token || DONE_RE.test(token)) continue;
    const m = LOADING_RE.exec(token);
    if (m) return m[0].toLowerCase();
  }
  return null;
}

/** What makes el a loading indicator, or null. Visibility is checked by the caller. */
function indicatorWord(el: Element): string | null {
  if (explicitRole(el) === "progressbar") return "progressbar";
  if (el.getAttribute("aria-busy") === "true") return "busy";
  const word = classWord(el);
  if (!word) return null;
  if (BLOCK_RE.test(word)) return word;
  const r = el.getBoundingClientRect();
  return r.width <= SPINNER_MAX_PX && r.height <= SPINNER_MAX_PX ? word : null;
}

export function loadingState(): LoadingState {
  // Equal reasons are merged with a count: two progressbars in one section read as "×2".
  const counts = new Map<string, number>();
  const cache = new Cache();
  for (const el of document.querySelectorAll(CANDIDATE_SEL)) {
    if (counts.size >= MAX_REASONS) break;
    const word = indicatorWord(el);
    if (!word || !isRendered(el)) continue;
    const ctx = contextPath(el, cache);
    const reason = `${word} in ${ctx.length ? ctx[ctx.length - 1] : "page"}`;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const reasons = [...counts].map(([reason, n]) => {
    if (n === 1) return reason;
    const at = reason.indexOf(" in ");
    return `${reason.slice(0, at)} ×${n}${reason.slice(at)}`;
  });
  const moving = animations();
  if (moving) reasons.push(`animation${moving > 1 ? ` ×${moving}` : ""}`);
  return { busy: reasons.length > 0, reasons };
}

/** A panel expanding or a list sliding in has no DOM mutations, but its content is not final yet. */
const ANIMATION_MAX_MS = 3000;

/** Short CSS transitions/animations still running. Endless ones are spinners, covered above. */
function animations(): number {
  if (!document.getAnimations) return 0;
  let n = 0;
  for (const a of document.getAnimations()) {
    if (a.playState !== "running") continue;
    const end = Number(a.effect?.getComputedTiming().endTime);
    if (Number.isFinite(end) && end <= ANIMATION_MAX_MS) n++;
  }
  return n;
}
