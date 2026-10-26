import type { SettleResult } from "../types.js";

export interface SettleProbe {
  inflight(): number;
  pendingDescriptions(): string[];
  mutationCount(): Promise<number>;
  busyReasons(): Promise<string[]>;
}

const MAX_PROBE_CALL_MS = 1000;

/** Resolves to `fallback` if the promise does not settle within `ms`. */
function withDeadline<T>(call: () => Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), Math.max(1, ms));
  });
  let started: Promise<T>;
  try {
    started = call();
  } catch {
    started = Promise.reject(new Error("probe threw"));
  }
  return Promise.race([started.catch(() => fallback), deadline]).finally(() => clearTimeout(timer));
}

/**
 * Waits until the page looks settled after an action: no countable network requests for
 * `quietNetworkMs`, no DOM mutations for `quietDomMs`, and no busy indicators.
 * Never returns before max(quietNetworkMs, quietDomMs) has passed.
 */
export async function waitForSettle(
  probe: SettleProbe,
  opts: { quietNetworkMs?: number; quietDomMs?: number; timeoutMs?: number; pollMs?: number } = {},
): Promise<SettleResult> {
  const quietNetworkMs = opts.quietNetworkMs ?? 300;
  const quietDomMs = opts.quietDomMs ?? 200;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const pollMs = opts.pollMs ?? 50;
  const minWaitMs = Math.max(quietNetworkMs, quietDomMs);

  const start = Date.now();
  let netQuietSince: number | null = null; // when inflight last became 0
  let lastMutation: number | undefined; // last observed DOM counter value
  let domQuietSince: number | null = null; // when the DOM counter last changed
  let lastState = { inflight: 0, descriptions: [] as string[], domChanged: false, busy: [] as string[], probeError: false };

  for (;;) {
    const now = Date.now();
    const remaining = timeoutMs - (now - start);
    const callBudget = Math.min(MAX_PROBE_CALL_MS, Math.max(remaining, 1));

    let probeError = false;
    let busy: string[] = [];
    let inflight = 0;
    let descriptions: string[] = [];
    try {
      inflight = probe.inflight();
      descriptions = probe.pendingDescriptions();
    } catch {
      probeError = true;
    }

    if (!probeError) {
      const mutation = await withDeadline<number | undefined>(() => probe.mutationCount(), callBudget, undefined);
      const reasons = await withDeadline<string[] | undefined>(() => probe.busyReasons(), callBudget, undefined);
      if (mutation === undefined || reasons === undefined) {
        probeError = true;
      } else {
        busy = reasons;
        if (mutation !== lastMutation) {
          lastMutation = mutation;
          domQuietSince = now;
        }
      }
    }

    if (probeError) {
      // Navigation or a busy page: not quiet, and the DOM baseline is unknown again.
      netQuietSince = null;
      domQuietSince = null;
      lastMutation = undefined;
      busy = [];
      lastState = { inflight, descriptions, domChanged: true, busy: [], probeError: true };
    } else {
      if (inflight > 0) netQuietSince = null;
      else if (netQuietSince === null) netQuietSince = now;
      if (domQuietSince === null) domQuietSince = now;

      const domChanged = now - domQuietSince < quietDomMs;
      lastState = { inflight, descriptions, domChanged, busy, probeError: false };

      const elapsed = now - start;
      const netQuiet = netQuietSince !== null && now - netQuietSince >= quietNetworkMs;
      const domQuiet = !domChanged;
      if (elapsed >= minWaitMs && netQuiet && domQuiet && busy.length === 0) {
        return { settled: true, waitedMs: elapsed, pending: [] };
      }
    }

    if (now - start >= timeoutMs) {
      return { settled: false, waitedMs: now - start, pending: describePending(lastState) };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, timeoutMs - (Date.now() - start)))));
  }
}

function describePending(state: {
  inflight: number;
  descriptions: string[];
  domChanged: boolean;
  busy: string[];
  probeError: boolean;
}): string[] {
  const pending: string[] = [];
  if (state.probeError) pending.push("page busy or navigating (scripts did not answer)");
  if (state.inflight > 0) {
    const n = state.inflight;
    const list = state.descriptions.join(", ");
    pending.push(`${n} request${n === 1 ? "" : "s"}${list ? `: ${list}` : ""}`);
  }
  if (state.domChanged) pending.push("DOM mutating");
  for (const reason of state.busy) pending.push(reason);
  return pending.length > 0 ? pending : ["timeout"];
}
