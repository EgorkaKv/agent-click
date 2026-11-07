import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "puppeteer-core";
import { launchTestBrowser } from "../helpers/browser.js";
import { api, find, openPage, snapshot } from "./helpers.js";

// Fixture from a real session: a radio with opacity 0 under a visible label, a dialog without
// a name, a table row, and a results list whose cards are split into small blocks.
describe("real-session fixes 5", () => {
  let browser: Browser;
  let close: () => Promise<void>;
  let page: Page;

  beforeAll(async () => {
    ({ browser, close } = await launchTestBrowser());
    page = await openPage(browser, "page-real5.html");
  }, 60_000);

  afterAll(async () => {
    await close();
  });

  it("lists a transparent radio under its visible label and clicks the label", async () => {
    const els = (await snapshot(page)).elements;
    expect(find(els, "radio", "Large")).toBeDefined();
    expect(find(els, "radio", "Medium")).toBeDefined();
    const loc = await api(page, "locate", "Large");
    expect(loc.ok).toBe(true);
    const label = await page.$eval("label.box", (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    expect(loc.point.x).toBeGreaterThan(label.x);
    expect(loc.point.x).toBeLessThan(label.x + label.w);
    expect(loc.point.y).toBeGreaterThan(label.y);
    expect(loc.point.y).toBeLessThan(label.y + label.h);
    await page.mouse.click(loc.point.x, loc.point.y);
    expect(await page.$eval("#r-large", (el) => (el as HTMLInputElement).checked)).toBe(true);
  });

  it("scopes by a table row name", async () => {
    const els = (await snapshot(page, { scope: 'row "21 $171"' })).elements;
    expect(els.filter((e: any) => e.role === "button").map((e: any) => e.name)).toEqual(["Выбрать"]);
  });

  it("resolves the unnamed dialog layer by its role word as scope", async () => {
    // Open while the test runs: an open modal is a layer, and the snapshot shows only its layer.
    await page.$eval("#dlg", (el) => ((el as HTMLElement).style.display = ""));
    try {
      const els = (await snapshot(page, { scope: "dialog" })).elements;
      expect(find(els, "textbox", "Откуда")).toBeDefined();
      const text = await api(page, "read", "dialog");
      expect(text.text).toContain("Укажите пункт отправления");
    } finally {
      await page.$eval("#dlg", (el) => ((el as HTMLElement).style.display = "none"));
    }
  });

  it("reads a list item as one line of fragments", async () => {
    const text = (await api(page, "read", "main")).text as string;
    expect(text).toContain("- Tap Air Portugal · LOT · Самая низкая цена · от 174 $");
    expect(text).not.toContain("PortugalLOT");
  });
});
