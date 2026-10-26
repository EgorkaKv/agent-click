import { describe, it, expect } from "vitest";
import { formatSnapshot } from "../../src/render/format.js";
import type { ElementInfo, Snapshot } from "../../src/types.js";

function el(over: Partial<ElementInfo> & Pick<ElementInfo, "id" | "role">): ElementInfo {
  return {
    kind: "interactive",
    name: "",
    state: {},
    rect: { x: 0, y: 0, w: 10, h: 10 },
    inViewport: true,
    context: [],
    ...over,
  };
}

function snap(over: Partial<Snapshot>): Snapshot {
  return {
    url: "https://example.com/",
    title: "Example",
    viewport: { w: 1280, h: 800 },
    scroll: { x: 0, y: 0, maxY: 2400 },
    loading: { busy: false, reasons: [] },
    elements: [],
    offscreen: [],
    messages: [],
    ...over,
  };
}

const DIALOG = 'dialog "Add phase"';

const dialogSnapshot = snap({
  url: "https://appstoreconnect.apple.com/apps/123/distribution?ref=abc",
  title: "App Store Connect — Flowr",
  layer: DIALOG,
  loading: { busy: true, reasons: ['spinner in section "Build"'] },
  elements: [
    el({
      id: 40,
      role: "combobox",
      name: "Type",
      value: "",
      error: "Select an option",
      context: [DIALOG],
    }),
    el({ id: 41, role: "textbox", name: "Duration", value: "3", context: [DIALOG] }),
    el({
      id: 42,
      role: "combobox",
      name: "Unit",
      value: "Months",
      optionsCount: 12,
      context: [DIALOG],
    }),
    el({ id: 43, role: "button", name: "Apply", state: { disabled: true }, context: [DIALOG] }),
    el({ id: 44, role: "button", name: "Cancel", context: [DIALOG] }),
  ],
  messages: ["Your changes have been saved"],
});

const DIALOG_EXPECTED = [
  "Page: App Store Connect — Flowr · appstoreconnect.apple.com/apps/123/distribution",
  'Viewport 1280×800 · scroll 0/2400 · ⏳ loading (2 requests, spinner in section "Build")',
  'Layer: dialog "Add phase" (page below is blocked)',
  "",
  '[dialog "Add phase"]',
  '  [40] combobox "Type" = "" ⚠ "Select an option"',
  '  [41] textbox "Duration" = "3"',
  '  [42] combobox "Unit" = "Months" (12 options)',
  '  [43] button "Apply" (disabled)',
  '  [44] button "Cancel"',
  'Messages: "Your changes have been saved"',
].join("\n");

const pageSnapshot = snap({
  url: "https://adsmanager.facebook.com/adsmanager/manage/campaigns",
  title: "Ads Manager",
  elements: [
    el({ id: 3, role: "combobox", name: "Ad account", value: "Rostemo (act_1234…)", context: ["header"] }),
    el({ id: 30, role: "tab", name: "Description", state: { selected: true }, context: ["main", "tablist"] }),
    el({ id: 31, role: "tab", name: "Media", hiddenCount: 12, context: ["main", "tablist"] }),
    el({ id: 50, role: "heading", name: "Contact", level: 2, context: ['main', 'section "Review info"', 'group "Contact"'] }),
    el({
      id: 51,
      role: "textbox",
      name: "First name",
      value: "Yehor",
      hint: "id contactFirstName",
      context: ['main', 'section "Review info"', 'group "Contact"'],
    }),
    el({
      id: 52,
      role: "textbox",
      name: "Phone",
      value: "",
      placeholder: "+48…",
      context: ['main', 'section "Review info"', 'group "Contact"'],
    }),
    el({ id: 53, role: "checkbox", name: "Agree", state: { checked: true }, context: ['main', 'section "Review info"', 'group "Contact"'] }),
    el({ id: 54, role: "text", name: "FAILED", kind: "text", context: ['main', 'section "Review info"', 'group "Contact"'] }),
    el({
      id: 60,
      role: "button",
      name: "Save",
      state: { disabled: true },
      occludedBy: "footer (sticky)",
      context: ["main", "footer"],
    }),
  ],
  offscreen: [
    { direction: "below", context: 'section "Version"', count: 8 },
    { direction: "below", context: 'section "Build"', count: 3 },
  ],
});

const PAGE_EXPECTED = [
  "Page: Ads Manager · adsmanager.facebook.com/adsmanager/manage/campaigns",
  "Viewport 1280×800 · scroll 0/2400 · ✓ settled",
  "",
  "[header]",
  '  [3] combobox "Ad account" = "Rostemo (act_1234…)"',
  "[main › tablist]",
  '  [30] tab "Description" (selected)',
  '  [31] tab "Media" (12 inside)',
  '[main › section "Review info" › group "Contact"]',
  '  [50] heading(2) "Contact"',
  '  [51] textbox "First name" = "Yehor" (id contactFirstName)',
  '  [52] textbox "Phone" = "" placeholder "+48…"',
  '  [53] checkbox "Agree" ☑',
  '  [54] text "FAILED"',
  "[main › footer]",
  '  [60] button "Save" (disabled, occluded by footer (sticky))',
  '↓ below: section "Version" (8), section "Build" (3)',
].join("\n");

describe("formatSnapshot", () => {
  it("reproduces the dialog example from the spec", () => {
    expect(formatSnapshot(dialogSnapshot, { pendingRequests: 2 })).toBe(DIALOG_EXPECTED);
  });

  it("reproduces the page example from the spec", () => {
    expect(formatSnapshot(pageSnapshot)).toBe(PAGE_EXPECTED);
  });

  it("counts pending requests in the loading line and treats them as loading", () => {
    const s = snap({ loading: { busy: false, reasons: [] } });
    const out = formatSnapshot(s, { pendingRequests: 3 });
    expect(out.split("\n")[1]).toBe("Viewport 1280×800 · scroll 0/2400 · ⏳ loading (3 requests)");
  });

  it("shows settled when nothing is busy and no requests are pending", () => {
    const out = formatSnapshot(snap({ loading: { busy: false, reasons: ["ignored"] } }), { pendingRequests: 0 });
    expect(out.split("\n")[1]).toContain("✓ settled");
  });

  it("uses [page] for elements without context and groups consecutive equal contexts", () => {
    const s = snap({
      elements: [
        el({ id: 1, role: "button", name: "A" }),
        el({ id: 2, role: "button", name: "B" }),
        el({ id: 3, role: "link", name: "C", context: ["nav"] }),
        el({ id: 4, role: "link", name: "D", context: ["nav"] }),
        el({ id: 5, role: "button", name: "E" }),
      ],
    });
    const lines = formatSnapshot(s).split("\n");
    expect(lines.slice(3)).toEqual([
      "[page]",
      '  [1] button "A"',
      '  [2] button "B"',
      "[nav]",
      '  [3] link "C"',
      '  [4] link "D"',
      "[page]",
      '  [5] button "E"',
    ]);
  });

  it("omits quotes for an empty name", () => {
    const s = snap({ elements: [el({ id: 7, role: "button" })] });
    expect(formatSnapshot(s).split("\n").at(-1)).toBe("  [7] button");
  });

  it("renders checkbox states and mixed", () => {
    const s = snap({
      elements: [
        el({ id: 1, role: "checkbox", name: "a", state: {} }),
        el({ id: 2, role: "radio", name: "b", state: { checked: "mixed" } }),
        el({ id: 3, role: "switch", name: "c", state: { checked: false } }),
      ],
    });
    const lines = formatSnapshot(s).split("\n").slice(-3);
    expect(lines).toEqual([
      '  [1] checkbox "a" ☐',
      '  [2] radio "b" ◩',
      '  [3] switch "c" ☐',
    ]);
  });

  it("renders all flags in the documented order", () => {
    const s = snap({
      elements: [
        el({
          id: 9,
          role: "button",
          name: "Full",
          state: { disabled: true, selected: true, expanded: false, pressed: true, required: true, readonly: true, focused: true, invalid: true },
          optionsCount: 3,
          hiddenCount: 2,
          hint: "name x",
          occludedBy: "bar",
        }),
      ],
    });
    expect(formatSnapshot(s).split("\n").at(-1)).toBe(
      '  [9] button "Full" (disabled, selected, collapsed, pressed, required, readonly, focused, invalid, 3 options, 2 inside, name x, occluded by bar)',
    );
  });

  it("renders expanded and empty value of a value-bearing role with placeholder", () => {
    const s = snap({
      elements: [
        el({ id: 1, role: "combobox", name: "Pick", state: { expanded: true } }),
        el({ id: 2, role: "searchbox", name: "Find", value: "", placeholder: "Search" }),
        el({ id: 3, role: "spinbutton", name: "Qty", value: "" }),
      ],
    });
    const lines = formatSnapshot(s).split("\n").slice(-3);
    expect(lines).toEqual([
      '  [1] combobox "Pick" = "" (expanded)',
      '  [2] searchbox "Find" = "" placeholder "Search"',
      '  [3] spinbutton "Qty" = ""',
    ]);
  });

  it("shows value on non-form elements when defined", () => {
    const s = snap({ elements: [el({ id: 1, role: "cell", name: "", kind: "text", value: "42" })] });
    expect(formatSnapshot(s).split("\n").at(-1)).toBe('  [1] cell = "42"');
  });

  it("renders offscreen above and below, joined with commas", () => {
    const s = snap({
      offscreen: [
        { direction: "above", context: 'section "Top"', count: 2 },
        { direction: "above", context: 'section "Head"', count: 1 },
        { direction: "below", context: 'section "Build"', count: 3 },
      ],
      elements: [el({ id: 1, role: "button", name: "X" })],
    });
    const lines = formatSnapshot(s).split("\n");
    expect(lines.slice(-3)).toEqual([
      '  [1] button "X"',
      '↑ above: section "Top" (2), section "Head" (1)',
      '↓ below: section "Build" (3)',
    ]);
  });

  it("renders several messages separated by middle dots", () => {
    const s = snap({ messages: ["one", "two"] });
    expect(formatSnapshot(s).split("\n").at(-1)).toBe('Messages: "one" · "two"');
  });

  it("adds the truncation notice", () => {
    const s = snap({ elements: [el({ id: 1, role: "button", name: "X" })], truncated: true });
    expect(formatSnapshot(s).split("\n").at(-1)).toBe("… list truncated (1 shown), use scope or full");
  });

  it("truncates the url to 100 chars and drops the query", () => {
    const long = "https://example.com/" + "a".repeat(200) + "?q=1";
    const first = formatSnapshot(snap({ url: long })).split("\n")[0];
    const shown = first.slice("Page: Example · ".length);
    expect(shown.length).toBeLessThanOrEqual(100);
    expect(shown.endsWith("…")).toBe(true);
    expect(first).not.toContain("?q=1");
  });

  it("escapes double quotes and backslashes in quoted fields and flattens newlines", () => {
    const s = snap({
      elements: [
        el({ id: 1, role: "button", name: 'Say "hi"' }),
        el({ id: 2, role: "textbox", name: "Note", value: "line1\nline2" }),
        el({ id: 3, role: "textbox", name: "Code", value: "", placeholder: 'C:\\dir"' }),
        el({ id: 4, role: "textbox", name: "Code2", value: "", error: 'bad "x"\r\ny' }),
      ],
    });
    const lines = formatSnapshot(s).split("\n").slice(-4);
    expect(lines).toEqual([
      '  [1] button "Say \\"hi\\""',
      '  [2] textbox "Note" = "line1 line2"',
      '  [3] textbox "Code" = "" placeholder "C:\\\\dir\\""',
      '  [4] textbox "Code2" = "" ⚠ "bad \\"x\\" y"',
    ]);
  });

  it("produces no trailing spaces and no empty trailing line", () => {
    const out = formatSnapshot(snap({ elements: [el({ id: 1, role: "button" })] }));
    for (const line of out.split("\n")) expect(line).toBe(line.trimEnd());
    expect(out.endsWith("\n")).toBe(false);
  });

  it("does not render the blank separator when there is no body", () => {
    expect(formatSnapshot(snap({}))).toBe(
      "Page: Example · example.com/\nViewport 1280×800 · scroll 0/2400 · ✓ settled",
    );
  });
});
