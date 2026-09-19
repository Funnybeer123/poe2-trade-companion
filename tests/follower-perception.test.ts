import { describe, expect, it } from "vitest";
import {
  buildNameplateTemplate, calibrationIssue, findNameplate, LeaderTracker, parseFollowerCalibration, templatePixelCount,
  type FollowerCalibration, type WhiteFrame,
} from "../src/core/followerPerception.js";

// SYNTHETIC frames only. These tests prove the algorithm's contract, not accuracy on real gameplay.
const GLYPHS: Record<string, string[]> = {
  A: [".##.", "#..#", "####", "#..#", "#..#"], B: ["###.", "#..#", "###.", "#..#", "###."], E: ["####", "#...", "###.", "#...", "####"],
  L: ["#...", "#...", "#...", "#...", "####"], M: ["#..#", "####", "####", "#..#", "#..#"], N: ["#..#", "##.#", "#.##", "#..#", "#..#"],
  I: ["###.", ".#..", ".#..", ".#..", "###."], R: ["###.", "#..#", "###.", "#.#.", "#..#"],
};
function frame(width: number, height: number, fill = 20): WhiteFrame { return { width, height, pixels: new Uint8Array(width * height).fill(fill) }; }
/** Draws text at 2× scale: each glyph cell becomes a 2×2 block, 10 px per character. */
function draw(f: WhiteFrame, text: string, x: number, y: number, value = 240): void {
  [...text].forEach((ch, i) => GLYPHS[ch].forEach((row, gy) => [...row].forEach((cell, gx) => {
    if (cell !== "#") return;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) f.pixels[(y + gy * 2 + dy) * f.width + x + i * 10 + gx * 2 + dx] = value;
  })));
}
function noise(f: WhiteFrame, seed: number, density: number): void {
  let s = seed;
  for (let i = 0; i < f.pixels.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; if (s / 2 ** 32 < density) f.pixels[i] = 255; }
}
function calibrated(name = "MAINBEAR"): FollowerCalibration {
  const f = frame(640, 360); draw(f, name, 200, 100);
  const { template, nameplate } = buildNameplateTemplate(f, { x: 190, y: 94, width: name.length * 10 + 20, height: 22 });
  return parseFollowerCalibration({ version: 1, targetName: name, view: { width: 640, height: 360 }, searchArea: { x: 0, y: 0, width: 640, height: 360 }, nameplate, template, calibratedAt: "2026-09-19T00:00:00.000Z" });
}

describe("follower nameplate perception (synthetic frames)", () => {
  it("builds a trimmed binary template from the operator's selection", () => {
    const c = calibrated();
    expect(c.nameplate).toEqual({ x: 199, y: 99, width: 80, height: 12 });
    expect(c.template.mask).toHaveLength(12);
    expect(templatePixelCount(c.template)).toBeGreaterThan(200);
  });
  it("rejects selections without text, mostly bright selections, and out-of-frame selections", () => {
    expect(() => buildNameplateTemplate(frame(200, 100), { x: 10, y: 10, width: 100, height: 20 })).toThrow("No bright name text");
    expect(() => buildNameplateTemplate(frame(200, 100, 250), { x: 10, y: 10, width: 100, height: 20 })).toThrow("mostly bright");
    expect(() => buildNameplateTemplate(frame(200, 100), { x: 150, y: 10, width: 100, height: 20 })).toThrow("inside the captured");
    expect(() => buildNameplateTemplate(frame(200, 100), { x: 0, y: 0, width: 8, height: 8 })).toThrow("12–400");
  });
  it("finds the nameplate wherever it moved, over scattered bright clutter", () => {
    const c = calibrated(), f = frame(640, 360); noise(f, 7, .01); draw(f, "MAINBEAR", 411, 233);
    const result = findNameplate(f, c.template);
    expect(result.best).toMatchObject({ x: 410, y: 232 });
    expect(result.best!.score).toBeGreaterThan(.85);
  });
  it("reports nothing on an empty scene, a bright wash, or a loading-screen-like frame", () => {
    const c = calibrated(), washed = frame(640, 360, 250), cluttered = frame(640, 360); noise(cluttered, 3, .2);
    for (const f of [frame(640, 360), washed, cluttered]) expect(findNameplate(f, c.template).best).toBeUndefined();
  });
  it("keeps a different same-length name below the default 85% confidence gate", () => {
    // These blocky glyphs overlap far more than a real font; the raw match is weak evidence, never identity.
    const c = calibrated(), f = frame(640, 360); draw(f, "BRAINLAB", 300, 150);
    const tracker = new LeaderTracker(c), { region, searched } = tracker.nextRegion(0);
    expect(tracker.observe(f, region, searched, 0, { captureMs: 1, matchMs: 1 }).confidence).toBeLessThan(.85);
    const both = frame(640, 360); draw(both, "BRAINLAB", 300, 150); draw(both, "MAINBEAR", 80, 40);
    expect(findNameplate(both, c.template).best).toMatchObject({ x: 79, y: 39 });
  });
  it("loses a half-occluded nameplate rather than guessing", () => {
    const c = calibrated(), f = frame(640, 360); draw(f, "MAINBEAR", 300, 150);
    for (let y = 148; y < 164; y++) f.pixels.fill(20, y * 640 + 335, y * 640 + 390);
    expect(findNameplate(f, c.template).best).toBeUndefined();
  });
  it("drops confidence to zero when two identical nameplates make identity ambiguous", () => {
    const c = calibrated(), f = frame(640, 360); draw(f, "MAINBEAR", 100, 80); draw(f, "MAINBEAR", 400, 260);
    const tracker = new LeaderTracker(c), { region, searched } = tracker.nextRegion(0);
    const seen = tracker.observe(f, region, searched, 0, { captureMs: 1, matchMs: 1 });
    expect(seen.found).toBe(true);
    expect(seen.evidence.candidates).toBe(2);
    expect(seen.confidence).toBe(0);
  });
  it("tracks in a window around the last sighting, re-verifies with periodic full searches, and reacquires after loss", () => {
    const c = calibrated(), tracker = new LeaderTracker(c), timing = { captureMs: 1, matchMs: 1 };
    const crop = (f: WhiteFrame, r: { x: number; y: number; width: number; height: number }): WhiteFrame => {
      const out = frame(r.width, r.height); for (let y = 0; y < r.height; y++) out.pixels.set(f.pixels.subarray((r.y + y) * f.width + r.x, (r.y + y) * f.width + r.x + r.width), y * r.width); return out;
    };
    const step = (now: number, x?: number, y?: number) => {
      const f = frame(640, 360); if (x !== undefined) draw(f, "MAINBEAR", x, y!);
      const next = tracker.nextRegion(now);
      return { next, seen: tracker.observe(crop(f, next.region), next.region, next.searched, now, timing) };
    };
    const first = step(0, 300, 150);
    expect(first.next.searched).toBe("full");
    expect(first.seen).toMatchObject({ found: true, position: { x: 339, y: 155 }, identity: { name: "MAINBEAR", method: "nameplate-template" } });
    expect(first.seen.confidence).toBeGreaterThan(.85);
    const second = step(33, 340, 170);
    expect(second.next).toMatchObject({ searched: "window", region: { x: 139, y: 0 } });
    expect(second.next.region.width).toBeLessThan(640);
    expect(second.seen.position).toEqual({ x: 379, y: 175 });
    expect(step(2100, 340, 170).next.searched).toBe("full");
    for (const now of [2133, 2166]) expect(step(now).seen).toMatchObject({ found: false, confidence: 0 });
    expect(step(2200).next.searched).toBe("window");
    const back = step(2233, 40, 300);
    expect(back.next.searched).toBe("full");
    expect(back.seen.found).toBe(true);
  });
  it("invalidates calibration when the view or the selected character changes", () => {
    const c = calibrated();
    expect(calibrationIssue(c, "MAINBEAR", { width: 640, height: 360 })).toBeUndefined();
    expect(calibrationIssue(c, "MAINBEAR", { width: 1280, height: 720 })).toContain("Game view changed from 640 × 360 to 1280 × 720");
    expect(calibrationIssue(c, "OtherMain")).toContain("calibrate again for OtherMain");
  });
  it("rejects malformed saved calibration", () => {
    const c = calibrated();
    for (const bad of [null, { ...c, version: 2 }, { ...c, targetName: "" }, { ...c, searchArea: { x: 0, y: 0, width: 9999, height: 10 } },
      { ...c, template: { ...c.template, mask: c.template.mask.slice(1) } }, { ...c, template: { ...c.template, mask: c.template.mask.map(r => r.replace(/#/g, "x")) } },
      { ...c, template: { ...c.template, threshold: 5 } }]) expect(() => parseFollowerCalibration(bad)).toThrow("Calibrate again");
  });
  it("searches a synthetic 1920×1080 frame well inside one observation cycle", () => {
    // Generous bound: a sparse synthetic scene is far cheaper than gameplay. Not a gameplay measurement.
    const c = calibrated(), f = frame(1920, 1080); noise(f, 11, .01); draw(f, "MAINBEAR", 1500, 900);
    const started = performance.now(), result = findNameplate(f, c.template), elapsed = performance.now() - started;
    expect(result.best).toMatchObject({ x: 1499, y: 899 });
    expect(elapsed).toBeLessThan(1000);
  });
});
