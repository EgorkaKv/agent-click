import { describe, it, expect } from "vitest";
import { launchTestBrowser } from "./helpers/browser.js";

describe("test harness", () => {
  it("launches headless Brave", async () => {
    const { browser, close } = await launchTestBrowser();
    const page = await browser.newPage();
    await page.setContent("<button>Hi</button>");
    expect(await page.$eval("button", (b) => b.textContent)).toBe("Hi");
    await close();
  });
});
