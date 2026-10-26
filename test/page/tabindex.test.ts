import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "puppeteer-core";
import { launchTestBrowser } from "../helpers/browser.js";
import { find, openPage, snapshot } from "./helpers.js";

describe("container candidates (tabindex and cursor:pointer)", () => {
  let browser: Browser;
  let close: () => Promise<void>;
  let page: Page;
  let els: any[];

  beforeAll(async () => {
    ({ browser, close } = await launchTestBrowser());
    page = await openPage(browser, "page-tabindex.html");
    els = (await snapshot(page, { full: true })).elements;
  }, 60_000);

  afterAll(async () => {
    await close();
  });

  it("drops a tabindex-only scroll region that contains interactive elements", () => {
    const regions = els.filter((e) => e.kind === "interactive" && e.role === "generic");
    expect(regions).toEqual([]);
    expect(els.filter((e) => e.kind === "interactive" && e.name.includes("AppsFlyer"))).toEqual([]);
  });

  it("keeps the controls inside the tabindex region", () => {
    expect(find(els, "textbox", "API key")).toBeDefined();
    expect(find(els, "button", "Save config")).toBeDefined();
  });

  it("drops a cursor:pointer container with two or more interactive elements", () => {
    expect(els.filter((e) => e.role === "clickable" && e.name.startsWith("Card"))).toEqual([]);
    expect(find(els, "button", "Card action one")).toBeDefined();
    expect(find(els, "link", "Card link")).toBeDefined();
  });

  it("keeps a cursor:pointer element without interactive descendants as clickable", () => {
    expect(find(els, "clickable", "Pointer single")).toBeDefined();
  });
});
