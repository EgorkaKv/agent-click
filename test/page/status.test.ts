import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "puppeteer-core";
import { launchTestBrowser } from "../helpers/browser.js";
import { find, openPage, snapshot } from "./helpers.js";

describe("messages, loading, offscreen, hints, scope", () => {
  let browser: Browser;
  let close: () => Promise<void>;
  let page: Page;

  beforeAll(async () => {
    ({ browser, close } = await launchTestBrowser());
    page = await openPage(browser, "page-status.html");
  }, 60_000);

  afterAll(async () => {
    await close();
  });

  it("collects status and toast texts as messages", async () => {
    const snap = await snapshot(page);
    expect(snap.messages).toContain("Saved draft");
    expect(snap.messages).toContain("Changes saved");
    expect(snap.messages.length).toBeLessThanOrEqual(5);
  });

  it("reports busy state with reasons in context", async () => {
    const snap = await snapshot(page);
    expect(snap.loading.busy).toBe(true);
    expect(snap.loading.reasons).toContain("progressbar in page");
    expect(snap.loading.reasons).toContain('spinner in section "Build"');
    expect(snap.loading.reasons.length).toBeLessThanOrEqual(5);
  });

  it("summarizes offscreen elements above and below the viewport", async () => {
    const snap = await snapshot(page);
    expect(snap.offscreen).toContainEqual({ direction: "below", context: 'section "Versions"', count: 1 });
    expect(snap.elements.find((e: any) => e.name === "Delete")).toBeUndefined();
  });

  it("returns offscreen elements as a full list when full is set", async () => {
    const snap = await snapshot(page, { full: true });
    expect(snap.offscreen).toEqual([]);
    expect(snap.elements.find((e: any) => e.name === "Delete")).toBeDefined();
  });

  it("sets hints on same-named fields in the same context", async () => {
    const els = (await snapshot(page, { full: true })).elements;
    const phones = els.filter((e: any) => e.role === "textbox" && e.name === "Phone");
    expect(phones.map((p: any) => p.hint)).toEqual(["id phone1", "id phone2"]);
    expect(find(els, "textbox", "Phone")).toBeDefined();
  });

  it("caps elements with maxElements and sets truncated", async () => {
    const snap = await snapshot(page, { maxElements: 2 });
    expect(snap.elements).toHaveLength(2);
    expect(snap.truncated).toBe(true);
  });

  it("restricts collection to a scope given as a section name", async () => {
    const snap = await snapshot(page, { scope: "Build" });
    expect(snap.elements.length).toBeGreaterThan(0);
    for (const e of snap.elements) expect(e.context).toContain('section "Build"');
  });

  it("throws for a scope that does not resolve", async () => {
    await expect(snapshot(page, { scope: "No such section" })).rejects.toThrow(/scope not found/);
  });
});
