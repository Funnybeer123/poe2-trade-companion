import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { pngPlane, pngPlanes, pngWhiteness } from "../src/adapters/pngWhiteness.js";
import {
  buildMapCalibration, decodeKeyPoints, findMapLabels, findTemplateSparse, FollowSteering, keyPointsOf, LABEL_LIMITS, mapCalibrationIssue, MapMarkerTracker, ORIGIN_LIMITS, parseMapCalibration,
  type KeyPoint, type MapCalibration, type MapObservation, type SteeringConfig, type SteeringDecision,
} from "../src/core/followerMapMarker.js";
import { buildNameplateTemplate, channelValue, findNameplate, PLANE_CHANNELS, templatePixelCount, type NameplateTemplate, type PixelRect, type WhiteFrame } from "../src/core/followerPerception.js";

// SYNTHETIC frames only. Every plane, label, marker and observation below is drawn by this file.
// These tests prove the algorithms' contracts, not accuracy on real gameplay, and nothing here captures or emits input.
const GLYPHS: Record<string, string[]> = {
  A: [".##.", "#..#", "####", "#..#", "#..#"], B: ["###.", "#..#", "###.", "#..#", "###."], E: ["####", "#...", "###.", "#...", "####"],
  L: ["#...", "#...", "#...", "#...", "####"], M: ["#..#", "####", "####", "#..#", "#..#"], N: ["#..#", "##.#", "#.##", "#..#", "#..#"],
  I: ["###.", ".#..", ".#..", ".#..", "###."], R: ["###.", "#..#", "###.", "#.#.", "#..#"],
};
/** The map marker sprite: a 9 × 7 X, 27 pixels, centred on (left + 4, top + 3). */
const X_MARK = ["##.....##", ".##...##.", "..##.##..", "...###...", "..##.##..", ".##...##.", "##.....##"];
const GREEN = 200, ORANGE = 140, VIEW = { width: 640, height: 360 }, AT = "2026-09-19T00:00:00.000Z", TIMING = { captureMs: 1, matchMs: 1 };
type View = { width: number; height: number };

function plane(width: number, height: number, fill = 0): WhiteFrame { return { width, height, pixels: new Uint8Array(width * height).fill(fill) }; }
function drawMask(f: WhiteFrame, mask: string[], x: number, y: number, value: number): void {
  mask.forEach((row, my) => [...row].forEach((cell, mx) => { if (cell === "#") f.pixels[(y + my) * f.width + x + mx] = value; }));
}
/** Draws text at 2× scale, clipped to the plane: each glyph cell becomes a 2×2 block, 10 px per character, 10 px tall. */
function drawText(f: WhiteFrame, text: string, x: number, y: number, value = GREEN): void {
  [...text].forEach((ch, i) => GLYPHS[ch].forEach((row, gy) => [...row].forEach((cell, gx) => {
    if (cell !== "#") return;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const px = x + i * 10 + gx * 2 + dx, py = y + gy * 2 + dy;
      if (px >= 0 && py >= 0 && px < f.width && py < f.height) f.pixels[py * f.width + px] = value;
    }
  })));
}
function random(seed: number): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
/** Where the game draws the player's own marker: measured at 0.4998 w, 0.4858 h of the client. */
const mapCentre = (view: View): KeyPoint => ({ x: Math.round(view.width * .4998), y: Math.round(view.height * .4858) });

interface Scene { green: WhiteFrame; orange: WhiteFrame }
interface Label { text: string; x: number; y: number; marker?: false | { dx: number; dy: number } }
/** Party labels in green, each with its X marker centred five rows beneath it; the player's orange X centred on `own`. */
function mapScene(labels: Label[], own: KeyPoint | null = mapCentre(VIEW), view: View = VIEW): Scene {
  const green = plane(view.width, view.height), orange = plane(view.width, view.height);
  for (const l of labels) {
    drawText(green, l.text, l.x, l.y);
    if (l.marker !== false) drawMask(green, X_MARK, l.x + l.text.length * 5 - 5 + (l.marker?.dx ?? 0), l.y + 14 + (l.marker?.dy ?? 0), GREEN);
  }
  if (own) drawMask(orange, X_MARK, own.x - 4, own.y - 3, ORANGE);
  return { green, orange };
}
const leaderAt = (x: number, y: number): Label => ({ text: "MAINBEAR", x, y });
/** The label text position that puts the leader's marker centre on `p` (marker centre = text + (39, 17)). */
const leaderMarkerOn = (p: KeyPoint): Label => leaderAt(p.x - 39, p.y - 17);
function calibrated(view: View = VIEW): MapCalibration {
  const s = mapScene([leaderAt(200, 100)], mapCentre(view), view);
  return buildMapCalibration(s.green, s.orange, "MainBear", AT);
}
/** What the native 'key' op returns for a tracker request: sparse above-threshold pixels of each region in client coordinates. */
function step(tracker: MapMarkerTracker, scene: Scene, now: number) {
  const request = tracker.nextRequest(now);
  const seen = tracker.observe(keyPointsOf(scene.green, request.threshold, request.region), keyPointsOf(scene.orange, request.second.threshold, request.second), request.searched, now, TIMING);
  return { request, seen };
}
const contains = (outer: PixelRect, inner: PixelRect) => outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;

function crc(bytes: Buffer): number { let c = ~0; for (const b of bytes) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; }
function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8); head.writeUInt32BE(body.length); head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), body])));
  return Buffer.concat([head, body, tail]);
}
/** Minimal unfiltered 8-bit RGB(A) PNG encoder. */
function png(width: number, height: number, channels: 3 | 4, rgba: (x: number, y: number) => number[]): Buffer {
  const stride = width * channels, raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba(x, y).slice(0, channels).forEach((v, c) => { raw[y * (stride + 1) + 1 + x * channels + c] = v; });
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = channels === 3 ? 2 : 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

describe("colour channels (synthetic pixels)", () => {
  it("computes white = min(R,G,B), green = G − max(R,B) and orange = min(R − G, G − B), never below zero", () => {
    expect(PLANE_CHANNELS).toEqual(["white", "green", "orange"]);
    const cases: Array<[number[], number, number, number]> = [
      // rgb, white, green, orange
      [[240, 250, 230], 230, 10, 0], [[255, 255, 255], 255, 0, 0], [[0, 0, 0], 0, 0, 0], [[128, 128, 128], 128, 0, 0],
      [[40, 230, 60], 40, 170, 0], [[0, 255, 0], 0, 255, 0], [[90, 200, 120], 90, 80, 0], [[10, 200, 250], 10, 0, 0],
      [[240, 140, 30], 30, 0, 100], [[255, 128, 0], 0, 0, 127], [[255, 200, 0], 0, 0, 55], [[255, 60, 0], 0, 0, 60],
      [[255, 0, 0], 0, 0, 0], [[255, 255, 0], 0, 0, 0], [[0, 0, 255], 0, 0, 0], [[200, 100, 150], 100, 0, 0],
    ];
    for (const [[r, g, b], white, green, orange] of cases) {
      expect([channelValue(r, g, b, "white"), channelValue(r, g, b, "green"), channelValue(r, g, b, "orange")], `rgb(${r},${g},${b})`).toEqual([white, green, orange]);
    }
  });
  it("keeps every channel inside one byte and keeps green and orange mutually exclusive, for seeded random colours", () => {
    const next = random(5);
    for (let i = 0; i < 2000; i++) {
      const r = Math.floor(next() * 256), g = Math.floor(next() * 256), b = Math.floor(next() * 256);
      const values = PLANE_CHANNELS.map(c => channelValue(r, g, b, c));
      for (const v of values) { expect(Number.isInteger(v)).toBe(true); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(255); }
      // Green ink needs G above R; orange ink needs R above G: one pixel can never be both.
      expect(Math.min(values[1], values[2])).toBe(0);
    }
  });
  it("decodes several planes from one PNG, in the requested order, identical to the per-pixel formulas", () => {
    const colour = (x: number, y: number) => [(x * 37 + y * 11) & 255, (x * 5 + y * 91 + 140) & 255, (x * y * 7 + 17) & 255, 255];
    for (const channels of [3, 4] as const) {
      const file = png(11, 7, channels, colour), [orange, white, green] = pngPlanes(file, ["orange", "white", "green"]);
      for (const p of [orange, white, green]) { expect(p).toMatchObject({ width: 11, height: 7 }); expect(p.pixels).toHaveLength(77); }
      for (let y = 0; y < 7; y++) for (let x = 0; x < 11; x++) {
        const [r, g, b] = colour(x, y);
        expect([white.pixels[y * 11 + x], green.pixels[y * 11 + x], orange.pixels[y * 11 + x]]).toEqual([channelValue(r, g, b, "white"), channelValue(r, g, b, "green"), channelValue(r, g, b, "orange")]);
      }
      expect(pngPlane(file, "green")).toEqual(green);
      expect(pngPlane(file, "orange")).toEqual(orange);
      expect(pngWhiteness(file)).toEqual(white);
      expect(pngPlanes(file, [])).toEqual([]);
      // Separate planes must not share one buffer.
      expect(white.pixels.buffer).not.toBe(green.pixels.buffer);
    }
  });
  it("turns a synthetic map screenshot into the green and orange planes calibration reads", () => {
    // A green label with its marker, an orange X at the map centre, white HUD text and grey scenery: only map ink survives.
    const s = mapScene([leaderAt(200, 100)]), hud = plane(VIEW.width, VIEW.height); drawText(hud, "BRAINLAB", 40, 300, 1);
    const file = png(VIEW.width, VIEW.height, 3, (x, y) => { const i = y * VIEW.width + x; return s.green.pixels[i] ? [40, 235, 50] : s.orange.pixels[i] ? [245, 140, 35] : hud.pixels[i] ? [250, 250, 250] : [60, 62, 58]; });
    const [green, orange] = pngPlanes(file, ["green", "orange"]);
    expect(findMapLabels(green)).toEqual([{ label: { x: 200, y: 100, width: 78, height: 10 }, marker: { x: 239, y: 117 } }]);
    expect(new MapMarkerTracker(buildMapCalibration(green, orange, "MainBear", AT)).origin).toEqual(mapCentre(VIEW));
  });
  it("rejects files that are not the recorder's PNGs", () => {
    const good = png(4, 4, 3, () => [1, 2, 3]);
    expect(() => pngPlanes(Buffer.from("not a png at all, just thirty-three+ bytes"), ["green"])).toThrow("Not a PNG");
    expect(() => pngPlanes(good.subarray(0, 40), ["green"])).toThrow();
    const palette = Buffer.from(good); palette[25] = 3;
    expect(() => pngPlanes(palette, ["green"])).toThrow("Unsupported PNG");
  });
});

describe("sparse marker pixels (synthetic)", () => {
  const encode = (points: KeyPoint[]) => { const b = Buffer.alloc(points.length * 4); points.forEach((p, i) => { b.writeUInt16LE(p.x, i * 4); b.writeUInt16LE(p.y, i * 4 + 2); }); return b.toString("base64"); };
  it("round-trips base64 UInt16 LE x,y pairs, including the corners of the coordinate range", () => {
    const next = random(9), points: KeyPoint[] = [{ x: 0, y: 0 }, { x: 65535, y: 65535 }, { x: 2559, y: 1439 }, { x: 256, y: 1 }, { x: 1, y: 256 }];
    for (let i = 0; i < 500; i++) points.push({ x: Math.floor(next() * 8192), y: Math.floor(next() * 8192) });
    expect(decodeKeyPoints(encode(points))).toEqual(points);
    expect(decodeKeyPoints("")).toEqual([]);
    // Byte order is little-endian x then y.
    expect(decodeKeyPoints(Buffer.from([0x34, 0x12, 0x78, 0x56]).toString("base64"))).toEqual([{ x: 0x1234, y: 0x5678 }]);
    // Same pixels as a dense threshold of the plane, in raster order.
    const f = plane(40, 20); drawMask(f, X_MARK, 7, 5, GREEN);
    expect(decodeKeyPoints(encode(keyPointsOf(f, 80)))).toEqual(keyPointsOf(f, 80));
  });
  it("rejects a missing or torn pixel list rather than guessing", () => {
    for (const bad of [undefined, null, 42, {}, ["AAAA"], Buffer.from([1, 2, 3, 4])]) expect(() => decodeKeyPoints(bad)).toThrow("no marker pixels");
    for (const bytes of [1, 2, 3, 5, 6, 7, 401]) expect(() => decodeKeyPoints(Buffer.alloc(bytes).toString("base64"))).toThrow("malformed marker pixels");
  });
  it("lists exactly the above-threshold pixels of a plane or of one region of it", () => {
    const f = plane(60, 30, 10); drawMask(f, X_MARK, 20, 10, GREEN); f.pixels[0] = 80; f.pixels[1] = 79;
    expect(keyPointsOf(f, 80)).toHaveLength(28);
    expect(keyPointsOf(f, 80)[0]).toEqual({ x: 0, y: 0 });
    expect(keyPointsOf(f, 80, { x: 20, y: 10, width: 9, height: 7 })).toHaveLength(27);
    expect(keyPointsOf(f, 80, { x: 20, y: 10, width: 9, height: 1 })).toEqual([{ x: 20, y: 10 }, { x: 21, y: 10 }, { x: 27, y: 10 }, { x: 28, y: 10 }]);
    expect(keyPointsOf(f, 201)).toEqual([]);
  });
});

describe("sparse template matcher (synthetic scenes)", () => {
  const NAMES = ["MAINBEAR", "BRAINLAB", "LIMNER", "MARLIN", "ANNABEL", "MIRABEL", "MEB", "BEN"];
  function templateOf(name: string): NameplateTemplate {
    const f = plane(name.length * 10 + 40, 40); drawText(f, name, 20, 15);
    return buildNameplateTemplate(f, { x: 14, y: 11, width: name.length * 10 + 10, height: 18 }, LABEL_LIMITS).template;
  }
  /**
   * A seeded random scene: dim scenery, bright clutter, usually the target label, and up to two extras
   * (a twin, a same-length rival, or a half-covered copy). With `edge` false all ink stays a template
   * away from the frame edge; with `edge` true labels may touch, straddle or leave the frame.
   */
  function randomScene(seed: number, edge: boolean): { name: string; template: NameplateTemplate; frame: WhiteFrame } {
    const next = random(seed * 7919), pick = (n: number) => Math.floor(next() * n);
    const name = NAMES[pick(NAMES.length)], template = templateOf(name), tw = template.width, th = template.height, rivals = NAMES.filter(n => n.length === name.length);
    const width = tw * 3 + 40 + pick(200), height = th * 3 + 30 + pick(120), frame = plane(width, height, pick(40)), mx = edge ? 0 : tw, my = edge ? 0 : th;
    const place = () => edge ? { x: pick(width + tw) - tw, y: pick(height + th) - th } : { x: tw + pick(width - 3 * tw), y: th + pick(height - 3 * th) };
    const density = next() * .02;
    for (let y = my; y < height - my; y++) for (let x = mx; x < width - mx; x++) if (next() < density) frame.pixels[y * width + x] = 120 + pick(136);
    if (next() < .7) { const p = place(); drawText(frame, name, p.x, p.y, 150 + pick(100)); }
    for (let extra = pick(3); extra > 0; extra--) {
      const p = place(), kind = pick(3), from = Math.max(0, p.x + pick(tw / 2)), to = Math.min(width, p.x + tw / 2 + pick(tw / 2));
      drawText(frame, kind === 0 ? name : rivals[pick(rivals.length)], p.x, p.y, 150 + pick(100));
      // A third of the extras are half covered by dark scenery.
      if (kind === 2 && from < to) for (let y = Math.max(0, p.y); y < Math.min(height, p.y + 10); y++) frame.pixels.fill(0, y * width + from, y * width + to);
    }
    return { name, template, frame };
  }
  /** The dense matcher over the same plane extended with empty pixels on every side: no frame edge to stop an anchor. */
  function findNameplateUnbounded(f: WhiteFrame, template: NameplateTemplate) {
    const tw = template.width, th = template.height, padded = plane(f.width + 2 * tw, f.height + 2 * th);
    for (let y = 0; y < f.height; y++) padded.pixels.set(f.pixels.subarray(y * f.width, (y + 1) * f.width), (y + th) * padded.width + tw);
    const search = findNameplate(padded, template);
    return search.best ? { ...search, best: { ...search.best, x: search.best.x - tw, y: search.best.y - th } } : search;
  }
  it("PROPERTY: agrees with the dense matcher on best position, score, runner-up and candidate count across seeded random scenes", () => {
    let found = 0, ambiguous = 0, empty = 0;
    for (let seed = 1; seed <= 200; seed++) {
      // Ink stays a template away from the frame edge here; the edge itself is covered by the next three tests.
      const { name, template, frame } = randomScene(seed, false);
      const dense = findNameplate(frame, template), sparse = findTemplateSparse(keyPointsOf(frame, template.threshold), template);
      expect(sparse, `seed ${seed}: ${name} in ${frame.width} × ${frame.height}`).toEqual(dense);
      if (!dense.best) empty++; else { found++; if (dense.candidates > 1) ambiguous++; }
    }
    // The generator must actually exercise found, not-found and ambiguous scenes.
    expect({ found: found > 100, empty: empty > 15, ambiguous: ambiguous > 15 }, `found ${found}, empty ${empty}, ambiguous ${ambiguous}`).toEqual({ found: true, empty: true, ambiguous: true });
  }, 60_000);
  it("PROPERTY: with labels touching or straddling the frame edge, agrees with the dense matcher over the plane extended by empty pixels", () => {
    // Sparse points carry no frame, so anchors may overhang it: exactly the dense search without a frame edge.
    let overhanging = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const { name, template, frame } = randomScene(seed, true);
      const dense = findNameplateUnbounded(frame, template), sparse = findTemplateSparse(keyPointsOf(frame, template.threshold), template);
      expect(sparse, `seed ${seed}: ${name} in ${frame.width} × ${frame.height}`).toEqual(dense);
      if (sparse.best && (sparse.best.x < 0 || sparse.best.y < 0 || sparse.best.x + template.width > frame.width || sparse.best.y + template.height > frame.height)) overhanging++;
    }
    expect(overhanging).toBeGreaterThan(10);
  }, 60_000);
  // SUSPECTED SOURCE DIVERGENCE (reported; source untouched). findTemplateSparse is documented as "the same
  // Dice-scored template search as findNameplate", but it also scores anchors that overhang the frame. Templates
  // carry a one-pixel dark border, so a fully visible label flush against the view edge scores 1 at x = −1 in the
  // sparse matcher while the dense one can only offer a shifted alignment (0.70 at x = 0 here); a label cut by the
  // edge is matched at its true, partly off-frame position by the sparse matcher only. Off-frame pixels can never
  // count as surplus ink, so a clipped label also scores higher than the same ink would with neighbours in view.
  // This test states the documented contract (identical results). Remove `.fails` once the two are reconciled.
  it.fails("agrees with the dense matcher for a label flush against, or clipped by, the frame edge", () => {
    const template = templateOf("MAINBEAR");
    for (const x of [0, -24, 245]) {
      const f = plane(300, 60); drawText(f, "MAINBEAR", x, 20);
      expect(findTemplateSparse(keyPointsOf(f, template.threshold), template), `label at x = ${x}`).toEqual(findNameplate(f, template));
    }
  });
  it("places a label clipped by the view edge where it really is, with a score that drops as more of it is cut off", () => {
    const template = templateOf("MAINBEAR"), scores: number[] = [];
    for (const x of [0, -8, -16, -24, -32]) {
      const f = plane(300, 60); drawText(f, "MAINBEAR", x, 20);
      const best = findTemplateSparse(keyPointsOf(f, template.threshold), template).best;
      expect(best, `label at x = ${x}`).toMatchObject({ x: x - 1, y: 19 });
      scores.push(best!.score);
    }
    expect(scores[0]).toBe(1);
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeLessThan(scores[i - 1]);
    // Most of the label gone: no match, however clean what remains.
    const f = plane(300, 60); drawText(f, "MAINBEAR", -50, 20);
    expect(findTemplateSparse(keyPointsOf(f, template.threshold), template).best).toBeUndefined();
  });
  it("PROPERTY: agrees with the dense matcher for a custom minimum score, as origin verification uses", () => {
    const shape = buildNameplateTemplate((() => { const f = plane(40, 30); drawMask(f, X_MARK, 15, 10, ORANGE); return f; })(), { x: 12, y: 8, width: 15, height: 11 }, ORIGIN_LIMITS).template;
    expect(shape).toMatchObject({ width: 11, height: 9, threshold: 30 });
    for (let seed = 1; seed <= 60; seed++) {
      const next = random(seed * 104729), pick = (n: number) => Math.floor(next() * n), f = plane(90, 80);
      for (let n = pick(3); n >= 0; n--) drawMask(f, X_MARK, 12 + pick(56), 10 + pick(52), 40 + pick(200));
      for (let n = pick(40); n > 0; n--) f.pixels[(10 + pick(60)) * 90 + 12 + pick(64)] = 255;
      expect(findTemplateSparse(keyPointsOf(f, shape.threshold), shape, .5), `seed ${seed}`).toEqual(findNameplate(f, shape, .5));
    }
  });
  it("finds nothing in no pixels, in clutter, or with an empty template", () => {
    const template = templateOf("MAINBEAR"), next = random(3), clutter: KeyPoint[] = [];
    for (let i = 0; i < 1500; i++) clutter.push({ x: Math.floor(next() * 300), y: Math.floor(next() * 100) });
    expect(findTemplateSparse([], template)).toEqual({ runnerUp: 0, candidates: 0 });
    expect(findTemplateSparse(clutter, template).best).toBeUndefined();
    expect(findTemplateSparse([{ x: 1, y: 1 }], { width: 3, height: 3, threshold: 60, mask: ["...", "...", "..."] })).toEqual({ runnerUp: 0, candidates: 0 });
  });
  it("matches in client coordinates when given only the pixels of a capture window", () => {
    const template = templateOf("MAINBEAR"), f = plane(640, 360); drawText(f, "MAINBEAR", 411, 233);
    const window = { x: 300, y: 150, width: 300, height: 200 };
    expect(findTemplateSparse(keyPointsOf(f, template.threshold, window), template).best).toMatchObject({ x: 410, y: 232, score: 1, matchedPixels: templatePixelCount(template) });
  });
  it("loses a half-occluded label and reports two identical labels as two candidates", () => {
    const template = templateOf("MAINBEAR"), half = plane(640, 360), twice = plane(640, 360);
    drawText(half, "MAINBEAR", 300, 150); for (let y = 148; y < 164; y++) half.pixels.fill(0, y * 640 + 335, y * 640 + 390);
    expect(findTemplateSparse(keyPointsOf(half, template.threshold), template).best).toBeUndefined();
    drawText(twice, "MAINBEAR", 100, 80); drawText(twice, "MAINBEAR", 400, 260);
    expect(findTemplateSparse(keyPointsOf(twice, template.threshold), template)).toMatchObject({ best: { x: 99, y: 79 }, runnerUp: 1, candidates: 2 });
  });
});

describe("overlay-map labels (synthetic green planes)", () => {
  it("pairs a text-like label with the X marker beneath it", () => {
    const { green } = mapScene([leaderAt(200, 100)]);
    expect(findMapLabels(green)).toEqual([{ label: { x: 200, y: 100, width: 78, height: 10 }, marker: { x: 239, y: 117 } }]);
  });
  it("finds every party member and ignores ink below the threshold", () => {
    const { green } = mapScene([leaderAt(60, 40), { text: "BRAINLAB", x: 400, y: 250 }]);
    drawText(green, "ANNABEL", 300, 60, 70); drawMask(green, X_MARK, 330, 74, 70);
    const pairs = findMapLabels(green).sort((a, b) => a.label.x - b.label.x);
    expect(pairs.map(p => p.marker)).toEqual([{ x: 99, y: 57 }, { x: 439, y: 267 }]);
    expect(findMapLabels(green, 60)).toHaveLength(3);
  });
  it("rejects a lone label, a lone marker, and an empty plane", () => {
    expect(findMapLabels(plane(640, 360))).toEqual([]);
    expect(findMapLabels(mapScene([{ ...leaderAt(200, 100), marker: false }]).green)).toEqual([]);
    const lone = plane(640, 360); drawMask(lone, X_MARK, 300, 200, GREEN);
    expect(findMapLabels(lone)).toEqual([]);
  });
  it("rejects a marker that is not directly beneath the label, and text too short to be a name", () => {
    expect(findMapLabels(mapScene([{ ...leaderAt(200, 100), marker: { dx: 0, dy: 9 } }]).green)).toEqual([]);      // 14 rows below the text
    expect(findMapLabels(mapScene([{ ...leaderAt(200, 100), marker: { dx: 30, dy: 0 } }]).green)).toEqual([]);     // off to one side
    expect(findMapLabels(mapScene([{ ...leaderAt(200, 100), marker: { dx: 0, dy: -40 } }]).green)).toEqual([]);    // above the text
    expect(findMapLabels(mapScene([{ ...leaderAt(200, 100), marker: { dx: 10, dy: 6 } }]).green)).toHaveLength(1); // still beneath
    expect(findMapLabels(mapScene([{ text: "AB", x: 200, y: 100 }]).green)).toEqual([]);
  });
  it("refuses to cluster a screen full of saturated green", () => {
    const f = plane(640, 360); for (let y = 100; y < 160; y++) f.pixels.fill(GREEN, y * 640 + 100, y * 640 + 160);
    expect(() => findMapLabels(f)).toThrow("Too much saturated green");
  });
});

describe("map calibration (synthetic planes)", () => {
  it("calibrates from one frame: label template, marker offset, and the player's own marker at the map centre", () => {
    const c = calibrated();
    expect(c).toMatchObject({ version: 1, targetName: "MainBear", view: VIEW, calibratedAt: AT, markerOffset: { dx: 40, dy: 18 }, originAnchor: { x: 315, y: 171 } });
    expect(c.label).toMatchObject({ width: 80, height: 12, threshold: LABEL_LIMITS.minThreshold });
    expect(c.originTemplate).toMatchObject({ width: 11, height: 9, threshold: ORIGIN_LIMITS.minThreshold });
    expect(c.originTemplate.mask.slice(1, -1).map(row => row.slice(1, -1))).toEqual(X_MARK);
    expect(templatePixelCount(c.label)).toBeGreaterThan(200);
    expect(new MapMarkerTracker(c).origin).toEqual({ x: 320, y: 175 });
    // Survives the JSON round trip the drive service performs, as an independent copy.
    const saved = parseMapCalibration(JSON.parse(JSON.stringify(c)));
    expect(saved).toEqual(c);
    saved.label.mask[0] = "changed"; expect(c.label.mask[0]).not.toBe("changed");
  });
  it("puts the origin on the measured map centre at 1920 × 1080 and 2560 × 1440", () => {
    for (const view of [{ width: 1920, height: 1080 }, { width: 2560, height: 1440 }]) {
      const c = calibrated(view), origin = new MapMarkerTracker(c).origin;
      expect(origin).toEqual(mapCentre(view));
      expect(Math.abs(origin.x - view.width * .4998)).toBeLessThanOrEqual(.5);
      expect(Math.abs(origin.y - view.height * .4858)).toBeLessThanOrEqual(.5);
      expect(c.view).toEqual(view);
    }
  });
  it("keeps the label and marker templates apart when the marker sits as close beneath the label as clustering allows", () => {
    // Three rows between label and marker (closer ink would be one cluster). The marker may be offset and the label elsewhere.
    const s = mapScene([{ ...leaderAt(420, 40), marker: { dx: -6, dy: -2 } }]), c = buildMapCalibration(s.green, s.orange, "MainBear", AT);
    expect(c).toMatchObject({ markerOffset: { dx: 34, dy: 16 }, originAnchor: { x: 315, y: 171 }, label: calibrated().label, originTemplate: calibrated().originTemplate });
  });
  it("needs a character name and planes of one size", () => {
    const s = mapScene([leaderAt(200, 100)]);
    expect(() => buildMapCalibration(s.green, s.orange, "", AT)).toThrow("Enter and save the character");
    expect(() => buildMapCalibration(s.green, plane(640, 361), "MainBear", AT)).toThrow("planes differ in size");
    expect(() => buildMapCalibration(s.green, plane(641, 360), "MainBear", AT)).toThrow("planes differ in size");
  });
  it("refuses zero labels, and two labels until the operator selects one", () => {
    const none = mapScene([]), two = mapScene([leaderAt(60, 40), { text: "BRAINLAB", x: 400, y: 250 }]);
    expect(() => buildMapCalibration(none.green, none.orange, "MainBear", AT)).toThrow("No party label found on the overlay map");
    expect(() => buildMapCalibration(two.green, two.orange, "MainBear", AT)).toThrow("Found 2 party labels on the overlay map. Calibrate while MainBear is the only other party member");
    expect(() => buildMapCalibration(two.green, two.orange, "MainBear", AT, { x: 250, y: 150, width: 60, height: 30 })).toThrow("found in the selection");
    const first = buildMapCalibration(two.green, two.orange, "MainBear", AT, { x: 50, y: 30, width: 100, height: 30 });
    const second = buildMapCalibration(two.green, two.orange, "BrainLab", AT, { x: 430, y: 255, width: 8, height: 4 });
    expect(first.label).toEqual(calibrated().label);
    expect(second.label).not.toEqual(first.label);
    expect(second).toMatchObject({ targetName: "BrainLab", markerOffset: { dx: 40, dy: 18 }, originAnchor: first.originAnchor });
    // Each calibration finds its own label, not the other party member's.
    const tracker = new MapMarkerTracker(second);
    expect(step(tracker, two, 0).seen).toMatchObject({ leaderFound: true, leader: { x: 439, y: 267 } });
  });
  it("throws when the player's own orange marker is missing or is not at the map centre", () => {
    const missing = mapScene([leaderAt(200, 100)], null);
    expect(() => buildMapCalibration(missing.green, missing.orange, "MainBear", AT)).toThrow("Could not find your own marker at the centre");
    // Shifted by an open side panel, drawn in the corner minimap, or sitting on the true view centre below the map centre.
    for (const own of [{ x: 360, y: 175 }, { x: 160, y: 175 }, { x: 320, y: 215 }, { x: 590, y: 50 }, { x: 320, y: 140 }]) {
      const s = mapScene([leaderAt(200, 100)], own);
      expect(() => buildMapCalibration(s.green, s.orange, "MainBear", AT), `own marker at ${own.x},${own.y}`).toThrow("Could not find your own marker at the centre");
    }
    // Orange ink of another shape at the centre is not the marker either.
    const blob = mapScene([leaderAt(200, 100)], null); for (let y = 170; y < 181; y++) blob.orange.pixels.fill(ORANGE, y * 640 + 314, y * 640 + 327);
    expect(() => buildMapCalibration(blob.green, blob.orange, "MainBear", AT)).toThrow("Could not find your own marker at the centre");
  });
  it("rejects malformed saved calibration", () => {
    const c = calibrated(), dots = (t: NameplateTemplate) => ({ ...t, mask: t.mask.map(r => r.replace(/#/g, ".")) });
    const huge = { width: 41, height: 41, threshold: 30, mask: Array.from({ length: 41 }, (_, y) => (y % 2 ? "#." : ".#").repeat(21).slice(0, 41)) };
    const bad: unknown[] = [null, undefined, "calibration", 7, [], { ...c, version: 2 }, { ...c, targetName: "" }, { ...c, targetName: 5 }, { ...c, targetName: "x".repeat(81) }, { ...c, calibratedAt: "x".repeat(41) }, { ...c, calibratedAt: undefined },
      { ...c, view: undefined }, { ...c, view: { width: 319, height: 360 } }, { ...c, view: { width: 640, height: 239 } }, { ...c, view: { width: 640.5, height: 360 } }, { ...c, view: { width: 8193, height: 360 } },
      { ...c, label: undefined }, { ...c, label: { ...c.label, threshold: LABEL_LIMITS.minThreshold - 1 } }, { ...c, label: { ...c.label, threshold: LABEL_LIMITS.maxThreshold + 1 } }, { ...c, label: { ...c.label, threshold: 60.5 } },
      { ...c, label: { ...c.label, mask: c.label.mask.slice(1) } }, { ...c, label: { ...c.label, mask: c.label.mask.map(r => r.slice(1)) } }, { ...c, label: { ...c.label, mask: c.label.mask.map(r => r.replace(/#/g, "x")) } },
      { ...c, label: { ...c.label, mask: "nope" } }, { ...c, label: dots(c.label) }, { ...c, label: { ...c.label, width: 405, mask: c.label.mask.map(r => r.padEnd(405, ".")) } },
      { ...c, originTemplate: undefined }, { ...c, originTemplate: { ...c.originTemplate, threshold: ORIGIN_LIMITS.minThreshold - 1 } }, { ...c, originTemplate: dots(c.originTemplate) }, { ...c, originTemplate: huge },
      { ...c, markerOffset: undefined }, { ...c, markerOffset: { dx: .5, dy: 18 } }, { ...c, markerOffset: { dx: 40, dy: -1 } }, { ...c, markerOffset: { dx: 40, dy: 121 } }, { ...c, markerOffset: { dx: 405, dy: 18 } }, { ...c, markerOffset: { dx: -405, dy: 18 } },
      { ...c, originAnchor: undefined }, { ...c, originAnchor: { x: 19, y: 171 } }, { ...c, originAnchor: { x: 315, y: 19 } }, { ...c, originAnchor: { x: 315.5, y: 171 } },
      { ...c, originAnchor: { x: 640 - 11 - 19, y: 171 } }, { ...c, originAnchor: { x: 315, y: 360 - 9 - 19 } }];
    bad.forEach((raw, i) => expect(() => parseMapCalibration(raw), `malformed case ${i}`).toThrow("Saved map calibration is invalid. Calibrate again."));
    // The nearest valid neighbours of the rejected edges parse.
    expect(parseMapCalibration({ ...c, originAnchor: { x: 20, y: 20 } }).originAnchor).toEqual({ x: 20, y: 20 });
    expect(parseMapCalibration({ ...c, originAnchor: { x: 640 - 11 - 20, y: 360 - 9 - 20 } }).originAnchor).toEqual({ x: 609, y: 331 });
    expect(parseMapCalibration({ ...c, markerOffset: { dx: -404, dy: 120 } }).markerOffset).toEqual({ dx: -404, dy: 120 });
    expect(parseMapCalibration({ ...c, extra: "ignored" })).toEqual(c);
  });
  it("invalidates calibration when the view or the selected character changes", () => {
    const c = calibrated();
    expect(mapCalibrationIssue(c, "MainBear")).toBeUndefined();
    expect(mapCalibrationIssue(c, "MainBear", { width: 640, height: 360 })).toBeUndefined();
    expect(mapCalibrationIssue(c, "MainBear", { width: 1280, height: 720 })).toContain("Game view changed from 640 × 360 to 1280 × 720");
    expect(mapCalibrationIssue(c, "MainBear", { width: 640, height: 361 })).toContain("Calibrate again");
    expect(mapCalibrationIssue(c, "OtherMain")).toBe("Map calibrated for MainBear; calibrate again for OtherMain.");
    expect(mapCalibrationIssue(c, "mainbear")).toContain("calibrate again for mainbear");
    expect(mapCalibrationIssue(c, "")).toContain("calibrate again for the selected character");
  });
});

describe("map marker tracker (synthetic key pixels)", () => {
  it("searches the full view first, then a window that contains the label, and reports the leader relative to the map centre", () => {
    const c = calibrated(), tracker = new MapMarkerTracker(c);
    const first = step(tracker, mapScene([leaderAt(200, 100)]), 0);
    expect(first.request).toMatchObject({ full: true, searched: "full", channel: "green", threshold: c.label.threshold, region: { x: 0, y: 0, width: 640, height: 360 } });
    expect(first.request.second).toEqual({ x: 295, y: 151, width: 51, height: 49, channel: "orange", threshold: c.originTemplate.threshold });
    expect(first.seen).toMatchObject({ capturedAt: 0, view: VIEW, identity: { name: "MainBear", method: "map-label-template" }, leaderFound: true, origin: { x: 320, y: 175 }, leader: { x: 239, y: 117 },
      offset: { dx: -81, dy: -58, distance: 99.6 }, confidence: 1, originVerified: true, evidence: { score: 1, runnerUp: 0, candidates: 1, originScore: 1, originSeenAgoMs: 0, searched: "full", overflow: false }, timing: TIMING });
    expect(first.seen.evidence.keyPixels).toBe(keyPointsOf(mapScene([leaderAt(200, 100)]).green, c.label.threshold).length);
    const second = step(tracker, mapScene([leaderAt(230, 120)]), 33);
    expect(second.request).toMatchObject({ full: false, searched: "window", region: { x: 103, y: 3, width: 272, height: 204 } });
    expect(contains(second.request.region, { x: 199, y: 99, width: c.label.width, height: c.label.height })).toBe(true);
    expect(second.seen).toMatchObject({ leaderFound: true, leader: { x: 269, y: 137 }, evidence: { searched: "window" } });
    const third = step(tracker, mapScene([leaderAt(230, 120)]), 66);
    expect(contains(third.request.region, { x: 229, y: 119, width: c.label.width, height: c.label.height })).toBe(true);
    expect(third.request.second).toEqual(first.request.second);
  });
  it("clamps the tracking window to the view at every corner", () => {
    const c = calibrated();
    for (const at of [{ x: 3, y: 3 }, { x: 559, y: 3 }, { x: 3, y: 330 }, { x: 559, y: 330 }]) {
      const tracker = new MapMarkerTracker(c), scene = mapScene([leaderAt(at.x, at.y)]);
      expect(step(tracker, scene, 0).seen.leaderFound).toBe(true);
      const { request, seen } = step(tracker, scene, 33), r = request.region;
      expect(request.searched).toBe("window");
      expect(r.x >= 0 && r.y >= 0 && r.x + r.width <= 640 && r.y + r.height <= 360 && r.width > 0 && r.height > 0).toBe(true);
      expect(contains(r, { x: at.x - 1, y: at.y - 1, width: c.label.width, height: c.label.height })).toBe(true);
      expect(seen.leaderFound).toBe(true);
    }
  });
  it("runs a full search at least every 1000 ms while tracking", () => {
    const tracker = new MapMarkerTracker(calibrated()), scene = mapScene([leaderAt(200, 100)]);
    expect(step(tracker, scene, 0).request.full).toBe(true);
    expect(step(tracker, scene, 999).request.full).toBe(false);
    expect(step(tracker, scene, 1000).request.full).toBe(true);
    // Whenever 1000 ms have passed since the last full request, this request must be full; between them it tracks in a window.
    let lastFull = 1000, fulls = 0, windows = 0;
    for (let now = 1033; now <= 5000; now += 33) {
      const { request, seen } = step(tracker, scene, now);
      if (request.full) { lastFull = now; fulls++; } else windows++;
      expect(now - lastFull, `at ${now} ms`).toBeLessThan(1000);
      expect(seen.leaderFound).toBe(true);
    }
    expect({ fulls, windows }).toEqual({ fulls: 3, windows: 118 });
  }, 30_000);
  it("keeps the window for two misses, then searches the full view and reacquires the leader anywhere", () => {
    const tracker = new MapMarkerTracker(calibrated()), gone = mapScene([]);
    expect(step(tracker, mapScene([leaderAt(200, 100)]), 0).seen.leaderFound).toBe(true);
    for (const now of [33, 66, 99]) {
      const { request, seen } = step(tracker, gone, now);
      expect(request.searched).toBe("window");
      expect(seen).toMatchObject({ leaderFound: false, confidence: 0, leader: undefined, offset: undefined });
    }
    // A jump far outside the old window is only visible to a full search.
    const back = step(tracker, mapScene([leaderAt(500, 300)]), 132);
    expect(back.request.searched).toBe("full");
    expect(back.seen).toMatchObject({ leaderFound: true, leader: { x: 539, y: 317 } });
    expect(step(tracker, mapScene([leaderAt(500, 300)]), 165).request).toMatchObject({ searched: "window", region: { x: 403, y: 203 } });
  });
  it("searches the full view again at once after a full search finds nothing, and treats pixel overflow as no observation", () => {
    const tracker = new MapMarkerTracker(calibrated());
    for (const now of [0, 33, 66]) expect(step(tracker, mapScene([]), now).request.searched).toBe("full");
    // Overflow: the capture worker saw too many pixels to list. Nothing is matched and the origin is not refreshed.
    const request = tracker.nextRequest(99), overflow = tracker.observe(undefined, undefined, request.searched, 99, TIMING);
    expect(overflow).toMatchObject({ leaderFound: false, leader: undefined, offset: undefined, confidence: 0, evidence: { score: 0, overflow: true, keyPixels: 0, originScore: 0, originSeenAgoMs: 33, searched: "full" } });
    expect(new FollowSteering({ stopPx: 30, resumePx: 36, clickIntervalMs: 110, mapScale: 7, confidence: .85 }).decide(overflow, 99).kind).toBe("hold");
    const fresh = new MapMarkerTracker(calibrated());
    expect(fresh.observe(undefined, undefined, fresh.nextRequest(0).searched, 0, TIMING)).toMatchObject({ leaderFound: false, originVerified: false, evidence: { overflow: true, originSeenAgoMs: null } });
    // Only the orange list overflowing keeps the label but lets the origin go stale.
    const green = keyPointsOf(mapScene([leaderAt(200, 100)]).green, 60);
    expect(tracker.observe(green, undefined, tracker.nextRequest(1700).searched, 1700, TIMING)).toMatchObject({ leaderFound: true, originVerified: false, evidence: { overflow: false, originSeenAgoMs: 1634 } });
    expect(step(tracker, mapScene([leaderAt(200, 100)]), 1733).seen).toMatchObject({ leaderFound: true, originVerified: true });
  });
  it("drops confidence to zero when two identical labels make identity ambiguous, and keeps another member's label under the gate", () => {
    const c = calibrated();
    const twins = step(new MapMarkerTracker(c), mapScene([leaderAt(60, 40), leaderAt(400, 250)]), 0).seen;
    expect(twins).toMatchObject({ leaderFound: true, confidence: 0, evidence: { candidates: 2, runnerUp: 1 } });
    const other = step(new MapMarkerTracker(c), mapScene([{ text: "BRAINLAB", x: 400, y: 250 }]), 0).seen;
    expect(other.confidence).toBeLessThan(.85);
    const both = step(new MapMarkerTracker(c), mapScene([{ text: "BRAINLAB", x: 400, y: 250 }, leaderAt(60, 40)]), 0).seen;
    expect(both).toMatchObject({ leaderFound: true, leader: { x: 99, y: 57 } });
  });
  it("verifies the origin while the player's orange marker is within 5 px of where calibration put it", () => {
    const c = calibrated(), centre = mapCentre(VIEW);
    for (const [dx, dy] of [[0, 0], [5, 0], [-5, 0], [0, 5], [0, -5], [5, -5]]) {
      const seen = step(new MapMarkerTracker(c), mapScene([leaderAt(200, 100)], { x: centre.x + dx, y: centre.y + dy }), 0).seen;
      expect(seen, `own marker displaced ${dx},${dy}`).toMatchObject({ originVerified: true, origin: centre, evidence: { originScore: 1, originSeenAgoMs: 0 } });
    }
  });
  it("does not verify the origin when the orange marker is displaced more than 5 px or was never seen", () => {
    const c = calibrated(), centre = mapCentre(VIEW);
    for (const [dx, dy] of [[6, 0], [-6, 0], [0, 6], [0, -6], [12, 9], [-18, -18]]) {
      const seen = step(new MapMarkerTracker(c), mapScene([leaderAt(200, 100)], { x: centre.x + dx, y: centre.y + dy }), 0).seen;
      // The marker is seen (it scores) but it is not in place, so the map centre cannot be trusted.
      expect(seen, `own marker displaced ${dx},${dy}`).toMatchObject({ leaderFound: true, originVerified: false, evidence: { originScore: 1, originSeenAgoMs: null } });
    }
    expect(step(new MapMarkerTracker(c), mapScene([leaderAt(200, 100)], null), 0).seen).toMatchObject({ originVerified: false, evidence: { originScore: 0, originSeenAgoMs: null } });
    expect(step(new MapMarkerTracker(c), mapScene([leaderAt(200, 100)], { x: 420, y: 175 }), 0).seen.originVerified).toBe(false);
  });
  it("trusts a hidden origin for 1500 ms, withdraws a displaced one at once, and restores either when the marker is back in place", () => {
    const c = calibrated(), centre = mapCentre(VIEW), absent = mapScene([leaderAt(200, 100)], null), shifted = mapScene([leaderAt(200, 100)], { x: centre.x + 9, y: centre.y });
    const hiddenTracker = new MapMarkerTracker(c);
    expect(step(hiddenTracker, mapScene([leaderAt(200, 100)]), 100).seen.originVerified).toBe(true);
    // Effects can wash the marker out for a moment: absence alone is tolerated briefly.
    expect(step(hiddenTracker, absent, 800).seen).toMatchObject({ originVerified: true, evidence: { originSeenAgoMs: 700 } });
    expect(step(hiddenTracker, absent, 1600).seen).toMatchObject({ originVerified: true, evidence: { originSeenAgoMs: 1500 } });
    expect(step(hiddenTracker, absent, 1601).seen).toMatchObject({ leaderFound: true, originVerified: false, evidence: { originSeenAgoMs: 1501 } });
    expect(step(hiddenTracker, absent, 9000).seen.originVerified).toBe(false);
    expect(step(hiddenTracker, mapScene([leaderAt(200, 100)]), 9033).seen).toMatchObject({ originVerified: true, evidence: { originSeenAgoMs: 0 } });
    // The marker turning up somewhere else is positive evidence that the map centre moved: no grace period.
    const movedTracker = new MapMarkerTracker(c);
    expect(step(movedTracker, mapScene([leaderAt(200, 100)]), 100).seen.originVerified).toBe(true);
    expect(step(movedTracker, shifted, 133).seen).toMatchObject({ leaderFound: true, originVerified: false, evidence: { originSeenAgoMs: null } });
    expect(step(movedTracker, mapScene([leaderAt(200, 100)]), 166).seen).toMatchObject({ originVerified: true, evidence: { originSeenAgoMs: 0 } });
  });
  it("withdraws the map centre at once when the leader's label jumps farther than a marker can travel between captures", () => {
    const c = calibrated(), tracker = new MapMarkerTracker(c);
    expect(step(tracker, mapScene([leaderAt(200, 100)]), 0).seen.originVerified).toBe(true);
    // A side panel opened: the whole map, label included, shifted, and our own marker left its window.
    expect(step(tracker, mapScene([leaderAt(120, 100)], null), 33).seen).toMatchObject({ leaderFound: true, originVerified: false, evidence: { originSeenAgoMs: null } });
    // A slow crawl with the marker merely hidden keeps the brief trust.
    const crawl = new MapMarkerTracker(c);
    expect(step(crawl, mapScene([leaderAt(200, 100)]), 0).seen.originVerified).toBe(true);
    expect(step(crawl, mapScene([leaderAt(203, 101)], null), 33).seen.originVerified).toBe(true);
  });
  it("keeps the origin verified while the leader's marker covers the player's, but only once the origin has been seen", () => {
    const c = calibrated(), centre = mapCentre(VIEW), onTop = mapScene([leaderMarkerOn(centre)], null), away = mapScene([leaderAt(200, 100)], null);
    const tracker = new MapMarkerTracker(c);
    expect(step(tracker, mapScene([leaderAt(200, 100)]), 0).seen.originVerified).toBe(true);
    const covered = step(tracker, onTop, 5000).seen;
    expect(covered).toMatchObject({ leaderFound: true, leader: centre, offset: { dx: 0, dy: 0, distance: 0 }, originVerified: true, evidence: { originScore: 0, originSeenAgoMs: 5000 } });
    // Once the leader walks off and our marker is still missing, the exception ends.
    expect(step(tracker, away, 5033).seen.originVerified).toBe(false);
    expect(step(tracker, mapScene([leaderMarkerOn({ x: centre.x + 60, y: centre.y })], null), 5066).seen.originVerified).toBe(false);
    // A tracker that never saw the origin gets no benefit of the doubt.
    expect(step(new MapMarkerTracker(c), onTop, 5000).seen).toMatchObject({ leaderFound: true, originVerified: false });
  });
});

describe("follow steering (synthetic observations)", () => {
  const CONFIG: SteeringConfig = { stopPx: 30, resumePx: 36, clickIntervalMs: 110, mapScale: 7, confidence: .85 }, QHD = { width: 2560, height: 1440 }, FHD = { width: 1920, height: 1080 };
  /** An observation as the tracker reports it: integer map offset, distance rounded to a tenth. */
  function observation(dx: number, dy: number, over: Partial<MapObservation> = {}, view: View = QHD): MapObservation {
    const origin = mapCentre(view);
    return { capturedAt: 0, view, identity: { name: "MainBear", method: "map-label-template" }, leaderFound: true, origin, leader: { x: origin.x + dx, y: origin.y + dy },
      offset: { dx, dy, distance: Math.round(Math.hypot(dx, dy) * 10) / 10 }, confidence: .97, originVerified: true,
      evidence: { score: .97, runnerUp: 0, candidates: 1, keyPixels: 300, originScore: 1, originSeenAgoMs: 0, searched: "window", overflow: false }, timing: TIMING, ...over };
  }
  const kinds = (decisions: SteeringDecision[]) => decisions.map(d => d.kind);

  it("holds without an observation, without the label, or below the confidence gate, and never moves blind", () => {
    const steering = new FollowSteering(CONFIG);
    expect(steering.decide(undefined, 0)).toEqual({ kind: "hold", reason: "No observation." });
    expect(steering.decide(observation(200, 0, { leaderFound: false, leader: undefined, offset: undefined, confidence: 0 }), 0)).toEqual({ kind: "hold", reason: "MainBear's map label is not visible." });
    expect(steering.decide(observation(200, 0, { leader: undefined }), 0).kind).toBe("hold");
    expect(steering.decide(observation(200, 0, { offset: undefined }), 0).kind).toBe("hold");
    expect(steering.decide(observation(200, 0, { confidence: .849 }), 0)).toEqual({ kind: "hold", reason: "Label confidence 0.849 is below 0.85.", distance: 200 });
    expect(steering.decide(observation(200, 0, { confidence: 0 }), 0).kind).toBe("hold");
    expect(steering.decide(observation(200, 0, { confidence: .85 }), 0).kind).toBe("move");
    // Losing the leader mid-pursuit sends nothing, however long it lasts.
    const lost = observation(0, 0, { leaderFound: false, leader: undefined, offset: undefined, confidence: 0 });
    for (let now = 10; now < 5000; now += 50) expect(steering.decide(lost, now).kind).toBe("hold");
  });
  it("pauses while the origin is unverified, whatever the distance", () => {
    const steering = new FollowSteering(CONFIG);
    for (const d of [5, 33, 200, 2000]) expect(steering.decide(observation(d, 0, { originVerified: false }), 0)).toMatchObject({ kind: "pause", distance: d });
    expect(steering.decide(observation(200, 0, { originVerified: false }), 0).reason).toContain("not at the calibrated map centre");
    expect(steering.decide(observation(200, 0), 0).kind).toBe("move");
  });
  it("stops inside stopPx and resumes only beyond resumePx", () => {
    const steering = new FollowSteering({ ...CONFIG, clickIntervalMs: 0 }), at = (d: number) => steering.decide(observation(d, 0), 0);
    expect(kinds([at(10), at(33), at(36)])).toEqual(["near", "near", "near"]);      // standing: anything up to resumePx is near
    expect(at(37)).toMatchObject({ kind: "move", distance: 37 });                   // beyond resumePx: go
    expect(kinds([at(36), at(33), at(31)])).toEqual(["move", "move", "move"]);      // moving: keep closing until stopPx
    expect(at(30)).toEqual({ kind: "near", reason: "Within following distance.", distance: 30 });
    expect(kinds([at(33), at(36), at(37), at(33)])).toEqual(["near", "near", "move", "move"]);
  });
  it("clicks at once the first time, retries at once until a click is committed, then paces by clickIntervalMs", () => {
    const steering = new FollowSteering(CONFIG), far = observation(120, -90);
    expect(steering.decide(far, 1000).kind).toBe("move");
    // Refused input (stale frame, focus lost) is never committed: the next cycle must try again immediately.
    for (const now of [1001, 1009, 1017]) expect(steering.decide(far, now).kind).toBe("move");
    steering.committed(1017);
    expect(steering.decide(far, 1018)).toEqual({ kind: "hold", reason: "Pacing movement clicks.", distance: 150 });
    expect(steering.decide(far, 1126).kind).toBe("hold");
    expect(steering.decide(far, 1127).kind).toBe("move");
    expect(steering.decide(far, 1135).kind).toBe("move");
    steering.committed(1135);
    expect(kinds([steering.decide(far, 1244), steering.decide(far, 1245)])).toEqual(["hold", "move"]);
    // Pacing never turns into a click once the leader is near.
    expect(steering.decide(observation(20, 0), 1246).kind).toBe("near");
  });
  it("commits at most one click per interval over a simulated 8 ms loop", () => {
    const steering = new FollowSteering(CONFIG), far = observation(-300, 40), clicks: number[] = [];
    for (let now = 0; now <= 2000; now += 8) if (steering.decide(far, now).kind === "move") { clicks.push(now); steering.committed(now); }
    expect(clicks[0]).toBe(0);
    for (let i = 1; i < clicks.length; i++) expect(clicks[i] - clicks[i - 1]).toBeGreaterThanOrEqual(CONFIG.clickIntervalMs);
    expect(clicks.length).toBeGreaterThanOrEqual(17);
  });
  it("aims from the map centre toward the leader, scaled by mapScale and clamped between 6% and 26% of the view height", () => {
    const origin = mapCentre(QHD), aim = (dx: number, dy: number, mapScale = 7) => new FollowSteering({ ...CONFIG, mapScale }).decide(observation(dx, dy), 0);
    expect(origin).toEqual({ x: 1279, y: 700 });
    expect(aim(40, 0)).toEqual({ kind: "move", x: 1279 + 280, y: 700, distance: 40, reason: "Move toward MainBear: 40 map px away." });
    expect(aim(-40, 0)).toMatchObject({ x: 1279 - 280, y: 700 });
    expect(aim(0, 40)).toMatchObject({ x: 1279, y: 980 });
    expect(aim(0, -500)).toMatchObject({ x: 1279, y: 700 - 374 });                          // 0.26 × 1440 = 374.4
    expect(aim(37, 0, 2)).toMatchObject({ x: 1279 + 86, y: 700 });                          // 0.06 × 1440 = 86.4
    expect(aim(300, 400)).toMatchObject({ x: Math.round(1279 + 374.4 * .6), y: Math.round(700 + 374.4 * .8) });
  });
  it("PROPERTY: every move target lies inside the native safe disc (0.30 × view height around the VIEW centre) and clear of the player's feet", () => {
    const next = random(20260919);
    let moves = 0, widest = 0;
    for (const view of [QHD, FHD]) {
      const origin = mapCentre(view), limit = view.height * .30;
      expect(origin).toEqual({ x: Math.round(view.width * .4998), y: Math.round(view.height * .4858) });
      const check = (dx: number, dy: number, mapScale: number, stopPx: number) => {
        const steering = new FollowSteering({ stopPx, resumePx: stopPx + 6, clickIntervalMs: 110, mapScale, confidence: .85 });
        const d = steering.decide(observation(dx, dy, {}, view), 0);
        if (d.kind !== "move") { expect(d.kind).toBe("near"); expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(stopPx + 6.05); return; }
        moves++;
        const label = `view ${view.width}×${view.height} offset ${dx},${dy} scale ${mapScale}`;
        expect(Number.isInteger(d.x) && Number.isInteger(d.y), label).toBe(true);
        // Same arithmetic as FollowInput.Check in scripts/win-follower-input-host.ps1.
        const fromViewCentre = Math.hypot(d.x - view.width / 2, d.y - view.height / 2);
        widest = Math.max(widest, fromViewCentre / view.height);
        expect(fromViewCentre, label).toBeLessThanOrEqual(limit);
        expect(d.x >= 0 && d.y >= 0 && d.x < view.width && d.y < view.height, label).toBe(true);
        // Off our own feet, and pointing the way the leader is.
        const reach = Math.hypot(d.x - origin.x, d.y - origin.y), length = Math.hypot(dx, dy);
        expect(reach, label).toBeGreaterThanOrEqual(view.height * .06 - 1.5);
        expect(reach, label).toBeLessThanOrEqual(view.height * .26 + 1.5);
        expect(((d.x - origin.x) * dx + (d.y - origin.y) * dy) / (reach * length), label).toBeGreaterThan(.999);
      };
      // Every whole degree at representative distances and the extremes of the allowed map scale (2–20)…
      for (let degrees = 0; degrees < 360; degrees++) for (const distance of [7, 13, 37, 60, 150, 400, 1500]) for (const mapScale of [2, 7, 20]) {
        const a = degrees * Math.PI / 180;
        check(Math.round(Math.cos(a) * distance), Math.round(Math.sin(a) * distance), mapScale, 6);
      }
      // …and seeded random offsets anywhere on the view, with random settings.
      for (let i = 0; i < 4000; i++) check(Math.round((next() - .5) * 2 * view.width), Math.round((next() - .5) * 2 * view.height), 2 + next() * 18, 6 + Math.floor(next() * 10) * 6);
    }
    expect(moves).toBeGreaterThan(20000);
    // The clamp leaves real headroom under 0.30: the origin sits 0.0142 h below the view centre.
    expect(widest).toBeLessThan(.28);
  }, 30_000);
  /** The own-marker centre at the top-left corner of the central crop buildMapCalibration searches (0.485 w, 0.46 h). */
  const cropCorner = (view: View): KeyPoint => ({ x: Math.round(view.width * .485) + 5, y: Math.round(view.height * .46) + 4 });
  const ring = (view: View, origin: KeyPoint) => Array.from({ length: 360 }, (_, degrees) => {
    const a = degrees * Math.PI / 180, dx = Math.round(Math.cos(a) * 400), dy = Math.round(Math.sin(a) * 400);
    return { degrees, decision: new FollowSteering(CONFIG).decide(observation(dx, dy, { origin, leader: { x: origin.x + dx, y: origin.y + dy } }, view), 0) };
  });
  it("calibration accepts an own marker anywhere in its central search crop, including the corner", () => {
    for (const view of [QHD, FHD]) {
      const s = mapScene([leaderAt(200, 100)], cropCorner(view), view);
      expect(new MapMarkerTracker(buildMapCalibration(s.green, s.orange, "MainBear", AT)).origin).toEqual(cropCorner(view));
      // Steering from that origin moves in every direction (so the expected failure below can only be the disc).
      expect(ring(view, cropCorner(view)).every(r => r.decision.kind === "move")).toBe(true);
      // From the measured map centre the same ring is entirely inside the disc.
      for (const { decision: d } of ring(view, mapCentre(view))) expect(d.kind === "move" && Math.hypot(d.x - view.width / 2, d.y - view.height / 2) <= view.height * .30).toBe(true);
    }
  });
  // SUSPECTED SOURCE GAP (reported; source untouched). Steering clamps clicks to 0.26 × height around the ORIGIN, the
  // native worker allows 0.30 × height around the VIEW centre. The two only agree while the origin is within 0.04 × height
  // of the view centre, but calibration (test above) accepts origins up to about 0.044 × height away, and
  // parseMapCalibration accepts any origin 20 px inside the view. From such an origin a far leader up and to the left
  // yields a target the native check refuses ("Click outside the safe movement area"), which the drive loop treats as a
  // fatal input error and stops. Fail-safe, never a stray click, but following dies instead of steering.
  // This test states the invariant the design needs. Remove `.fails` once steering or calibration enforces it.
  it("PROPERTY: every move target stays inside the native safe disc for any origin calibration accepts", () => {
    for (const view of [QHD, FHD]) for (const { degrees, decision: d } of ring(view, cropCorner(view))) {
      if (d.kind === "move") expect(Math.hypot(d.x - view.width / 2, d.y - view.height / 2), `view ${view.width}×${view.height} at ${degrees}°`).toBeLessThanOrEqual(view.height * .30);
    }
  });
  it("PROPERTY: targets computed from real tracker observations at 1920 × 1080 stay inside the safe disc", () => {
    const view = FHD, c = calibrated(view), centre = mapCentre(view), next = random(77);
    for (let i = 0; i < 12; i++) {
      const tracker = new MapMarkerTracker(c), steering = new FollowSteering(CONFIG);
      const marker = { x: 120 + Math.floor(next() * (view.width - 240)), y: 60 + Math.floor(next() * (view.height - 120)) };
      const { seen } = step(tracker, mapScene([leaderMarkerOn(marker)], centre, view), 0), d = steering.decide(seen, 0);
      expect(seen).toMatchObject({ leaderFound: true, leader: marker, originVerified: true, confidence: 1 });
      if (d.kind !== "move") { expect(Math.hypot(marker.x - centre.x, marker.y - centre.y)).toBeLessThanOrEqual(CONFIG.resumePx + .05); continue; }
      expect(Math.hypot(d.x - view.width / 2, d.y - view.height / 2)).toBeLessThanOrEqual(view.height * .30);
      expect((d.x - centre.x) * (marker.x - centre.x) + (d.y - centre.y) * (marker.y - centre.y)).toBeGreaterThan(0);
    }
  });
});
