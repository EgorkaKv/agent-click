import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "puppeteer-core";
import { launchTestBrowser } from "../helpers/browser.js";
import { api, openPage } from "./helpers.js";

describe("label of a custom control", () => {
  let browser: Browser;
  let close: () => Promise<void>;
  let page: Page;

  beforeAll(async () => {
    ({ browser, close } = await launchTestBrowser());
    page = await openPage(browser, "page-label.html");
  }, 60_000);

  afterAll(async () => {
    await page.close();
    await close();
  });

  const rectOf = (sel: string) =>
    page.$eval(sel, (el) => {
      const r = el.getBoundingClientRect();
      return { x1: r.left, y1: r.top, x2: r.right, y2: r.bottom };
    });

  it("does not report a transparent radio's label (label for=, span inside) as an occluder; clicks the label", async () => {
    const r = await api(page, "locate", "Large");
    expect(r.ok).toBe(true);
    expect(r.occludedBy).toBeUndefined();
    const box = await rectOf("#lab-radio");
    expect(r.point.x).toBeGreaterThanOrEqual(box.x1);
    expect(r.point.x).toBeLessThanOrEqual(box.x2);
    expect(r.point.y).toBeGreaterThanOrEqual(box.y1);
    expect(r.point.y).toBeLessThanOrEqual(box.y2);
  });

  it("does not report a checkbox wrapped in a label with a span as occluded", async () => {
    const r = await api(page, "locate", "Agree");
    expect(r.ok).toBe(true);
    expect(r.occludedBy).toBeUndefined();
  });

  it("still reports a fixed overlay that covers the label of a transparent radio", async () => {
    const r = await api(page, "locate", "Covered");
    expect(r.ok).toBe(true);
    expect(r.occludedBy).toContain("(fixed)");
  });
});
