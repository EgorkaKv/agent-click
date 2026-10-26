// Shared helpers for the in-page tests: open a page, inject dist/page.js, call PageApi.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser, Page } from "puppeteer-core";
import { FIXTURES, PAGE_SCRIPT } from "../helpers/browser.js";

export function injectSource(): string {
  return readFileSync(PAGE_SCRIPT, "utf8");
}

/** Inject dist/page.js into a page (may be called many times). */
export async function inject(page: Page): Promise<void> {
  await page.evaluate(injectSource());
}

export async function openHtml(browser: Browser, html: string): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 700 });
  await page.setContent(html, { waitUntil: "load" });
  await inject(page);
  return page;
}

/** Opens test/fixtures/<name> at 1000x700 and injects the page script. */
export async function openPage(browser: Browser, fixture: string): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 700 });
  await page.goto(pathToFileURL(join(FIXTURES, fixture)).href, { waitUntil: "load" });
  await inject(page);
  return page;
}

/** Calls window.__agentClick[method](...args) in the page. */
export function api<T = any>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    (m: string, a: unknown[]) => {
      const w = window as any;
      return w.__agentClick[m](...a);
    },
    method,
    args,
  ) as Promise<T>;
}

export function snapshot(page: Page, opts?: Record<string, unknown>): Promise<any> {
  return api(page, "snapshot", opts ?? {});
}

/** Finds the first element of a snapshot list by role and name. */
export function find(list: any[], role: string, name: string): any {
  return list.find((e) => e.role === role && e.name === name);
}
