import type { BgrImage, ScreenRegion } from "./cellOccupancy.js";
import type { ScreenRect } from "./screenLayout.js";

/** Average-pooled RGB patch of one grid cell, flattened as [r,g,b, r,g,b, ...]. */
export interface CellPatch {
  w: number;
  h: number;
  rgb: number[];
  /** How many observations were averaged into this patch. */
  samples: number;
}

export interface BaselineModel {
  version: 1;
  cols: number;
  rows: number;
  patchSize: number;
  /** Row-major; null where no known-empty observation exists yet. */
  cells: Array<CellPatch | null>;
  /** Channel-median of all learned cells — fallback reference for unseen cells. */
  median: CellPatch | null;
  updatedAt: string;
}

export interface BaselineScore {
  row: number;
  col: number;
  x: number;
  y: number;
  /** Mean absolute RGB difference (0..255) against the reference patch. */
  diff: number;
  reference: "cell" | "median" | "none";
}

export const BASELINE_OCCUPIED_DIFF = 22;
const PATCH_INSET = 0.18;

export function emptyBaseline(cols: number, rows: number, patchSize = 8): BaselineModel {
  return {
    version: 1,
    cols,
    rows,
    patchSize,
    cells: Array.from({ length: cols * rows }, () => null),
    median: null,
    updatedAt: new Date().toISOString(),
  };
}

function cellBox(region: ScreenRegion, col: number, row: number, cols: number, rows: number) {
  const cellW = region.w / cols;
  const cellH = region.h / rows;
  return { x: region.x + col * cellW, y: region.y + row * cellH, w: cellW, h: cellH };
}

/** Average-pool the inset interior of a client-space box into a patchSize² RGB patch. */
export function extractCellPatch(
  image: BgrImage,
  client: ScreenRect,
  box: { x: number; y: number; w: number; h: number },
  patchSize: number,
): CellPatch {
  const sx = image.width / client.width;
  const sy = image.height / client.height;
  const fx = (box.x - client.left + box.w * PATCH_INSET) * sx;
  const fy = (box.y - client.top + box.h * PATCH_INSET) * sy;
  const fw = Math.max(patchSize, box.w * (1 - PATCH_INSET * 2) * sx);
  const fh = Math.max(patchSize, box.h * (1 - PATCH_INSET * 2) * sy);
  const rgb: number[] = new Array(patchSize * patchSize * 3).fill(0);
  for (let py = 0; py < patchSize; py += 1) {
    for (let px = 0; px < patchSize; px += 1) {
      const x0 = Math.floor(fx + (px * fw) / patchSize);
      const x1 = Math.max(x0 + 1, Math.floor(fx + ((px + 1) * fw) / patchSize));
      const y0 = Math.floor(fy + (py * fh) / patchSize);
      const y1 = Math.max(y0 + 1, Math.floor(fy + ((py + 1) * fh) / patchSize));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        if (yy < 0 || yy >= image.height) continue;
        for (let xx = x0; xx < x1; xx += 1) {
          if (xx < 0 || xx >= image.width) continue;
          const i = (yy * image.width + xx) * 3;
          b += image.data[i]!;
          g += image.data[i + 1]!;
          r += image.data[i + 2]!;
          n += 1;
        }
      }
      const out = (py * patchSize + px) * 3;
      rgb[out] = n ? Math.round(r / n) : 0;
      rgb[out + 1] = n ? Math.round(g / n) : 0;
      rgb[out + 2] = n ? Math.round(b / n) : 0;
    }
  }
  return { w: patchSize, h: patchSize, rgb, samples: 1 };
}

function mergePatch(existing: CellPatch | null, next: CellPatch): CellPatch {
  if (!existing || existing.rgb.length !== next.rgb.length) return next;
  const total = existing.samples + 1;
  return {
    w: existing.w,
    h: existing.h,
    samples: total,
    rgb: existing.rgb.map((value, i) => Math.round((value * existing.samples + next.rgb[i]!) / total)),
  };
}

function medianPatch(cells: Array<CellPatch | null>, patchSize: number): CellPatch | null {
  const learned = cells.filter((cell): cell is CellPatch => cell !== null);
  if (learned.length === 0) return null;
  const length = patchSize * patchSize * 3;
  const rgb: number[] = new Array(length);
  const scratch: number[] = new Array(learned.length);
  for (let i = 0; i < length; i += 1) {
    for (let c = 0; c < learned.length; c += 1) scratch[c] = learned[c]!.rgb[i]!;
    scratch.sort((a, b) => a - b);
    rgb[i] = scratch[Math.floor(scratch.length / 2)]!;
  }
  return { w: patchSize, h: patchSize, rgb, samples: learned.length };
}

/**
 * Fold known-empty cells from one frame into the model. Callers should only
 * pass cells that independent classifiers agree are empty across every frame
 * of a capture burst, so the model never learns item art as "empty".
 */
export function learnBaseline(
  model: BaselineModel,
  image: BgrImage,
  client: ScreenRect,
  region: ScreenRegion,
  emptyCells: Array<{ row: number; col: number }>,
): BaselineModel {
  const cells = [...model.cells];
  for (const cell of emptyCells) {
    if (cell.row < 0 || cell.col < 0 || cell.row >= model.rows || cell.col >= model.cols) continue;
    const index = cell.row * model.cols + cell.col;
    const patch = extractCellPatch(
      image,
      client,
      cellBox(region, cell.col, cell.row, model.cols, model.rows),
      model.patchSize,
    );
    cells[index] = mergePatch(cells[index] ?? null, patch);
  }
  return {
    ...model,
    cells,
    median: medianPatch(cells, model.patchSize),
    updatedAt: new Date().toISOString(),
  };
}

export function patchDiff(a: CellPatch, b: CellPatch): number {
  const length = Math.min(a.rgb.length, b.rgb.length);
  if (length === 0) return 255;
  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += Math.abs(a.rgb[i]! - b.rgb[i]!);
  return sum / length;
}

/**
 * Score every cell by difference from its own known-empty appearance
 * (falling back to the tab-median empty patch). Unlike absolute luma
 * thresholds this survives colored tab backgrounds, gamma changes, and
 * dark item art: anything that is not the empty texture scores high.
 */
export function scoreAgainstBaseline(
  model: BaselineModel,
  image: BgrImage,
  client: ScreenRect,
  region: ScreenRegion,
): BaselineScore[] {
  const scores: BaselineScore[] = [];
  for (let row = 0; row < model.rows; row += 1) {
    for (let col = 0; col < model.cols; col += 1) {
      const box = cellBox(region, col, row, model.cols, model.rows);
      const reference = model.cells[row * model.cols + col] ?? model.median;
      const kind: BaselineScore["reference"] = model.cells[row * model.cols + col]
        ? "cell"
        : model.median
          ? "median"
          : "none";
      let diff = -1;
      if (reference) {
        const patch = extractCellPatch(image, client, box, model.patchSize);
        diff = patchDiff(patch, reference);
      }
      scores.push({
        row,
        col,
        x: Math.round(box.x + box.w / 2),
        y: Math.round(box.y + box.h / 2),
        diff,
        reference: kind,
      });
    }
  }
  return scores;
}

export function occupiedFromBaseline(
  scores: BaselineScore[],
  threshold = BASELINE_OCCUPIED_DIFF,
): Array<{ row: number; col: number; x: number; y: number }> {
  return scores
    .filter((score) => score.reference !== "none" && score.diff >= threshold)
    .map(({ row, col, x, y }) => ({ row, col, x, y }));
}

export function baselineCoverage(model: BaselineModel): { learned: number; total: number } {
  return {
    learned: model.cells.filter((cell) => cell !== null).length,
    total: model.cols * model.rows,
  };
}
