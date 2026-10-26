import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "puppeteer-core";
import { launchTestBrowser } from "../helpers/browser.js";
import { find, openPage, snapshot } from "./helpers.js";

describe("what is collected", () => {
  let browser: Browser;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ browser, close } = await launchTestBrowser());
  }, 60_000);

  afterAll(async () => {
    await close();
  });

  it("collects cursor:pointer divs as clickable, drops wrappers whose only control is inside", async () => {
    const page: Page = await openPage(browser, "page-pointer.html");
    const els = (await snapshot(page, { full: true })).elements;
    const card = find(els, "clickable", "Open report");
    expect(card).toMatchObject({ kind: "interactive" });
    expect(find(els, "clickable", "Real button")).toBeUndefined();
    expect(find(els, "button", "Real button")).toBeDefined();
    expect(find(els, "clickable", "Inner")).toBeDefined();
    await page.close();
  });

  it("does not collect a label of a control, but names the control with it", async () => {
    const page: Page = await openPage(browser, "page-pointer.html");
    const els = (await snapshot(page, { full: true })).elements;
    expect(els.filter((e: any) => e.name === "Remember me" && e.role === "clickable")).toHaveLength(0);
    expect(find(els, "checkbox", "Remember me")).toBeDefined();
    await page.close();
  });

  it("finds elements inside open shadow roots with top-level rects", async () => {
    const page: Page = await openPage(browser, "page-shadow.html");
    const els = (await snapshot(page, { full: true })).elements;
    const btn = find(els, "button", "Shadow button");
    expect(btn).toBeDefined();
    const expected = await page.evaluate(() => {
      const r = (document.querySelector("my-widget")!.shadowRoot!.querySelector("button") as HTMLElement).getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    });
    expect(btn.rect).toEqual(expected);
  });

  it("finds elements in same-origin iframes with offsets to top-level coordinates", async () => {
    const page: Page = await openPage(browser, "page-shadow.html");
    const els = (await snapshot(page, { full: true })).elements;
    const btn = find(els, "button", "Inside frame");
    expect(btn).toBeDefined();
    const expected = await page.evaluate(() => {
      const f = document.getElementById("f") as HTMLIFrameElement;
      const fr = f.getBoundingClientRect();
      // 5px border + 10px padding on each side of the frame content box
      const br = (f.contentDocument!.querySelector("button") as HTMLElement).getBoundingClientRect();
      return {
        x: Math.round(fr.left + 15 + br.left),
        y: Math.round(fr.top + 15 + br.top),
        w: Math.round(br.width),
        h: Math.round(br.height),
      };
    });
    expect(btn.rect).toEqual(expected);
    expect(btn.inViewport).toBe(true);
  });

  it("returns nothing from visually hidden or aria-hidden subtrees", async () => {
    const page: Page = await openPage(browser, "page-form.html");
    await page.evaluate(() => {
      const d = document.createElement("div");
      d.setAttribute("aria-hidden", "true");
      d.innerHTML = "<button>Ghost</button>";
      document.body.append(d);
      const h = document.createElement("button");
      h.style.display = "none";
      h.textContent = "Hidden";
      document.body.append(h);
    });
    const els = (await snapshot(page, { full: true })).elements;
    expect(find(els, "button", "Ghost")).toBeUndefined();
    expect(find(els, "button", "Hidden")).toBeUndefined();
    await page.close();
  });
});
