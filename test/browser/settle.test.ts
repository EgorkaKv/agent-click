import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser } from "puppeteer-core";
import { launchTestBrowser } from "../helpers/browser.js";
import { waitForSettle, type SettleProbe } from "../../src/browser/settle.js";
import { NetworkRecorder } from "../../src/browser/network.js";
import { click } from "../../src/browser/input.js";
import { startFixtureServer, type FixtureServer } from "./support.js";

/** A probe with no DOM mutations, no busy indicators and nothing in flight. */
function quietProbe(over: Partial<SettleProbe> = {}): SettleProbe {
  return {
    inflight: () => 0,
    pendingDescriptions: () => [],
    mutationCount: async () => 0,
    busyReasons: async () => [],
    ...over,
  };
}

describe("waitForSettle with a fake probe", () => {
  it("settles after the quiet window when nothing happens", async () => {
    const r = await waitForSettle(quietProbe());
    expect(r.settled).toBe(true);
    expect(r.pending).toEqual([]);
    expect(r.waitedMs).toBeGreaterThanOrEqual(300);
    expect(r.waitedMs).toBeLessThan(1000);
  });

  it("waits for requests that finish later", async () => {
    const end = Date.now() + 400;
    const r = await waitForSettle(
      quietProbe({
        inflight: () => (Date.now() < end ? 1 : 0),
        pendingDescriptions: () => ["GET /api/a"],
      }),
      { timeoutMs: 3000 },
    );
    expect(r.settled).toBe(true);
    // Requests end at ~400 ms, then 300 ms of network quiet.
    expect(r.waitedMs).toBeGreaterThanOrEqual(690);
  });

  it("returns settled:false with the pending requests when never quiet", async () => {
    const r = await waitForSettle(
      quietProbe({ inflight: () => 1, pendingDescriptions: () => ["POST /api/b"] }),
      { timeoutMs: 600 },
    );
    expect(r.settled).toBe(false);
    expect(r.waitedMs).toBeGreaterThanOrEqual(600);
    expect(r.pending[0]).toBe("1 request: POST /api/b");
  });

  it("waits while the DOM keeps mutating", async () => {
    const start = Date.now();
    let count = 0;
    const r = await waitForSettle(
      quietProbe({
        mutationCount: async () => (Date.now() - start < 500 ? ++count : count),
      }),
    );
    expect(r.settled).toBe(true);
    // Last change is seen at ~450-500 ms, then 200 ms of DOM quiet.
    expect(r.waitedMs).toBeGreaterThanOrEqual(600);
  });

  it("waits while a busy indicator is visible", async () => {
    const start = Date.now();
    const r = await waitForSettle(
      quietProbe({
        busyReasons: async () => (Date.now() - start < 400 ? ["spinner in dialog \"Сохранение\""] : []),
      }),
      { timeoutMs: 3000 },
    );
    expect(r.settled).toBe(true);
    expect(r.waitedMs).toBeGreaterThanOrEqual(400);
  });

  it("treats a throwing probe as not quiet and keeps polling until it recovers", async () => {
    const start = Date.now();
    const r = await waitForSettle(
      quietProbe({
        mutationCount: async () => {
          if (Date.now() - start < 300) throw new Error("Execution context was destroyed");
          return 0;
        },
      }),
      { timeoutMs: 3000 },
    );
    expect(r.settled).toBe(true);
    expect(r.waitedMs).toBeGreaterThanOrEqual(500);
  });

  it("gives up at the timeout when the probe always throws", async () => {
    const r = await waitForSettle(
      quietProbe({
        inflight: () => {
          throw new Error("detached");
        },
      }),
      { timeoutMs: 400 },
    );
    expect(r.settled).toBe(false);
    expect(r.pending).toContain("page not responding (navigating?)");
  });
});

describe("waitForSettle with a real browser", () => {
  let server: FixtureServer;
  let browser: Browser;
  let closeBrowser: () => Promise<void>;

  beforeAll(async () => {
    server = await startFixtureServer();
    ({ browser, close: closeBrowser } = await launchTestBrowser());
  });

  afterAll(async () => {
    await closeBrowser();
    await server.close();
  });

  it("settles after a click that starts a 500 ms fetch and then updates the DOM", async () => {
    const page = await browser.newPage();
    await page.goto(`${server.base}/page/browser-settle.html`);
    const cdp = await page.createCDPSession();
    const recorder = new NetworkRecorder(cdp, () => page.url());
    await recorder.start();
    try {
      const point = await page.$eval("#go", (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await click(cdp, point);
      const probe: SettleProbe = {
        inflight: () => recorder.inflight(),
        pendingDescriptions: () => recorder.pendingDescriptions(),
        mutationCount: () => page.evaluate(() => (window as unknown as { __mutations: () => number }).__mutations()),
        busyReasons: async () => [],
      };
      const r = await waitForSettle(probe, { timeoutMs: 5000 });
      expect(r.settled).toBe(true);
      expect(r.waitedMs).toBeGreaterThanOrEqual(500);
      expect(await page.$eval("#out", (el) => el.textContent)).toBe("done slow");
    } finally {
      recorder.dispose();
      await page.close();
    }
  });
});
