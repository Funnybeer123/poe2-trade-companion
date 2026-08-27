import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bmpToGray, readBmpBgr } from "../src/adapters/bmp.js";
import { toScreenBox } from "../src/core/calibrationProfile.js";
import { loadProfile } from "../src/core/calibrationStore.js";
import { occupiedFromRgbScores, scoreGridCellsRgb } from "../src/core/cellOccupancy.js";
import { perceiveUi } from "../src/core/uiPerception.js";

const CLIENT = { left: 0, top: 0, width: 3840, height: 2160 };
const profile = loadProfile(path.resolve("fixtures/perception/templates"));
const wandBmp = path.resolve("fixtures/perception/live/deposit-1787705758242.bmp");

describe("Codex RGB occupancy on live frames", () => {
  it("sees the leftover wand that gray occupancy is tuned to catch", () => {
    if (!existsSync(wandBmp) || !profile.bagGrid) return;
    const bag = toScreenBox(CLIENT, profile.bagGrid);
    const bgr = readBmpBgr(wandBmp);
    const rgb = occupiedFromRgbScores(scoreGridCellsRgb(bgr, CLIENT, bag, 12, 5));
    const gray = perceiveUi(bmpToGray(wandBmp), CLIENT, {}, profile).occupiedBag;
    const combined = perceiveUi(bmpToGray(wandBmp), CLIENT, {}, profile, bgr).occupiedBag;
    expect(gray.some((cell) => cell.col === 11 && cell.row <= 2)).toBe(true);
    expect(rgb.some((cell) => cell.col === 11 && cell.row <= 2)).toBe(true);
    expect(combined.some((cell) => cell.col === 11 && cell.row <= 2)).toBe(true);
    expect(combined.map((cell) => [cell.row, cell.col])).toEqual(
      rgb.map((cell) => [cell.row, cell.col]),
    );
  });

  it("does not mark a whole empty-looking bag as occupied", () => {
    if (!existsSync(wandBmp) || !profile.bagGrid) return;
    const bag = toScreenBox(CLIENT, profile.bagGrid);
    const rgb = occupiedFromRgbScores(scoreGridCellsRgb(readBmpBgr(wandBmp), CLIENT, bag, 12, 5));
    expect(rgb.length).toBeLessThan(20);
    expect(rgb.filter((cell) => cell.col < 10).length).toBeLessThan(8);
  });
});
