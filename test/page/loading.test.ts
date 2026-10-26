import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "puppeteer-core";
import { launchTestBrowser } from "../helpers/browser.js";
import { api, openPage, snapshot } from "./helpers.js";

describe("loading()", () => {
  let browser: Browser;
  let close: () => Promise<void>;
  let page: Page;

  beforeAll(async () => {
    ({ browser, close } = await launchTestBrowser());
    page = await openPage(browser, "page-loading.html");
  }, 60_000);

  afterAll(async () => {
    await close();
  });

  it("counts a visible spinner, ignores a persistent wrapper and aria-hidden spinners", async () => {
    const r = await api(page, "loading");
    expect(r).toEqual({ busy: true, reasons: ["spinner in page"] });
  });

  it("is not busy once the spinner is gone, even with the wrapper present", async () => {
    await page.evaluate(() => document.getElementById("spin")!.remove());
    expect(await api(page, "loading")).toEqual({ busy: false, reasons: [] });
  });

  it("snapshot().loading matches loading()", async () => {
    expect((await snapshot(page)).loading).toEqual(await api(page, "loading"));
  });
});
