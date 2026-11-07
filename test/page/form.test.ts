import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "puppeteer-core";
import { launchTestBrowser } from "../helpers/browser.js";
import { find, openPage, snapshot } from "./helpers.js";

describe("basic form", () => {
  let browser: Browser;
  let close: () => Promise<void>;
  let page: Page;
  let els: any[];

  beforeAll(async () => {
    ({ browser, close } = await launchTestBrowser());
    page = await openPage(browser, "page-form.html");
    els = (await snapshot(page, { full: true })).elements;
  }, 60_000);

  afterAll(async () => {
    await close();
  });

  it("names controls from their labels and reports values and placeholders", () => {
    const first = find(els, "textbox", "First name");
    expect(first).toMatchObject({ kind: "interactive", value: "Ivan", placeholder: "Jane" });
    expect(first.rect.w).toBeGreaterThan(0);
    expect(find(els, "textbox", "Notes").value).toBe("Hello there");
  });

  it("masks password values", () => {
    const pw = find(els, "textbox", "Password");
    expect(pw.value).toBe("••••");
    expect(JSON.stringify(els)).not.toContain("secret123");
  });

  it("reports error, invalid and required states from aria attributes", () => {
    const email = find(els, "textbox", "Email");
    expect(email.error).toBe("Enter a valid email");
    expect(email.state).toEqual({ invalid: true, required: true });
  });

  it("takes an invalid field's message from red text next to it when there is no aria link (Meta)", () => {
    expect(find(els, "textbox", "Daily budget").error).toBe("Budget must be at least $1.00");
  });

  it("reports checked, disabled and selected states, omitting false keys", () => {
    expect(find(els, "checkbox", "Subscribe").state.checked).toBe(true);
    expect(find(els, "checkbox", "Subscribe")).not.toHaveProperty("value");
    expect(find(els, "checkbox", "Locked option").state.disabled).toBe(true);
    expect(find(els, "radio", "Basic").state.checked).toBe(true);
    expect(find(els, "radio", "Pro").state).toEqual({});
    expect(find(els, "button", "More").state.expanded).toBeUndefined();
    expect(find(els, "button", "Submit later").state.disabled).toBe(true);
  });

  it("reports the selected option and option count of a native select", () => {
    const country = find(els, "combobox", "Country");
    expect(country.value).toBe("Germany");
    expect(country.optionsCount).toBe(3);
  });

  it("collects headings with level and short badges as text", () => {
    expect(find(els, "heading", "Create contact")).toMatchObject({ kind: "text", level: 1 });
    expect(find(els, "status", "Active")).toMatchObject({ kind: "text" });
  });
});
