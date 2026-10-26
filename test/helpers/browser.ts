// Test harness: launches a separate headless Brave with a throwaway profile.
// Never touches the user's real profile. Override the binary with AGENT_CLICK_TEST_BROWSER.
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const DEFAULT_BROWSER = "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe";

export const FIXTURES = resolve(import.meta.dirname, "../fixtures");
export const PAGE_SCRIPT = resolve(import.meta.dirname, "../../dist/page.js");

export async function launchTestBrowser(): Promise<{ browser: Browser; close: () => Promise<void> }> {
  const userDataDir = mkdtempSync(join(tmpdir(), "agent-click-test-"));
  const browser = await puppeteer.launch({
    executablePath: process.env.AGENT_CLICK_TEST_BROWSER ?? DEFAULT_BROWSER,
    headless: true,
    userDataDir,
    defaultViewport: { width: 1280, height: 800 },
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  return {
    browser,
    close: async () => {
      await browser.close();
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

/** Open a fixture file (test/fixtures/<name>) in a new page and inject dist/page.js. */
export async function openFixture(browser: Browser, name: string): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(join(FIXTURES, name)).href);
  await page.evaluate(readFileSync(PAGE_SCRIPT, "utf8"));
  return page;
}
