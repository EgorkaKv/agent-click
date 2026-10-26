import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "puppeteer-core";
import { launchTestBrowser } from "../helpers/browser.js";
import { find, openPage, snapshot } from "./helpers.js";

describe("context paths", () => {
  let browser: Browser;
  let close: () => Promise<void>;
  let page: Page;
  let els: any[];

  beforeAll(async () => {
    ({ browser, close } = await launchTestBrowser());
    page = await openPage(browser, "page-context.html");
    els = (await snapshot(page, { full: true })).elements;
  }, 60_000);

  afterAll(async () => {
    await close();
  });

  it("uses a named section label", () => {
    expect(find(els, "button", "Run build").context).toEqual(["main", 'section "Build"']);
  });

  it("falls back to the nearest preceding heading when there is no section label", () => {
    expect(find(els, "button", "Create version").context).toEqual(["main", 'section "Versions"']);
  });

  it("uses fieldset legends as groups", () => {
    expect(find(els, "textbox", "Contact first name").context).toEqual(["main", 'group "Contacts"']);
  });

  it("labels table rows by their first cell", () => {
    const edit = find(els, "button", "Edit");
    expect(edit.context).toEqual(["main", 'row "Campaign A"', 'section "Versions"']);
  });

  it("labels named forms and landmarks", () => {
    expect(find(els, "button", "Apply").context).toEqual(["main", 'form "Filters"']);
    expect(find(els, "link", "Terms").context).toEqual(["footer"]);
    expect(find(els, "link", "Home").context).toEqual(["header", 'nav "Main"']);
  });

  it("keeps at most 3 entries: the outermost and the two innermost", () => {
    expect(find(els, "button", "Deep").context).toEqual(["main", 'group "Mid"', 'section "Inner"']);
  });
});
