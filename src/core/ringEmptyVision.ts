import type { BgrImage } from "./cellOccupancy.js";
import type { GridMark } from "./calibrationProfile.js";
import { bagCellInterior } from "./bagFastVision.js";

/** Match every interior pixel to the same slot in a verified empty inventory.
 * Deliberately rejects even small art: uncertainty falls back to clipboard reads.
 * The caller must first verify inventory chrome, cursor and frame stability. */
export function matchesEmptyRingSlot(image: BgrImage, reference: BgrImage, grid: GridMark, slot: number): boolean {
  if (image.width !== reference.width || image.height !== reference.height ||
    image.data.length !== image.width * image.height * 3 || reference.data.length !== image.data.length ||
    !Number.isInteger(slot) || slot < 0 || slot >= 60) return false;
  const box = bagCellInterior(grid, { row: Math.floor(slot / 12), col: slot % 12 });
  if (box.x < 0 || box.y < 0 || box.w < 1 || box.h < 1 || box.x + box.w > image.width || box.y + box.h > image.height) return false;
  let delta = 0, count = 0, minimum = 255, maximum = 0;
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) {
    const start = (y * image.width + x) * 3;
    for (let c = 0; c < 3; c++) {
      const a = image.data[start + c]!, b = reference.data[start + c]!, difference = Math.abs(a - b);
      if (difference > 12 || a > 60 || b > 60) return false;
      minimum = Math.min(minimum, b); maximum = Math.max(maximum, b);
      delta += difference; count++;
    }
  }
  // An unrendered black rectangle is not an empty-slot ornament.
  return maximum - minimum >= 6 && delta / count <= 1;
}
