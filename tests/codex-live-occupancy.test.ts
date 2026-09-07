import { describe, expect, it } from "vitest";
import { bmpToGray, readBmpBgr } from "../src/adapters/bmp.js";
import { toScreenBox } from "../src/core/calibrationProfile.js";
import { loadProfile } from "../src/core/calibrationStore.js";
import { occupiedFromRgbScores, scoreGridCellsRgb } from "../src/core/cellOccupancy.js";
import { perceiveUi } from "../src/core/uiPerception.js";
import { LIVE_CALIBRATION, LIVE_WAND_BMP, missingLiveFixture, TEMPLATE_DIR } from "./liveFixtures.js";

const CLIENT = { left: 0, top: 0, width: 3840, height: 2160 };
const missing = missingLiveFixture("tests/codex-live-occupancy.test.ts", [LIVE_CALIBRATION, LIVE_WAND_BMP]);

describe.skipIf(Boolean(missing))("Codex RGB occupancy on live frames", () => {
  const profile = loadProfile(TEMPLATE_DIR);

  it("sees the leftover wand that gray occupancy is tuned to catch", () => {
    expect(profile.bagGrid).toBeTruthy();
    const bag = toScreenBox(CLIENT, profile.bagGrid!);
    const bgr = readBmpBgr(LIVE_WAND_BMP);
    const rgb = occupiedFromRgbScores(scoreGridCellsRgb(bgr, CLIENT, bag, 12, 5));
    const gray = perceiveUi(bmpToGray(LIVE_WAND_BMP), CLIENT, {}, profile).occupiedBag;
    const combined = perceiveUi(bmpToGray(LIVE_WAND_BMP), CLIENT, {}, profile, bgr).occupiedBag;
    expect(gray.some((cell) => cell.col === 11 && cell.row <= 2)).toBe(true);
    expect(rgb.some((cell) => cell.col === 11 && cell.row <= 2)).toBe(true);
    expect(combined.some((cell) => cell.col === 11 && cell.row <= 2)).toBe(true);
    expect(combined.map((cell) => [cell.row, cell.col])).toEqual(
      rgb.map((cell) => [cell.row, cell.col]),
    );
  });

  it("does not mark a whole empty-looking bag as occupied", () => {
    const bag = toScreenBox(CLIENT, profile.bagGrid!);
    const rgb = occupiedFromRgbScores(scoreGridCellsRgb(readBmpBgr(LIVE_WAND_BMP), CLIENT, bag, 12, 5));
    expect(rgb.length).toBeLessThan(20);
    expect(rgb.filter((cell) => cell.col < 10).length).toBeLessThan(8);
  });
});
