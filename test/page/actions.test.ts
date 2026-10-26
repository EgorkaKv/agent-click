import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "puppeteer-core";
import { launchTestBrowser } from "../helpers/browser.js";
import { api, find, openHtml, snapshot } from "./helpers.js";

const HTML = `<!doctype html><html><body>
  <label for="x">Title</label><input id="x" value="a">
  <label for="s">Size</label>
  <select id="s"><option>One</option><option>Two</option></select>
  <label for="t">Body</label><textarea id="t"></textarea>
  <div contenteditable="true" id="ce">Edit me</div>
  <div role="listbox" id="lb"><div role="option">Alpha</div><div role="option">Beta</div></div>
  <script>
    window.inputEvents = 0; window.changeEvents = 0;
    document.addEventListener('input', () => window.inputEvents++);
    document.addEventListener('change', () => window.changeEvents++);
  </script>
</body></html>`;

describe("page actions", () => {
  let browser: Browser;
  let close: () => Promise<void>;
  let page: Page;

  beforeAll(async () => {
    ({ browser, close } = await launchTestBrowser());
    page = await openHtml(browser, HTML);
  }, 60_000);

  afterAll(async () => {
    await close();
  });

  it("setNativeValue sets the value and dispatches input and change", async () => {
    const els = (await snapshot(page)).elements;
    const id = find(els, "textbox", "Title").id;
    const ok = await api(page, "setNativeValue", id, "hello");
    expect(ok).toBe(true);
    expect(await page.$eval("#x", (el) => (el as HTMLInputElement).value)).toBe("hello");
    expect(await page.evaluate(() => [(window as any).inputEvents, (window as any).changeEvents])).toEqual([1, 1]);
  });

  it("selectNativeOption picks by case-insensitive substring, or reports the options", async () => {
    const els = (await snapshot(page)).elements;
    const id = find(els, "combobox", "Size").id;
    const r = await api(page, "selectNativeOption", id, "tw");
    expect(r.ok).toBe(true);
    expect(r.value).toBe("Two");
    expect(await page.$eval("#s", (el) => (el as HTMLSelectElement).value)).toBe("Two");
    const miss = await api(page, "selectNativeOption", id, "Four");
    expect(miss).toEqual({ ok: false, options: ["One", "Two"] });
  });

  it("hasText searches visible text case-insensitively, optionally inside a scope", async () => {
    expect(await api(page, "hasText", "edit ME")).toBe(true);
    expect(await api(page, "hasText", "nothere")).toBe(false);
    expect(await api(page, "hasText", "Alpha", "Size")).toBe(false);
  });

  it("mutationCount grows when the DOM changes", async () => {
    const before = await api<number>(page, "mutationCount");
    await page.evaluate(() => document.body.append(document.createElement("span")));
    await page.evaluate(() => Promise.resolve());
    expect(await api<number>(page, "mutationCount")).toBeGreaterThan(before);
  });

  it("focusAndSelectAll focuses a textarea and selects it", async () => {
    const els = (await snapshot(page)).elements;
    const id = find(els, "textbox", "Body").id;
    expect(await api(page, "focusAndSelectAll", id)).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("t");
    expect(await api(page, "focusAndSelectAll", 999999)).toBe(false);
  });

  it("openOptions lists visible options of a listbox with ids", async () => {
    const opts = await api<any[]>(page, "openOptions");
    expect(opts.map((o) => o.name)).toEqual(["Alpha", "Beta"]);
    expect(opts.every((o) => typeof o.id === "number")).toBe(true);
  });

  it("describe returns null for unknown ids", async () => {
    expect(await api(page, "describe", 999999)).toBeNull();
  });
});
