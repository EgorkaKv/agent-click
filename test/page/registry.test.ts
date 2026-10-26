import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "puppeteer-core";
import { launchTestBrowser } from "../helpers/browser.js";
import { api, find, inject, openHtml, snapshot } from "./helpers.js";

const HTML = `<!doctype html><html><body><main>
  <button id="a">Next</button><button id="b">Back</button>
</main></body></html>`;

describe("stable ids", () => {
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

  it("keeps the id of an element replaced by an identical node", async () => {
    const before = find((await snapshot(page)).elements, "button", "Next");
    await page.evaluate(() => {
      const old = document.getElementById("a")!;
      const clone = old.cloneNode(true) as HTMLElement;
      clone.id = "a2";
      old.replaceWith(clone);
    });
    const after = find((await snapshot(page)).elements, "button", "Next");
    expect(after.id).toBe(before.id);
  });

  it("keeps ids stable when the page script is injected again", async () => {
    const before = (await snapshot(page)).elements.map((e: any) => e.id);
    await inject(page);
    const after = (await snapshot(page)).elements.map((e: any) => e.id);
    expect(after).toEqual(before);
  });

  it("gives a new id to a different element and never reuses a retired id", async () => {
    const snap1 = await snapshot(page);
    const back = find(snap1.elements, "button", "Back");
    const maxBefore = Math.max(...snap1.elements.map((e: any) => e.id));

    await page.evaluate(() => {
      const b = document.createElement("button");
      b.id = "finish";
      b.textContent = "Finish";
      document.querySelector("main")!.append(b);
    });
    const finish = find((await snapshot(page)).elements, "button", "Finish");
    expect(finish.id).toBeGreaterThan(maxBefore);

    await page.evaluate(() => document.getElementById("finish")!.remove());
    await page.evaluate(() => {
      const b = document.createElement("button");
      b.textContent = "Other";
      document.querySelector("main")!.append(b);
    });
    const other = find((await snapshot(page)).elements, "button", "Other");
    expect(other.id).not.toBe(finish.id);
    expect(other.id).toBeGreaterThan(finish.id);
    expect(find((await snapshot(page)).elements, "button", "Back").id).toBe(back.id);
  });

  it("resolves an id whose element was re-rendered, via describe and locate", async () => {
    const back = find((await snapshot(page)).elements, "button", "Back");
    await page.evaluate(() => {
      const old = [...document.querySelectorAll("button")].find((b) => b.textContent === "Back")!;
      const fresh = document.createElement("button");
      fresh.textContent = "Back";
      old.replaceWith(fresh);
    });
    const info = await api(page, "describe", back.id);
    expect(info).toMatchObject({ id: back.id, name: "Back" });
    const loc = await api(page, "locate", back.id);
    expect(loc.ok).toBe(true);
    expect(loc.id).toBe(back.id);
  });

  it("reports stale for ids whose element is gone", async () => {
    const other = find((await snapshot(page)).elements, "button", "Other");
    await page.evaluate(() => {
      [...document.querySelectorAll("button")].find((b) => b.textContent === "Other")!.remove();
    });
    expect(await api(page, "describe", other.id)).toBeNull();
    expect(await api(page, "locate", other.id)).toMatchObject({ ok: false, error: "stale" });
  });
});
