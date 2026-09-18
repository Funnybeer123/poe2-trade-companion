import { expect, it } from "vitest";
import { existsSync } from "node:fs";
import { readBmpBgr } from "../src/adapters/bmp.js";
import { matchesEmptyRingSlot } from "../src/core/ringEmptyVision.js";

const grid = { x: 0, y: 0, w: 240, h: 100, cols: 12, rows: 5 };
function empty() {
  const data = Buffer.alloc(240 * 100 * 3);
  for (let y = 0; y < 100; y++) for (let x = 0; x < 240; x++)
    for (let c = 0; c < 3; c++) data[(y * 240 + x) * 3 + c] = 4 + x % 10;
  return { width: 240, height: 100, data };
}
it("recognizes the calibrated ornament in every empty cell", () => {
  const reference = empty();
  for (let slot = 0; slot < 60; slot++) expect(matchesEmptyRingSlot(empty(), reference, grid, slot)).toBe(true);
});
it("rejects a tiny sprite, dark tinted item, black loading frame, and shifted geometry", () => {
  const reference = empty(), tiny = empty(), dark = empty(), black = empty();
  tiny.data[(8 * 240 + 8) * 3] = 90;
  for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) dark.data[(y * 240 + x) * 3] = 29;
  black.data.fill(0);
  for (const image of [tiny, dark, black]) expect(matchesEmptyRingSlot(image, reference, grid, 0)).toBe(false);
  expect(matchesEmptyRingSlot(black, black, grid, 0)).toBe(false);
  expect(matchesEmptyRingSlot(reference, reference, { ...grid, x: 240 }, 0)).toBe(false);
  expect(matchesEmptyRingSlot(reference, { ...reference, width: 120 }, grid, 0)).toBe(false);
});
const directory = "artifacts/ring-gamble/speed-test-06.jsonl.evidence/";
const fullBag = "artifacts/ring-gamble/visual-full-02.jsonl.evidence/frame-4.bmp";
it.skipIf(!existsSync(fullBag) || !existsSync(directory + "frame-2.bmp"))("rejects every occupied slot in the live full bag", () => {
  const reference = readBmpBgr(directory + "frame-2.bmp"), occupied = readBmpBgr(fullBag);
  const liveGrid = { x: 2541, y: 1180, w: 1265, h: 527, cols: 12, rows: 5 };
  for (let slot = 0; slot < 60; slot++) expect(matchesEmptyRingSlot(occupied, reference, liveGrid, slot), `occupied ${slot}`).toBe(false);
});
it.skipIf(!existsSync(directory + "frame-5.bmp"))("replays the verified empty bag and six purchased rings without false empties", () => {
  const reference = readBmpBgr(directory + "frame-2.bmp"), occupied = readBmpBgr(directory + "frame-5.bmp");
  const liveGrid = { x: 2541, y: 1180, w: 1265, h: 527, cols: 12, rows: 5 };
  const ringSlots = new Set([0, 1, 12, 24, 36, 48]);
  for (let slot = 0; slot < 60; slot++) {
    expect(matchesEmptyRingSlot(reference, reference, liveGrid, slot), `reference ${slot}`).toBe(true);
    expect(matchesEmptyRingSlot(occupied, reference, liveGrid, slot), `purchased ${slot}`).toBe(!ringSlots.has(slot));
  }
});
