import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "puppeteer-core";
import { launchTestBrowser } from "../helpers/browser.js";
import { api, openHtml } from "./helpers.js";

/** ~300 sections, each with a heading, a card, a few controls: about 3000 elements. */
function bigPage(): string {
  const parts: string[] = [];
  for (let i = 0; i < 300; i++) {
    parts.push(
      `<section aria-label="S${i}"><h3>Section ${i}</h3><div class="card" style="padding:4px">` +
        `<span>Item ${i}</span><button>Action ${i}</button><a href="#${i}">Link ${i}</a>` +
        `<label for="f${i}">Field ${i}</label><input id="f${i}" placeholder="Field ${i}">` +
        `<span class="badge" style="background:#eee;padding:1px 4px">OK</span>` +
        `<div><span>Note ${i}</span><span>More ${i}</span></div></div></section>`,
    );
  }
  return `<!doctype html><html><body><main>${parts.join("")}</main></body></html>`;
}

describe("performance", () => {
  let browser: Browser;
  let close: () => Promise<void>;
  let page: Page;

  beforeAll(async () => {
    ({ browser, close } = await launchTestBrowser());
    page = await openHtml(browser, bigPage());
  }, 60_000);

  afterAll(async () => {
    await close();
  });

  it("takes under 150 ms for a snapshot of a ~3000 element page (target 50 ms)", async () => {
    const elementCount = await page.evaluate(() => document.querySelectorAll("*").length);
    expect(elementCount).toBeGreaterThan(2900);

    const timed = (opts: Record<string, unknown>) =>
      page.evaluate((o) => {
        const t0 = performance.now();
        (window as any).__agentClick.snapshot(o);
        return performance.now() - t0;
      }, opts);

    const cold = await timed({});
    const warm: number[] = [];
    for (let i = 0; i < 5; i++) warm.push(await timed({}));
    const full = await timed({ full: true, maxElements: 5000 });
    const best = Math.min(...warm);
    console.log(
      `snapshot ms (elements=${elementCount}): cold=${cold.toFixed(1)} warm-best=${best.toFixed(1)} warm-median=${warm
        .slice()
        .sort((a, b) => a - b)[2]
        .toFixed(1)} full=${full.toFixed(1)}`,
    );
    expect(best).toBeLessThan(150);
    expect(full).toBeLessThan(150 * 3);
  }, 60_000);

  it("returns a bounded viewport snapshot on a large page", async () => {
    const snap = await api(page, "snapshot", {});
    expect(snap.elements.length).toBeLessThanOrEqual(150);
    expect(snap.elements.length).toBeGreaterThan(0);
  });
});
