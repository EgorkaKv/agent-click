import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "puppeteer-core";
import { launchTestBrowser } from "../helpers/browser.js";
import { find, openPage, snapshot } from "./helpers.js";

// Fixture from a real session: landmarks, KPI headings, unnamed controls, a status badge.
describe("real-session fixes", () => {
  let browser: Browser;
  let close: () => Promise<void>;
  let page: Page;
  let els: any[];
  let snap: any;

  beforeAll(async () => {
    ({ browser, close } = await launchTestBrowser());
    page = await openPage(browser, "page-real1.html");
    snap = await snapshot(page, { full: true });
    els = snap.elements;
  }, 60_000);

  afterAll(async () => {
    await close();
  });

  it("accepts a landmark word as scope (outermost rendered one)", async () => {
    const ids = (await snapshot(page, { scope: "main", full: true })).elements.map((e: any) => e.name);
    expect(ids).toContain("Details");
    expect(ids).not.toContain("Apps");
  });

  it("accepts a label as printed in the output as scope", async () => {
    const names = (await snapshot(page, { scope: 'nav "Side navigation"', full: true })).elements.map((e: any) => e.name);
    expect(names).toEqual(["Apps"]);
  });

  it("names unnamed controls from nearby visible text", () => {
    expect(find(els, "textbox", "Facebook App Id").value).toBe("2480843132394718");
    expect(find(els, "checkbox", "Activate partner")).toBeDefined();
  });

  it("reports a clickable wrapper around a hidden checkbox as checkbox with its checked state", () => {
    const toggle = find(els, "checkbox", "Activate partner");
    expect(toggle.state.checked).toBe(true);
    expect(els.filter((e) => e.role === "clickable")).toEqual([]);
  });

  it("skips numeric headings when naming the context of a control", () => {
    expect(find(els, "button", "Details").context).toEqual(["main", "main", 'section "Revenue"']);
  });

  it("does not repeat a status element in messages, but keeps other messages", () => {
    expect(find(els, "status", "id6792269704")).toBeDefined();
    expect(snap.messages).not.toContain("id6792269704");
    expect(snap.messages).toContain("Saved changes");
  });
});
