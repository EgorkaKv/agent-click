// Per-tool-call timing log: where the time of one call goes (settle, snapshot, screenshot, ...).
// One line per call, appended to AGENT_CLICK_LOG (default: <tmp>/agent-click.log).
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Trace {
  phases: string[];
}

const store = new AsyncLocalStorage<Trace>();
export const LOG_PATH = process.env.AGENT_CLICK_LOG ?? join(tmpdir(), "agent-click.log");

/** Runs one tool call and logs `time tool total ms | phase ms, ...`. */
export async function traced<T>(tool: string, args: unknown, fn: () => Promise<T>): Promise<T> {
  const trace: Trace = { phases: [] };
  const start = performance.now();
  let failed = false;
  try {
    return await store.run(trace, fn);
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    const total = Math.round(performance.now() - start);
    const brief = JSON.stringify(args).slice(0, 120);
    const line = `${new Date().toISOString()} ${tool}${failed ? " ERR" : ""} ${total}ms ${brief} | ${trace.phases.join(", ")}\n`;
    appendFile(LOG_PATH, line).catch(() => {});
  }
}

/** Times a phase of the current call. `note` adds a result detail, e.g. "timeout". */
export async function phase<T>(name: string, fn: () => Promise<T>, note?: (r: T) => string | undefined): Promise<T> {
  const trace = store.getStore();
  if (!trace) return fn();
  const start = performance.now();
  try {
    const r = await fn();
    const n = note?.(r);
    trace.phases.push(`${name} ${Math.round(performance.now() - start)}${n ? ` (${n})` : ""}`);
    return r;
  } catch (e) {
    trace.phases.push(`${name} ${Math.round(performance.now() - start)} (error)`);
    throw e;
  }
}
