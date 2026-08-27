import { describe, expect, it } from "vitest";
import { packPatch, type CalibrationProfile, type GridMark } from "../src/core/calibrationProfile.js";
import { fillRect } from "../src/core/grayImage.js";
import { perceiveUi } from "../src/core/uiPerception.js";
import { stashAndBagFrame, TEST_CLIENT } from "./perceptionFixtures.js";

function bgrFromGray(pixels: Uint8Array): Uint8Array {
  const data = new Uint8Array(pixels.length * 3);
  for (let pixel = 0; pixel < pixels.length; pixel += 1) {
    const value = pixels[pixel]!;
    data[pixel * 3] = value;
    data[pixel * 3 + 1] = value;
    data[pixel * 3 + 2] = value;
  }
  return data;
}

describe("RGB-assisted bag perception", () => {
  it("rejects a thin text overlay while preserving gray-only fallback behavior", () => {
    const frame = stashAndBagFrame([]);
    const stash: GridMark = { x: 80, y: 144, w: 736, h: 630, cols: 12, rows: 12 };
    const bag: GridMark = { x: 1048, y: 324, w: 480, h: 450, cols: 12, rows: 5 };

    // Simulate chat text crossing row 3, column 0 between RGB sample points.
    fillRect(frame, 1055, 645, 25, 10, 220);
    const profile: CalibrationProfile = {
      version: 1,
      client: { width: TEST_CLIENT.width, height: TEST_CLIENT.height },
      npcs: [],
      stashGrid: { ...stash, patch: packPatch(frame, TEST_CLIENT, stash) },
      bagGrid: { ...bag, patch: packPatch(frame, TEST_CLIENT, bag) },
      updatedAt: new Date(0).toISOString(),
    };

    const grayOnly = perceiveUi(frame, TEST_CLIENT, {}, profile);
    const rgbAssisted = perceiveUi(frame, TEST_CLIENT, {}, profile, {
      width: frame.width,
      height: frame.height,
      data: bgrFromGray(frame.pixels),
    });

    expect(grayOnly.occupiedBag).toEqual(
      expect.arrayContaining([expect.objectContaining({ row: 3, col: 0 })]),
    );
    expect(rgbAssisted.occupiedBag).toEqual([]);
    expect(rgbAssisted.bagEmpty).toBe(true);
  });
});
