import { describe, expect, it } from "vitest";
import { CONFIRM_BAND, CONFIRM_CHANNEL, CONFIRM_MAX_POINTS, CONFIRM_MIN_POINTS, CONFIRM_OK, CONFIRM_POINT_CAP, CONFIRM_THRESHOLD, confirmBand, confirmDialog, confirmOk } from "../src/core/followerConfirm.js";
import type { KeyPoint } from "../src/core/followerMapMarker.js";

// The counts are the real ones, measured on 2560 x 1440 captures in the band below at threshold 110:
// the teleport modal, then two frames of ordinary play. Only how many points there are decides the answer,
// so the points themselves are synthetic filler spread across the band.
const VIEW = { width: 2560, height: 1440 }, SMALL = { width: 1920, height: 1080 };
const DIALOG = 1253, PLAYED = [36767, 75234];
const points = (count: number, view = VIEW): KeyPoint[] => {
  const b = confirmBand(view);
  return Array.from({ length: count }, (_, i) => ({ x: b.x + i % b.width, y: b.y + Math.floor(i / b.width) % b.height }));
};

describe("teleport confirmation (measured darkness of the middle band)", () => {
  it("scans the measured band with the capture worker's existing white channel", () => {
    expect([CONFIRM_CHANNEL, CONFIRM_THRESHOLD]).toEqual(["white", 110]);
    expect(CONFIRM_BAND).toBe(confirmBand);
    expect(confirmBand(VIEW)).toEqual({ x: 563, y: 547, width: 1434, height: 317 });
    expect(confirmBand(SMALL)).toEqual({ x: 422, y: 410, width: 1076, height: 238 });
    // What we scan covers what we click: the OK button sits inside the band at either size.
    for (const view of [VIEW, SMALL]) {
      const b = confirmBand(view), ok = confirmOk(view);
      expect(ok.x >= b.x && ok.x < b.x + b.width && ok.y >= b.y && ok.y < b.y + b.height, `${view.width}x${view.height}`).toBe(true);
    }
  });

  it("accepts the measured dialog count and refuses both measured frames of play", () => {
    expect(confirmDialog(points(DIALOG), VIEW)).toEqual({ ok: { x: 1732, y: 764 } });
    for (const lit of PLAYED) expect(confirmDialog(points(lit), VIEW), String(lit)).toBeUndefined();
  });

  it("keeps a cap a played scene overflows long before the dialog reaches it", () => {
    expect(CONFIRM_POINT_CAP).toBeGreaterThan(CONFIRM_MAX_POINTS);
    expect(CONFIRM_POINT_CAP / DIALOG).toBeGreaterThan(3);              // the dialog never hits the cap
    expect(Math.min(...PLAYED) / CONFIRM_POINT_CAP).toBeGreaterThan(3); // played pixels always do
    expect(CONFIRM_MAX_POINTS / DIALOG).toBeGreaterThan(3);
    expect(Math.min(...PLAYED) / CONFIRM_MAX_POINTS).toBeGreaterThan(3);
    expect(CONFIRM_POINT_CAP).toBeLessThanOrEqual(60_000);              // the worker's own bounds on a cap
    expect(CONFIRM_POINT_CAP).toBeGreaterThanOrEqual(100);
  });

  it("refuses an overflowed scan, a failed scan, and anything too bright or too empty", () => {
    expect(confirmDialog(points(DIALOG), VIEW, true)).toBeUndefined();  // bright enough to give up: not a modal
    expect(confirmDialog(undefined, VIEW)).toBeUndefined();
    expect(confirmDialog(undefined, VIEW, true)).toBeUndefined();
    expect(confirmDialog(points(CONFIRM_MAX_POINTS), VIEW)).toEqual({ ok: { x: 1732, y: 764 } });
    expect(confirmDialog(points(CONFIRM_MAX_POINTS + 1), VIEW)).toBeUndefined();
    expect(confirmDialog(points(CONFIRM_MIN_POINTS), VIEW)).toEqual({ ok: { x: 1732, y: 764 } });
    // A black loading screen is what an accepted teleport shows next, and it is darker than the modal.
    expect(confirmDialog(points(CONFIRM_MIN_POINTS - 1), VIEW)).toBeUndefined();
    expect(confirmDialog([], VIEW)).toBeUndefined();
  });

  it("aims at the measured OK button, and scales it to another resolution", () => {
    expect(confirmOk(VIEW)).toEqual({ x: 1732, y: 764 });
    expect(confirmOk(SMALL)).toEqual({ x: 1299, y: 573 });
    expect(confirmOk(VIEW).x / VIEW.width).toBeCloseTo(CONFIRM_OK.x, 3);
    // OK is the right-hand button; CANCEL is left of centre at x 948 (0.370 w) and can never be what we return.
    expect(CONFIRM_OK.x).toBeGreaterThan(.5);
    expect(confirmOk(VIEW).x - 948).toBeGreaterThan(VIEW.width * .25);
    // The same dialog at 1920 x 1080 dims a band 56% the area, so it carries about 707 points.
    expect(confirmDialog(points(707, SMALL), SMALL)).toEqual({ ok: { x: 1299, y: 573 } });
    expect(707).toBeGreaterThan(CONFIRM_MIN_POINTS);
  });
});
