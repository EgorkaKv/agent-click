import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "puppeteer-core";
import { launchTestBrowser } from "../helpers/browser.js";
import { find, openPage, snapshot } from "./helpers.js";

describe("messages and occluder description", () => {
  let browser: Browser;
  let close: () => Promise<void>;
  let page: Page;

  beforeAll(async () => {
    ({ browser, close } = await launchTestBrowser());
    page = await openPage(browser, "page-noise.html");
  }, 60_000);

  afterAll(async () => {
    await close();
  });

  it("skips a long live region but keeps a short toast", async () => {
    const snap = await snapshot(page);
    expect(snap.messages).toContain("Changes saved");
    expect(snap.messages.some((m: string) => m.startsWith("Model answer"))).toBe(false);
  });

  it("reports a toast nested in a live region once", async () => {
    const snap = await snapshot(page);
    expect(snap.messages.filter((m: string) => m === "Saved draft")).toHaveLength(1);
  });

  it("describes a button under a fixed panel by the panel, not by main", async () => {
    const snap = await snapshot(page);
    const send = find(snap.elements, "button", "Send");
    expect(send.occludedBy).toContain("Введите запрос для Gemini");
    expect(send.occludedBy).toContain("(fixed)");
  });
});
