import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { Browser, CDPSession, Page } from "puppeteer-core";
import { launchTestBrowser, FIXTURES } from "../helpers/browser.js";
import { click, enableFocusEmulation, hover, insertText, parseCombo, press } from "../../src/browser/input.js";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface RecordedEvent {
  type: string;
  trusted: boolean;
  x: number;
  y: number;
  detail: number;
  key: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

let browser: Browser;
let closeBrowser: () => Promise<void>;
let page: Page;
let cdp: CDPSession;

beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});

afterAll(async () => {
  await closeBrowser();
});

async function openInputFixture(): Promise<void> {
  page = await browser.newPage();
  await page.goto(pathToFileURL(join(FIXTURES, "browser-input.html")).href);
  cdp = await page.createCDPSession();
}

afterEach(async () => {
  await page?.close();
});

async function centerOf(selector: string): Promise<{ x: number; y: number }> {
  return page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
}

function events(type?: string): Promise<RecordedEvent[]> {
  return page.evaluate((t) => {
    const all = (window as unknown as { events: RecordedEvent[] }).events;
    return t ? all.filter((e) => e.type === t) : all;
  }, type ?? null);
}

describe("parseCombo", () => {
  it("parses modifiers and keys", () => {
    expect(parseCombo("Meta+Enter")).toMatchObject({ modifiers: ["Meta"], key: { key: "Enter", vk: 13 } });
    expect(parseCombo("Shift+Tab").modifiers).toEqual(["Shift"]);
    expect(parseCombo("ctrl+shift+a")).toMatchObject({ modifiers: ["Control", "Shift"], key: { key: "a", text: "a" } });
    expect(parseCombo("+").key.key).toBe("+");
    expect(parseCombo("Control++").key.key).toBe("+");
    expect(parseCombo("ArrowDown").key.code).toBe("ArrowDown");
  });

  it("throws on unknown keys and modifiers", () => {
    expect(() => parseCombo("Hyper+A")).toThrow(/Unknown modifier/);
    expect(() => parseCombo("Foo")).toThrow(/Unknown key/);
    expect(() => parseCombo("")).toThrow(/Unknown key/);
  });
});

describe("trusted input", () => {
  it("click lands at the point and is trusted", async () => {
    await openInputFixture();
    const point = await centerOf("#btn");
    await click(cdp, point);
    const clicks = await events("click");
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.trusted).toBe(true);
    expect(clicks[0]!.x).toBeCloseTo(point.x, 0);
    expect(clicks[0]!.y).toBeCloseTo(point.y, 0);
    expect(clicks[0]!.detail).toBe(1);
  });

  it("hover moves the pointer without clicking", async () => {
    await openInputFixture();
    const point = await centerOf("#btn");
    await hover(cdp, point);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 50)));
    expect(await events("click")).toHaveLength(0);
    expect((await events("mousedown")).length).toBe(0);
  });

  it("dblclick sends two clicks and a dblclick event", async () => {
    await openInputFixture();
    const point = await centerOf("#btn");
    await click(cdp, point, { clickCount: 2 });
    expect((await events("click")).map((e) => e.detail)).toEqual([1, 2]);
    const dbl = await events("dblclick");
    expect(dbl).toHaveLength(1);
    expect(dbl[0]!.trusted).toBe(true);
  });

  it("press Control+A selects all text in a focused input", async () => {
    await openInputFixture();
    await page.focus("#field");
    await page.evaluate(() => (document.getElementById("field") as HTMLInputElement).setSelectionRange(2, 2));
    await press(cdp, "Control+A");
    const sel = await page.$eval("#field", (el) => {
      const i = el as HTMLInputElement;
      return [i.selectionStart, i.selectionEnd, i.value.length];
    });
    expect(sel).toEqual([0, 11, 11]);
    const keydowns = await events("keydown");
    const ctrlA = keydowns.find((e) => e.key.toLowerCase() === "a");
    expect(ctrlA?.ctrl).toBe(true);
    expect(ctrlA?.trusted).toBe(true);
  });

  it("press Enter submits a form from a focused input", async () => {
    await openInputFixture();
    await page.focus("#q");
    await press(cdp, "Enter");
    expect(await page.evaluate(() => (window as unknown as { submitted: boolean }).submitted)).toBe(true);
    const keydowns = await events("keydown");
    expect(keydowns.some((e) => e.key === "Enter")).toBe(true);
  });

  it("press Shift+Tab moves focus backwards", async () => {
    await openInputFixture();
    await page.focus("#q");
    await press(cdp, "Shift+Tab");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("field");
    const tab = (await events("keydown")).find((e) => e.key === "Tab");
    expect(tab?.shift).toBe(true);
  });

  it("insertText types Cyrillic text into the focused input", async () => {
    await openInputFixture();
    await page.focus("#q");
    await insertText(cdp, "Привет, мир");
    expect(await page.$eval("#q", (el) => (el as HTMLInputElement).value)).toBe("Привет, мир");
  });

  it("press throws on an unknown key without sending any event", async () => {
    await openInputFixture();
    await expect(press(cdp, "NotAKey")).rejects.toThrow(/Unknown key/);
    expect(await events()).toHaveLength(0);
  });

  it("enableFocusEmulation resolves", async () => {
    await openInputFixture();
    await expect(enableFocusEmulation(cdp)).resolves.toBeUndefined();
  });
});
