#!/usr/bin/env node
// MCP server (stdio). Tools: look, act, find, read, navigate, tabs, eval. See docs/api-draft.md.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { act } from "./core/act.js";
import { findIn } from "./core/find.js";
import { Session } from "./core/session.js";
import { phase, traced } from "./core/trace.js";
import { View, withEvents, type ToolOutput } from "./core/view.js";
import type { Step } from "./types.js";

const session = new Session();
const view = new View(session);
const server = new McpServer({ name: "agent-click", version: "0.1.0" });

const imageMode = z.enum(["auto", "always", "never"]);
/** find scans the whole page; Ads Manager has ~1000 elements on a busy screen. */
const FIND_SCAN_MAX = 3000;

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
  async ({ scope, image, full }) => run("look", { scope, image, full }, () => view.look({ scope, image, full })),
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
      "  {fill: {\"14\": \"50\", \"Description\": \"text\"}} — replaces field values, reports if the page changed the value; " +
      "a search/autocomplete field is typed key by key and keeps focus, so its suggestions stay open\n" +
      "  {select: [target, \"option text\"]} — native or custom dropdown/autocomplete\n" +
      "  {check: [target, true|false]} — checkbox/radio/switch\n" +
      "  {press: \"Enter\" | \"Control+A\" | \"Escape\" ...}\n" +
      "  {scroll: {to: \"top\"|\"bottom\"|pixels|target, in?: target}} — pixels scroll BY that amount (negative = up); in = an element inside the list to scroll\n" +
      "  {wait_for: {text?|gone?|url?}, timeout?: ms} — wait for a condition, never for a fixed time\n" +
      "  {expect: {text?, in?, url?}} — assert without acting; e.g. before confirming a delete, expect the dialog names the right object",
    inputSchema: {
      steps: z.array(z.record(z.string(), z.unknown())).min(1).describe("Steps, see description"),
      screenshot: z.union([imageMode, z.boolean()]).optional().describe("Attach a screenshot after the steps: auto (on big changes) / true / false"),
    },
  },
  async ({ steps, screenshot }) => run("act", steps, () => act(session, view, steps as unknown as Step[], screenshot)),
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
    run("navigate", url, async () => {
      const { page } = await session.current();
      const opts = { waitUntil: "domcontentloaded" as const, timeout: 30_000 };
      await phase("goto", async () => {
        if (url === "back") await page.goBack(opts);
        else if (url === "forward") await page.goForward(opts);
        else if (url === "reload") await page.reload(opts);
        else await page.goto(url, opts);
      });
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
      match: z.string().optional().describe("Instead of index: part of the tab's URL or title (switch/close)"),
      url: z.string().optional().describe("URL for new"),
    },
  },
  async ({ action, index, match, url }) =>
    run("tabs", { action, index, match, url }, async () => {
      const current = (await session.current()).page;
      const pages = await session.pages();
      const pick = async () => {
        if (match !== undefined) {
          const q = match.toLowerCase();
          const titles = await Promise.all(pages.map((p) => p.title().catch(() => "")));
          const hits = pages.filter((p, i) => p.url().toLowerCase().includes(q) || titles[i].toLowerCase().includes(q));
          if (hits.length === 1) return hits[0];
          const list = hits.map((p) => `  ${pages.indexOf(p) + 1} ${p.url()}`).join("\n");
          throw new Error(hits.length ? `"${match}" matches ${hits.length} tabs, use index:\n${list}` : `no tab matches "${match}"`);
        }
        const p = index !== undefined ? pages[index - 1] : undefined;
        if (!p) throw new Error(`no tab ${index}; there are ${pages.length}`);
        return p;
      };
      if (action === "switch") {
        const p = await pick();
        await p.bringToFront();
        await session.attach(p);
        view.reset();
        return view.look();
      }
      if (action === "new") {
        const browser = current.browser();
        const p = await browser.newPage();
        session.forgetNewTabs();
        if (url) await p.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await session.attach(p);
        view.reset();
        await session.settle(15_000);
        return view.look();
      }
      if (action === "close") {
        const p = await pick();
        if (p === current) throw new Error("cannot close the active tab; switch first");
        await p.close();
      }
      const all = await session.pages();
      const titles = await Promise.all(all.map((p) => p.title().catch(() => "")));
      const list = all.map((p, i) => `${i + 1}${p === current ? " *" : ""} ${p.url()}${titles[i] ? ` — ${titles[i].slice(0, 60)}` : ""}`);
      return { text: withEvents(list.join("\n"), session) };
    }),
);

server.registerTool(
  "read",
  {
    description:
      "Read the text of the page or a part of it: headings, paragraphs, lists, tables as | a | b | rows, form values as " +
      "[label: value], checkboxes as ☑/☐. Use it to read content (a table, a settings page, a message) instead of eval. " +
      "Default scope: the open dialog, else main, else the whole page.",
    inputSchema: {
      scope: z.union([z.number(), z.string()]).optional().describe("Element number, dialog/section/heading text, or landmark (main, nav, ...)"),
    },
  },
  async ({ scope }) =>
    run("read", { scope }, async () => {
      const { text, truncated } = await session.call("read", scope);
      return { text: (text || "(no text)") + (truncated ? "\n… (truncated; narrow the scope)" : "") };
    }),
);

server.registerTool(
  "find",
  {
    description:
      "Find elements by words instead of reading the whole page: returns the few matching elements with their numbers, " +
      "values, states and context, also those above/below the view. Searches names, values, placeholders. Use it to locate " +
      "or check something specific (\"budget\", \"Сохранить\", a field's value). Not needed before acting: act accepts text targets.",
    inputSchema: {
      query: z.string().describe("Words that should appear in the element's name or value; all must match, case-insensitive"),
      role: z.string().optional().describe("Only these roles, e.g. \"textbox\" or \"button|link\""),
      in: z.union([z.number(), z.string()]).optional().describe("Limit to a container: element number or dialog/section/heading text"),
    },
  },
  async ({ query, role, in: scope }) =>
    run("find", { query, role, in: scope }, async () => {
      const snap = await session.call("snapshot", { full: true, scope, maxElements: FIND_SCAN_MAX });
      const { text, count } = findIn(snap, query, { role, in: scope });
      const notes: string[] = [];
      if (snap.layer) notes.push(`(searched inside ${snap.layer} only: it covers the page)`);
      if (snap.truncated) notes.push(`(the page has more than ${FIND_SCAN_MAX} elements; narrow with in)`);
      if (!count && (await session.call("hasText", query, scope))) {
        notes.push("The text is on the page, but not as a control or short text: use read to see it in context.");
      }
      return { text: withEvents([text, ...notes].join("\n"), session) };
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
    run("eval", js, async () => {
      const { page } = await session.current();
      const value = await phase("evaluate", () => page.evaluate(`(async () => { return (${js}); })()`));
      const text = JSON.stringify(value, null, 1) ?? "undefined";
      return { text: text.length > 5000 ? `${text.slice(0, 5000)}… (${text.length} chars)` : text };
    }),
);

function stripSlash(u: string): string {
  return u.replace(/\/$/, "");
}

async function run(tool: string, args: unknown, fn: () => Promise<ToolOutput>) {
  try {
    const out = await traced(tool, args, fn);
    const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [{ type: "text", text: out.text }];
    if (out.image) content.push({ type: "image", data: out.image.toString("base64"), mimeType: "image/jpeg" });
    return { content };
  } catch (e) {
    return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
  }
}

await server.connect(new StdioServerTransport());
