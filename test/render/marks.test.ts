import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { drawMarks, placeLabels, resizeForBudget, type LabelItem } from "../../src/render/marks.js";
import type { ElementInfo } from "../../src/types.js";

function el(over: Partial<ElementInfo> & Pick<ElementInfo, "id" | "role" | "rect">): ElementInfo {
  return {
    kind: "interactive",
    name: "",
    state: {},
    inViewport: true,
    context: [],
    ...over,
  };
}

function overlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

async function solid(w: number, h: number, gray: number): Promise<Buffer> {
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r: gray, g: gray, b: gray } },
  })
    .png()
    .toBuffer();
}

async function pixel(buf: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

function differs(a: [number, number, number], b: [number, number, number], min = 60) {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])) >= min;
}

describe("placeLabels", () => {
  it("puts a label inside the top-left corner of a tall and wide element, inset 1 px", () => {
    const [p] = placeLabels(
      [{ id: 1, rect: { x: 100, y: 100, w: 60, h: 30 }, w: 15, h: 20 }],
      { w: 800, h: 600 },
    );
    expect(p).toEqual({ id: 1, x: 101, y: 101 });
  });

  it("puts a small element's label above it when there is space", () => {
    const [p] = placeLabels(
      [{ id: 1, rect: { x: 100, y: 100, w: 10, h: 10 }, w: 15, h: 20 }],
      { w: 800, h: 600 },
    );
    expect(p).toEqual({ id: 1, x: 100, y: 78 });
  });

  it("falls back to outside bottom-left when both top candidates are out of bounds", () => {
    const [p] = placeLabels(
      [{ id: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, w: 15, h: 20 }],
      { w: 800, h: 600 },
    );
    // small element: top-left and top-right would be above the top edge; bottom-left fits
    expect(p).toEqual({ id: 1, x: 0, y: 12 });
  });

  it("never overlaps another label or its own element when there is room", () => {
    const items: LabelItem[] = [];
    let id = 1;
    // 50 small elements on a 10x5 grid with generous gaps
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 10; col++) {
        items.push({
          id: id++,
          rect: { x: 40 + col * 70, y: 60 + row * 100, w: 12, h: 12 },
          w: 15,
          h: 20,
        });
      }
    }
    const bounds = { w: 800, h: 600 };
    const pos = placeLabels(items, bounds);
    expect(pos).toHaveLength(50);

    const boxes = pos.map((p) => {
      const it = items.find((i) => i.id === p.id)!;
      return { id: p.id, x: p.x, y: p.y, w: it.w, h: it.h, rect: it.rect };
    });

    for (const b of boxes) {
      // inside bounds
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(bounds.w);
      expect(b.y + b.h).toBeLessThanOrEqual(bounds.h);
      // not on its own element
      expect(overlap(b, b.rect)).toBe(false);
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(overlap(boxes[i], boxes[j]), `labels ${boxes[i].id} and ${boxes[j].id}`).toBe(false);
      }
    }
  });

  it("keeps labels inside bounds for an element at the bottom-right corner", () => {
    const [p] = placeLabels(
      [{ id: 12, rect: { x: 790, y: 590, w: 10, h: 10 }, w: 30, h: 20 }],
      { w: 800, h: 600 },
    );
    expect(p.x + 30).toBeLessThanOrEqual(800);
    expect(p.y + 20).toBeLessThanOrEqual(600);
  });

  it("returns positions in input order", () => {
    const pos = placeLabels(
      [
        { id: 5, rect: { x: 300, y: 300, w: 20, h: 20 }, w: 15, h: 20 },
        { id: 2, rect: { x: 10, y: 100, w: 20, h: 20 }, w: 15, h: 20 },
      ],
      { w: 800, h: 600 },
    );
    expect(pos.map((p) => p.id)).toEqual([5, 2]);
  });
});

describe("drawMarks", () => {
  const W = 800;
  const H = 600;

  it("returns a JPEG of the same size by default", async () => {
    const src = await solid(W, H, 200);
    const out = await drawMarks(
      src,
      [el({ id: 1, role: "button", name: "Go", rect: { x: 100, y: 100, w: 60, h: 30 } })],
      { scale: 1 },
    );
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(W);
    expect(meta.height).toBe(H);
  });

  it("draws the outline and the label badge with pixels different from the source", async () => {
    const src = await solid(W, H, 200);
    const out = await drawMarks(
      src,
      [el({ id: 1, role: "button", name: "Go", rect: { x: 100, y: 100, w: 60, h: 30 } })],
      { scale: 1, format: "png" },
    );
    // label badge sits inside the top-left corner: top-left at (101, 101), size 15x20
    expect(differs(await pixel(out, 102, 102), [200, 200, 200])).toBe(true);
    // outline on the left edge of the element
    expect(differs(await pixel(out, 100, 115), [200, 200, 200])).toBe(true);
    // far away pixel untouched
    expect(await pixel(out, 700, 500)).toEqual([200, 200, 200]);
  });

  it("does not draw occluded, text, or out-of-viewport elements", async () => {
    const src = await solid(W, H, 200);
    const out = await drawMarks(
      src,
      [
        el({ id: 2, role: "button", name: "Hidden", rect: { x: 300, y: 300, w: 60, h: 30 }, occludedBy: "footer" }),
        el({ id: 3, role: "text", kind: "text", name: "Label", rect: { x: 500, y: 300, w: 60, h: 30 } }),
        el({ id: 4, role: "button", name: "Off", rect: { x: 100, y: 450, w: 60, h: 30 }, inViewport: false }),
      ],
      { scale: 1, format: "png" },
    );
    // would-be outline of element 2 / 3 / 4 and their label positions stay untouched
    expect(await pixel(out, 300, 315)).toEqual([200, 200, 200]);
    expect(await pixel(out, 301, 280)).toEqual([200, 200, 200]);
    expect(await pixel(out, 500, 315)).toEqual([200, 200, 200]);
    expect(await pixel(out, 501, 280)).toEqual([200, 200, 200]);
    expect(await pixel(out, 100, 465)).toEqual([200, 200, 200]);
  });

  it("scales outline and labels with scale", async () => {
    const src = await solid(W * 2, H * 2, 200);
    const out = await drawMarks(
      src,
      // CSS rect 100,100 at scale 2 → image rect 200,200
      [el({ id: 1, role: "button", name: "Go", rect: { x: 100, y: 100, w: 60, h: 30 } })],
      { scale: 2, format: "png" },
    );
    expect(differs(await pixel(out, 200, 230), [200, 200, 200])).toBe(true);
    expect(await pixel(out, 500, 500)).toEqual([200, 200, 200]);
  });

  it("accepts a PNG input and returns a JPEG by default", async () => {
    const src = await solid(W, H, 10);
    const out = await drawMarks(src, [], { scale: 1 });
    expect(out[0]).toBe(0xff);
    expect(out[1]).toBe(0xd8);
  });
});

describe("placeLabels: dense layouts and obstacles", () => {
  it("keeps every label inside its own item in a stacked list of 20 items 40 px tall", () => {
    const items: LabelItem[] = [];
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    for (let i = 0; i < 20; i++) {
      const rect = { x: 50, y: 20 + i * 40, w: 200, h: 40 };
      rects.push(rect);
      items.push({ id: i + 1, rect, w: 22, h: 20 });
    }
    const pos = placeLabels(items, { w: 800, h: 900 }, rects);
    expect(pos).toHaveLength(20);
    pos.forEach((p, i) => {
      const r = rects[i];
      expect(p.x).toBeGreaterThanOrEqual(r.x);
      expect(p.y).toBeGreaterThanOrEqual(r.y);
      expect(p.x + 22).toBeLessThanOrEqual(r.x + r.w);
      expect(p.y + 20).toBeLessThanOrEqual(r.y + r.h);
    });
  });

  it("keeps labels of 16 px icons in a row off the other icons when there is space", () => {
    const items: LabelItem[] = [];
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    for (let i = 0; i < 20; i++) {
      const rect = { x: 20 + i * 24, y: 100, w: 16, h: 16 };
      rects.push(rect);
      items.push({ id: i + 1, rect, w: 22, h: 20 });
    }
    const pos = placeLabels(items, { w: 800, h: 600 }, rects);
    pos.forEach((p, i) => {
      const box = { x: p.x, y: p.y, w: 22, h: 20 };
      rects.forEach((r, j) => {
        if (j !== i) expect(overlap(box, r), `label ${p.id} vs element ${j + 1}`).toBe(false);
      });
    });
  });

  it("moves an outside label away from a candidate that hits another element", () => {
    const icon = { x: 100, y: 100, w: 16, h: 16 };
    const blocker = { x: 90, y: 70, w: 40, h: 25 }; // covers the label's top-left candidate
    const [p] = placeLabels([{ id: 1, rect: icon, w: 15, h: 20 }], { w: 800, h: 600 }, [icon, blocker]);
    expect(overlap({ x: p.x, y: p.y, w: 15, h: 20 }, blocker)).toBe(false);
    expect(overlap({ x: p.x, y: p.y, w: 15, h: 20 }, icon)).toBe(false);
  });
});

describe("resizeForBudget", () => {
  it("keeps the image untouched when it is within budget", async () => {
    const src = await solid(800, 600, 50);
    const r = await resizeForBudget(src, 1280);
    expect(r.factor).toBe(1);
    expect(r.image).toBe(src);
  });

  it("downscales wider images keeping aspect ratio and reports the factor", async () => {
    const src = await solid(2560, 1600, 50);
    const r = await resizeForBudget(src, 1280);
    const meta = await sharp(r.image).metadata();
    expect(meta.width).toBe(1280);
    expect(meta.height).toBe(800);
    expect(r.factor).toBeCloseTo(0.5, 10);
  });

  it("uses 1280 as the default max width", async () => {
    const src = await solid(1600, 900, 50);
    const r = await resizeForBudget(src);
    expect((await sharp(r.image).metadata()).width).toBe(1280);
    expect(r.factor).toBeCloseTo(0.8, 10);
  });
});
