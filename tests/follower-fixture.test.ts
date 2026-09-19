import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { pngWhiteness } from "../src/adapters/pngWhiteness.js";
import { evaluateFixture, parseFixtureLabels, parseRecordingManifest, type RecordingManifest } from "../src/core/followerFixture.js";
import { buildNameplateTemplate, parseFollowerCalibration, type WhiteFrame } from "../src/core/followerPerception.js";

// SYNTHETIC recordings. They test the measuring instrument, not the game.
const W = 640, H = 360;
function crc(bytes: Buffer): number { let c = ~0; for (const b of bytes) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; }
function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8); head.writeUInt32BE(body.length); head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), body])));
  return Buffer.concat([head, body, tail]);
}
/** Encodes RGB(A) rows with a chosen PNG filter per row so every unfilter path is exercised. */
function png(width: number, height: number, channels: 3 | 4, rgba: (x: number, y: number) => number[], filters: number[]): Buffer {
  const stride = width * channels, raw = Buffer.alloc((stride + 1) * height), plain = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba(x, y).slice(0, channels).forEach((v, c) => { plain[y * stride + x * channels + c] = v; });
  for (let y = 0; y < height; y++) {
    const filter = filters[y % filters.length]; raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? plain[y * stride + i - channels] : 0, up = y ? plain[(y - 1) * stride + i] : 0, upLeft = y && i >= channels ? plain[(y - 1) * stride + i - channels] : 0;
      const p = left + up - upLeft, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - upLeft);
      const predicted = [0, left, up, (left + up) >> 1, a <= b && a <= c ? left : b <= c ? up : upLeft][filter];
      raw[y * (stride + 1) + 1 + i] = (plain[y * stride + i] - predicted) & 255;
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = channels === 3 ? 2 : 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function scene(name?: { x: number; y: number }, decoy?: { x: number; y: number }): WhiteFrame {
  const f = { width: W, height: H, pixels: new Uint8Array(W * H).fill(20) };
  const bar = (at: { x: number; y: number }, notch: boolean) => { for (let y = 0; y < 10; y++) for (let x = 0; x < 60; x++) if ((x % 6 < 3 || y < 2) && !(notch && x > 40 && y > 6)) f.pixels[(at.y + y) * W + at.x + x] = 240; };
  if (name) bar(name, true);
  if (decoy) bar(decoy, true);
  return f;
}
const calibration = (() => {
  const { template, nameplate } = buildNameplateTemplate(scene({ x: 100, y: 80 }), { x: 95, y: 76, width: 72, height: 18 });
  return parseFollowerCalibration({ version: 1, targetName: "Main", view: { width: W, height: H }, searchArea: { x: 0, y: 0, width: W, height: H }, nameplate, template, calibratedAt: "2026-09-19T00:00:00.000Z" });
})();
const manifest = (...offsets: number[]): RecordingManifest => ({ version: 1, recordedAt: "2026-09-19T00:00:00.000Z", view: { width: W, height: H }, frames: offsets.map((offsetMs, i) => ({ file: `frame-${String(i + 1).padStart(4, "0")}.png`, offsetMs })) });

describe("recorded PNG decoding", () => {
  it("decodes RGB and RGBA with every PNG row filter into min(R,G,B)", () => {
    const colour = (x: number, y: number) => [(x * 37 + y * 11) & 255, (x * 5 + y * 91) & 255, (x * y + 17) & 255, 255];
    for (const channels of [3, 4] as const) {
      const decoded = pngWhiteness(png(9, 10, channels, colour, [0, 1, 2, 3, 4]));
      expect(decoded).toMatchObject({ width: 9, height: 10 });
      for (let y = 0; y < 10; y++) for (let x = 0; x < 9; x++) expect(decoded.pixels[y * 9 + x]).toBe(Math.min(...colour(x, y).slice(0, 3)));
    }
  });
  it("rejects non-PNG, truncated, and unsupported files", () => {
    const good = png(4, 4, 3, () => [1, 2, 3], [0]);
    expect(() => pngWhiteness(Buffer.from("not a png at all, just thirty-three+ bytes"))).toThrow("Not a PNG");
    expect(() => pngWhiteness(good.subarray(0, 40))).toThrow();
    const sixteenBit = Buffer.from(good); sixteenBit[24] = 16;
    expect(() => pngWhiteness(sixteenBit)).toThrow("Unsupported PNG");
  });
});

describe("fixture replay metrics (synthetic recordings)", () => {
  it("scores correct, missed, absent, false and ambiguous frames and reports what the gate accepted", () => {
    // Offsets are chosen so frames 4–6 are full searches; a tracking window cannot see a distant look-alike.
    const m = manifest(0, 700, 1400, 2100, 2800, 4900), frames: Record<string, WhiteFrame> = {
      "frame-0001.png": scene({ x: 100, y: 80 }), "frame-0002.png": scene({ x: 130, y: 90 }), "frame-0003.png": scene(),
      "frame-0004.png": scene(), "frame-0005.png": scene(undefined, { x: 400, y: 200 }), "frame-0006.png": scene({ x: 100, y: 80 }, { x: 400, y: 200 }),
    };
    const labels = parseFixtureLabels({ version: 1, targetName: "Main", frames: {
      "frame-0001.png": { leader: { x: 100, y: 80, width: 60, height: 10 } }, "frame-0002.png": { leader: { x: 130, y: 90, width: 60, height: 10 } },
      "frame-0003.png": { leader: { x: 300, y: 300, width: 60, height: 10 }, note: "occluded" }, "frame-0004.png": { leader: null },
      "frame-0005.png": { leader: null, note: "look-alike" }, "frame-0006.png": { leader: { x: 100, y: 80, width: 60, height: 10 } },
    } }, m);
    let clock = 0;
    const { results, metrics } = evaluateFixture(calibration, m, file => frames[file], labels, .85, () => (clock += 2));
    expect(results.map(r => r.outcome)).toEqual(["correct", "correct", "missed", "correct-absent", "false-acquisition", "correct"]);
    expect(results.map(r => r.accepted)).toEqual([true, true, false, false, true, false]);
    expect(results[1].searched).toBe("window");
    expect(results[5]).toMatchObject({ confidence: 0, runnerUp: 1 });
    expect(metrics).toEqual({ frames: 6, labelled: 6, leaderVisible: 4, leaderAbsent: 2, detected: 3, accepted: 3, missed: 1, acceptedWrong: 1, rejectedWrong: 0, recall: .75, acceptedRecall: .5, acceptedPrecision: .667, medianMatchMs: 2 });
  });
  it("reports no accuracy figures for an unlabelled recording", () => {
    const { results, metrics } = evaluateFixture(calibration, manifest(0, 250), () => scene({ x: 100, y: 80 }), undefined, .85);
    expect(results.every(r => r.outcome === "unlabelled" && r.found)).toBe(true);
    expect(metrics).toMatchObject({ labelled: 0, recall: undefined, acceptedPrecision: undefined });
  });
  it("refuses mismatched views, targets, frame sizes, and malformed manifests or labels", () => {
    const m = manifest(0);
    expect(() => evaluateFixture(calibration, { ...m, view: { width: 1280, height: 720 } }, () => scene(), undefined, .85)).toThrow("Recording is 1280 × 720");
    expect(() => evaluateFixture(calibration, m, () => ({ width: 10, height: 10, pixels: new Uint8Array(100) }), undefined, .85)).toThrow("does not match");
    expect(() => evaluateFixture(calibration, m, () => scene(), { version: 1, targetName: "Other", frames: {} }, .85)).toThrow("Labels are for Other");
    for (const bad of [null, { ...m, version: 2 }, { ...m, frames: [{ file: "../evil.png", offsetMs: 0 }] }, { ...m, frames: [...m.frames, ...m.frames] }, { ...m, frames: [{ file: "frame-0001.png", offsetMs: Number.NaN }] }]) expect(() => parseRecordingManifest(bad)).toThrow("Invalid follower recording");
    expect(() => parseFixtureLabels({ version: 1, targetName: "Main", frames: { "frame-0009.png": { leader: null } } }, m)).toThrow("not in the recording");
    expect(() => parseFixtureLabels({ version: 1, targetName: "Main", frames: { "frame-0001.png": { leader: { x: 0, y: 0, width: 9999, height: 1 } } } }, m)).toThrow("rectangle inside the view");
  });
});
