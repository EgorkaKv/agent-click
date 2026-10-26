// Assembles window.__agentClick. Every method is synchronous and returns plain data.
import type { ElementInfo, PageApi } from "../types.js";
import { collect } from "./collect.js";
import { buildInfo } from "./info.js";
import { resolveById } from "./resolve.js";
import { locate } from "./locate.js";
import { snapshot } from "./snapshot.js";
import { VERSION } from "./version.js";
import {
  focusAndSelectAll,
  hasText,
  openOptions,
  selectNativeOption,
  setNativeValue,
} from "./actions.js";

function describeId(id: number): ElementInfo | null {
  const r = resolveById(collect(), id);
  return r.ok ? buildInfo(r.cand, id) : null;
}

export function createApi(): PageApi {
  let mutations = 0;
  // Counts DOM changes for settle detection. Lives as long as the page does.
  new MutationObserver(() => {
    mutations++;
  }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });

  return {
    version: VERSION,
    snapshot: (opts) => snapshot(opts ?? {}),
    locate: (target, opts) => locate(target, opts ?? {}),
    describe: describeId,
    focusAndSelectAll,
    setNativeValue,
    selectNativeOption,
    hasText,
    openOptions,
    mutationCount: () => mutations,
  };
}

