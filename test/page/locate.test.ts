import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "puppeteer-core";
import { launchTestBrowser } from "../helpers/browser.js";
import { api, find, openPage, snapshot } from "./helpers.js";

describe("locate", () => {
  let browser: Browser;
  let close: () => Promise<void>;
  let page: Page;

  beforeAll(async () => {
    ({ browser, close } = await launchTestBrowser());
    page = await openPage(browser, "page-locate.html");
  }, 60_000);

  afterAll(async () => {
    await close();
  });

  it("finds a unique exact name and returns a point inside the viewport", async () => {
    const r = await api(page, "locate", "Discard");
    expect(r.ok).toBe(true);
    expect(r.info.name).toBe("Discard");
    expect(r.point.x).toBeGreaterThan(0);
    expect(r.point.y).toBeGreaterThan(0);
    expect(r.occludedBy).toBeUndefined();
  });

  it("reports ambiguous exact matches with candidates and a message", async () => {
    const r = await api(page, "locate", "Save");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("ambiguous");
    expect(r.message).toMatch(
      /^2 elements match "Save": \[\d+\] button "Save" in header, \[\d+\] button "Save" in section "Edit"/,
    );
    expect(r.candidates).toHaveLength(2);
  });

  it("resolves {text, in} within a named section", async () => {
    const r = await api(page, "locate", { text: "Save", in: "Edit" });
    expect(r.ok).toBe(true);
    expect(r.info.context).toEqual(["main", 'section "Edit"']);
  });

  it("falls back to substring matching", async () => {
    const r = await api(page, "locate", "publi");
    expect(r.ok).toBe(true);
    expect(r.info.name).toBe("Publish");
  });

  it("reports not_found with similar candidates sharing a word", async () => {
    const r = await api(page, "locate", "Save changes");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("not_found");
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates.every((c: any) => c.name === "Save")).toBe(true);
  });

  it("reports disabled targets", async () => {
    const r = await api(page, "locate", "Locked");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("disabled");
  });

  it("scrolls an offscreen element into view and returns its point", async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    const r = await api(page, "locate", "Publish");
    expect(r.ok).toBe(true);
    expect(r.point.y).toBeGreaterThanOrEqual(0);
    expect(r.point.y).toBeLessThanOrEqual(700);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  });

  it("reports not_visible for offscreen elements when scroll is false", async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    const r = await api(page, "locate", "Publish", { scroll: false });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("not_visible");
  });

  it("reports occlusion by a fixed footer", async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    const snap = await snapshot(page);
    const covered = find(snap.elements, "button", "Covered");
    expect(covered.occludedBy).toBe("footer (fixed)");
    const r = await api(page, "locate", covered.id);
    expect(r.ok).toBe(true);
    expect(r.occludedBy).toBe("footer (fixed)");
  });

  it("locates by registry id and reports stale for unknown ids", async () => {
    const snap = await snapshot(page);
    const discard = find(snap.elements, "button", "Discard");
    const r = await api(page, "locate", discard.id);
    expect(r.ok).toBe(true);
    expect(r.id).toBe(discard.id);
    const bad = await api(page, "locate", 999999);
    expect(bad).toMatchObject({ ok: false, error: "stale" });
  });
});
