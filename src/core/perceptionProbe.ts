import type { BgrImage, ScreenRegion } from "./cellOccupancy.js";
import { occupiedFromRgbScores, scoreGridCellsRgb } from "./cellOccupancy.js";
import type { GrayImage } from "./grayImage.js";
import { occupiedFromScores, scoreGridCells } from "./itemSprites.js";
import type { ScreenRect } from "./screenLayout.js";
import type { BBox, UiFacts } from "./uiPerception.js";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export const PROBE_COLORS = {
  grid: { r: 255, g: 214, b: 0 },
  agree: { r: 46, g: 204, b: 64 },
  grayOnly: { r: 255, g: 133, b: 27 },
  rgbOnly: { r: 240, g: 18, b: 190 },
  baseline: { r: 0, g: 216, b: 255 },
  flicker: { r: 255, g: 65, b: 54 },
} as const;

export function cloneBgr(image: BgrImage): BgrImage {
  return { width: image.width, height: image.height, data: Buffer.from(image.data) };
}

function putPixel(image: BgrImage, x: number, y: number, color: Rgb): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const i = (y * image.width + x) * 3;
  image.data[i] = color.b;
  image.data[i + 1] = color.g;
  image.data[i + 2] = color.r;
}

export function drawRectOutline(
  image: BgrImage,
  x: number,
  y: number,
  w: number,
  h: number,
  color: Rgb,
  thickness = 2,
): void {
  const x0 = Math.round(x);
  const y0 = Math.round(y);
  const x1 = Math.round(x + w) - 1;
  const y1 = Math.round(y + h) - 1;
  for (let t = 0; t < thickness; t += 1) {
    for (let xx = x0; xx <= x1; xx += 1) {
      putPixel(image, xx, y0 + t, color);
      putPixel(image, xx, y1 - t, color);
    }
    for (let yy = y0; yy <= y1; yy += 1) {
      putPixel(image, x0 + t, yy, color);
      putPixel(image, x1 - t, yy, color);
    }
  }
}

export function fillRectBgr(image: BgrImage, x: number, y: number, w: number, h: number, color: Rgb): void {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(image.width, Math.round(x + w));
  const y1 = Math.min(image.height, Math.round(y + h));
  for (let yy = y0; yy < y1; yy += 1) {
    for (let xx = x0; xx < x1; xx += 1) putPixel(image, xx, yy, color);
  }
}

export function cropBgr(image: BgrImage, x: number, y: number, w: number, h: number): BgrImage {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const cw = Math.min(image.width - x0, Math.round(w));
  const ch = Math.min(image.height - y0, Math.round(h));
  const data = Buffer.alloc(Math.max(0, cw * ch * 3));
  for (let yy = 0; yy < ch; yy += 1) {
    const src = ((y0 + yy) * image.width + x0) * 3;
    data.set(image.data.subarray(src, src + cw * 3), yy * cw * 3);
  }
  return { width: Math.max(0, cw), height: Math.max(0, ch), data };
}

export interface GridSnapshot {
  region: BBox;
  cols: number;
  rows: number;
  /** Grayscale brightness/variance classifier (current stash path). */
  gray: Array<{ row: number; col: number; x: number; y: number }>;
  /** RGB point-sample classifier (current bag path). */
  rgb: Array<{ row: number; col: number; x: number; y: number }>;
  /** Cells the two classifiers disagree on. */
  grayOnly: Array<{ row: number; col: number }>;
  rgbOnly: Array<{ row: number; col: number }>;
}

export interface FrameAnalysis {
  facts: UiFacts;
  stash?: GridSnapshot;
  bag?: GridSnapshot;
  timings: { perceiveMs: number; classifiersMs: number };
}

function keySet(cells: Array<{ row: number; col: number }>): Set<string> {
  return new Set(cells.map((cell) => `${cell.row},${cell.col}`));
}

function snapshotGrid(
  frame: GrayImage,
  bgr: BgrImage,
  client: ScreenRect,
  region: BBox,
  cols: number,
  rows: number,
): GridSnapshot {
  const gray = occupiedFromScores(scoreGridCells(frame, client, region, cols, rows));
  const rgb = occupiedFromRgbScores(scoreGridCellsRgb(bgr, client, region as ScreenRegion, cols, rows));
  const graySet = keySet(gray);
  const rgbSet = keySet(rgb);
  return {
    region,
    cols,
    rows,
    gray,
    rgb,
    grayOnly: gray.filter((cell) => !rgbSet.has(`${cell.row},${cell.col}`)),
    rgbOnly: rgb.filter((cell) => !graySet.has(`${cell.row},${cell.col}`)),
  };
}

/** Run full perception plus both cell classifiers on each detected grid. */
export function analyzeFrame(
  perceive: () => UiFacts,
  frame: GrayImage,
  bgr: BgrImage,
  client: ScreenRect,
): FrameAnalysis {
  const t0 = performance.now();
  const facts = perceive();
  const t1 = performance.now();
  const stash =
    facts.stashRegion && facts.stashGridSize
      ? snapshotGrid(frame, bgr, client, facts.stashRegion, facts.stashGridSize.cols, facts.stashGridSize.rows)
      : undefined;
  const bag = facts.inventoryRegion
    ? snapshotGrid(frame, bgr, client, facts.inventoryRegion, 12, 5)
    : undefined;
  const t2 = performance.now();
  return { facts, stash, bag, timings: { perceiveMs: t1 - t0, classifiersMs: t2 - t1 } };
}

export interface AnnotateOptions {
  flickerCells?: Array<{ row: number; col: number }>;
  baselineOccupied?: Array<{ row: number; col: number }>;
}

/** Paint one grid's classifier verdicts onto the frame (frame-space pixels). */
export function annotateGrid(
  image: BgrImage,
  client: ScreenRect,
  snapshot: GridSnapshot,
  options: AnnotateOptions = {},
): void {
  const sx = image.width / client.width;
  const sy = image.height / client.height;
  const fx = (snapshot.region.x - client.left) * sx;
  const fy = (snapshot.region.y - client.top) * sy;
  const fw = snapshot.region.w * sx;
  const fh = snapshot.region.h * sy;
  drawRectOutline(image, fx, fy, fw, fh, PROBE_COLORS.grid, 3);
  const cellW = fw / snapshot.cols;
  const cellH = fh / snapshot.rows;
  const rgbSet = keySet(snapshot.rgb);
  const graySet = keySet(snapshot.gray);
  const flickerSet = keySet(options.flickerCells ?? []);
  const baselineSet = keySet(options.baselineOccupied ?? []);
  for (let row = 0; row < snapshot.rows; row += 1) {
    for (let col = 0; col < snapshot.cols; col += 1) {
      const key = `${row},${col}`;
      const inGray = graySet.has(key);
      const inRgb = rgbSet.has(key);
      const cx = fx + col * cellW;
      const cy = fy + row * cellH;
      if (inGray || inRgb) {
        const color = inGray && inRgb ? PROBE_COLORS.agree : inGray ? PROBE_COLORS.grayOnly : PROBE_COLORS.rgbOnly;
        drawRectOutline(image, cx + 2, cy + 2, cellW - 4, cellH - 4, color, 3);
      }
      if (baselineSet.has(key)) {
        fillRectBgr(image, cx + cellW * 0.72, cy + cellH * 0.08, cellW * 0.2, cellH * 0.2, PROBE_COLORS.baseline);
      }
      if (flickerSet.has(key)) {
        fillRectBgr(image, cx + cellW * 0.08, cy + cellH * 0.08, cellW * 0.2, cellH * 0.2, PROBE_COLORS.flicker);
      }
    }
  }
}
