import { describe, expect, it } from "vitest";
import { findIn } from "../../src/core/find.js";
import type { ElementInfo, Snapshot } from "../../src/types.js";

let next = 1;
const el = (role: string, name: string, extra: Partial<ElementInfo> = {}): ElementInfo => ({
  id: next++,
  kind: "interactive",
  role,
  name,
  state: {},
  rect: { x: 0, y: 100, w: 100, h: 20 },
  inViewport: true,
  context: [],
  ...extra,
});

const snap: Snapshot = {
  url: "https://example.com/",
  title: "",
  viewport: { w: 1280, h: 800 },
  scroll: { x: 0, y: 0, maxY: 2000 },
  loading: { busy: false, reasons: [] },
  offscreen: [],
  messages: [],
  elements: [
    el("text", "Бюджет кампании: не задан", { kind: "text", context: ['section "Кампания"'] }),
    el("heading", "Бюджет и график", { inViewport: false, rect: { x: 0, y: 1400, w: 300, h: 30 } }),
    el("textbox", "Дневной бюджет", { value: "10,00", context: ['section "Бюджет и график"'], inViewport: false, rect: { x: 0, y: 1500, w: 300, h: 30 } }),
    el("button", "Сохранить"),
    el("textbox", "Название", { value: "Flowr Бюджет test" }),
  ],
};

describe("findIn", () => {
  it("ranks name matches first, shows value, context and position", () => {
    const { text, count } = findIn(snap, "бюджет");
    expect(count).toBe(4);
    const lines = text.split("\n");
    expect(lines[0]).toBe('4 matches for "бюджет":');
    expect(lines[1]).toContain('"Бюджет кампании: не задан" — section "Кампания"');
    expect(lines[3]).toMatch(/textbox "Дневной бюджет" = "10,00".*section "Бюджет и график" ↓ below/);
    expect(lines[4]).toContain('"Название" = "Flowr Бюджет test"'); // matched by value, last
  });

  it("filters by role and reports no match", () => {
    expect(findIn(snap, "бюджет", { role: "textbox" }).count).toBe(2);
    expect(findIn(snap, "оплата").text).toBe('0 matches for "оплата"');
  });
});
