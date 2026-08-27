import { crop, meanVariance, type GrayImage } from "./grayImage.js";
import type { ScreenRect } from "./screenLayout.js";
import { LEGAL_SIZES, type StashItem } from "./bagPack.js";
import type { BBox, OccupiedCell } from "./uiPerception.js";

export interface CellScore {
  row: number;
  col: number;
  x: number;
  y: number;
  mean: number;
  variance: number;
  itemFrac: number;
}

function cellBox(region: BBox, col: number, row: number, cols: number, rows: number) {
  const cellW = region.w / cols;
  const cellH = region.h / rows;
  return {
    x: region.x + col * cellW,
    y: region.y + row * cellH,
    w: cellW,
    h: cellH,
  };
}

function insetCrop(
  frame: GrayImage,
  client: ScreenRect,
  box: { x: number; y: number; w: number; h: number },
  inset = 0.18,
): GrayImage {
  const sx = frame.width / client.width;
  const sy = frame.height / client.height;
  const fx = (box.x - client.left + box.w * inset) * sx;
  const fy = (box.y - client.top + box.h * inset) * sy;
  return crop(frame, fx, fy, box.w * (1 - inset * 2) * sx, box.h * (1 - inset * 2) * sy);
}

function brightFraction(image: GrayImage, threshold: number): number {
  if (image.pixels.length === 0) return 0;
  let n = 0;
  for (const value of image.pixels) if (value > threshold) n += 1;
  return n / image.pixels.length;
}

export function scoreGridCells(
  frame: GrayImage,
  client: ScreenRect,
  region: BBox,
  cols: number,
  rows: number,
): CellScore[] {
  const raw: Omit<CellScore, "itemFrac">[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const box = cellBox(region, col, row, cols, rows);
      const patch = insetCrop(frame, client, box);
      const stats = meanVariance(patch);
      raw.push({
        row,
        col,
        x: Math.round(box.x + box.w / 2),
        y: Math.round(box.y + box.h / 2),
        mean: stats.mean,
        variance: stats.variance,
      });
    }
  }
  const means = [...raw.map((cell) => cell.mean)].sort((a, b) => a - b);
  const baseline = means[Math.floor(means.length * 0.25)] ?? 0;
  const threshold = baseline + 20;
  return raw.map((cell) => {
    const box = cellBox(region, cell.col, cell.row, cols, rows);
    const patch = insetCrop(frame, client, box);
    return { ...cell, itemFrac: brightFraction(patch, threshold) };
  });
}

export function cellLooksOccupied(cell: CellScore): boolean {
  return (
    cell.itemFrac >= 0.22 ||
    (cell.mean > 35 && cell.variance > 120 && cell.itemFrac >= 0.12) ||
    (cell.variance > 180 && (cell.itemFrac >= 0.08 || cell.mean >= 16))
  );
}

/** Stash-search matches stay bright; non-matches dim. Hover-blue is a different class. */
export function cellLooksSearchLit(cell: CellScore): boolean {
  return cell.itemFrac >= 0.28 && cell.mean >= 36 && (cell.variance > 70 || cell.itemFrac >= 0.38);
}

/**
 * Stash search dims non-matching item art while matching item art remains stable.
 * Comparing the same cell before and after the query avoids treating a colored
 * stash-tab background as a highlighted item.
 */
export function searchMatchedCells(
  beforeFrame: GrayImage,
  afterFrame: GrayImage,
  client: ScreenRect,
  region: BBox,
  cols: number,
  rows: number,
): CellScore[] {
  const before = scoreGridCells(beforeFrame, client, region, cols, rows);
  const after = scoreGridCells(afterFrame, client, region, cols, rows);
  return after.filter((cell, index) => {
    const previous = before[index];
    if (!previous || !cellLooksOccupied(previous)) return false;
    const meanLoss = cell.mean - previous.mean;
    const fractionLoss = cell.itemFrac - previous.itemFrac;
    return cell.mean >= 24 && cell.itemFrac >= 0.12 && meanLoss >= -6 && fractionLoss >= -0.08;
  });
}

function seamLooksEmpty(
  frame: GrayImage,
  client: ScreenRect,
  region: BBox,
  cols: number,
  rows: number,
  row: number,
  col: number,
  w: number,
  h: number,
  baseline: number,
): boolean {
  const sx = frame.width / client.width;
  const sy = frame.height / client.height;
  const cellW = region.w / cols;
  const cellH = region.h / rows;
  if (w >= 2) {
    for (let split = 1; split < w; split += 1) {
      const x = region.x + (col + split) * cellW - cellW * 0.08;
      const y = region.y + row * cellH + cellH * 0.2;
      const strip = crop(frame, (x - client.left) * sx, (y - client.top) * sy, cellW * 0.16 * sx, cellH * (h - 0.4) * sy);
      if (meanVariance(strip).mean < baseline + 6) return true;
    }
  }
  if (h >= 2) {
    for (let split = 1; split < h; split += 1) {
      const x = region.x + col * cellW + cellW * 0.2;
      const y = region.y + (row + split) * cellH - cellH * 0.08;
      const strip = crop(frame, (x - client.left) * sx, (y - client.top) * sy, cellW * (w - 0.4) * sx, cellH * 0.16 * sy);
      if (meanVariance(strip).mean < baseline + 6) return true;
    }
  }
  return false;
}

export function detectSpriteItems(
  frame: GrayImage,
  client: ScreenRect,
  region: BBox,
  cols: number,
  rows: number,
  looksOccupied: (cell: CellScore) => boolean = cellLooksOccupied,
): StashItem[] {
  const scores = scoreGridCells(frame, client, region, cols, rows);
  const byKey = new Map(scores.map((cell) => [`${cell.row},${cell.col}`, cell]));
  const means = [...scores.map((cell) => cell.mean)].sort((a, b) => a - b);
  const baseline = means[Math.floor(means.length * 0.25)] ?? 0;
  const unused = new Set(
    scores.filter(looksOccupied).map((cell) => `${cell.row},${cell.col}`),
  );
  const items: StashItem[] = [];
  const seeds = scores.filter((cell) => unused.has(`${cell.row},${cell.col}`)).sort((a, b) => b.itemFrac - a.itemFrac);

  for (const seed of seeds) {
    const seedKey = `${seed.row},${seed.col}`;
    if (!unused.has(seedKey)) continue;
    let chosen: { w: number; h: number; row: number; col: number } | null = null;
    sizeLoop: for (const { w, h } of LEGAL_SIZES) {
      for (let dr = 0; dr < h; dr += 1) {
        for (let dc = 0; dc < w; dc += 1) {
          const row = seed.row - dr;
          const col = seed.col - dc;
          if (row < 0 || col < 0 || row + h > rows || col + w > cols) continue;
          const cells: CellScore[] = [];
          let blocked = false;
          for (let r = 0; r < h; r += 1) {
            for (let c = 0; c < w; c += 1) {
              const key = `${row + r},${col + c}`;
              if (!unused.has(key)) {
                blocked = true;
                break;
              }
              cells.push(byKey.get(key)!);
            }
          }
          if (blocked) continue;
          const weak = cells.filter((cell) => cell.itemFrac < 0.05).length;
          const allowWeak = w === 1 && h >= 3 ? 1 : 0;
          if (weak > allowWeak) continue;
          const avg = cells.reduce((sum, cell) => sum + cell.itemFrac, 0) / cells.length;
          if (avg < 0.1) continue;
          if (seamLooksEmpty(frame, client, region, cols, rows, row, col, w, h, baseline)) continue;
          chosen = { w, h, row, col };
          break sizeLoop;
        }
      }
    }
    const row = chosen?.row ?? seed.row;
    const col = chosen?.col ?? seed.col;
    const w = chosen?.w ?? 1;
    const h = chosen?.h ?? 1;
    const cells: OccupiedCell[] = [];
    for (let r = 0; r < h; r += 1) {
      for (let c = 0; c < w; c += 1) {
        unused.delete(`${row + r},${col + c}`);
        const scored = byKey.get(`${row + r},${col + c}`);
        cells.push({
          row: row + r,
          col: col + c,
          x: scored?.x ?? seed.x,
          y: scored?.y ?? seed.y,
          bag: "stash",
        });
      }
    }
    const grab = byKey.get(`${row},${col}`) ?? seed;
    items.push({
      id: `${row},${col}:${w}x${h}`,
      grab: { row, col, x: grab.x, y: grab.y, bag: "stash" },
      cells,
      w,
      h,
    });
  }
  return items.sort((a, b) => b.cells.length - a.cells.length || b.h - a.h || a.id.localeCompare(b.id));
}

export function occupiedFromScores(scores: CellScore[]): OccupiedCell[] {
  return scores.filter(cellLooksOccupied).map((cell) => ({
    row: cell.row,
    col: cell.col,
    x: cell.x,
    y: cell.y,
  }));
}
