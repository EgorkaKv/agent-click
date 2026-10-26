import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "puppeteer-core";
import { launchTestBrowser } from "../helpers/browser.js";
import { openPage, snapshot } from "./helpers.js";

describe("modal layer", () => {
  let browser: Browser;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ browser, close } = await launchTestBrowser());
  }, 60_000);

  afterAll(async () => {
    await close();
  });

  it("returns the whole page when no modal is open, then restricts to the open dialog", async () => {
    const page: Page = await openPage(browser, "page-modal.html");
    const before = await snapshot(page);
    expect(before.layer).toBeUndefined();
    const beforeNames = before.elements.map((e: any) => `${e.role}:${e.name}`);
    expect(beforeNames).toContain("button:Open dialog");
    expect(beforeNames).toContain("button:Behind button");

    await page.click("#open");
    const snap = await snapshot(page);
    expect(snap.layer).toBe('dialog "Add phase"');
    const names = snap.elements.map((e: any) => `${e.role}:${e.name}`);
    expect(names).toContain("textbox:Phase name");
    expect(names).toContain("button:Save");
    expect(names).toContain("button:Cancel");
    expect(names).toContain("heading:Add phase");
    expect(names).not.toContain("button:Open dialog");
    expect(names).not.toContain("button:Behind button");
    expect(names).not.toContain("heading:Page heading");
    for (const e of snap.elements) expect(e.context[0]).toBe('dialog "Add phase"');
    await page.close();
  });
});
