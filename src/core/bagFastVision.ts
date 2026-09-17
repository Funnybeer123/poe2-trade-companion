import type { BgrImage } from "./cellOccupancy.js";
import type { ClientBox, GridMark } from "./calibrationProfile.js";
import { validCell, type BagPosition } from "./bagAssessment.js";

/** A client-space rectangle captured on its own. Coordinates passed to every
 * helper below are CLIENT coordinates; the part supplies its own origin. */
export interface BagViewPart extends ClientBox { image: BgrImage }
export interface BagView {
  at: string;
  evidence: string;
  pointer: { x: number; y: number };
  parts: BagViewPart[];
}
export type BagCellLook = "same" | "empty" | "changed";
export interface BagArtMask {
  cells: BagPosition[];
  /** Packed client x, y, b, g, r per feature. */
  features: Int32Array;
  /** Stack-count corner of the first cell, judged on its own: the glyphs are too few
   * pixels to move the whole-art score, yet a different count is a different stack. */
  count: Int32Array;
  /** Dark art without enough bright edges can prove presence, not identity. */
  weak: boolean;
}
export interface ProbeDelta { changed: number; box?: ClientBox }

const validImage = (image: BgrImage) => !!image && Number.isSafeInteger(image.width) && Number.isSafeInteger(image.height) &&
  image.width > 0 && image.height > 0 && image.data.length === image.width * image.height * 3;
function partFor(view: BagView, box: ClientBox): BagViewPart {
  const part = view.parts.find(p => box.x >= p.x && box.y >= p.y && box.x + box.w <= p.x + p.w && box.y + box.h <= p.y + p.h);
  if (!part || !validImage(part.image) || part.image.width !== part.w || part.image.height !== part.h) throw new Error("Bag evidence does not cover the requested client region.");
  return part;
}
const offset = (part: BagViewPart, x: number, y: number) => ((y - part.y) * part.w + (x - part.x)) * 3;

/** The four-pixel cell border carries hover and placement highlights, never item identity. */
export function bagCellInterior(grid: GridMark, cell: BagPosition): ClientBox {
  if (!validCell(cell)) throw new Error("Invalid bag cell.");
  const w = grid.w / 12, h = grid.h / 5;
  const x = Math.ceil(grid.x + cell.col * w) + 5, y = Math.ceil(grid.y + cell.row * h) + 5;
  return { x, y, w: Math.floor(grid.x + (cell.col + 1) * w) - 5 - x, h: Math.floor(grid.y + (cell.row + 1) * h) - 5 - y };
}

/** Positive empty evidence at full resolution. Every occupied PoE2 cell carries a
 * tinted background (identified navy, unidentified or unusable red, armed olive)
 * or art; an empty cell is neutral near-black apart from its faint ornament.
 * Measured live: empty <= 2% tinted / 0% bright, occupied >= 41% tinted. */
export function emptyBagCell(view: BagView, grid: GridMark, cell: BagPosition): boolean {
  const box = bagCellInterior(grid, cell), part = partFor(view, box);
  let tinted = 0, bright = 0;
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) {
    const i = offset(part, x, y), b = part.image.data[i]!, g = part.image.data[i + 1]!, r = part.image.data[i + 2]!;
    const max = Math.max(b, g, r);
    if (max - Math.min(b, g, r) > 12) tinted++;
    if (max > 60) bright++;
  }
  const count = box.w * box.h;
  return count > 0 && tinted / count <= 0.06 && bright / count <= 0.04;
}

/** Bright edge pixels of the item art, taken from the BEFORE view only. Background
 * tints pulse and change with cursor mode and identification; bright art does not
 * (measured live: every selected pixel stayed within 1 RGB while Wisdom was armed).
 * The top-left stack-count corner is excluded on request because a legitimate
 * Wisdom use changes those glyphs; the count is then proven by the text read. */
export function bagArtMask(view: BagView, grid: GridMark, cells: BagPosition[], options: { excludeCount?: boolean } = {}): BagArtMask {
  if (!cells.length || cells.some(cell => !validCell(cell))) throw new Error("Invalid bag footprint.");
  const cols = new Set(cells.map(c => c.col)).size, rows = new Set(cells.map(c => c.row)).size;
  for (const brightness of [200, 160, 120]) {
    const found: number[] = [], count: number[] = [];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const cell of cells) {
      const box = bagCellInterior(grid, cell), part = partFor(view, box);
      for (let y = box.y; y < box.y + box.h - 2; y++) for (let x = box.x; x < box.x + box.w - 2; x++) {
        const corner = cell === cells[0] && x - box.x <= box.w * .5 && y - box.y <= box.h * .38;
        if (corner && options.excludeCount) continue;
        const i = offset(part, x, y), n = offset(part, x + 2, y + 2), data = part.image.data;
        const b = data[i]!, g = data[i + 1]!, r = data[i + 2]!;
        if (Math.max(b, g, r) < brightness) continue;
        if (Math.max(Math.abs(b - data[n]!), Math.abs(g - data[n + 1]!), Math.abs(r - data[n + 2]!)) < 18) continue;
        (corner ? count : found).push(x, y, b, g, r);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    const spanX = (maxX - minX) / (cols * grid.w / 12), spanY = (maxY - minY) / (rows * grid.h / 5);
    if (found.length / 5 >= 40 && spanX >= .25 && spanY >= .25) return { cells: structuredClone(cells), features: Int32Array.from(found), count: Int32Array.from(count), weak: false };
  }
  return { cells: structuredClone(cells), features: new Int32Array(0), count: new Int32Array(0), weak: true };
}

/** "same" needs the recorded art still in place; a weak mask can only show the
 * footprint is still occupied. Neither outcome is ever inferred from an intent. */
export function bagFootprintLook(view: BagView, grid: GridMark, mask: BagArtMask): BagCellLook {
  const empties = mask.cells.filter(cell => emptyBagCell(view, grid, cell)).length;
  if (empties === mask.cells.length) return "empty";
  if (empties) return "changed";
  if (mask.weak) return "same";
  const f = mask.features, boxes = mask.cells.map(cell => bagCellInterior(grid, cell));
  const left = Math.min(...boxes.map(b => b.x)), top = Math.min(...boxes.map(b => b.y));
  const part = partFor(view, { x: left, y: top, w: Math.max(...boxes.map(b => b.x + b.w)) - left, h: Math.max(...boxes.map(b => b.y + b.h)) - top });
  const data = part.image.data;
  const kept = (list: Int32Array) => {
    let good = 0;
    for (let i = 0; i < list.length; i += 5) {
      const o = offset(part, list[i]!, list[i + 1]!);
      if (Math.abs(data[o]! - list[i + 2]!) <= 10 && Math.abs(data[o + 1]! - list[i + 3]!) <= 10 && Math.abs(data[o + 2]! - list[i + 4]!) <= 10) good++;
    }
    return good / (list.length / 5);
  };
  if (mask.count.length / 5 >= 12 && kept(mask.count) < .9) return "changed";
  return kept(f) >= .97 ? "same" : "changed";
}

/** Pixels that differ from the run's own empty-cursor baseline inside one probe
 * region. The probe backgrounds are static inventory artwork (byte-identical
 * across minutes live), so software-rendered cursor payloads are the only change. */
export function bagProbeDelta(baseline: BagView, view: BagView, region: ClientBox): ProbeDelta {
  const a = partFor(baseline, region), b = partFor(view, region);
  let changed = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let y = region.y; y < region.y + region.h; y++) for (let x = region.x; x < region.x + region.w; x++) {
    const i = offset(a, x, y), j = offset(b, x, y);
    if (Math.max(Math.abs(a.image.data[i]! - b.image.data[j]!), Math.abs(a.image.data[i + 1]! - b.image.data[j + 1]!),
      Math.abs(a.image.data[i + 2]! - b.image.data[j + 2]!)) <= 6) continue;
    changed++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return changed ? { changed, box: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } } : { changed: 0 };
}

export type BagCursorLook = "clean" | "occupied" | "unknown";
/** "clean" is positive evidence: the pointer is inside this probe region and the
 * whole potential-payload area equals the baseline. "occupied" needs a compact
 * change around the pointer. Anything else is unknown and stops the run. */
export function bagCursorLook(baseline: BagView, view: BagView, region: ClientBox): { look: BagCursorLook; delta: ProbeDelta } {
  const p = view.pointer;
  if (![p.x, p.y].every(Number.isFinite) || p.x < region.x + region.w * .25 || p.x > region.x + region.w * .75 ||
    p.y < region.y + region.h * .25 || p.y > region.y + region.h * .75) return { look: "unknown", delta: { changed: -1 } };
  const delta = bagProbeDelta(baseline, view, region);
  if (delta.changed <= 4) return { look: "clean", delta };
  const box = delta.box!;
  const near = p.x >= box.x - 24 && p.x <= box.x + box.w + 24 && p.y >= box.y - 24 && p.y <= box.y + box.h + 24;
  return { look: delta.changed >= 120 && near ? "occupied" : "unknown", delta };
}
