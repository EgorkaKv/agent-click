// Connection to the user's browser and the tab the agent works in.
// One Session per server process (D-4): connect lazily, reconnect on transport loss.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, CDPSession, Dialog, Page, Target } from "puppeteer-core";
import { connectBrowser } from "../browser/connect.js";
import { enableFocusEmulation } from "../browser/input.js";
import { NetworkRecorder } from "../browser/network.js";
import { waitForSettle } from "../browser/settle.js";
import type { PageApi, SettleResult } from "../types.js";
import { phase } from "./trace.js";

// dist/core/session.js → dist/page.js; when run from src via tsx → ../../dist/page.js.
const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE_SCRIPT_PATH = HERE.includes("dist") ? join(HERE, "..", "page.js") : join(HERE, "..", "..", "dist", "page.js");
const NOT_INSTALLED = "__agent_click_not_installed__";
/** Heavy pages (Ads Manager) take 2–3 s for a frame, more when the window is in the background. */
const SCREENSHOT_TIMEOUT_MS = 8000;
/** One connection per chat: kept between tasks, closed after this long without tool calls (D-16). */
const IDLE_DISCONNECT_MS = 2 * 60 * 60 * 1000;

type ApiMethod = Exclude<keyof PageApi, "version">;
type ApiReturn<M extends ApiMethod> = PageApi[M] extends (...args: never[]) => infer R ? R : never;

export interface Attached {
  page: Page;
  cdp: CDPSession;
  network: NetworkRecorder;
}

export class Session {
  private browser?: Browser;
  private attached?: Attached;
  private pageScript?: string;
  /** Native dialogs (alert/confirm/beforeunload) seen since the last report. */
  private dialogs: string[] = [];
  /** Tabs opened since the last report (popups, target=_blank, also with noopener). */
  private newTabs: Target[] = [];
  private idleTimer?: NodeJS.Timeout;

  /** `connect` is replaceable for tests (a headless browser instead of the user's one). */
  constructor(private connect: () => Promise<Browser> = connectBrowser) {}

  async current(): Promise<Attached> {
    this.touch();
    if (this.attached && !this.attached.page.isClosed() && this.browser?.connected) return this.attached;
    const browser = await this.ensureBrowser();
    const page = this.attached && !this.attached.page.isClosed() ? this.attached.page : await pickActivePage(browser);
    return phase("attach", () => this.attach(page));
  }

  async pages(): Promise<Page[]> {
    const browser = await this.ensureBrowser();
    return (await browser.pages()).filter((p) => !p.url().startsWith("devtools://"));
  }

  async attach(page: Page): Promise<Attached> {
    if (this.attached?.page === page && !page.isClosed()) return this.attached;
    this.detach();
    const cdp = await page.createCDPSession();
    const network = new NetworkRecorder(cdp, () => page.url());
    await network.start();
    await enableFocusEmulation(cdp);
    page.on("dialog", this.onDialog);
    this.attached = { page, cdp, network };
    return this.attached;
  }

  /** Call a method of window.__agentClick in the current tab, injecting the script if needed. */
  async call<M extends ApiMethod>(method: M, ...args: Parameters<PageApi[M]>): Promise<ApiReturn<M>> {
    const { page } = await this.current();
    // mutationCount/loading are polled while settling; they are part of the settle phase.
    if (method !== "mutationCount" && method !== "loading") return phase(method, () => this.evaluateApi(page, method, args));
    return this.evaluateApi(page, method, args);
  }

  private async evaluateApi<M extends ApiMethod>(page: Page, method: M, args: unknown[]): Promise<ApiReturn<M>> {
    // JSON turns an omitted optional argument into null, which the page would take as a value.
    while (args.length && args[args.length - 1] === undefined) args = args.slice(0, -1);
    const expr =`window.__agentClick ? window.__agentClick.${method}(...${JSON.stringify(args)}) : ${JSON.stringify(NOT_INSTALLED)}`;
    let result = await page.evaluate(expr);
    if (result === NOT_INSTALLED) {
      await phase("inject", () => page.evaluate(this.script()));
      result = await page.evaluate(expr);
    }
    return result as ApiReturn<M>;
  }

  async settle(timeoutMs = 5000): Promise<SettleResult> {
    const { network } = await this.current();
    const settle = () => waitForSettle(
      {
        inflight: () => network.inflight(),
        pendingDescriptions: () => network.pendingDescriptions(),
        mutationCount: () => this.call("mutationCount"),
        busyReasons: async () => {
          const l = await this.call("loading");
          return l.busy ? l.reasons : [];
        },
      },
      { timeoutMs },
    );
    return phase("settle", settle, (r) => (r.settled ? undefined : `timeout: ${r.pending.join("; ")}`));
  }

  /** JPEG screenshot of the viewport, or null if the browser did not answer in time. */
  async screenshot(): Promise<{ data: Buffer; dpr: number } | null> {
    const { page, cdp } = await this.current();
    try {
      const dpr = (await page.evaluate("window.devicePixelRatio")) as number;
      const shot = (await phase("screenshot", () =>
        withTimeout(cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 85, optimizeForSpeed: true }), SCREENSHOT_TIMEOUT_MS),
      )) as { data: string };
      return { data: Buffer.from(shot.data, "base64"), dpr };
    } catch {
      return null;
    }
  }

  /** Native dialogs and new tabs since the last call, as report lines. */
  takeEvents(): string[] {
    const lines = this.dialogs.map((d) => `native dialog: ${d}`);
    for (const t of this.newTabs) lines.push(`new tab opened: ${t.url()} (use tabs to switch)`);
    this.dialogs = [];
    this.newTabs = [];
    return lines;
  }

  hasNewTab(): boolean {
    return this.newTabs.length > 0;
  }

  /** Switches to the latest tab opened since the last report, as the browser itself does. */
  async followNewTab(): Promise<Page | null> {
    const target = this.newTabs.pop();
    this.newTabs = [];
    const page = await target?.page();
    if (!page) return null;
    await this.attach(page);
    return page;
  }

  /** Forget tabs opened so far (the agent opened them itself). */
  forgetNewTabs(): void {
    this.newTabs = [];
  }

  /** Restarts the idle timer: the connection lives across tasks of one chat and closes after a long pause. */
  private touch(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.disconnect(), IDLE_DISCONNECT_MS);
    this.idleTimer.unref(); // never keeps the process alive by itself
  }

  /** Drops the browser connection; the next tool call connects again (and the browser asks Allow). */
  disconnect(): void {
    this.detach();
    this.browser?.disconnect().catch(() => {});
    this.browser = undefined;
  }

  private script(): string {
    this.pageScript ??= readFileSync(PAGE_SCRIPT_PATH, "utf8");
    return this.pageScript;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.connected) return this.browser;
    this.attached = undefined;
    this.browser = await phase("connect", this.connect);
    // Any new tab counts: links with rel=noopener (common) leave no opener to compare with.
    this.browser.on("targetcreated", (target: Target) => {
      if (target.type() === "page") this.newTabs.push(target);
    });
    return this.browser;
  }

  private detach(): void {
    if (!this.attached) return;
    this.attached.page.off("dialog", this.onDialog);
    this.attached.network.dispose();
    this.attached.cdp.detach().catch(() => {});
    this.attached = undefined;
  }

  // A native dialog blocks the page entirely, so it is resolved right away and reported.
  // alert/beforeunload are accepted only when harmless; confirm/prompt are dismissed (D-7: the
  // agent decides, so it gets the text and can redo the action differently).
  private onDialog = async (dialog: Dialog): Promise<void> => {
    const type = dialog.type();
    const msg = dialog.message().slice(0, 200);
    if (type === "alert") {
      this.dialogs.push(`alert "${msg}" (closed)`);
      await dialog.accept().catch(() => {});
    } else if (type === "beforeunload") {
      this.dialogs.push(`"Leave site?" — the page has unsaved changes; navigation was cancelled`);
      await dialog.dismiss().catch(() => {});
    } else {
      this.dialogs.push(`${type} "${msg}" (dismissed)`);
      await dialog.dismiss().catch(() => {});
    }
  };
}

async function pickActivePage(browser: Browser): Promise<Page> {
  const pages = (await browser.pages()).filter((p) => !p.url().startsWith("devtools://"));
  for (const p of pages) {
    const visible = await withTimeout(p.evaluate("document.visibilityState === 'visible'"), 1000).catch(() => false);
    if (visible) return p;
  }
  return pages[0] ?? (await browser.newPage());
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms`)), ms);
    promise.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}
