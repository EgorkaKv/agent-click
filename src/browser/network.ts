import type { CDPSession, Protocol } from "puppeteer-core";
import type { NetworkEvent } from "../types.js";

/**
 * Known analytics / telemetry hosts. An entry is either a host ("datadoghq.com", matches the host,
 * its subdomains and "-" prefixed hosts like browser-intake-datadoghq.eu) or a host plus path prefix
 * ("facebook.com/tr").
 */
export const TELEMETRY_PATTERNS: readonly string[] = [
  "google-analytics.com",
  "googletagmanager.com",
  "doubleclick.net",
  "facebook.com/tr",
  "connect.facebook.net",
  "sentry.io",
  "segment.io",
  "segment.com",
  "mixpanel.com",
  "amplitude.com",
  "hotjar.com",
  "hotjar.io",
  "clarity.ms",
  "datadoghq.com",
  "datadoghq.eu",
  "newrelic.com",
  "nr-data.net",
  "posthog.com",
  "intercom.io",
  "fullstory.com",
  "bugsnag.com",
];

/** Generic telemetry endpoints, matched on the last path segment of any host. */
export const TELEMETRY_PATHS: readonly string[] = [
  "collect",
  "beacon",
  "log",
  "logging",
  "track",
  "telemetry",
  "rum",
  "ping",
];

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Resource types that never count as "the page is still loading". */
const IGNORED_TYPES = new Set(["WebSocket", "EventSource", "Ping", "Other", "Media", "Image", "Font"]);
/**
 * Code and styles count only while fresh: a click that lazy-loads a chunk must wait for it, but
 * heavy SPAs (Ads Manager) keep hundreds of script requests open for many seconds.
 */
const STATIC_TYPES = new Set(["Script", "Stylesheet"]);
const STATIC_MAX_MS = 3000;
const MAX_BODY_CHARS = 300;
const MAX_PENDING = 5;
const MAX_KEPT_MUTATIONS = 200;
const DEFAULT_LONG_POLL_MS = 10_000;

export function isTelemetry(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  for (const pattern of TELEMETRY_PATTERNS) {
    const slash = pattern.indexOf("/");
    const patternHost = slash === -1 ? pattern : pattern.slice(0, slash);
    const patternPath = slash === -1 ? "" : pattern.slice(slash);
    if (host !== patternHost && !host.endsWith("." + patternHost) && !host.endsWith("-" + patternHost)) continue;
    if (patternPath === "" || u.pathname === patternPath || u.pathname.startsWith(patternPath + "/")) {
      return true;
    }
  }
  const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
  return TELEMETRY_PATHS.includes(last.toLowerCase());
}

const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "ac", "edu"]);

/** Registrable domain, approximately: "hq1.appsflyer.com" → "appsflyer.com", "a.b.co.uk" → "b.co.uk". */
export function siteOf(host: string): string {
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host;
  const parts = host.split(".");
  const n = parts.length >= 3 && parts.at(-1)!.length === 2 && SECOND_LEVEL.has(parts.at(-2)!) ? 3 : 2;
  return parts.slice(-n).join(".");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Same-origin: path only ("/v20.0/act_1/adsets"). Otherwise host + path. Query and hash are dropped. */
export function shortenUrl(raw: string, pageOrigin: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw.split(/[?#]/)[0] ?? raw;
  }
  if (u.origin === pageOrigin) return u.pathname;
  return `${u.host}${u.pathname}`;
}

interface Entry {
  requestId: string;
  seq: number;
  method: string;
  rawUrl: string;
  type: string;
  startedAt: number;
  status: number;
  state: "active" | "finished" | "failed";
  cancelled?: boolean;
  error?: string;
  /** Resolves when the response body of a failed mutation has been read. */
  bodyRead?: Promise<void>;
}

/**
 * Records network activity of one page through a page-level CDP session.
 * Call start() once. Use inflight()/pendingDescriptions() for settle detection,
 * and mark()/drain()/mutationsSince() to collect the mutations an action caused.
 */
export class NetworkRecorder {
  readonly #cdp: CDPSession;
  readonly #getPageUrl: () => string;
  readonly #longPollMs: number;
  readonly #active = new Map<string, Entry>();
  #finishedMutations: Entry[] = [];
  #seq = 0;
  #started = false;

  readonly #onRequest = (e: Protocol.Network.RequestWillBeSentEvent): void => {
    // Redirect hops reuse the requestId; keep the original entry.
    if (e.redirectResponse || this.#active.has(e.requestId)) return;
    // Extensions (chrome-extension://), data: and blob: are not the page talking to its server.
    if (!/^https?:/i.test(e.request.url)) return;
    this.#active.set(e.requestId, {
      requestId: e.requestId,
      seq: ++this.#seq,
      method: e.request.method.toUpperCase(),
      rawUrl: e.request.url,
      type: e.type ?? "Other",
      startedAt: Date.now(),
      status: 0,
      state: "active",
    });
  };

  readonly #onResponse = (e: Protocol.Network.ResponseReceivedEvent): void => {
    const entry = this.#active.get(e.requestId);
    if (!entry) return;
    entry.status = e.response.status;
    if (e.type) entry.type = e.type;
  };

  readonly #onFinished = (e: Protocol.Network.LoadingFinishedEvent): void => {
    const entry = this.#active.get(e.requestId);
    if (!entry) return;
    this.#active.delete(e.requestId);
    entry.state = "finished";
    if (MUTATING.has(entry.method) && entry.status >= 400) {
      entry.bodyRead = this.#readBody(entry);
    }
    this.#keepIfMutation(entry);
  };

  readonly #onFailed = (e: Protocol.Network.LoadingFailedEvent): void => {
    const entry = this.#active.get(e.requestId);
    if (!entry) return;
    this.#active.delete(e.requestId);
    // Blocked by an ad blocker / Brave Shields: the page did not really try to save anything.
    if (e.blockedReason || /BLOCKED_BY_CLIENT/.test(e.errorText)) return;
    entry.state = "failed";
    entry.error = e.errorText.slice(0, MAX_BODY_CHARS);
    entry.cancelled = e.canceled === true || /ERR_ABORTED/.test(e.errorText);
    this.#keepIfMutation(entry);
  };

  constructor(cdp: CDPSession, getPageUrl: () => string, opts: { longPollMs?: number } = {}) {
    this.#cdp = cdp;
    this.#getPageUrl = getPageUrl;
    this.#longPollMs = opts.longPollMs ?? DEFAULT_LONG_POLL_MS;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#cdp.on("Network.requestWillBeSent", this.#onRequest);
    this.#cdp.on("Network.responseReceived", this.#onResponse);
    this.#cdp.on("Network.loadingFinished", this.#onFinished);
    this.#cdp.on("Network.loadingFailed", this.#onFailed);
    await this.#cdp.send("Network.enable");
  }

  dispose(): void {
    if (!this.#started) return;
    this.#started = false;
    this.#cdp.off("Network.requestWillBeSent", this.#onRequest);
    this.#cdp.off("Network.responseReceived", this.#onResponse);
    this.#cdp.off("Network.loadingFinished", this.#onFinished);
    this.#cdp.off("Network.loadingFailed", this.#onFailed);
  }

  /** Requests in progress that count for "the page is still loading". */
  inflight(): number {
    return this.#countable().length;
  }

  /** "GET /api/items" style descriptions of countable in-flight requests, at most 5. */
  pendingDescriptions(): string[] {
    const origin = this.#pageOrigin();
    return this.#countable()
      .slice(0, MAX_PENDING)
      .map((e) => `${e.method} ${shortenUrl(e.rawUrl, origin)}`);
  }

  /** Sequence number; requests started after this call are "after the mark". */
  mark(): number {
    return this.#seq;
  }

  /**
   * Waits until the bodies of recently failed mutations are read, so that mutationsSince()
   * reports their `error` text. Call before mutationsSince() when the action may have failed.
   */
  async drain(): Promise<void> {
    await Promise.all(this.#finishedMutations.map((e) => e.bodyRead));
  }

  /**
   * Finished or failed mutating requests started after the mark, in start order, without telemetry.
   * Requests to other sites are left out unless they failed, and then are marked thirdParty.
   */
  mutationsSince(mark: number): NetworkEvent[] {
    const origin = this.#pageOrigin();
    const site = siteOf(hostOf(this.#getPageUrl()));
    const third = (e: Entry) => siteOf(hostOf(e.rawUrl)) !== site;
    const failed = (e: Entry) => e.state === "failed" || e.status >= 400;
    return this.#finishedMutations
      .filter((e) => e.seq > mark && !isTelemetry(e.rawUrl) && (!third(e) || failed(e)))
      .sort((a, b) => a.seq - b.seq)
      .map((e) => {
        const event: NetworkEvent = {
          method: e.method,
          url: shortenUrl(e.rawUrl, origin),
          status: e.status,
        };
        if (e.error !== undefined) event.error = e.error;
        if (third(e)) event.thirdParty = true;
        if (e.cancelled) event.cancelled = true;
        return event;
      });
  }

  #countable(): Entry[] {
    const now = Date.now();
    const result: Entry[] = [];
    for (const e of this.#active.values()) {
      if (IGNORED_TYPES.has(e.type)) continue;
      if (isTelemetry(e.rawUrl)) continue;
      if (now - e.startedAt > (STATIC_TYPES.has(e.type) ? STATIC_MAX_MS : this.#longPollMs)) continue;
      result.push(e);
    }
    // Data requests first: "GET /api/items" says more than the 40th script chunk.
    return result.sort((a, b) => Number(STATIC_TYPES.has(a.type)) - Number(STATIC_TYPES.has(b.type)) || a.seq - b.seq);
  }

  #keepIfMutation(entry: Entry): void {
    if (!MUTATING.has(entry.method)) return;
    this.#finishedMutations.push(entry);
    if (this.#finishedMutations.length > MAX_KEPT_MUTATIONS) this.#finishedMutations.shift();
  }

  async #readBody(entry: Entry): Promise<void> {
    try {
      const body = await this.#cdp.send("Network.getResponseBody", { requestId: entry.requestId });
      const text = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
      entry.error = text.trim() ? text.slice(0, MAX_BODY_CHARS) : `HTTP ${entry.status}`;
    } catch {
      entry.error = `HTTP ${entry.status} (body unavailable)`;
    }
  }

  #pageOrigin(): string {
    try {
      return new URL(this.#getPageUrl()).origin;
    } catch {
      return "";
    }
  }
}
