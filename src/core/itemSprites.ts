import { crop, meanVariance, regionStats, type GrayImage } from "./grayImage.js";
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

function insetStats(
  frame: GrayImage,
  client: ScreenRect,
  box: { x: number; y: number; w: number; h: number },
  brightThreshold = Number.POSITIVE_INFINITY,
  inset = 0.18,
): { mean: number; variance: number; brightFraction: number } {
  const sx = frame.width / client.width;
  const sy = frame.height / client.height;
  const fx = (box.x - client.left + box.w * inset) * sx;
  const fy = (box.y - client.top + box.h * inset) * sy;
  return regionStats(
    frame,
    fx,
    fy,
    box.w * (1 - inset * 2) * sx,
    box.h * (1 - inset * 2) * sy,
    brightThreshold,
  );
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
      const stats = insetStats(frame, client, box);
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
    return { ...cell, itemFrac: insetStats(frame, client, box, threshold).brightFraction };
  });
}

/**
 * Mean brightness along each INTERNAL boundary line of a hypothetical 24x24
 * lattice over `region` (3px strips, full length, both axes). On a quad tab
 * all 23 lines per axis are dark separators; on a standard 12x12 tab only the
 * even-indexed ones are — odd positions cut through cell interiors and read
 * brighter. The caller compares the two groups to detect the tab size.
 */
export function boundaryBrightness24(
  frame: GrayImage,
  client: ScreenRect,
  region: BBox,
): { odd: number[]; even: number[] } {
  const odd: number[] = [];
  const even: number[] = [];
  for (let k = 1; k < 24; k += 1) {
    const x = region.x + (k * region.w) / 24;
    const y = region.y + (k * region.h) / 24;
    const vertical = insetStats(
      frame, client, { x: x - 1.5, y: region.y, w: 3, h: region.h }, Number.POSITIVE_INFINITY, 0,
    ).mean;
    const horizontal = insetStats(
      frame, client, { x: region.x, y: y - 1.5, w: region.w, h: 3 }, Number.POSITIVE_INFINITY, 0,
    ).mean;
    (k % 2 === 1 ? odd : even).push(vertical, horizontal);
  }
  return { odd, even };
}

/**
 * The single best Ctrl+C probe point for a cell whose CENTRE hover yielded no
 * item text: the centre of the brightest 9x9 pixel block inside the cell
 * (small art — rings, jewels — can sit off-centre where the centre hover
 * pokes dead space). One informed probe replaces the old blind 4-offset
 * pattern. Returns undefined when the cell has no block meaningfully brighter
 * than its darkest corner (nothing to aim at — probably truly empty).
 */
export function brightestCellPoint(
  frame: GrayImage,
  client: ScreenRect,
  region: BBox,
  cols: number,
  rows: number,
  cell: { row: number; col: number },
): { x: number; y: number } | undefined {
  const box = cellBox(region, cell.col, cell.row, cols, rows);
  const sx = frame.width / client.width;
  const sy = frame.height / client.height;
  // Search inside a 12% inset so the probe never lands on a neighbour.
  const inset = 0.12;
  const left = box.x + box.w * inset;
  const top = box.y + box.h * inset;
  const width = box.w * (1 - inset * 2);
  const height = box.h * (1 - inset * 2);
  const blockClient = 9 / Math.min(sx, sy); // 9x9 frame px, in client units
  const steps = 5;
  let best: { x: number; y: number; mean: number } | undefined;
  let darkest = Number.POSITIVE_INFINITY;
  for (let iy = 0; iy < steps; iy += 1) {
    for (let ix = 0; ix < steps; ix += 1) {
      const cx = left + ((ix + 0.5) * width) / steps;
      const cy = top + ((iy + 0.5) * height) / steps;
      const stats = regionStats(
        frame,
        (cx - blockClient / 2 - client.left) * sx,
        (cy - blockClient / 2 - client.top) * sy,
        blockClient * sx,
        blockClient * sy,
      );
      if (stats.mean < darkest) darkest = stats.mean;
      if (!best || stats.mean > best.mean) best = { x: cx, y: cy, mean: stats.mean };
    }
  }
  if (!best || best.mean < darkest + 8) return undefined;
  return { x: Math.round(best.x), y: Math.round(best.y) };
}

/**
 * Contiguous BRIGHT runs along a horizontal band — a light-coloured tab
 * header (the user's silver Dump tab) renders light-on-dark, which is
 * exactly what defeats its label's OCR, active or not. Scanned in 8px
 * column chunks; a run must clear `threshold` mean brightness for at least
 * `minRunPx`. Returns client-coordinate x ranges.
 *
 * Threshold measured live (2026-08-30): the inactive silver header's
 * columns read 98-113 mean, the brown/gold headers peak at 78, background
 * sits near 15 — 88 splits the gap; the ACTIVE header is brighter still.
 */
export function brightHeaderRuns(
  frame: GrayImage,
  client: ScreenRect,
  band: BBox,
  threshold = 88,
  minRunPx = 50,
): Array<{ x0: number; x1: number }> {
  const sx = frame.width / client.width;
  const sy = frame.height / client.height;
  const step = 8;
  const runs: Array<{ x0: number; x1: number }> = [];
  let runStart: number | undefined;
  for (let x = band.x; x <= band.x + band.w; x += step) {
    const bright =
      x < band.x + band.w &&
      regionStats(
        frame,
        (x - client.left) * sx,
        (band.y - client.top) * sy,
        step * sx,
        band.h * sy,
      ).mean >= threshold;
    if (bright && runStart === undefined) runStart = x;
    if (!bright && runStart !== undefined) {
      if (x - runStart >= minRunPx) runs.push({ x0: runStart, x1: x });
      runStart = undefined;
    }
  }
  return runs;
}

/**
 * Does the sprite in cell (row, col-1) CONTINUE into cell (row, col)?
 *
 * Compares the two thin vertical strips flanking the shared boundary (a few
 * pixels in from the lattice line so the separator itself never votes). A
 * multi-cell item's art flows across the boundary — the strips correlate and
 * both carry real content. Two separate items leave a dark gutter at their
 * cell edges — the content gate fails and no skip happens. Deliberately
 * conservative: this may only PROPOSE skipping a hover; claimNeedsReverify +
 * a re-read dispose (never classify from pixels).
 */
export function cellEdgeContinuity(
  frame: GrayImage,
  client: ScreenRect,
  region: BBox,
  cols: number,
  rows: number,
  row: number,
  col: number,
): boolean {
  if (col <= 0 || col >= cols) return false;
  const sx = frame.width / client.width;
  const sy = frame.height / client.height;
  const cellW = region.w / cols;
  const cellH = region.h / rows;
  const boundaryX = region.x + col * cellW;
  const top = region.y + row * cellH + cellH * 0.2;
  const height = cellH * 0.6;
  const stripW = Math.max(2 / sx, cellW * 0.08);
  const gap = Math.max(2 / sx, cellW * 0.05); // clear of the lattice line
  const sample = (clientX: number): number[] => {
    const fx = Math.round((clientX - client.left) * sx);
    const fy0 = Math.round((top - client.top) * sy);
    const fh = Math.round(height * sy);
    const fw = Math.max(1, Math.round(stripW * sx));
    const profile: number[] = [];
    const bins = 16;
    for (let b = 0; b < bins; b += 1) {
      const stats = regionStats(frame, fx, fy0 + (b * fh) / bins, fw, fh / bins);
      profile.push(stats.mean);
    }
    return profile;
  };
  const leftProfile = sample(boundaryX - gap - stripW);
  const rightProfile = sample(boundaryX + gap);
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  const leftMean = mean(leftProfile);
  const rightMean = mean(rightProfile);
  // Content gate: both edges must hold actual art. Empty gutters and flat
  // backgrounds fail here, so separate items are never bridged.
  const spread = (values: number[], m: number) =>
    values.reduce((acc, value) => acc + (value - m) ** 2, 0) / values.length;
  const leftVar = spread(leftProfile, leftMean);
  const rightVar = spread(rightProfile, rightMean);
  if (leftMean < 22 || rightMean < 22) return false;
  // BOTH sides must carry real structure: an empty quad's uniform glare rows
  // correlate near-perfectly and once chained 23 empty cells into one
  // phantom "item" (Dump tab, 2026-08-30) — variance is what separates item
  // art from a flat sheen, and one flat side means there is no sprite here.
  if (leftVar < 60 || rightVar < 60) return false;
  // Shape gate: the vertical brightness profiles must actually correlate.
  let cov = 0;
  for (let i = 0; i < leftProfile.length; i += 1) {
    cov += (leftProfile[i]! - leftMean) * (rightProfile[i]! - rightMean);
  }
  const denom = Math.sqrt(leftVar * rightVar) * leftProfile.length;
  if (denom < 1e-6) return false;
  const correlation = cov / denom;
  return correlation >= 0.8 && Math.abs(leftMean - rightMean) < Math.max(leftMean, rightMean) * 0.45;
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
