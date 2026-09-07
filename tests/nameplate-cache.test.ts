import { describe, expect, it } from "vitest";
import {
  NAMEPLATE_TTL_MS,
  loadNameplateCache,
  lookupNameplate,
  parseNameplateCache,
  recordNameplateHit,
  rememberNameplate,
  saveNameplateCache,
  serializeNameplateCache,
  type NameplateCacheFs,
} from "../src/core/nameplateCache.js";

const NOW = Date.parse("2026-09-07T12:00:00Z");

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

describe("nameplate cache", () => {
  it("expires entries after the TTL and keeps them right up to it", () => {
    const cache = rememberNameplate({}, "ZELINA", { x: 1177.4, y: 900.6 }, NOW);
    expect(cache.zelina).toEqual({ x: 1177, y: 901, seenAt: NOW, hits: 0 });
    expect(lookupNameplate(cache, "zelina", NOW + NAMEPLATE_TTL_MS)).toBeDefined();
    expect(lookupNameplate(cache, "Zelina ", NOW + NAMEPLATE_TTL_MS + 1)).toBeUndefined();
    expect(lookupNameplate(cache, "stash", NOW)).toBeUndefined();
  });

  it("counts band hits, refreshes the point, and restarts on a full-screen find", () => {
    let cache = rememberNameplate({}, "stash", { x: 2000, y: 1000 }, NOW);
    cache = recordNameplateHit(cache, "stash", { x: 2010, y: 1004 }, NOW + 1000);
    cache = recordNameplateHit(cache, "stash", { x: 2012, y: 1003 }, NOW + 2000);
    expect(cache.stash).toEqual({ x: 2012, y: 1003, seenAt: NOW + 2000, hits: 2 });
    cache = rememberNameplate(cache, "stash", { x: 1500, y: 800 }, NOW + 3000);
    expect(cache.stash).toEqual({ x: 1500, y: 800, seenAt: NOW + 3000, hits: 0 });
    // A hit on an unknown key still records it.
    expect(recordNameplateHit({}, "ange", { x: 1, y: 2 }, NOW).ange.hits).toBe(1);
  });

  it("round-trips through JSON and drops expired or malformed rows on parse", () => {
    const cache = recordNameplateHit(rememberNameplate({}, "zelina", { x: 1177, y: 900 }, NOW), "zelina", { x: 1177, y: 900 }, NOW);
    const text = serializeNameplateCache(cache);
    expect(text.endsWith("\n")).toBe(true);
    expect(parseNameplateCache(text, NOW)).toEqual(cache);

    const mixed = JSON.stringify({
      Fresh: { x: 1, y: 2, seenAt: NOW, hits: 3.9 },
      stale: { x: 1, y: 2, seenAt: NOW - NAMEPLATE_TTL_MS - 1, hits: 9 },
      broken: { x: "no", y: 2, seenAt: NOW },
      nul: null,
    });
    expect(parseNameplateCache(mixed, NOW)).toEqual({ fresh: { x: 1, y: 2, seenAt: NOW, hits: 3 } });
    expect(parseNameplateCache("not json", NOW)).toEqual({});
    expect(parseNameplateCache("[1,2]", NOW)).toEqual({});
    expect(parseNameplateCache(undefined, NOW)).toEqual({});
  });

  it("loads and saves through the injected fs, treating a missing or corrupt file as empty", () => {
    const file = "artifacts/nameplates.json";
    const fs = memoryFs();
    expect(loadNameplateCache(file, fs, NOW)).toEqual({});
    fs.files.set(file, "{{{");
    expect(loadNameplateCache(file, fs, NOW)).toEqual({});

    const cache = rememberNameplate({}, "zelina", { x: 1177, y: 900 }, NOW);
    saveNameplateCache(file, cache, fs);
    expect(loadNameplateCache(file, fs, NOW + 60_000)).toEqual(cache);
    expect(loadNameplateCache(file, fs, NOW + NAMEPLATE_TTL_MS + 1)).toEqual({});

    const throwing: NameplateCacheFs = {
      readFile: () => {
        throw new Error("EACCES");
      },
      writeFile: () => {},
    };
    expect(loadNameplateCache(file, throwing, NOW)).toEqual({});
  });
});
