import { describe, expect, it } from "vitest";
import {
  NAMEPLATE_BAND,
  bandAround,
  findNameplate,
  type NameplateHost,
} from "../src/adapters/nameplateFinder.js";
import {
  parseNameplateCache,
  rememberNameplate,
  serializeNameplateCache,
  type NameplateCacheFs,
} from "../src/core/nameplateCache.js";
import type { OcrLine } from "../src/core/tabList.js";

const NOW = Date.parse("2026-09-07T12:00:00Z");
const FILE = "artifacts/nameplates.json";
const ZELINA: OcrLine = { text: "ZELINA", x: 1140, y: 880, w: 80, h: 30 };

function memoryFs(initial: Record<string, string> = {}): NameplateCacheFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readFile: (file) => files.get(file),
    writeFile: (file, text) => {
      files.set(file, text);
    },
  };
}

/** Fake host: a band request (has `left`) answers with `band`, a full pass with `full`. */
function fakeHost(band: OcrLine[], full: OcrLine[]): NameplateHost & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    async send(payload) {
      calls.push(payload);
      if (payload.op !== "ocr") return { ok: true };
      const isBand = payload.left !== undefined;
      return { ok: true, text: "", lines: isBand ? band : full };
    },
  };
}

describe("findNameplate", () => {
  it("hits the band around a cached point on the first call and counts the hit", async () => {
    const seeded = rememberNameplate({}, "zelina", { x: 1180, y: 895 }, NOW - 60_000);
    const fs = memoryFs({ [FILE]: serializeNameplateCache(seeded) });
    const host = fakeHost([ZELINA], []);

    const found = await findNameplate(host, /^zelina$/i, { cacheKey: "zelina", cacheFile: FILE, fs, now: () => NOW, holdAlt: true });

    expect(found).toEqual({ x: 1180, y: 895 + 70, line: ZELINA, source: "band" });
    expect(host.calls).toHaveLength(1);
    expect(host.calls[0]).toEqual({
      op: "ocr",
      left: 1180 - NAMEPLATE_BAND.width / 2,
      top: 895 - NAMEPLATE_BAND.height / 2,
      width: NAMEPLATE_BAND.width,
      height: NAMEPLATE_BAND.height,
      holdAlt: true,
    });
    expect(parseNameplateCache(fs.files.get(FILE), NOW).zelina).toEqual({ x: 1180, y: 895, seenAt: NOW, hits: 1 });
  });

  it("falls back to a full-screen pass when the band misses, and re-remembers the plate", async () => {
    const seeded = rememberNameplate({}, "zelina", { x: 3000, y: 400 }, NOW - 60_000);
    const fs = memoryFs({ [FILE]: serializeNameplateCache(seeded) });
    const host = fakeHost([], [{ text: "STASH", x: 10, y: 10, w: 50, h: 20 }, ZELINA]);
    const scans: OcrLine[][] = [];

    const found = await findNameplate(host, /^zelina$/i, {
      cacheKey: "zelina",
      cacheFile: FILE,
      fs,
      now: () => NOW,
      onFullScan: (lines) => scans.push(lines),
    });

    expect(found?.source).toBe("full");
    expect(found).toMatchObject({ x: 1180, y: 965 });
    expect(host.calls.map((call) => call.left !== undefined)).toEqual([true, false]);
    expect(host.calls[1]).toEqual({ op: "ocr" });
    expect(scans).toHaveLength(1);
    expect(parseNameplateCache(fs.files.get(FILE), NOW).zelina).toEqual({ x: 1180, y: 895, seenAt: NOW, hits: 0 });
  });

  it("goes straight to the full screen with an empty cache and returns undefined on a miss", async () => {
    const fs = memoryFs();
    const missing = fakeHost([ZELINA], []);
    expect(await findNameplate(missing, /^zelina$/i, { cacheKey: "zelina", cacheFile: FILE, fs, now: () => NOW })).toBeUndefined();
    expect(missing.calls).toHaveLength(1);
    expect(missing.calls[0]!.left).toBeUndefined();
    expect(fs.files.has(FILE)).toBe(false);
  });

  it("applies the caller's accept rule against every line of the pass", async () => {
    const guild: OcrLine = { text: "Guild Stash", x: 1100, y: 880, w: 140, h: 30 };
    const stash: OcrLine = { text: "Stash", x: 1120, y: 890, w: 60, h: 30 };
    const host = fakeHost([], [guild, stash]);
    const fs = memoryFs();
    const found = await findNameplate(host, /^stash$/i, {
      cacheKey: "stash",
      cacheFile: FILE,
      fs,
      now: () => NOW,
      accept: (line, lines) =>
        !lines.some((other) => /guild/i.test(other.text) && Math.abs(other.x - line.x) < 300 && Math.abs(other.y - line.y) < 60),
    });
    expect(found).toBeUndefined();
  });

  it("clamps the band to the screen edges", () => {
    expect(bandAround({ x: 50, y: 20 })).toEqual({ left: 0, top: 0, width: 800, height: 160 });
    expect(bandAround({ x: 3830, y: 2150 })).toEqual({ left: 3040, top: 2000, width: 800, height: 160 });
    expect(bandAround({ x: 1920, y: 1080 }, { width: 400, height: 100 })).toEqual({ left: 1720, top: 1030, width: 400, height: 100 });
  });
});
