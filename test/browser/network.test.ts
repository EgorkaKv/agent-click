import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser, CDPSession, Page } from "puppeteer-core";
import { launchTestBrowser } from "../helpers/browser.js";
import { NetworkRecorder, isTelemetry, shortenUrl, siteOf } from "../../src/browser/network.js";
import { startFixtureServer, waitFor, type FixtureServer } from "./support.js";

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

interface Session {
  page: Page;
  cdp: CDPSession;
  recorder: NetworkRecorder;
}

async function openSession(longPollMs?: number): Promise<Session> {
  const page = await browser.newPage();
  await page.goto(`${server.base}/page/browser-network.html`);
  const cdp = await page.createCDPSession();
  const recorder = new NetworkRecorder(cdp, () => page.url(), longPollMs ? { longPollMs } : {});
  await recorder.start();
  return { page, cdp, recorder };
}

describe("isTelemetry", () => {
  it.each([
    "https://www.google-analytics.com/g/collect?v=2&tid=G-1",
    "https://www.googletagmanager.com/gtm.js?id=GTM-1",
    "https://stats.g.doubleclick.net/r/collect",
    "https://www.facebook.com/tr?id=1&ev=PageView",
    "https://connect.facebook.net/en_US/fbevents.js",
    "https://o1.ingest.sentry.io/api/1/envelope/",
    "https://api.segment.io/v1/track",
    "https://api.mixpanel.com/track?data=x",
    "https://api2.amplitude.com/2/httpapi",
    "https://static.hotjar.com/c/hotjar-1.js",
    "https://www.clarity.ms/tag/abc",
    "https://http-intake.logs.datadoghq.com/api/v2/logs",
    "https://browser-intake-datadoghq.com/api/v2/rum",
    "https://browser-intake-datadoghq.eu/api/v2/rum",
    "https://bam.nr-data.net/jserrors/1",
    "https://us.i.posthog.com/e/",
    "https://api.intercom.io/events",
    "https://rs.fullstory.com/rec/page",
    "https://notify.bugsnag.com/",
    "https://example.com/collect",
    "https://example.com/v1/beacon",
    "https://example.com/logging",
    "https://example.com/api/rum",
  ])("matches telemetry %s", (url) => {
    expect(isTelemetry(url)).toBe(true);
  });

  it.each([
    "https://example.com/api/items",
    "https://example.com/api/logs",
    "https://example.com/api/logout",
    "https://graph.facebook.com/v20.0/act_1/adsets",
    "https://www.facebook.com/adsmanager/manage",
    "https://example.com/",
    "not a url",
  ])("does not match normal URL %s", (url) => {
    expect(isTelemetry(url)).toBe(false);
  });
});

describe("shortenUrl", () => {
  it("keeps only the path for same-origin URLs", () => {
    expect(shortenUrl("https://ads.example.com/v20.0/act_1/adsets?fields=id#x", "https://ads.example.com")).toBe(
      "/v20.0/act_1/adsets",
    );
  });

  it("keeps host and path for other origins", () => {
    expect(shortenUrl("https://graph.facebook.com/v20.0/act_1/adsets?x=1", "https://ads.example.com")).toBe(
      "graph.facebook.com/v20.0/act_1/adsets",
    );
  });
});

describe("NetworkRecorder", () => {
  it("reports finished and failed mutations with status and body, not GET", async () => {
    const { page, recorder } = await openSession();
    try {
      const mark = recorder.mark();
      await page.evaluate(() =>
        Promise.all([window.post("/api/ok", { a: 1 }), window.post("/api/conflict", { b: 2 }), window.get("/api/items")]),
      );
      await waitFor(() => recorder.mutationsSince(mark).length === 2);
      await recorder.drain();
      expect(recorder.mutationsSince(mark)).toEqual([
        { method: "POST", url: "/api/ok", status: 200 },
        {
          method: "POST",
          url: "/api/conflict",
          status: 409,
          error: '{"error":"version_conflict","detail":"item changed by another user"}',
        },
      ]);
      // Only requests after the mark count.
      expect(recorder.mutationsSince(recorder.mark())).toEqual([]);
    } finally {
      recorder.dispose();
      await page.close();
    }
  });

  it("excludes telemetry from mutations", async () => {
    const { page, recorder } = await openSession();
    try {
      const mark = recorder.mark();
      await page.evaluate(() => Promise.all([window.post("/collect", {}), window.post("/api/ok", {})]));
      await waitFor(() => recorder.mutationsSince(mark).length === 1);
      expect(recorder.mutationsSince(mark).map((e) => e.url)).toEqual(["/api/ok"]);
    } finally {
      recorder.dispose();
      await page.close();
    }
  });

  it("counts a slow request as in flight and ignores telemetry", async () => {
    const { page, recorder } = await openSession();
    try {
      expect(recorder.inflight()).toBe(0);
      const done = page.evaluate(() => Promise.all([window.get("/api/slow"), window.get("/collect")]));
      await waitFor(() => recorder.pendingDescriptions().includes("GET /api/slow"));
      expect(recorder.inflight()).toBe(1);
      expect(recorder.pendingDescriptions()).toEqual(["GET /api/slow"]);
      await done;
      await waitFor(() => recorder.inflight() === 0);
    } finally {
      recorder.dispose();
      await page.close();
    }
  });

  it("limits pending descriptions to 5", async () => {
    const { page, recorder } = await openSession();
    try {
      const done = page.evaluate(() => Promise.all(Array.from({ length: 7 }, () => window.get("/api/slow"))));
      await waitFor(() => recorder.inflight() === 7);
      expect(recorder.pendingDescriptions()).toHaveLength(5);
      await done;
      await waitFor(() => recorder.inflight() === 0);
    } finally {
      recorder.dispose();
      await page.close();
    }
  });

  it("ignores requests in flight longer than the long-poll limit", async () => {
    const { page, recorder } = await openSession(100);
    try {
      const done = page.evaluate(() => window.get("/api/slow"));
      await waitFor(() => recorder.pendingDescriptions().length === 1, 2000, 10);
      await new Promise((r) => setTimeout(r, 200));
      expect(recorder.inflight()).toBe(0);
      await done;
    } finally {
      recorder.dispose();
      await page.close();
    }
  });

  it("stops recording after dispose", async () => {
    const { page, recorder } = await openSession();
    const mark = recorder.mark();
    recorder.dispose();
    await page.evaluate(() => window.post("/api/ok", {}));
    await new Promise((r) => setTimeout(r, 200));
    expect(recorder.mutationsSince(mark)).toEqual([]);
    await page.close();
  });
});

describe("siteOf", () => {
  it.each([
    ["hq1.appsflyer.com", "appsflyer.com"],
    ["business.facebook.com", "facebook.com"],
    ["a.b.co.uk", "b.co.uk"],
    ["127.0.0.1", "127.0.0.1"],
    ["localhost", "localhost"],
  ])("%s → %s", (host, site) => {
    expect(siteOf(host)).toBe(site);
  });
});
