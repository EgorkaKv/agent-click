import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "puppeteer-core";
import { launchTestBrowser } from "../helpers/browser.js";
import { api, find, openPage, snapshot } from "./helpers.js";

// Fixture from a real session: a table whose link changes name, a heading editor without
// sections, glued and duplicated names, an option with a description, and a time field.
describe("real-session fixes 3", () => {
  let browser: Browser;
  let close: () => Promise<void>;
  let page: Page;

  beforeAll(async () => {
    ({ browser, close } = await launchTestBrowser());
    page = await openPage(browser, "page-real3.html");
  }, 60_000);

  afterAll(async () => {
    await close();
  });

  it("gives an object-role element a new id when its name changes, and keeps the id of a toggling button", async () => {
    const link = find((await snapshot(page)).elements, "link", "PL+UA 18-35 Instagram (Android)");
    const toggle = find((await snapshot(page)).elements, "button", "Показать");
    await page.evaluate(() => {
      document.getElementById("camp")!.textContent = "agent-click test — Flowr iOS";
      document.getElementById("toggle")!.textContent = "Скрыть";
    });
    const els = (await snapshot(page)).elements;
    const moved = find(els, "link", "agent-click test — Flowr iOS");
    expect(moved.id).not.toBe(link.id);
    expect(await api(page, "describe", link.id)).toBeNull();
    expect(find(els, "button", "Скрыть").id).toBe(toggle.id);
  });

  it("scopes by a heading to the container the heading titles", async () => {
    const r = await snapshot(page, { scope: "Бюджет и график" });
    expect(find(r.elements, "textbox", "Дневной бюджет")).toBeDefined();
    const text = await api(page, "read", "Бюджет и график");
    expect(text.text).toContain("Сумма 100");
  });

  it("does not put a heading into the section of the heading before it", async () => {
    const els = (await snapshot(page, { full: true })).elements;
    expect(find(els, "heading", "Аудитория").context.join(" ")).not.toContain("Бюджет");
    expect(find(els, "button", "Добавить интересы").context.at(-1)).toBe('section "Аудитория"');
    expect(find(els, "textbox", "Дневной бюджет").context.at(-1)).toBe('section "Бюджет и график"');
  });

  it("joins block children and drops a repeated copy in names", async () => {
    const els = (await snapshot(page, { full: true })).elements;
    expect(find(els, "button", "Настройки рекламы не установлены")).toBeDefined();
    expect(find(els, "link", "Настройки")).toBeDefined();
  });

  it("keeps the description line of an option", async () => {
    const els = (await snapshot(page, { full: true })).elements;
    expect(find(els, "option", "flowr: Self-Care Planner — Не подключено к вашему рекламному аккаунту")).toBeDefined();
  });

  it("does not take a time field or an input value as a message", async () => {
    const snap = await snapshot(page, { full: true });
    expect(snap.messages).toContain("Черновик сохранён");
    expect(snap.messages).not.toContain("19:35");
  });
});
