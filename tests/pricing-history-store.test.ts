import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TrendSeries } from "../src/core/priceTrends.js";
import {
  leagueSlug,
  PricingHistoryStore,
  type PricingHistoryFs,
} from "../src/main/features/pricingHistory/historyStore.js";

const LEAGUE = "Runes of Aldur";
const NOW = new Date("2026-09-12T12:00:00.000Z");

function fixtureSeries(): TrendSeries[] {
  const cache = JSON.parse(
    readFileSync(new URL("../fixtures/pricing-history/price-trends.cache.json", import.meta.url), "utf8"),
  ) as { series: TrendSeries[] };
  return cache.series;
}

const temporary: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pricing-history-"));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true });
});

function store(dir: string, fs?: PricingHistoryFs): PricingHistoryStore {
  return new PricingHistoryStore({ dir, ...(fs ? { fs } : {}), now: () => NOW });
}

describe("leagueSlug", () => {
  it("makes a file-safe name and never an empty one", () => {
    expect(leagueSlug("Runes of Aldur")).toBe("runes-of-aldur");
    expect(leagueSlug("HC Forbidden Rites (2)")).toBe("hc-forbidden-rites-2");
    expect(leagueSlug("   ")).toBe("unknown-league");
  });
});

describe("PricingHistoryStore", () => {
  it("writes one file per league, reloads it, and reports stats", () => {
    const dir = scratch();
    const first = store(dir);
    const merged = first.merge(LEAGUE, fixtureSeries(), "2026-09-12T06:00:00.000Z");
    expect(merged.addedBars).toBe(30);
    expect(first.file(LEAGUE)).toBe(path.join(dir, "runes-of-aldur.json"));
    expect(first.lastError).toBeUndefined();

    const reopened = store(dir);
    const stats = reopened.stats(LEAGUE)!;
    expect(stats).toMatchObject({ keys: 6, bars: 30, file: first.file(LEAGUE) });
    expect(stats.bytes).toBeGreaterThan(0);
    expect(reopened.read(LEAGUE, "divine")!.points).toHaveLength(7);
    expect(reopened.read(LEAGUE, "nope")).toBeUndefined();
    expect(reopened.stats("Some Other League")).toBeUndefined();
  });

  it("skips a snapshot it already merged, even when two overviews overlap", () => {
    const dir = scratch();
    const writes: string[] = [];
    const files = new Map<string, string>();
    const fs: PricingHistoryFs = {
      read: (file) => files.get(file),
      write: (file, text) => {
        writes.push(file);
        files.set(file, text);
      },
      remove: (file) => void files.delete(file),
      list: () => [...files.keys()].map((file) => path.basename(file)),
    };
    const subject = store(dir, fs);
    const series = fixtureSeries();
    // Two overlapping overview calls resolving against the same cache stamp.
    const a = subject.merge(LEAGUE, series, "stamp-1");
    const b = subject.merge(LEAGUE, series, "stamp-1");
    expect(a.addedBars).toBe(30);
    expect(b.addedBars).toBe(0);
    expect(b.changed).toBe(false);
    expect(writes).toHaveLength(1);

    // A new stamp with the same bars rewrites nothing new either.
    const c = subject.merge(LEAGUE, series, "stamp-2");
    expect(c.addedBars).toBe(0);
    expect(c.changed).toBe(true);
    expect(writes).toHaveLength(2);
  });

  it("lists every league file and clears only its own json files", () => {
    const dir = scratch();
    const subject = store(dir);
    subject.merge(LEAGUE, fixtureSeries(), "stamp-1");
    subject.merge("Forbidden Rites", fixtureSeries().slice(0, 2), "stamp-1");
    writeFileSync(path.join(dir, "notes.txt"), "not mine", "utf8");

    const leagues = store(dir).leagues();
    expect(leagues.map((entry) => entry.league)).toEqual(["Forbidden Rites", "Runes of Aldur"]);
    expect(leagues[1]).toMatchObject({ keys: 6, bars: 30 });

    expect(subject.clear("Forbidden Rites")).toBe(1);
    expect(store(dir).leagues().map((entry) => entry.league)).toEqual([LEAGUE]);
    expect(subject.clear()).toBe(1);
    expect(store(dir).leagues()).toEqual([]);
    expect(readFileSync(path.join(dir, "notes.txt"), "utf8")).toBe("not mine");
    expect(subject.clear(LEAGUE)).toBe(0);
  });

  it("surfaces a write failure instead of throwing, and keeps serving from memory", () => {
    const dir = scratch();
    const fs: PricingHistoryFs = {
      read: () => undefined,
      write: () => {
        throw new Error("disk full");
      },
      remove: () => undefined,
      list: () => [],
    };
    const subject = store(dir, fs);
    const merged = subject.merge(LEAGUE, fixtureSeries(), "stamp-1");
    expect(merged.addedBars).toBe(30);
    expect(subject.lastError).toBe("disk full");
    expect(subject.read(LEAGUE, "divine")!.points).toHaveLength(7);
  });

  it("treats a torn file as a cold history rather than losing the league", () => {
    const dir = scratch();
    writeFileSync(path.join(dir, "runes-of-aldur.json"), "{not json", "utf8");
    const subject = store(dir);
    expect(subject.stats(LEAGUE)).toBeUndefined();
    expect(subject.leagues()).toEqual([]);
    expect(subject.merge(LEAGUE, fixtureSeries(), "stamp-1").addedBars).toBe(30);
    expect(store(dir).stats(LEAGUE)!.keys).toBe(6);
  });
});
