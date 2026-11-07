import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "puppeteer-core";
import { launchTestBrowser } from "../helpers/browser.js";
import { find, openPage, snapshot } from "./helpers.js";

// Fixture from live session 3: names of contenteditable and image links, glued machine tokens,
// a repeated phrase, a radio inside a card, and section context in div soup, tables and sidebars.
describe("real-session fixes 4 (names and context)", () => {
  let browser: Browser;
  let close: () => Promise<void>;
  let page: Page;
  let els: any[];

  beforeAll(async () => {
    ({ browser, close } = await launchTestBrowser());
    page = await openPage(browser, "page-real4.html");
    els = (await snapshot(page, { full: true })).elements;
  }, 60_000);

  afterAll(async () => {
    await close();
  });

  it("names a textbox by its placeholder, never by its typed content", () => {
    expect(find(els, "textbox", "Задайте уточняющий вопрос")).toBeDefined();
    expect(find(els, "textbox", "Задайте любой вопрос")).toBeDefined();
    expect(els.some((e) => e.name === "Назови 5 самых интересных мест")).toBe(false);
  });

  it("names an input by its placeholder when it has no label", () => {
    expect(find(els, "textbox", "Поиск по аккаунту")).toMatchObject({ value: "абв" });
  });

  it("names image links from alt, then from the file name without size prefix", () => {
    expect(find(els, "link", "Chromium Material Icon")).toBeDefined();
    expect(find(els, "link", "Логотип Wikipedia")).toBeDefined();
    expect(find(els, "button", "close btn")).toBeDefined();
  });

  it("drops zero-width spaces and machine tokens from names", () => {
    expect(find(els, "link", "Меню")).toBeDefined();
    expect(find(els, "link", "Все объявления")).toBeDefined();
    expect(find(els, "link", "Справка")).toBeDefined();
    expect(find(els, "link", "Сохранить")).toBeDefined();
    expect(JSON.stringify(els)).not.toContain("status_before_click");
  });

  it("keeps a repeated phrase once", () => {
    expect(find(els, "button", "Бюджет Параметр Advantage+ включен")).toBeDefined();
  });

  it("names a radio without a name from the card that holds it", () => {
    expect(find(els, "radio", "Рекомендуемые настройки")).toBeDefined();
    expect(find(els, "radio", "Подключение вручную")).toBeDefined();
  });

  it("gives an element the heading of its own section and no other", () => {
    expect(find(els, "button", "Аукцион").context.at(-1)).toBe('section "Тип закупки рекламы"');
    expect(find(els, "button", "Сумма в день").context.at(-1)).toBe('section "Бюджет и график"');
    expect(find(els, "button", "Создать группу").context.join(" ")).not.toContain("Уведомления");
    expect(find(els, "link", "Журнал").context.join(" ")).toContain("Уведомления");
  });

  it("never takes a table column header as a section", () => {
    const toggle = find(els, "button", "Вкл");
    expect(toggle.context.join(" ")).not.toContain("Выкл./вкл.");
  });
});
