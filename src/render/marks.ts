import sharp from "sharp";
import type { ElementInfo, Rect } from "../types.js";

const PALETTE = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#0a7e8c"];
/** Label metrics at scale 1 (CSS px). */
const FONT_SIZE = 13;
const DIGIT_WIDTH = 0.62; // bold digit advance, in em
const PAD_X = 3;
const PAD_Y = 2;
const GAP = 2;
const OUTLINE = 2;

export interface LabelItem {
  id: number;
  rect: Rect;
  /** Label size in the same units as rect. */
  w: number;
  h: number;
}

export interface LabelPosition {
  id: number;
  x: number;
  y: number;
}

function intersects(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Places a label per item.
 *
 * - Tall and wide element (rect.h >= h + 4 and rect.w >= w + 8): the label goes inside the
 *   top-left corner, inset by 1 px. Then the outside candidates follow.
 * - Otherwise (small elements): outside candidates in order (top-left, top-right, bottom-left,
 *   left). An outside candidate is rejected if it intersects any obstacle rect (other elements).
 *   Then inside top-left.
 * - A candidate is used if it is inside bounds and does not intersect an already placed label.
 *   If none fits, the inside top-left position is used (clamped to bounds).
 */
export function placeLabels(
  items: LabelItem[],
  bounds: { w: number; h: number },
  obstacles: Rect[] = [],
): LabelPosition[] {
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  const result: LabelPosition[] = [];

  for (const { id, rect: r, w, h } of items) {
    const tall = r.h >= h + 4 && r.w >= w + 8;
    const outside: [number, number][] = [
      [r.x, r.y - h - GAP],
      [r.x + r.w - w, r.y - h - GAP],
      [r.x, r.y + r.h + GAP],
      [r.x - w - GAP, r.y],
    ];
    let candidates: [number, number][];
    let inside: [number, number];
    if (tall) {
      inside = [r.x + 1, r.y + 1];
      candidates = [inside, ...outside];
    } else {
      inside = [r.x, r.y];
      const clear = outside.filter(
        (c) => !obstacles.some((o) => intersects({ x: c[0], y: c[1], w, h }, o)),
      );
      candidates = [...clear, inside];
    }

    const inBounds = ([x, y]: [number, number]) =>
      x >= 0 && y >= 0 && x + w <= bounds.w && y + h <= bounds.h;
    const free = ([x, y]: [number, number]) =>
      !placed.some((p) => intersects({ x, y, w, h }, p));

    let pos = candidates.find((c) => inBounds(c) && free(c));
    if (!pos) {
      const [x, y] = inside;
      pos = [
        Math.min(Math.max(x, 0), Math.max(0, bounds.w - w)),
        Math.min(Math.max(y, 0), Math.max(0, bounds.h - h)),
      ];
    }
    placed.push({ x: pos[0], y: pos[1], w, h });
    result.push({ id, x: pos[0], y: pos[1] });
  }

  return result;
}

export function colorFor(id: number): string {
  return PALETTE[((id % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

export async function drawMarks(
  image: Buffer,
  elements: ElementInfo[],
  opts: { scale: number; format?: "jpeg" | "png"; quality?: number },
): Promise<Buffer> {
  const { scale, format = "jpeg", quality = 75 } = opts;
  const meta = await sharp(image).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  const visible = elements.filter(
    (e) => e.kind === "interactive" && e.inViewport && !e.occludedBy,
  );

  const fs = FONT_SIZE * scale;
  const padX = PAD_X * scale;
  const padY = PAD_Y * scale;

  const items: LabelItem[] = visible.map((e) => ({
    id: e.id,
    rect: {
      x: e.rect.x * scale,
      y: e.rect.y * scale,
      w: e.rect.w * scale,
      h: e.rect.h * scale,
    },
    w: Math.ceil(String(e.id).length * fs * DIGIT_WIDTH + 2 * padX),
    h: Math.ceil(fs * 1.2 + 2 * padY),
  }));

  const positions = placeLabels(
    items,
    { w: width, h: height },
    items.map((it) => it.rect),
  );
  const byId = new Map(items.map((it) => [it.id, it] as const));

  const parts: string[] = [];
  for (const pos of positions) {
    const it = byId.get(pos.id)!;
    const color = colorFor(pos.id);
    const r = it.rect;
    parts.push(
      `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="none" stroke="${color}" stroke-width="${OUTLINE * scale}"/>`,
    );
    const rx = 3 * scale;
    parts.push(
      `<rect x="${pos.x}" y="${pos.y}" width="${it.w}" height="${it.h}" rx="${rx}" ry="${rx}" fill="${color}"/>`,
    );
    const baseline = pos.y + it.h / 2 + fs * 0.36;
    parts.push(
      `<text x="${pos.x + it.w / 2}" y="${baseline}" font-family="Arial, Helvetica, sans-serif" font-weight="bold" font-size="${fs}" fill="#ffffff" text-anchor="middle">${pos.id}</text>`,
    );
  }

  let pipeline = sharp(image);
  if (parts.length) {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      parts.join("") +
      `</svg>`;
    pipeline = pipeline.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]);
  }

  return format === "png"
    ? pipeline.png().toBuffer()
    : pipeline.jpeg({ quality }).toBuffer();
}

/** Downscale to maxWidth if wider; returns the factor (new width / old width). */
export async function resizeForBudget(
  image: Buffer,
  maxWidth = 1280,
): Promise<{ image: Buffer; factor: number }> {
  const meta = await sharp(image).metadata();
  const width = meta.width ?? 0;
  if (!width || width <= maxWidth) return { image, factor: 1 };
  const out = await sharp(image).resize({ width: maxWidth }).toBuffer();
  return { image: out, factor: maxWidth / width };
}
