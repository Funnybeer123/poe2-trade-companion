import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALL_CATEGORY,
  buildPricingRows,
  categoryLabel,
  displayPrice,
  divineRateInfo,
  emptyStoredHistory,
  FAVORITES_CATEGORY,
  filterRows,
  formatPriceNumber,
  historyBarCount,
  isLowStock,
  matchesSearch,
  MAX_HISTORY_KEYS,
  MAX_HISTORY_POINTS,
  mergeHistory,
  MIN_HISTORY_POINTS,
  normalizeSort,
  parseStoredHistory,
  sampleSpark,
  sanitizeTrendPoints,
  serializeStoredHistory,
  sortRows,
  sparklinePath,
  timelineGeometry,
  trimHistoryToBudget,
  type PricingRow,
  type StoredHistory,
} from "../src/core/pricingHistory.js";
import type { TrendPoint, TrendSeries } from "../src/core/priceTrends.js";
import { PRICE_TABLE_SCHEMA_VERSION, type PriceTable } from "../src/core/priceTable.js";
import { normalizePricingSettings, DEFAULT_PRICING_SETTINGS } from "../src/shared/pricingHistory.js";

const NOW = "2026-09-12T12:00:00.000Z";

interface CacheFixture {
  fetchedAt: string;
  league: string;
  categories: string[];
  series: TrendSeries[];
}

function cacheFixture(): CacheFixture {
  return JSON.parse(
    readFileSync(new URL("../fixtures/pricing-history/price-trends.cache.json", import.meta.url), "utf8"),
  ) as CacheFixture;
}

function priceTable(): PriceTable {
  return {
    schemaVersion: PRICE_TABLE_SCHEMA_VERSION,
    currency: "exalted",
    entries: [
      { id: "feed:poe2scout:divine", match: { name: "Divine Orb" }, value: 640 },
      { id: "feed:poe2scout:perfect-jewellers-orb", match: { name: "Perfect Jeweller's Orb" }, value: 20 },
      {
        id: "feed:poe2scout:temporalis-silk-robe",
        match: { name: "Temporalis", baseType: "Silk Robe", rarity: "Unique" },
        value: 1_602_665,
      },
      { id: "manual-ring", match: { name: "Manual Ring" }, value: 5 },
    ],
  };
}

function row(partial: Partial<PricingRow> = {}): PricingRow {
  return {
    key: partial.key ?? "key",
    name: partial.name ?? "Item",
    category: partial.category ?? "currency",
    current: partial.current ?? 1,
    hasHistory: partial.hasHistory ?? true,
    lowStock: partial.lowStock ?? false,
    spark: partial.spark ?? [],
    favorite: partial.favorite ?? false,
    volume7d: partial.volume7d ?? 0,
    sampleSize: partial.sampleSize ?? 0,
    ...partial,
  };
}

/** The y of every vertex in an SVG path, in order. */
function pathY(path: string): number[] {
  return [...path.matchAll(/[ML] [\d.-]+ ([\d.-]+)/g)].map((match) => Number(match[1]));
}

function points(count: number, startDay = 1): TrendPoint[] {
  return Array.from({ length: count }, (_unused, index) => ({
    time: new Date(Date.UTC(2026, 0, startDay + index)).toISOString(),
    price: 10 + index,
    quantity: 100 + index,
  }));
}

describe("pricing settings sanitizer", () => {
  it("turns a junk document into the defaults and drops unknown keys", () => {
    const junk: unknown = JSON.parse(
      readFileSync(new URL("../fixtures/pricing-history/settings.junk.json", import.meta.url), "utf8"),
    );
    const settings = normalizePricingSettings(junk);
    expect(settings).toEqual({
      favorites: ["divine", "chaos", "x".repeat(120)],
      displayCurrency: "auto",
      hideLowStock: true,
      sort: { key: "change3d", direction: "desc" },
      category: "all",
      keepHistory: true,
    });
    expect(Object.keys(settings).sort()).toEqual(Object.keys(DEFAULT_PRICING_SETTINGS).sort());
  });

  it("caps favorites, keeps insertion order, and accepts a valid document", () => {
    const many = Array.from({ length: 250 }, (_unused, index) => `key-${index}`);
    expect(normalizePricingSettings({ favorites: many }).favorites).toHaveLength(200);
    expect(
      normalizePricingSettings({
        favorites: ["chaos", "divine"],
        displayCurrency: "divine",
        hideLowStock: false,
        sort: { key: "volume7d", direction: "asc" },
        category: "essences",
        keepHistory: false,
      }),
    ).toEqual({
      favorites: ["chaos", "divine"],
      displayCurrency: "divine",
      hideLowStock: false,
      sort: { key: "volume7d", direction: "asc" },
      category: "essences",
      keepHistory: false,
    });
  });

  it("accepts every category id the strip can render, and only those", () => {
    // poe2scout's CategoryApiId values are what the chips carry; a narrower
    // pattern would make such a category unselectable (it would snap to All).
    expect(normalizePricingSettings({ category: "uncut_gems" }).category).toBe("uncut_gems");
    expect(normalizePricingSettings({ category: "SoulCores" }).category).toBe("SoulCores");
    expect(normalizePricingSettings({ category: " essences " }).category).toBe("essences");
    expect(normalizePricingSettings({ category: "Not A Category" }).category).toBe("all");
    expect(normalizePricingSettings({ category: "x".repeat(61) }).category).toBe("all");
    expect(normalizePricingSettings({ category: 7 }).category).toBe("all");
  });

  it("normalizeSort falls back on an unknown key or direction", () => {
    expect(normalizeSort({ key: "moon", direction: "sideways" })).toEqual({
      key: "change3d",
      direction: "desc",
    });
    expect(normalizeSort({ key: "price", direction: "asc" })).toEqual({ key: "price", direction: "asc" });
    expect(normalizeSort(undefined)).toEqual({ key: "change3d", direction: "desc" });
  });
});

describe("buildPricingRows", () => {
  it("builds one row per series plus the feed-only rows, with ordered categories", () => {
    const built = buildPricingRows({
      series: cacheFixture().series,
      priceTable: priceTable(),
      favorites: ["chaos"],
      now: NOW,
    });
    expect(built.rows.map((entry) => entry.key)).toEqual([
      "divine",
      "chaos",
      "mirror",
      "essence-of-ruin",
      "breach-splinter",
      "temporalis-silk-robe",
      "perfect-jewellers-orb",
    ]);
    expect(built.categories).toEqual([
      { id: "currency", label: "Currency", count: 3 },
      { id: "essences", label: "Essences", count: 1 },
      { id: "breach", label: "Breach", count: 1 },
      { id: "uniques", label: "Uniques (no history)", count: 1 },
      { id: "feed", label: "Other feed items (no history)", count: 1 },
    ]);
    expect(built.divineRate).toBe(649.45);
    expect(built.divineRateSource).toBe("feed");

    const divine = built.rows[0]!;
    expect(divine.hasHistory).toBe(true);
    expect(divine.change1d).toBe(0.7);
    expect(divine.change3d).toBe(3.1);
    expect(divine.spark).toHaveLength(7);
    expect(built.rows[1]!.favorite).toBe(true);

    const feedOnly = built.rows.at(-1)!;
    expect(feedOnly).toMatchObject({
      key: "perfect-jewellers-orb",
      name: "Perfect Jeweller's Orb",
      category: "feed",
      current: 20,
      hasHistory: false,
      lowStock: false,
      spark: [],
      volume7d: 0,
    });
    expect(feedOnly.change3d).toBeUndefined();

    // A unique series without a CategoryApiId lands in the uniques bucket.
    expect(built.rows[5]).toMatchObject({ category: "uniques", unique: true, baseType: "Silk Robe" });
    // Thin markets are flagged, deep ones are not.
    expect(built.rows.find((entry) => entry.key === "essence-of-ruin")!.lowStock).toBe(true);
    expect(built.rows.find((entry) => entry.key === "breach-splinter")!.lowStock).toBe(false);
  });

  it("falls back from the feed to the price table and then to 40 for the divine rate", () => {
    const withoutDivine = cacheFixture().series.filter((entry) => entry.key !== "divine");
    expect(divineRateInfo(withoutDivine, priceTable())).toEqual({ rate: 640, source: "price-table" });
    expect(divineRateInfo(withoutDivine)).toEqual({ rate: 40, source: "fallback" });
    expect(divineRateInfo([], { ...priceTable(), entries: [] })).toEqual({ rate: 40, source: "fallback" });
    // A table that genuinely holds 40 is still the table, not the fallback:
    // the number is the same, the provenance we show the user is not.
    expect(
      divineRateInfo([], {
        ...priceTable(),
        entries: [{ id: "feed:poe2scout:divine", match: { name: "Divine Orb" }, value: 40 }],
      }),
    ).toEqual({ rate: 40, source: "price-table" });
  });

  it("isLowStock reads both the volume and the sample size", () => {
    expect(isLowStock({ volume7d: 9, sampleSize: 7 })).toBe(true);
    expect(isLowStock({ volume7d: 5_000, sampleSize: 1 })).toBe(true);
    expect(isLowStock({ volume7d: 10, sampleSize: 2 })).toBe(false);
  });

  it("categoryLabel humanizes an unknown poe2scout category", () => {
    expect(categoryLabel("currency")).toBe("Currency");
    expect(categoryLabel("soulcores")).toBe("Soulcores");
    expect(categoryLabel("")).toBe("Other");
  });

  it("sampleSpark keeps the first and last bar", () => {
    expect(sampleSpark(points(7))).toHaveLength(7);
    const sampled = sampleSpark(points(40));
    expect(sampled).toHaveLength(14);
    expect(sampled[0]).toBe(10);
    expect(sampled.at(-1)).toBe(49);
  });
});

describe("displayPrice", () => {
  const rate = 649.45;

  it("switches units at one divine in auto mode", () => {
    expect(displayPrice(649.45, rate, "auto")).toEqual({ amount: 1, unit: "div", text: "1 div" });
    expect(displayPrice(44.8, rate, "auto")).toEqual({ amount: 44.8, unit: "ex", text: "44.8 ex" });
    expect(displayPrice(1_602_665, rate, "auto").text).toBe("2,467.73 div");
  });

  it("honours a pinned unit and marks dust as under a hundredth of a divine", () => {
    expect(displayPrice(1_602_665, rate, "exalted").text).toBe("1,602,665 ex");
    expect(displayPrice(44.8, rate, "divine").text).toBe("0.069 div");
    expect(displayPrice(1, rate, "divine").text).toBe("<0.01 div");
  });

  it("survives a broken rate", () => {
    expect(displayPrice(80, 0, "divine")).toEqual({ amount: 2, unit: "div", text: "2 div" });
    expect(formatPriceNumber(Number.NaN, 2)).toBe("—");
  });
});

describe("filterRows / sortRows", () => {
  const rows: PricingRow[] = [
    row({ key: "divine", name: "Divine Orb", current: 649, change3d: 3.1, volume7d: 800_000, sampleSize: 7 }),
    row({ key: "chaos", name: "Chaos Orb", current: 44, change3d: -6, volume7d: 900_000, sampleSize: 7, favorite: true }),
    row({ key: "ruin", name: "Essence of Ruin", category: "essences", current: 12, volume7d: 4, sampleSize: 2, lowStock: true }),
    row({ key: "temporalis", name: "Temporalis", baseType: "Silk Robe", category: "uniques", current: 1_602_665, hasHistory: false }),
  ];

  it("filters by category, favorites, search and low stock", () => {
    expect(filterRows(rows, { category: ALL_CATEGORY, search: "", hideLowStock: false }).rows).toHaveLength(4);
    expect(
      filterRows(rows, { category: FAVORITES_CATEGORY, search: "", hideLowStock: false }).rows.map((entry) => entry.key),
    ).toEqual(["chaos"]);
    expect(filterRows(rows, { category: "essences", search: "", hideLowStock: false }).rows).toHaveLength(1);
    const hidden = filterRows(rows, { category: ALL_CATEGORY, search: "", hideLowStock: true });
    expect(hidden.rows).toHaveLength(3);
    expect(hidden.hiddenLowStock).toBe(1);
    // A feed-only row has no volume to judge, so hiding low stock never drops it.
    expect(hidden.rows.some((entry) => entry.key === "temporalis")).toBe(true);
  });

  it("matches every search token against the name and base type", () => {
    expect(matchesSearch({ name: "Divine Orb" }, "div orb")).toBe(true);
    expect(matchesSearch({ name: "Divine Orb" }, "DIVINE")).toBe(true);
    expect(matchesSearch({ name: "Temporalis", baseType: "Silk Robe" }, "silk")).toBe(true);
    expect(matchesSearch({ name: "Divine Orb" }, "divine chaos")).toBe(false);
    expect(matchesSearch({ name: "Divine Orb" }, "   ")).toBe(true);
    expect(filterRows(rows, { category: ALL_CATEGORY, search: "silk", hideLowStock: false }).rows).toHaveLength(1);
  });

  it("sinks rows without the sorted reading in both directions and never mutates the input", () => {
    const input = [...rows];
    const desc = sortRows(rows, { key: "change3d", direction: "desc" });
    expect(desc.map((entry) => entry.key)).toEqual(["divine", "chaos", "ruin", "temporalis"]);
    const asc = sortRows(rows, { key: "change3d", direction: "asc" });
    expect(asc.map((entry) => entry.key)).toEqual(["chaos", "divine", "ruin", "temporalis"]);
    expect(asc.slice(-2).map((entry) => entry.key)).toEqual(["ruin", "temporalis"]);
    expect(sortRows(rows, { key: "name", direction: "asc" }).map((entry) => entry.name)).toEqual([
      "Chaos Orb",
      "Divine Orb",
      "Essence of Ruin",
      "Temporalis",
    ]);
    expect(sortRows(rows, { key: "price", direction: "desc" })[0]!.key).toBe("temporalis");
    expect(rows).toEqual(input);
  });
});

describe("svg geometry", () => {
  it("draws an empty, a single, a flat and a rising sparkline", () => {
    expect(sparklinePath([], 96, 24)).toEqual({ path: "", min: 0, max: 0 });
    const single = sparklinePath([5], 96, 24);
    expect(single.path).toBe("M 48 12");
    expect(single.last).toEqual({ x: 48, y: 12 });
    const flat = sparklinePath([3, 3, 3], 100, 20);
    expect(flat.path).toBe("M 2 10 L 50 10 L 98 10");
    const rising = sparklinePath([1, 2, 3], 100, 20);
    expect(rising.path).toBe("M 2 18 L 50 10 L 98 2");
    expect(rising).toMatchObject({ min: 1, max: 3 });
  });

  it("lays out the timeline bars, ticks and price ticks", () => {
    const series = cacheFixture().series[0]!;
    const geometry = timelineGeometry(series.points, { width: 640, height: 220 }, 649.45, "exalted");
    expect(geometry.bars).toHaveLength(7);
    expect(geometry.ticks).toHaveLength(7);
    expect(geometry.ticks[0]!.label).toBe("09-06");
    expect(geometry.priceTicks).toHaveLength(3);
    expect(geometry.priceTicks[0]!.label).toBe("649.45 ex");
    expect(geometry.unit).toBe("ex");
    expect(geometry.min).toBe(600);
    expect(geometry.max).toBe(649.45);
    expect(geometry.pricePath.startsWith("M 48 ")).toBe(true);
    for (const bar of geometry.bars) expect(bar.height).toBeGreaterThan(0);
    expect(timelineGeometry([], { width: 640, height: 220 }, 1, "auto").bars).toEqual([]);
  });

  it("plots one unit for the whole window when the series crosses a divine", () => {
    const crossing: TrendPoint[] = [90, 95, 110, 120].map((price, index) => ({
      time: new Date(Date.UTC(2026, 8, 9 + index)).toISOString(),
      price,
      quantity: 10,
    }));
    const geometry = timelineGeometry(crossing, { width: 640, height: 220 }, 100, "auto");
    expect(geometry.unit).toBe("div");
    expect(geometry.min).toBeCloseTo(0.9, 10);
    expect(geometry.max).toBeCloseTo(1.2, 10);
    expect(geometry.bars.map((bar) => bar.priceText)).toEqual([
      "0.9 div",
      "0.95 div",
      "1.1 div",
      "1.2 div",
    ]);
    expect(geometry.priceTicks.map((tick) => tick.label)).toEqual([
      "1.2 div",
      "1.05 div",
      "0.9 div",
    ]);
    // A rising series must rise: mixing units mid-window used to draw the
    // 110 ex bar below the 95 ex one (a 99 % "crash" that never happened).
    expect(pathY(geometry.pricePath)).toEqual([...pathY(geometry.pricePath)].sort((a, b) => b - a));
  });

  it("plots the unrounded ratio when the user pins divine", () => {
    const cheap: TrendPoint[] = [1, 1.02, 1.04].map((price, index) => ({
      time: new Date(Date.UTC(2026, 8, 9 + index)).toISOString(),
      price,
      quantity: 10,
    }));
    const geometry = timelineGeometry(cheap, { width: 640, height: 220 }, 650, "divine");
    expect(geometry.unit).toBe("div");
    expect(geometry.max).toBeCloseTo(1.04 / 650, 12);
    // Rounding to 4 decimals first would collapse these three bars onto two
    // heights; the labels stay rounded, the geometry does not.
    expect(new Set(pathY(geometry.pricePath)).size).toBe(3);
    expect(geometry.bars[0]!.priceText).toBe("<0.01 div");
  });
});

describe("stored history", () => {
  it("parses the fixture, refuses another league, junk and a future version", () => {
    const text = readFileSync(
      new URL("../fixtures/pricing-history/history.runes-of-aldur.json", import.meta.url),
      "utf8",
    );
    const history = parseStoredHistory(text, "Runes of Aldur", NOW);
    expect(Object.keys(history.series)).toEqual(["divine", "chaos"]);
    expect(history.series.divine!.points).toHaveLength(20);
    expect(history.since).toBe("2026-08-23T06:00:00.000Z");
    expect(history.sourceFetchedAt).toBe("2026-09-11T06:00:00.000Z");

    expect(parseStoredHistory(text, "Forbidden Rites", NOW).series).toEqual({});
    expect(parseStoredHistory("{not json", "Runes of Aldur", NOW)).toEqual(
      emptyStoredHistory("Runes of Aldur", NOW),
    );
    expect(parseStoredHistory(undefined, "Runes of Aldur", NOW).series).toEqual({});
    expect(
      parseStoredHistory(JSON.stringify({ version: 99, league: "Runes of Aldur" }), "Runes of Aldur", NOW).series,
    ).toEqual({});
    expect(serializeStoredHistory(history)).toContain('"version":1');
  });

  it("keeps the keys after an unusable one and never lets a key reach Object.prototype", () => {
    // Written as raw JSON on purpose: an object literal with a "__proto__"
    // member would set the literal's prototype instead of an own key.
    const text = [
      '{"version":1,"league":"L","since":"2026-09-01T00:00:00.000Z",',
      '"updatedAt":"2026-09-01T00:00:00.000Z","series":{',
      '"":{"name":"Blank","points":[{"time":"2026-09-01T00:00:00.000Z","price":1,"quantity":1}]},',
      '"__proto__":{"name":"Poison","points":[{"time":"2026-09-01T00:00:00.000Z","price":2,"quantity":1}]},',
      '"divine":{"name":"Divine Orb","points":[{"time":"2026-09-02T00:00:00.000Z","price":3,"quantity":1}]}',
      "}}",
    ].join("");
    const history = parseStoredHistory(text, "L", NOW);
    // The empty key is skipped, NOT a `break`: "divine" must survive, or the
    // next write silently throws away every bar collected so far.
    expect(Object.keys(history.series)).toEqual(["__proto__", "divine"]);
    expect(history.series.divine!.points).toHaveLength(1);
    expect(Object.getPrototypeOf(history.series)).toBeNull();
    expect((({}) as { name?: unknown }).name).toBeUndefined();
    expect(history.series["toString"]).toBeUndefined();
  });

  it("drops junk bars and sorts what is left", () => {
    const sanitized = sanitizeTrendPoints([
      { time: "2026-09-03T00:00:00.000Z", price: 3, quantity: 2 },
      { time: "2026-09-01T00:00:00.000Z", price: 1, quantity: 5 },
      { time: "not a time", price: 4, quantity: 1 },
      { time: "2026-09-02T00:00:00.000Z", price: 0, quantity: 1 },
      { time: "2026-09-02T00:00:00.000Z", price: 2, quantity: -3 },
      null,
    ]);
    expect(sanitized).toEqual([
      { time: "2026-09-01T00:00:00.000Z", price: 1, quantity: 5 },
      { time: "2026-09-02T00:00:00.000Z", price: 2, quantity: 0 },
      { time: "2026-09-03T00:00:00.000Z", price: 3, quantity: 2 },
    ]);
  });
});

describe("mergeHistory", () => {
  const series = cacheFixture().series;

  it("adds every bar once and is idempotent on the same snapshot", () => {
    const first = mergeHistory(emptyStoredHistory("Runes of Aldur", NOW), series, "2026-09-12T06:00:00.000Z", NOW);
    expect(first.addedBars).toBe(30);
    expect(first.changed).toBe(true);
    expect(historyBarCount(first.history)).toBe(30);
    const second = mergeHistory(first.history, series, "2026-09-12T06:00:00.000Z", NOW);
    expect(second.addedBars).toBe(0);
    expect(second.changed).toBe(false);
  });

  it("replaces a revised same-day bar and counts it as a change, not an addition", () => {
    const base = mergeHistory(emptyStoredHistory("L", NOW), series, "fetch-1", NOW).history;
    const revised: TrendSeries[] = [
      {
        ...series[0]!,
        points: series[0]!.points.map((point, index) =>
          index === series[0]!.points.length - 1 ? { ...point, price: 700 } : point,
        ),
      },
    ];
    const merged = mergeHistory(base, revised, "fetch-2", "2026-09-12T18:00:00.000Z");
    expect(merged.addedBars).toBe(0);
    expect(merged.changed).toBe(true);
    expect(merged.history.series.divine!.points.at(-1)!.price).toBe(700);
    expect(merged.history.updatedAt).toBe("2026-09-12T18:00:00.000Z");
    expect(merged.history.sourceFetchedAt).toBe("fetch-2");
  });

  it("keeps the newest MAX_HISTORY_POINTS bars per key and refuses new keys past the cap", () => {
    const long: TrendSeries = { key: "divine", name: "Divine Orb", points: points(MAX_HISTORY_POINTS + 50) };
    const merged = mergeHistory(emptyStoredHistory("L", NOW), [long], "fetch", NOW);
    expect(merged.history.series.divine!.points).toHaveLength(MAX_HISTORY_POINTS);
    expect(merged.history.series.divine!.points.at(-1)!.price).toBe(10 + MAX_HISTORY_POINTS + 49);

    const full: StoredHistory = emptyStoredHistory("L", NOW);
    for (let index = 0; index < MAX_HISTORY_KEYS; index += 1) {
      full.series[`key-${index}`] = { name: `Item ${index}`, points: points(1) };
    }
    const capped = mergeHistory(full, [{ key: "brand-new", name: "New", points: points(3) }], "fetch", NOW);
    expect(capped.history.series["brand-new"]).toBeUndefined();
    expect(capped.addedBars).toBe(0);
  });

  it("stores a hostile series key from the network as an own key", () => {
    const merged = mergeHistory(
      emptyStoredHistory("L", NOW),
      [{ key: "__proto__", name: "Poison", points: points(2) }],
      "fetch",
      NOW,
    );
    expect(Object.keys(merged.history.series)).toEqual(["__proto__"]);
    expect(merged.addedBars).toBe(2);
    expect((({}) as { points?: unknown }).points).toBeUndefined();
    expect(historyBarCount(merged.history)).toBe(2);
  });

  it("sets `since` once and keeps it across merges", () => {
    const first = mergeHistory(emptyStoredHistory("L", "2026-09-01T00:00:00.000Z"), series, "a", NOW);
    expect(first.history.since).toBe("2026-09-01T00:00:00.000Z");
    const second = mergeHistory(first.history, series, "b", "2026-09-20T00:00:00.000Z");
    expect(second.history.since).toBe("2026-09-01T00:00:00.000Z");
  });
});

describe("trimHistoryToBudget", () => {
  it("leaves a small file alone", () => {
    const history = mergeHistory(emptyStoredHistory("L", NOW), cacheFixture().series, "a", NOW).history;
    expect(trimHistoryToBudget(history)).toEqual({ history, droppedBars: 0 });
  });

  it("drops the oldest bars of the fattest keys but never below the floor", () => {
    const history = emptyStoredHistory("L", NOW);
    for (const key of ["divine", "chaos", "mirror"]) {
      history.series[key] = { name: key, points: points(60) };
    }
    const trimmed = trimHistoryToBudget(history, 2_000);
    expect(trimmed.droppedBars).toBeGreaterThan(0);
    expect(historyBarCount(trimmed.history)).toBeLessThan(180);
    for (const entry of Object.values(trimmed.history.series)) {
      expect(entry.points.length).toBeGreaterThanOrEqual(MIN_HISTORY_POINTS);
      // Newest bars survive: the last point is still the last one merged.
      expect(entry.points.at(-1)!.price).toBe(69);
    }
    // The input is untouched.
    expect(history.series.divine!.points).toHaveLength(60);
  });
});
