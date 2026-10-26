import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "puppeteer-core";
import { launchTestBrowser } from "../helpers/browser.js";
import { find, openPage, snapshot } from "./helpers.js";

// Fixture from a real session: a sidebar beside a main column, zero-width and machine-token
// names, duplicate progressbars, a rich-text editor, a glued profile text and a toast.
describe("real-session fixes 2", () => {
  let browser: Browser;
  let close: () => Promise<void>;
  let page: Page;
  let els: any[];
  let snap: any;

  beforeAll(async () => {
    ({ browser, close } = await launchTestBrowser());
    page = await openPage(browser, "page-real2.html");
    snap = await snapshot(page, { full: true });
    els = snap.elements;
  }, 60_000);

  afterAll(async () => {
    await close();
  });

  it("does not take a main-column heading as the section of a sidebar link", () => {
    expect(find(els, "link", "Поиск").context).toEqual([]);
    expect(find(els, "link", "Справка").context).toEqual([]);
  });

  it("labels a control by its own section, not by a heading of another column", () => {
    expect(find(els, "button", "Меню").context).toEqual(['section "Объявления"']);
  });

  it("drops zero-width characters from names and falls back for names that become empty", () => {
    expect(find(els, "button", "Меню")).toBeDefined();
    expect(find(els, "button", "Кампания 1")).toBeDefined();
  });

  it("drops machine tokens from names", () => {
    expect(find(els, "link", "Все объявления")).toBeDefined();
  });

  it("merges equal loading reasons with a count", () => {
    expect(snap.loading.reasons).toEqual(['progressbar ×2 in section "Объявления"']);
  });

  it("uses data-placeholder of a contenteditable as its placeholder", () => {
    const box = find(els, "textbox", "");
    expect(box.placeholder).toBe("Задайте уточняющий вопрос");
  });

  it("joins block children of a message with a space", () => {
    expect(snap.messages).toContain("Черновик сохранён Сейчас");
  });

  it("does not take a toast-like class as a message unless the element floats", () => {
    expect(snap.messages.some((m: string) => m.includes("Yehor"))).toBe(false);
  });
});
