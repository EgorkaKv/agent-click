// Connection to the user's browser and the tab the agent works in.
// One Session per server process (D-4): connect lazily, reconnect on transport loss.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, CDPSession, Dialog, Page } from "puppeteer-core";
import { connectBrowser } from "../browser/connect.js";
import { enableFocusEmulation } from "../browser/input.js";
import { NetworkRecorder } from "../browser/network.js";
import { waitForSettle } from "../browser/settle.js";
import type { PageApi, SettleResult } from "../types.js";

// dist/core/session.js → dist/page.js; when run from src via tsx → ../../dist/page.js.
const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE_SCRIPT_PATH = HERE.includes("dist") ? join(HERE, "..", "page.js") : join(HERE, "..", "..", "dist", "page.js");
const NOT_INSTALLED = "__agent_click_not_installed__";

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
  /** Tabs opened since the last report (popups, target=_blank). */
  private newTabs: Page[] = [];

  async current(): Promise<Attached> {
    if (this.attached && !this.attached.page.isClosed() && this.browser?.connected) return this.attached;
    const browser = await this.ensureBrowser();
    const page = this.attached && !this.attached.page.isClosed() ? this.attached.page : await pickActivePage(browser);
    return this.attach(page);
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
    const expr = `window.__agentClick ? window.__agentClick.${method}(...${JSON.stringify(args)}) : ${JSON.stringify(NOT_INSTALLED)}`;
    let result = await page.evaluate(expr);
    if (result === NOT_INSTALLED) {
      await page.evaluate(this.script());
      result = await page.evaluate(expr);
    }
    return result as ApiReturn<M>;
  }

  async settle(timeoutMs = 5000): Promise<SettleResult> {
    const { network } = await this.current();
    let busy: string[] = [];
    let busyAt = 0;
    return waitForSettle(
      {
        inflight: () => network.inflight(),
        pendingDescriptions: () => network.pendingDescriptions(),
        mutationCount: () => this.call("mutationCount"),
        busyReasons: async () => {
          // Snapshot is the only page-side source of loading signals and it is a full DOM pass,
          // so it is sampled at most every 250 ms. TODO: a dedicated PageApi.loading().
          if (Date.now() - busyAt > 250) {
            const s = await this.call("snapshot", { maxElements: 1 });
            busy = s.loading.busy ? s.loading.reasons : [];
            busyAt = Date.now();
          }
          return busy;
        },
      },
      { timeoutMs },
    );
  }

  /** JPEG screenshot of the viewport, or null if the browser did not answer in time. */
  async screenshot(): Promise<{ data: Buffer; dpr: number } | null> {
    const { page, cdp } = await this.current();
    try {
      const dpr = (await page.evaluate("window.devicePixelRatio")) as number;
      const shot = (await withTimeout(
        cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 85, optimizeForSpeed: true }),
        3000,
      )) as { data: string };
      return { data: Buffer.from(shot.data, "base64"), dpr };
    } catch {
      return null;
    }
  }

  /** Native dialogs and new tabs since the last call, as report lines. */
  takeEvents(): string[] {
    const lines = this.dialogs.map((d) => `native dialog: ${d}`);
    for (const p of this.newTabs) lines.push(`new tab opened: ${p.url()} (use tabs to switch)`);
    this.dialogs = [];
    this.newTabs = [];
    return lines;
  }

  private script(): string {
    this.pageScript ??= readFileSync(PAGE_SCRIPT_PATH, "utf8");
    return this.pageScript;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.connected) return this.browser;
    this.attached = undefined;
    this.browser = await connectBrowser();
    this.browser.on("targetcreated", async (target) => {
      if (target.type() !== "page") return;
      const page = await target.page();
      if (page && (await target.opener()?.page()) === this.attached?.page) this.newTabs.push(page);
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
