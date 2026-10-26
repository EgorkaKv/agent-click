import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { Browser, Page } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { act } from "../../src/core/act.js";
import { Session } from "../../src/core/session.js";
import { View } from "../../src/core/view.js";
import type { Step } from "../../src/types.js";
import { FIXTURES, launchTestBrowser } from "../helpers/browser.js";

let server: Server;
let browser: Browser;
let close: () => Promise<void>;
let session: Session;
let view: View;
let page: Page;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/publish") {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "The name 'Flowr' is already being used" }));
    } else if (req.method === "POST") {
      res.end("{}");
    } else {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(readFileSync(join(FIXTURES, "act.html")));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  ({ browser, close } = await launchTestBrowser());
  page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
  session = new Session(async () => browser);
  await session.pages();
  await session.attach(page);
  view = new View(session);
  await view.look({ image: "never" });
});

afterAll(async () => {
  await close();
  server.close();
});

// SHOW=1 prints what the agent would receive.
const run = async (...steps: Step[]) => {
  const { text } = await act(session, view, steps, false);
  if (process.env.SHOW) console.log(`--- ${JSON.stringify(steps)}
${text}`);
  return text;
};

describe("act", () => {
  it("fill reports the value the page reformatted on blur", async () => {
    const out = await run({ fill: { "Daily budget": "50", Name: "Spring" } });
    // Same amount, only formatted: the real value is shown, but it is not a warning.
    expect(out).toContain('"Daily budget" = "50.00"');
    expect(out).not.toContain("⚠");
    expect(out).toContain('"Name" = "Spring"');
  });

  it("selects in native and custom dropdowns, checks a checkbox", async () => {
    const out = await run({ select: ["Currency", "EUR"] }, { select: ["Country", "Germany"] }, { check: ["Agree", true] });
    expect(out).not.toContain("✗");
    expect(out).toContain('= "EUR"');
    expect(out).toContain('= "Germany"');
  });

  it("select: ambiguous option is an error, virtualized list is scrolled, key-only autocomplete gets keys", async () => {
    const amb = await run({ select: ["Country", "an"] });
    expect(amb).toMatch(/ambiguous option "an"/);
    const out = await run({ select: ["Age", "35"] }, { select: ["City", "Warsaw"] }, { expect: { text: "Budget" } });
    expect(out).not.toContain("✗");
    expect(out).toContain('= "35"');
    expect(out).toContain('= "Warsaw"');
  });

  it("a click with no effect stops the batch", async () => {
    const out = await run({ click: "Nothing" }, { click: "Open dialog" });
    expect(out).toContain("no visible change");
    expect(out).toContain("stopped: 0 of 2 done");
  });

  it("reports an opened dialog and expect checks its text", async () => {
    const out = await run({ click: "Open dialog" }, { expect: { text: "Spring sale", in: "Confirm" } }, { click: "Cancel" });
    expect(out).toContain('opened dialog "Confirm"');
    expect(out).not.toContain("✗");
  });

  it("shows mutating requests, and a 409 with its body fails the step", async () => {
    const out = await run({ click: "Save draft" }, { click: "Publish" });
    expect(out).toMatch(/POST \/save → 200/);
    expect(out).toMatch(/✗ click .*Publish[\s\S]*POST \/publish → 409 .*already being used/);
  });

  it("a failed request to another site does not fail the step", async () => {
    const out = await run({ click: "Sync partner" });
    expect(out).toMatch(/✓ click .*Sync partner/);
    expect(out).toContain("third-party, ignored");
  });

  it("scrolls an inner container and verifies that something moved", async () => {
    // The document is shorter than the viewport, so "bottom" goes to the largest scroll container.
    const out = await run({ scroll: { to: "bottom" } }, { scroll: { to: "Load more" } }, { scroll: { to: "top", in: "Load more" } }, { scroll: { to: "Load more" } });
    expect(out).not.toContain("✗");
    expect(out).toContain("(already in view)");
  });

  it("a link opening a new tab (noopener) switches to it and stops the batch", async () => {
    const out = await run({ click: "Open report" }, { click: "Nothing" });
    expect(out).toContain("opened a new tab");
    expect(out).toContain("stopped: 1 of 2 done");
    expect(out).toContain("Now in the new tab");
    expect(out).toContain("/report");
    await session.attach(page);
    view.reset();
    await view.look({ image: "never" });
  });

  it("unknown text is an error, nothing is clicked", async () => {
    const out = await run({ click: "Delete campaign" });
    expect(out).toContain("✗ click");
    expect(out).toContain("not_found");
  });
});

describe("read", () => {
  it("returns tables as rows, field values and hidden text left out", async () => {
    const { text } = await session.call("read");
    if (process.env.SHOW) console.log(text);
    expect(text).toContain("| rc_trial | fb_mobile_purchase |");
    expect(text).toContain("Name [Spring]");
    expect(text).not.toContain("Delete campaign"); // closed dialog
  });
});

