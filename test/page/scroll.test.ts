import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Browser, Page } from "puppeteer-core";
import { launchTestBrowser } from "../helpers/browser.js";
import { api, find, openHtml, openPage, snapshot } from "./helpers.js";

describe("clipping by scroll containers", () => {
  let browser: Browser;
  let close: () => Promise<void>;
  let page: Page;

  /** Puts the sidebar and the main region into the partly scrolled state the fixture is built for. */
  const scrollState = (navTop = 100, mainTop = 200) =>
    page.evaluate(
      (n: number, m: number) => {
        (document.getElementById("nav") as HTMLElement).scrollTop = n;
        (document.getElementById("main") as HTMLElement).scrollTop = m;
      },
      navTop,
      mainTop,
    );

  beforeAll(async () => {
    ({ browser, close } = await launchTestBrowser());
    page = await openPage(browser, "page-scroll.html");
  }, 60_000);

  afterAll(async () => {
    await close();
  });

  beforeEach(async () => {
    await scrollState();
  });

  it("does not report links scrolled out of a scroll container as occluded; they are not in viewport", async () => {
    const els = (await snapshot(page, { full: true })).elements;
    const link1 = find(els, "link", "Link 1");
    expect(link1.inViewport).toBe(false);
    expect(link1.occludedBy).toBeUndefined();
    // Link 4 is only partly inside the sidebar: visible, and not occluded by it either
    const link4 = find(els, "link", "Link 4");
    expect(link4.inViewport).toBe(true);
    expect(link4.occludedBy).toBeUndefined();
    expect(find(els, "link", "Link 5").occludedBy).toBeUndefined();
  });

  it("summarizes clipped elements as offscreen relative to their container", async () => {
    const snap = await snapshot(page);
    const above = snap.offscreen.find((o: any) => o.direction === "above" && o.context === 'nav "Sidebar"');
    expect(above?.count).toBeGreaterThanOrEqual(3);
    expect(snap.elements.find((e: any) => e.name === "Link 1")).toBeUndefined();
  });

  it("treats a combobox scrolled above its scrollable main as clipped, not occluded", async () => {
    const els = (await snapshot(page, { full: true })).elements;
    const plan = find(els, "combobox", "Plan");
    expect(plan.inViewport).toBe(false);
    expect(plan.occludedBy).toBeUndefined();
    const snap = await snapshot(page);
    expect(snap.offscreen).toContainEqual(expect.objectContaining({ direction: "above", context: "main" }));
  });

  it("scrolls a clipped link into its container and returns a point inside the visible area", async () => {
    const r = await api(page, "locate", "Link 1");
    expect(r.ok).toBe(true);
    expect(r.occludedBy).toBeUndefined();
    const box = await page.evaluate(() => {
      const b = (document.getElementById("nav") as HTMLElement).getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
    });
    expect(r.point.y).toBeGreaterThanOrEqual(box.top);
    expect(r.point.y).toBeLessThanOrEqual(box.bottom);
    expect(r.info.inViewport).toBe(true);
  });

  it("uses the visible part of a partly clipped link for its click point", async () => {
    const r = await api(page, "locate", "Link 4", { scroll: false });
    expect(r.ok).toBe(true);
    const box = await page.evaluate(() => {
      const b = (document.getElementById("nav") as HTMLElement).getBoundingClientRect();
      return { top: b.top, bottom: b.bottom };
    });
    expect(r.point.y).toBeGreaterThanOrEqual(box.top);
    expect(r.point.y).toBeLessThanOrEqual(box.bottom);
  });

  it("reports not_visible for a clipped element when scroll is false", async () => {
    const r = await api(page, "locate", "Link 1", { scroll: false });
    expect(r).toMatchObject({ ok: false, error: "not_visible" });
  });

  it("scrolls a clipped combobox inside main into view", async () => {
    const r = await api(page, "locate", "Plan");
    expect(r.ok).toBe(true);
    expect(r.point.y).toBeGreaterThanOrEqual(0);
    expect(r.point.y).toBeLessThanOrEqual(300);
  });
});

it("body with overflow:auto and a visible root does not clip the scrolled document (Google Flights)", async () => {
  const { browser, close } = await launchTestBrowser();
  try {
    const rows = Array.from({ length: 40 }, (_, i) => `<p><button>Day ${i + 1}</button></p>`).join("");
    const page = await openHtml(browser, `<style>body { overflow: auto; height: 100vh; margin: 0 }</style>${rows}`);
    await page.evaluate(() => window.scrollTo(0, 600));
    const els = (await snapshot(page)).elements;
    expect(els.filter((e: any) => e.role === "button" && e.inViewport).length).toBeGreaterThan(10);
  } finally {
    await close();
  }
}, 60_000);
