import type { BgrImage } from "./cellOccupancy.js";
import type { ClientBox, GridMark } from "./calibrationProfile.js";
import type { BagPosition } from "./bagAssessment.js";

/** Sample the whole interior, including stack counts. Edges contain grid highlights. */
export function bagCellPixels(image: BgrImage, grid: GridMark, cell: BagPosition): number[] {
  const w = grid.w / 12, h = grid.h / 5;
  return boxPixels(image, { x: grid.x + cell.col * w + 4, y: grid.y + cell.row * h + 4, w: w - 8, h: h - 8 }, 32);
}
export function boxPixels(image: BgrImage, box: ClientBox, samples = 32): number[] {
  if (box.x < 0 || box.y < 0 || box.w <= 0 || box.h <= 0 || box.x + box.w > image.width || box.y + box.h > image.height) throw new Error("Pixel evidence lies outside the current client.");
  const result: number[] = [];
  for (let y = 0; y < samples; y++) for (let x = 0; x < samples; x++) {
    const px = Math.floor(box.x + (x + 0.5) * box.w / samples), py = Math.floor(box.y + (y + 0.5) * box.h / samples);
    const i = (py * image.width + px) * 3;
    result.push(image.data[i]!, image.data[i + 1]!, image.data[i + 2]!);
  }
  return result;
}
export function sameBagPixels(before: readonly number[], after: readonly number[]): boolean {
  if (!before.length || before.length !== after.length) return false;
  let delta = 0, changed = 0;
  for (let i = 0; i < before.length; i++) { const d = Math.abs(before[i]! - after[i]!); delta += d; if (d > 16) changed++; }
  return delta / before.length <= 1.5 && changed / before.length <= 0.005;
}
/** Positive dark neutral empty-cell appearance, combined with TWO absent copy reads.
 * This intentionally rejects red equipment backgrounds and even small bright sprites. */
export function emptyBagPixels(pixels: readonly number[]): boolean {
  if (pixels.length !== 32 * 32 * 3) return false;
  let neutral = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    const max = Math.max(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!);
    const min = Math.min(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!);
    if (max > 75 || max - min > 30) return false;
    if (max <= 48 && max - min <= 20) neutral++;
  }
  return neutral / (pixels.length / 3) >= 0.98;
}

export function visibleLife(text: string): boolean {
  const match = /\bLife\s*([\d,]+)\s*\/\s*([\d,]+)/i.exec(text);
  return !!match && Number(match[1]!.replace(/,/g, "")) > 0 && Number(match[2]!.replace(/,/g, "")) >= Number(match[1]!.replace(/,/g, ""));
}
export function obstructingBagUi(text: string, panelLines: readonly string[] = text.split(/\r?\n/)): boolean {
  const panelOpen = panelLines.some(line => /^(?:trade|stash|guild stash|merchant|gamble|vendor)$/.test(line.trim().replace(/\s+/g, " ").replace(/[.:]+$/, "").toLowerCase()));
  if (panelOpen) return true;
  return /\b(?:resurrect|respawn|you have died|exit to character selection|exit to login screen|accept trade|trade request|destroy this item|are you sure|disconnected|connection failed|options|cosmetics|microtransaction shop|sell items|purchase items)\b/i.test(text.replace(/\bCosmetics\b/i, ""));
}
