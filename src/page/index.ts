// Entry point of dist/page.js. Injected with page.evaluate(source), possibly many times
// into the same document: the installed API (and its id registry) is kept when the
// version matches, so ids survive re-injection.
import type { PageApi } from "../types.js";
import { createApi } from "./api.js";
import { VERSION } from "./version.js";

declare global {
  interface Window {
    __agentClick?: PageApi;
  }
}

if (window.__agentClick?.version !== VERSION) {
  window.__agentClick = createApi();
}
