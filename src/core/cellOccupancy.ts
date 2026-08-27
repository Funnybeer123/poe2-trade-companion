/** PoE2 cell occupancy classifier ported from Codex Poe2StashRegexWeb InventoryScanCore. */

export type OccupancyClass = "empty" | "occupied" | "highlight" | "unknown";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface CellSampleResult {
  sampleCount: number;
  empty: number;
  occupied: number;
  highlight: number;
  unknown: number;
  isEmpty: boolean;
  reason: string;
}

export const DEFAULT_SAMPLE_POINTS = [
  [0.2, 0.2],
  [0.5, 0.2],
  [0.8, 0.2],
  [0.2, 0.5],
  [0.5, 0.5],
  [0.8, 0.5],
  [0.2, 0.8],
  [0.5, 0.8],
  [0.8, 0.8],
] as const;

export function classifySample(color: Rgb): OccupancyClass {
  const max = Math.max(color.r, color.g, color.b);
  const min = Math.min(color.r, color.g, color.b);
  const luma = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
  const chroma = max - min;

  if (color.b >= 40 && color.b - Math.max(color.r, color.g) >= 16 && luma <= 75) {
    return "highlight";
  }
  if ((luma <= 36 && chroma <= 18) || (max <= 58 && luma <= 42 && chroma <= 22)) {
    return "empty";
  }
  if ((luma >= 48 && (chroma >= 18 || max >= 95)) || (luma >= 30 && chroma >= 30)) {
    return "occupied";
  }
  return "unknown";
}

export function analyzeCellSamples(samples: Rgb[]): CellSampleResult {
  if (samples.length === 0) {
    return {
      sampleCount: 0,
      empty: 0,
      occupied: 0,
      highlight: 0,
      unknown: 0,
      isEmpty: false,
      reason: "no-samples",
    };
  }

  let empty = 0;
  let occupied = 0;
  let highlight = 0;
  let unknown = 0;
  for (const sample of samples) {
    const kind = classifySample(sample);
    if (kind === "empty") empty += 1;
    else if (kind === "occupied") occupied += 1;
    else if (kind === "highlight") highlight += 1;
    else unknown += 1;
  }

  const requiredEmpty = Math.max(3, Math.ceil(samples.length * 0.45));
  const base = { sampleCount: samples.length, empty, occupied, highlight, unknown };
  if (empty >= requiredEmpty && occupied === 0 && highlight <= 2) {
    return {
      ...base,
      isEmpty: true,
      reason: `empty-like votes ${empty}/${samples.length} with occupied=${occupied} highlight=${highlight}`,
    };
  }
  if (occupied >= 2) {
    return { ...base, isEmpty: false, reason: `occupied-like votes ${occupied}/${samples.length}` };
  }
  if (highlight >= 3) {
    return {
      ...base,
      isEmpty: false,
      reason: `highlight-heavy cell highlight=${highlight}/${samples.length}`,
    };
  }
  return {
    ...base,
    isEmpty: false,
    reason: `ambiguous cell treated occupied empty=${empty} occupied=${occupied} highlight=${highlight} unknown=${unknown}`,
  };
}

export interface BgrImage {
  width: number;
  height: number;
  data: Uint8Array | Buffer;
}

export interface ScreenRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RgbCellScore {
  row: number;
  col: number;
  x: number;
  y: number;
  result: CellSampleResult;
}

export function sampleBgr(image: BgrImage, x: number, y: number): Rgb | undefined {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= image.width || py >= image.height) return undefined;
  const i = (py * image.width + px) * 3;
  return { b: image.data[i]!, g: image.data[i + 1]!, r: image.data[i + 2]! };
}

export function scoreGridCellsRgb(
  image: BgrImage,
  client: { left: number; top: number; width: number; height: number },
  region: ScreenRegion,
  cols: number,
  rows: number,
): RgbCellScore[] {
  const sx = image.width / client.width;
  const sy = image.height / client.height;
  const cellW = region.w / cols;
  const cellH = region.h / rows;
  const scores: RgbCellScore[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const box = {
        x: region.x + col * cellW,
        y: region.y + row * cellH,
        w: cellW,
        h: cellH,
      };
      const samples: Rgb[] = [];
      for (const [fx, fy] of DEFAULT_SAMPLE_POINTS) {
        const sample = sampleBgr(
          image,
          (box.x - client.left + box.w * fx) * sx,
          (box.y - client.top + box.h * fy) * sy,
        );
        if (sample) samples.push(sample);
      }
      scores.push({
        row,
        col,
        x: Math.round(box.x + box.w / 2),
        y: Math.round(box.y + box.h / 2),
        result: analyzeCellSamples(samples),
      });
    }
  }
  return scores;
}

export function occupiedFromRgbScores(scores: RgbCellScore[]): Array<{ row: number; col: number; x: number; y: number }> {
  return scores
    .filter((cell) => !cell.result.isEmpty)
    .map((cell) => ({ row: cell.row, col: cell.col, x: cell.x, y: cell.y }));
}

export function groupOccupiedRegions(
  occupied: boolean[][],
): Array<{ cells: Array<{ row: number; col: number }>; rectangular: boolean }> {
  const rows = occupied.length;
  const cols = occupied[0]?.length ?? 0;
  const seen = Array.from({ length: rows }, () => Array.from({ length: cols }, () => false));
  const regions: Array<{ cells: Array<{ row: number; col: number }>; rectangular: boolean }> = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (!occupied[row]![col] || seen[row]![col]) continue;
      const cells: Array<{ row: number; col: number }> = [];
      const queue = [{ row, col }];
      seen[row]![col] = true;
      while (queue.length) {
        const cur = queue.shift()!;
        cells.push(cur);
        for (const [dr, dc] of [
          [0, 1],
          [1, 0],
          [0, -1],
          [-1, 0],
        ] as const) {
          const nr = cur.row + dr;
          const nc = cur.col + dc;
          if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
          if (!occupied[nr]![nc] || seen[nr]![nc]) continue;
          seen[nr]![nc] = true;
          queue.push({ row: nr, col: nc });
        }
      }
      const minR = Math.min(...cells.map((cell) => cell.row));
      const maxR = Math.max(...cells.map((cell) => cell.row));
      const minC = Math.min(...cells.map((cell) => cell.col));
      const maxC = Math.max(...cells.map((cell) => cell.col));
      regions.push({
        cells,
        rectangular: (maxR - minR + 1) * (maxC - minC + 1) === cells.length,
      });
    }
  }
  return regions;
}
