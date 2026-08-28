import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  BASELINE_OCCUPIED_DIFF,
  baselineCoverage,
  emptyBaseline,
  learnBaseline,
  occupiedFromBaseline,
  scoreAgainstBaseline,
} from "../src/core/cellBaseline.js";
import type { BgrImage } from "../src/core/cellOccupancy.js";
import { voteOccupancy } from "../src/core/occupancyVoting.js";
import { cloneBgr, cropBgr, drawRectOutline, fillRectBgr } from "../src/core/perceptionProbe.js";
import { encodeBgrPng } from "../src/core/pngWrite.js";
import type { ScreenRect } from "../src/core/screenLayout.js";

function makeBgr(width: number, height: number, fill: [number, number, number] = [20, 20, 20]): BgrImage {
  const data = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 3] = fill[0];
    data[i * 3 + 1] = fill[1];
    data[i * 3 + 2] = fill[2];
  }
  return { width, height, data };
}

function paintCell(
  image: BgrImage,
  region: { x: number; y: number; w: number; h: number },
  cols: number,
  rows: number,
  row: number,
  col: number,
  bgr: [number, number, number],
): void {
  const cellW = region.w / cols;
  const cellH = region.h / rows;
  fillRectBgr(
    image,
    region.x + col * cellW,
    region.y + row * cellH,
    cellW,
    cellH,
    { b: bgr[0], g: bgr[1], r: bgr[2] },
  );
}

const CLIENT: ScreenRect = { left: 0, top: 0, width: 480, height: 320 };
const REGION = { x: 40, y: 40, w: 240, h: 200 };

describe("pngWrite", () => {
  it("emits a valid PNG whose IDAT decodes back to the source pixels", () => {
    const image = makeBgr(3, 2, [10, 20, 30]);
    image.data[0] = 255; // blue channel of first pixel
    const png = encodeBgrPng(image);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(16)).toBe(3);
    expect(png.readUInt32BE(20)).toBe(2);
    const idatLen = png.readUInt32BE(33);
    expect(png.toString("ascii", 37, 41)).toBe("IDAT");
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    expect(raw.length).toBe(2 * (3 * 3 + 1));
    expect(raw[0]).toBe(0); // filter byte
    expect([raw[1], raw[2], raw[3]]).toEqual([30, 20, 255]); // RGB of first pixel
  });
});

describe("voteOccupancy", () => {
  const cell = (row: number, col: number) => ({ row, col });

  it("keeps cells present in most frames and flags transients as flicker", () => {
    const result = voteOccupancy([
      [cell(0, 0), cell(1, 1)],
      [cell(0, 0), cell(1, 1), cell(2, 2)],
      [cell(0, 0), cell(1, 1)],
    ]);
    expect(result.stable.map(({ row, col }) => [row, col])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(result.flicker).toHaveLength(1);
    expect(result.flicker[0]).toMatchObject({ row: 2, col: 2, votes: 1 });
    expect(result.flickerRate).toBeCloseTo(1 / 3);
  });

  it("reports zero flicker when every frame agrees", () => {
    const snapshot = [cell(3, 4)];
    const result = voteOccupancy([snapshot, snapshot, snapshot]);
    expect(result.flicker).toHaveLength(0);
    expect(result.flickerRate).toBe(0);
    expect(result.stable).toHaveLength(1);
  });
});

describe("cellBaseline", () => {
  it("scores learned-empty cells low and item cells high", () => {
    const cols = 4;
    const rows = 4;
    const empty = makeBgr(CLIENT.width, CLIENT.height);
    let model = emptyBaseline(cols, rows);
    const allCells = Array.from({ length: cols * rows }, (_, i) => ({
      row: Math.floor(i / cols),
      col: i % cols,
    }));
    model = learnBaseline(model, empty, CLIENT, REGION, allCells);
    expect(baselineCoverage(model)).toEqual({ learned: cols * rows, total: cols * rows });

    const withItems = cloneBgr(empty);
    paintCell(withItems, REGION, cols, rows, 1, 2, [40, 90, 160]); // bright item art
    paintCell(withItems, REGION, cols, rows, 3, 0, [45, 45, 60]); // dark item, still not empty texture
    const scores = scoreAgainstBaseline(model, withItems, CLIENT, REGION);
    const occupied = occupiedFromBaseline(scores);
    expect(occupied.map(({ row, col }) => [row, col]).sort()).toEqual([
      [1, 2],
      [3, 0],
    ]);
    const emptyScore = scores.find((score) => score.row === 0 && score.col === 0)!;
    expect(emptyScore.diff).toBeLessThan(BASELINE_OCCUPIED_DIFF / 2);
  });

  it("falls back to the median patch for cells never seen empty", () => {
    const cols = 3;
    const rows = 1;
    const empty = makeBgr(CLIENT.width, CLIENT.height, [30, 25, 35]);
    let model = emptyBaseline(cols, rows);
    model = learnBaseline(model, empty, CLIENT, REGION, [
      { row: 0, col: 0 },
      { row: 0, col: 1 },
    ]);
    const scores = scoreAgainstBaseline(model, empty, CLIENT, REGION);
    const unseen = scores.find((score) => score.col === 2)!;
    expect(unseen.reference).toBe("median");
    expect(unseen.diff).toBeLessThan(BASELINE_OCCUPIED_DIFF / 2);
  });

  it("averages repeated observations instead of replacing them", () => {
    const cols = 1;
    const rows = 1;
    const bright = makeBgr(CLIENT.width, CLIENT.height, [100, 100, 100]);
    const dark = makeBgr(CLIENT.width, CLIENT.height, [0, 0, 0]);
    let model = emptyBaseline(cols, rows);
    model = learnBaseline(model, bright, CLIENT, REGION, [{ row: 0, col: 0 }]);
    model = learnBaseline(model, dark, CLIENT, REGION, [{ row: 0, col: 0 }]);
    const patch = model.cells[0]!;
    expect(patch.samples).toBe(2);
    expect(patch.rgb[0]).toBe(50);
  });
});

describe("perceptionProbe drawing", () => {
  it("cropBgr extracts the requested window", () => {
    const image = makeBgr(10, 10);
    fillRectBgr(image, 4, 4, 2, 2, { r: 255, g: 0, b: 0 });
    const cropped = cropBgr(image, 4, 4, 2, 2);
    expect(cropped.width).toBe(2);
    expect(cropped.height).toBe(2);
    expect(cropped.data[2]).toBe(255); // red channel of first pixel
  });

  it("drawRectOutline paints the border but not the interior", () => {
    const image = makeBgr(20, 20, [0, 0, 0]);
    drawRectOutline(image, 2, 2, 10, 10, { r: 0, g: 255, b: 0 }, 1);
    const at = (x: number, y: number) => image.data[(y * image.width + x) * 3 + 1];
    expect(at(2, 2)).toBe(255);
    expect(at(11, 11)).toBe(255);
    expect(at(6, 6)).toBe(0);
  });
});
