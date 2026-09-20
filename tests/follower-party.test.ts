import { describe, expect, it } from "vitest";
import { findTravelButton, PARTY_BAND, PARTY_CHANNEL, PARTY_POINT_CAP, PARTY_THRESHOLD, partyBand } from "../src/core/followerParty.js";
import type { KeyPoint } from "../src/core/followerMapMarker.js";

// SYNTHETIC blue key points built from the real measurement: on 2560 x 1440 frames the travel button
// is a swirl filling x 11..38, y 322..349 (28 x 28, centre 25, 336) with 423 points at threshold 60.
// They prove the size, shape and ordering rules, not fidelity to the game's anti-aliased sprite.
const VIEW = { width: 2560, height: 1440 }, SMALL = { width: 1920, height: 1080 };
/** A swirl: an annulus filling its bounding box, which is the measured shape's 54% fill. */
function swirl(cx: number, cy: number, outer: number, inner = outer * .57): KeyPoint[] {
  const points: KeyPoint[] = [];
  for (let y = Math.ceil(cy - outer); y <= cy + outer; y++) for (let x = Math.ceil(cx - outer); x <= cx + outer; x++) {
    const d = Math.hypot(x - cx, y - cy);
    if (d <= outer && d >= inner) points.push({ x, y });
  }
  return points;
}
const disc = (cx: number, cy: number, radius: number): KeyPoint[] => swirl(cx, cy, radius, 0);
/** The first party member's button, exactly where it was measured. */
const BUTTON = swirl(24.5, 335.5, 14);

describe("party travel button (synthetic blue key points)", () => {
  it("scans the measured strip of the party frame with the capture worker's existing blue channel", () => {
    expect([PARTY_CHANNEL, PARTY_THRESHOLD]).toEqual(["blue", 60]);
    expect(PARTY_BAND).toBe(partyBand);
    expect(partyBand(VIEW)).toEqual({ x: 0, y: 250, width: 90, height: 420 });
    const band = partyBand(SMALL);
    expect(band).toEqual({ x: 0, y: 187, width: 68, height: 316 });
    // The button sits inside the band at either size.
    for (const [view, points] of [[VIEW, BUTTON], [SMALL, swirl(18.375, 251.625, 10.5)]] as const) {
      const b = partyBand(view);
      expect(points.every(p => p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height)).toBe(true);
    }
  });

  it("finds the measured button and reports its centre", () => {
    // Close to the 423 points measured at threshold 60, in exactly the measured 28 x 28 box.
    expect(BUTTON.length).toBeGreaterThanOrEqual(400);
    expect(BUTTON.length).toBeLessThanOrEqual(450);
    const found = findTravelButton(BUTTON, VIEW);
    expect(found).toEqual({ centre: { x: 25, y: 336 }, pixels: BUTTON.length });
  });

  it("finds the same button at 1920 x 1080, where everything is three quarters the size", () => {
    const scaled = swirl(18.375, 251.625, 10.5);
    expect(findTravelButton(scaled, SMALL)).toEqual({ centre: { x: 18, y: 252 }, pixels: scaled.length });
    // The 1440p button is too big for a 1080p view, and the 1080p one carries too little ink for a 1440p one.
    expect(findTravelButton(BUTTON, SMALL)).toBeUndefined();
    expect(findTravelButton(scaled, VIEW)).toBeUndefined();
  });

  it("finds a second party member's button on its own, and prefers the topmost when the party is bigger", () => {
    const second = swirl(24.5, 401.5, 14), third = swirl(24.5, 467.5, 14);
    expect(findTravelButton(second, VIEW)).toMatchObject({ centre: { x: 25, y: 402 } });
    // The first member is the one we follow, and the frame stacks members downward.
    expect(findTravelButton([...third, ...second, ...BUTTON], VIEW)).toMatchObject({ centre: { x: 25, y: 336 } });
  });

  it("reports nothing for an empty band, a scattered handful, or a sparse blob of the right size", () => {
    expect(findTravelButton([], VIEW)).toBeUndefined();
    expect(findTravelButton([{ x: 4, y: 260 }, { x: 40, y: 299 }, { x: 12, y: 355 }, { x: 70, y: 420 }, { x: 33, y: 512 }, { x: 8, y: 640 }], VIEW)).toBeUndefined();
    // A hollow 28 x 28 outline: the right box, nowhere near the ink of a swirl.
    const outline: KeyPoint[] = [];
    for (let i = 11; i <= 38; i++) outline.push({ x: i, y: 322 }, { x: i, y: 349 }, { x: 11, y: 322 + (i - 11) }, { x: 38, y: 322 + (i - 11) });
    expect(findTravelButton(outline, VIEW)).toBeUndefined();
  });

  it("rejects blobs that are the wrong size or the wrong shape, and a band flooded with blue", () => {
    expect(findTravelButton(disc(45, 450, 60), VIEW)).toBeUndefined();
    expect(findTravelButton(disc(24.5, 335.5, 6), VIEW)).toBeUndefined();
    // A bar: the party frame's own blue edging is nothing like a 28 px square.
    const bar: KeyPoint[] = [];
    for (let y = 300; y < 328; y++) for (let x = 5; x < 85; x++) bar.push({ x, y });
    expect(findTravelButton(bar, VIEW)).toBeUndefined();
    const flood: KeyPoint[] = [];
    for (let i = 0; i <= PARTY_POINT_CAP; i++) flood.push({ x: i % 90, y: 250 + Math.floor(i / 90) });
    expect(flood.length).toBeGreaterThan(PARTY_POINT_CAP);
    expect(findTravelButton([...flood, ...BUTTON], VIEW)).toBeUndefined();
  });

  it("still finds the button when the swirl is broken into pieces by the threshold", () => {
    // Anti-aliased rows drop out at threshold 60: the gaps they leave must still read as one blob.
    const dotted = BUTTON.filter(p => p.y % 4 !== 0);
    expect(dotted.length).toBeLessThan(BUTTON.length);
    expect(findTravelButton(dotted, VIEW)).toMatchObject({ centre: { x: 25, y: 336 } });
  });
});
