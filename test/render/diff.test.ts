import { describe, it, expect } from "vitest";
import { diffSnapshots, formatDiff, SIGNIFICANT_ADDED, SIGNIFICANT_RATIO } from "../../src/render/diff.js";
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

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    url: "https://example.com/app",
    title: "App",
    viewport: { w: 1280, h: 800 },
    scroll: { x: 0, y: 0, maxY: 0 },
    loading: { busy: false, reasons: [] },
    elements: [],
    offscreen: [],
    messages: [],
    ...over,
  };
}

/** Ten base elements, ids 1..10. */
function base(): ElementInfo[] {
  return Array.from({ length: 10 }, (_, i) =>
    el({ id: i + 1, role: "button", name: `B${i + 1}` }),
  );
}

describe("diffSnapshots", () => {
  it("reports no change for identical snapshots", () => {
    const s = snap({ elements: base() });
    const d = diffSnapshots(s, structuredClone(s));
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([]);
    expect(d.newMessages).toEqual([]);
    expect(d.urlChanged).toBeUndefined();
    expect(d.layerChanged).toBeUndefined();
    expect(d.significant).toBe(false);
    expect(formatDiff(d)).toBe("no visible change");
  });

  it("matches by id: added, removed, and changed fields", () => {
    const before = snap({
      elements: [
        el({ id: 1, role: "textbox", name: "Price", value: "199.99" }),
        el({ id: 2, role: "checkbox", name: "Agree", state: { checked: false } }),
        el({ id: 3, role: "button", name: "Old" }),
      ],
    });
    const after = snap({
      elements: [
        el({ id: 1, role: "textbox", name: "Price", value: "244.99", rect: { x: 5, y: 5, w: 10, h: 10 } }),
        el({ id: 2, role: "checkbox", name: "Agree", state: { checked: true } }),
        el({ id: 4, role: "button", name: "New" }),
      ],
    });
    const d = diffSnapshots(before, after);
    expect(d.added.map((e) => e.id)).toEqual([4]);
    expect(d.removed.map((e) => e.id)).toEqual([3]);
    expect(d.changed.map((c) => c.after.id)).toEqual([1, 2]);
    expect(d.changed[0].fields).toEqual(["value"]);
    expect(d.changed[1].fields).toEqual(["state.checked"]);
    expect(formatDiff(d)).toBe(
      [
        '+ [4] button "New"',
        '- [3] button "Old"',
        '~ [1] textbox "Price": value "199.99" → "244.99"',
        '~ [2] checkbox "Agree": state.checked ☐ → ☑',
      ].join("\n"),
    );
  });

  it("ignores rect-only changes", () => {
    const before = snap({ elements: [el({ id: 1, role: "button", name: "A" })] });
    const after = snap({
      elements: [el({ id: 1, role: "button", name: "A", rect: { x: 900, y: 900, w: 1, h: 1 } })],
    });
    const d = diffSnapshots(before, after);
    expect(d.changed).toEqual([]);
    expect(formatDiff(d)).toBe("no visible change");
  });

  it("treats undefined state flags as false", () => {
    const before = snap({ elements: [el({ id: 1, role: "button", name: "A", state: { disabled: false } })] });
    const after = snap({ elements: [el({ id: 1, role: "button", name: "A", state: {} })] });
    expect(diffSnapshots(before, after).changed).toEqual([]);
  });

  it("reports every changed field name", () => {
    const before = snap({ elements: [el({ id: 1, role: "textbox", name: "X", value: "a", state: { invalid: false } })] });
    const after = snap({
      elements: [
        el({ id: 1, role: "textbox", name: "Y", value: "b", error: "bad", occludedBy: "x", inViewport: false, state: { invalid: true } }),
      ],
    });
    const d = diffSnapshots(before, after);
    expect(d.changed[0].fields).toEqual(["name", "value", "error", "occludedBy", "inViewport", "state.invalid"]);
    expect(formatDiff(d)).toBe(
      '~ [1] textbox "Y": name "X" → "Y"; value "a" → "b"; error none → "bad"; occludedBy none → x; inViewport true → false; state.invalid off → on',
    );
  });

  it("reports url change as significant and formats it with shortened urls", () => {
    const d = diffSnapshots(
      snap({ url: "https://a.com/x?step=1" }),
      snap({ url: "https://a.com/y" }),
    );
    expect(d.urlChanged).toEqual({ from: "https://a.com/x?step=1", to: "https://a.com/y" });
    expect(d.significant).toBe(true);
    expect(formatDiff(d)).toBe("→ url a.com/x → a.com/y");
  });

  it("treats a #hash-only url change as a change", () => {
    const d = diffSnapshots(snap({ url: "https://a.com/x" }), snap({ url: "https://a.com/x#top" }));
    expect(d.urlChanged).toBeDefined();
    expect(d.significant).toBe(true);
  });

  it("reports layer opened, closed and changed", () => {
    const plain = snap();
    const dlg = snap({ layer: 'dialog "Add phase"' });
    const other = snap({ layer: 'dialog "Other"' });

    const opened = diffSnapshots(plain, dlg);
    expect(opened.layerChanged).toEqual({ from: undefined, to: 'dialog "Add phase"' });
    expect(opened.significant).toBe(true);
    expect(formatDiff(opened)).toBe('→ opened dialog "Add phase"');

    const closed = diffSnapshots(dlg, plain);
    expect(formatDiff(closed)).toBe('→ closed dialog "Add phase"');

    const changed = diffSnapshots(dlg, other);
    expect(formatDiff(changed)).toBe('→ layer dialog "Add phase" → dialog "Other"');
  });

  it("collects only new messages", () => {
    const d = diffSnapshots(
      snap({ messages: ["Saved"] }),
      snap({ messages: ["Saved", "Failed to save"] }),
    );
    expect(d.newMessages).toEqual(["Failed to save"]);
    expect(formatDiff(d)).toBe('Messages: "Failed to save"');
  });

  it("is significant when more than 30% of elements were added or removed", () => {
    const b = base(); // 10 elements
    const removed3 = diffSnapshots(snap({ elements: b }), snap({ elements: b.slice(3) }));
    expect(removed3.removed).toHaveLength(3);
    expect(3 / 10 > SIGNIFICANT_RATIO).toBe(false);
    expect(removed3.significant).toBe(false);

    const removed4 = diffSnapshots(snap({ elements: b }), snap({ elements: b.slice(4) }));
    expect(removed4.significant).toBe(true);
  });

  it("is significant when at least 10 elements were added, regardless of ratio", () => {
    const before = snap({ elements: Array.from({ length: 100 }, (_, i) => el({ id: i + 1, role: "button" })) });
    const added = Array.from({ length: SIGNIFICANT_ADDED - 1 }, (_, i) => el({ id: 1000 + i, role: "button" }));
    expect(diffSnapshots(before, snap({ elements: [...before.elements, ...added] })).significant).toBe(false);
    const added10 = [...added, el({ id: 2000, role: "button" })];
    expect(diffSnapshots(before, snap({ elements: [...before.elements, ...added10] })).significant).toBe(true);
  });

  it("is not significant for a plain value change", () => {
    const before = snap({ elements: base() });
    const after = snap({ elements: base().map((e) => (e.id === 1 ? { ...e, value: "x" } : e)) });
    expect(diffSnapshots(before, after).significant).toBe(false);
  });

  it("caps long added and removed lists", () => {
    const many = (start: number, n: number) =>
      Array.from({ length: n }, (_, i) => el({ id: start + i, role: "button", name: `N${start + i}` }));
    const before = snap({ elements: many(1, 20) });
    const after = snap({ elements: many(100, 35) });
    const lines = formatDiff(diffSnapshots(before, after)).split("\n");
    const added = lines.filter((l) => l.startsWith("+ "));
    const removed = lines.filter((l) => l.startsWith("- "));
    expect(added).toHaveLength(31);
    expect(added.at(-1)).toBe("+ … 5 more");
    expect(removed).toHaveLength(16);
    expect(removed.at(-1)).toBe("- … 5 more");
  });
});

describe("formatDiff overlays", () => {
  it("summarizes the background covered by a modal in one line, keeps other changes", () => {
    const before = base();
    const after = base().map((e) => ({ ...e, occludedBy: 'dialog "Create"' }));
    after[0].state = { disabled: true };
    const out = formatDiff(diffSnapshots(snap({ elements: before }), snap({ elements: after })));
    expect(out).toContain('~ 10 elements now covered by dialog "Create"');
    expect(out).toContain("[1]");
    expect(out.split("\n")).toHaveLength(2);
  });
});

describe("formatDiff noise (live session 3)", () => {
  it("shows only the changed part of names, caps renames, collapses re-rendered nodes", () => {
    const day = (id: number, price: number) => el({ id, role: "button", name: `суббота, ${id} декабря 2026 г., ${price} долларов США` });
    const card = (id: number, name: string) => el({ id, role: "link", name, context: ['list "Results"'] });
    const before = snap({ elements: [...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => day(i, 100)), card(20, "TAP 202 $"), card(21, "LOT 210 $")] });
    const after = snap({ elements: [...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => day(i, 200)), card(40, "TAP 202 $"), card(41, "LOT 210 $")] });
    const lines = formatDiff(diffSnapshots(before, after)).split("\n");
    expect(lines[0]).toBe("↻ 2 re-rendered with the same content, new numbers [40]–[41]");
    expect(lines[1]).toBe('~ [1] button "суббота, 1 декабря 2026 г., 200 долларов США": name "…100…" → "…200…"');
    expect(lines.at(-1)).toBe("~ … 2 more changed");
    expect(lines).toHaveLength(8);
  });

  it("collapses the page shown again after a dialog closes", () => {
    const page = [1, 2, 3, 4, 5].map((id) => el({ id, role: "button", name: `B${id}` }));
    const before = snap({ layer: 'dialog "Publish?"', elements: [el({ id: 9, role: "button", name: "Close" })] });
    const after = snap({ elements: page });
    const out = formatDiff(diffSnapshots(before, after));
    expect(out).toContain('→ closed dialog "Publish?"');
    expect(out).toContain("↩ 5 elements of the page are visible again");
    expect(out).not.toContain("+ [1]");
    // Closing after a scroll inside the dialog: its elements are gone, not scrolled away.
    expect(formatDiff(diffSnapshots(before, after), { scrolled: true })).toContain("- [9]");
  });

  it("collapses the page hidden under a dialog that opened", () => {
    const page = [1, 2, 3, 4, 5].map((id) => el({ id, role: "button", name: `B${id}` }));
    const before = snap({ elements: page });
    const after = snap({ layer: 'dialog "Publish?"', elements: [el({ id: 9, role: "button", name: "Close" })] });
    const out = formatDiff(diffSnapshots(before, after));
    expect(out).toContain('↧ 5 elements of the page are under dialog "Publish?" now');
    expect(out).toContain('+ [9] button "Close"');
    expect(out).not.toContain("- [1]");
  });
});
