import path from "node:path";
import { bmpToGray } from "../src/adapters/bmp.js";
import type { CalibrationProfile } from "../src/core/calibrationProfile.js";

/**
 * Geometry measured from the tracked 3840×2160 recording. These regression
 * tests exercise real item occupancy, so they must not read the user's
 * mutable, gitignored templates/calibration.json.
 */
export function recordedWandFixture() {
  const frame = bmpToGray(path.resolve("fixtures/perception/live/deposit-1787705758242.bmp"));
  const client = { left: 0, top: 0, width: 3840, height: 2160 };
  if (frame.width !== client.width || frame.height !== client.height) throw new Error("The recorded wand fixture must remain 3840×2160.");
  const profile: CalibrationProfile = {
    version: 1,
    client: { width: client.width, height: client.height },
    bagGrid: { x: 2544, y: 1184, w: 1260, h: 525, cols: 12, rows: 5 },
    quadStashGrid: { x: 34, y: 254, w: 1260, h: 1260, cols: 24, rows: 24 },
    activeStashTab: "quad",
    npcs: [],
    updatedAt: "2026-08-26T00:00:00.000Z",
  };
  return { frame, client, profile };
}
