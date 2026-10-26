#!/usr/bin/env node
// MCP server (stdio). Tools: look, act, navigate, tabs, eval. See docs/api-draft.md.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { act } from "./core/act.js";
import { Session } from "./core/session.js";
import { View, withEvents, type ToolOutput } from "./core/view.js";
import type { Step } from "./types.js";

const session = new Session();
const view = new View(session);
const server = new McpServer({ name: "agent-click", version: "0.1.0" });

const imageMode = z.enum(["auto", "always", "never"]);

server.registerTool(
  "look",
  {
    description:
      "Current state of the active browser tab: header (url, scroll, loading state, open modal layer), then the visible " +
      "interactive elements and short meaningful texts grouped by context, each with a stable number [N]. The same numbers " +
      "are drawn on the screenshot. A screenshot is attached when the page changed significantly (image: \"auto\"); request " +
      "one with image: \"always\". Elements below/above the viewport are summarized; use full: true for all of them as text.",
    inputSchema: {
      scope: z.union([z.number(), z.string()]).optional().describe("Limit to a container: element number or text of a dialog/section/heading"),
      image: imageMode.optional(),
      full: z.boolean().optional().describe("All elements of the page, not just the viewport"),
    },
  },
  async ({ scope, image, full }) => run(() => view.look({ scope, image, full })),
);

const target = z.union([z.number(), z.string(), z.object({ text: z.string(), in: z.union([z.string(), z.number()]).optional() })]);

server.registerTool(
  "act",
  {
    description:
      "Perform steps in the browser in order, like a human (trusted mouse/keyboard input). After each step the tool waits " +
      "until the page settles and verifies the effect; it stops at the first step that fails or has no effect. The answer " +
      "lists each step, mutating network requests it caused (with the error body on 4xx/5xx), and what changed on the page.\n" +
      "A target is an element number from look ([17] → 17), its visible text/label (\"Next\"), or {text, in} to disambiguate " +
      "(in = dialog/section text or number). Ambiguous text is an error listing candidates — nothing is guessed.\n" +
      "Steps:\n" +
      "  {click: target} | {dblclick: target} | {hover: target}\n" +
      "  {fill: {\"14\": \"50\", \"Description\": \"text\"}} — replaces field values, reports if the page changed the value\n" +
      "  {select: [target, \"option text\"]} — native or custom dropdown/autocomplete\n" +
      "  {check: [target, true|false]} — checkbox/radio/switch\n" +
      "  {press: \"Enter\" | \"Control+A\" | \"Escape\" ...}\n" +
      "  {scroll: {to: \"top\"|\"bottom\"|pixels|target, in?: target}}\n" +
      "  {wait_for: {text?|gone?|url?}, timeout?: ms} — wait for a condition, never for a fixed time\n" +
      "  {expect: {text?, in?, url?}} — assert without acting; e.g. before confirming a delete, expect the dialog names the right object",
    inputSchema: {
      steps: z.array(z.record(z.string(), z.unknown())).min(1).describe("Steps, see description"),
      screenshot: z.union([imageMode, z.boolean()]).optional().describe("Attach a screenshot after the steps: auto (on big changes) / true / false"),
    },
  },
  async ({ steps, screenshot }) => run(() => act(session, view, steps as unknown as Step[], screenshot)),
);

server.registerTool(
  "navigate",
  {
    description:
      "Open a URL in the active tab (or \"back\" / \"forward\" / \"reload\"), wait for real content, and return the page state like look. " +
      "Reports redirects, and does not leave a page with unsaved changes silently.",
    inputSchema: {
      url: z.string().describe("Absolute URL, or back | forward | reload"),
      screenshot: z.union([imageMode, z.boolean()]).optional(),
    },
  },
  async ({ url, screenshot }) =>
    run(async () => {
      const { page } = await session.current();
      const opts = { waitUntil: "domcontentloaded" as const, timeout: 30_000 };
      if (url === "back") await page.goBack(opts);
      else if (url === "forward") await page.goForward(opts);
      else if (url === "reload") await page.reload(opts);
      else await page.goto(url, opts);
      const settle = await session.settle(15_000);
      const image = screenshot === true ? "always" : screenshot === false ? "never" : (screenshot ?? "auto");
      const out = await view.look({ image, settled: settle.settled });
      const finalUrl = page.url();
      const redirect = !["back", "forward", "reload"].includes(url) && stripSlash(finalUrl) !== stripSlash(url) ? `→ redirected to ${finalUrl}\n` : "";
      return { ...out, text: redirect + out.text };
    }),
);

server.registerTool(
  "tabs",
  {
    description: "List browser tabs, or switch to / open / close one. The agent acts in the active tab only.",
    inputSchema: {
      action: z.enum(["list", "switch", "new", "close"]).default("list"),
      index: z.number().optional().describe("Tab number from the list (switch/close)"),
      url: z.string().optional().describe("URL for new"),
    },
  },
  async ({ action, index, url }) =>
    run(async () => {
      const current = (await session.current()).page;
      const pages = await session.pages();
      const pick = () => {
        const p = index !== undefined ? pages[index - 1] : undefined;
        if (!p) throw new Error(`no tab ${index}; there are ${pages.length}`);
        return p;
      };
      if (action === "switch") {
        const p = pick();
        await p.bringToFront();
        await session.attach(p);
        view.reset();
        return view.look();
      }
      if (action === "new") {
        const browser = current.browser();
        const p = await browser.newPage();
        if (url) await p.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await session.attach(p);
        view.reset();
        await session.settle(15_000);
        return view.look();
      }
      if (action === "close") {
        const p = pick();
        if (p === current) throw new Error("cannot close the active tab; switch first");
        await p.close();
      }
      const list = (await session.pages()).map((p, i) => `${i + 1}${p === current ? " *" : ""} ${p.url()}`);
      return { text: withEvents(list.join("\n"), session) };
    }),
);

server.registerTool(
  "eval",
  {
    description:
      "LAST RESORT: run JavaScript in the active tab and return the JSON result. Use only when look/act/navigate cannot do " +
      "the job (e.g. diagnosing why something is invisible). The expression may be async.",
    inputSchema: { js: z.string().describe("Expression or async IIFE") },
  },
  async ({ js }) =>
    run(async () => {
      const { page } = await session.current();
      const value = await page.evaluate(`(async () => { return (${js}); })()`);
      const text = JSON.stringify(value, null, 1) ?? "undefined";
      return { text: text.length > 5000 ? `${text.slice(0, 5000)}… (${text.length} chars)` : text };
    }),
);

function stripSlash(u: string): string {
  return u.replace(/\/$/, "");
}

async function run(fn: () => Promise<ToolOutput>) {
  try {
    const out = await fn();
    const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [{ type: "text", text: out.text }];
    if (out.image) content.push({ type: "image", data: out.image.toString("base64"), mimeType: "image/jpeg" });
    return { content };
  } catch (e) {
    return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
  }
}

await server.connect(new StdioServerTransport());
