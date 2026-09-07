import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeTrend,
  farmRanking,
  formatPercent,
  normalizeScoutPriceLogs,
  stackAdvice,
  summarizeTrends,
  type TrendSeries,
} from "../src/core/priceTrends.js";
import { PRICE_TABLE_SCHEMA_VERSION, type PriceTable } from "../src/core/priceTable.js";

// A real /Currencies/ByCategory?category=currency page (Runes of Aldur,
// captured 2026-09-07) trimmed to 10 items; all seven daily bars kept,
// including the `null` bars poe2scout emits for sparse shards.
const PAGE = JSON.parse(
  readFileSync(path.resolve("fixtures/market/poe2scout-currency-page.json"), "utf8"),
) as unknown;
const NOW = "2026-09-07T12:00:00Z";

const series = normalizeScoutPriceLogs(PAGE);
const byKey = new Map(series.map((entry) => [entry.key, entry] as const));

describe("poe2scout price-log normalization", () => {
  it("keys series by ApiId, matching the feed's row ids", () => {
    expect(series).toHaveLength(10);
    expect(series.map((entry) => entry.key)).toContain("divine");
    const divine = byKey.get("divine")!;
    expect(divine.name).toBe("Divine Orb");
    expect(divine.category).toBe("currency");
    expect(divine.current).toBeCloseTo(649.45, 1);
  });

  it("sorts bars oldest → newest and skips null bars", () => {
    const divine = byKey.get("divine")!;
    expect(divine.points).toHaveLength(7);
    expect(divine.points[0]!.time.slice(0, 10)).toBe("2026-09-01");
    expect(divine.points[6]!.time.slice(0, 10)).toBe("2026-09-07");
    const shard = byKey.get("transmutation-shard")!;
    expect(shard.points).toHaveLength(5); // two null bars in the source
    expect(shard.points.every((point) => point.price > 0)).toBe(true);
  });

  it("accepts a bare item array and rejects junk", () => {
    const items = (PAGE as { Items: unknown[] }).Items;
    expect(normalizeScoutPriceLogs(items)).toHaveLength(10);
    expect(normalizeScoutPriceLogs("nope")).toEqual([]);
    expect(normalizeScoutPriceLogs({ Items: [{ Text: "No bars", PriceLogs: [null] }] })).toEqual([]);
  });

  it("marks unique rows with rarity and base type", () => {
    const [unique] = normalizeScoutPriceLogs([
      {
        Name: "Temporalis",
        Type: "Silk Robe",
        Text: "Temporalis Silk Robe",
        CurrentPrice: 1500,
        PriceLogs: [{ Price: 1400, Time: "2026-09-06T00:00:00Z", Quantity: 3 }],
      },
    ]);
    expect(unique).toMatchObject({ key: "temporalis-silk-robe", unique: true, baseType: "Silk Robe" });
  });
});

describe("computeTrend", () => {
  it("reads a rising, deep market off divine orbs", () => {
    const trend = computeTrend(byKey.get("divine")!, NOW);
    expect(trend.current).toBeCloseTo(649.45, 1);
    // 649.45 vs 558.8 (09-06), 462.77 (09-04), 368.9 (09-01).
    expect(trend.change1d).toBeGreaterThan(15.5);
    expect(trend.change1d).toBeLessThan(17);
    expect(trend.change3d).toBeGreaterThan(39.5);
    expect(trend.change3d).toBeLessThan(41);
    expect(trend.change7d).toBeGreaterThan(75);
    expect(trend.change7d).toBeLessThan(77);
    expect(trend.volume7d).toBe(19_083_150);
    expect(trend.sampleSize).toBe(7);
    expect(trend.volatility7d).toBeGreaterThan(0.1);
    expect(trend.volatility7d).toBeLessThan(0.3);
    expect(trend.trend).toBe("rising");
    expect(trend.liquidity).toBe("deep");
  });

  it("reads a falling market and a thin one", () => {
    const greaterChaos = computeTrend(byKey.get("greater-chaos-orb")!, NOW);
    expect(greaterChaos.change3d).toBeLessThan(-15);
    expect(greaterChaos.trend).toBe("falling");
    const mirror = computeTrend(byKey.get("mirror")!, NOW);
    expect(mirror.volume7d).toBe(671);
    expect(mirror.liquidity).toBe("thin");
    expect(mirror.trend).toBe("rising");
  });

  it("uses the bar in force at the target time, not the nearest one", () => {
    // Bars are stamped 00:00Z for the day they describe. Noon three days
    // ago falls inside the 09-04 bar even though 09-05's is as close.
    const chaos = computeTrend(byKey.get("chaos")!, NOW);
    const bars = byKey.get("chaos")!.points;
    const sep4 = bars.find((point) => point.time.startsWith("2026-09-04"))!.price;
    expect(chaos.change3d).toBeCloseTo(((chaos.current - sep4) / sep4) * 100, 0);
    expect(chaos.trend).toBe("stable");
  });

  it("leaves a change undefined when no bar sits within tolerance", () => {
    // One bar 48 h from every reference target (1 d, 3 d, 7 d back).
    const sparse: TrendSeries = {
      key: "sparse",
      name: "Sparse Shard",
      points: [{ time: "2026-09-02T12:00:00Z", price: 5, quantity: 1 }],
    };
    const trend = computeTrend(sparse, NOW);
    expect(trend.current).toBe(5);
    expect(trend.change1d).toBeUndefined();
    expect(trend.change3d).toBeUndefined();
    expect(trend.change7d).toBeUndefined();
    expect(trend.volatility7d).toBeUndefined();
    expect(trend.trend).toBe("stable");
    expect(trend.liquidity).toBe("thin");
    expect(stackAdvice(trend)).toEqual({ verdict: "neutral", reason: "neutral: no price history yet" });
  });

  it("takes a tunable threshold", () => {
    const divine = byKey.get("divine")!;
    expect(computeTrend(divine, NOW, { trendThresholdPercent: 50 }).trend).toBe("stable");
    expect(computeTrend(divine, NOW, { deepVolume7d: 1e9 }).liquidity).toBe("thin");
  });
});

describe("stackAdvice", () => {
  it("holds rising stacks and sells falling ones", () => {
    const hold = stackAdvice(computeTrend(byKey.get("divine")!, NOW));
    expect(hold.verdict).toBe("hold");
    expect(hold.reason).toMatch(/^hold: \+40\.\d% over 3 d and rising$/);

    const sell = stackAdvice(computeTrend(byKey.get("greater-chaos-orb")!, NOW));
    expect(sell.verdict).toBe("sell");
    expect(sell.reason).toMatch(/^sell: -17\.\d% over 3 d$/);

    const neutral = stackAdvice(computeTrend(byKey.get("chaos")!, NOW));
    expect(neutral.verdict).toBe("neutral");
    expect(neutral.reason).toMatch(/^neutral: -2\.\d% over 3 d, stable$/);
  });

  it("warns when the market is thin", () => {
    const mirror = stackAdvice(computeTrend(byKey.get("mirror")!, NOW));
    expect(mirror.verdict).toBe("hold");
    expect(mirror.reason).toContain("thin market");
  });

  it("formats percentages compactly", () => {
    expect(formatPercent(12)).toBe("+12%");
    expect(formatPercent(-9.04)).toBe("-9.0%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(undefined)).toBe("n/a");
  });
});

describe("farmRanking", () => {
  const reports = summarizeTrends(series, NOW);

  it("ranks by price × 7-day volume, scaled to the leader", () => {
    const ranking = farmRanking(reports, { limit: 5 });
    expect(ranking).toHaveLength(5);
    expect(ranking[0]!.key).toBe("divine");
    expect(ranking[0]!.score).toBe(100);
    expect(ranking.every((candidate) => candidate.score > 0 && candidate.score <= 100)).toBe(true);
    expect(ranking[0]!.why).toContain("649 ex × 19.1M traded over 7 d");
    expect(ranking[0]!.why).toContain("rising");
    expect(ranking.map((candidate) => candidate.score)).toEqual(
      [...ranking.map((candidate) => candidate.score)].sort((a, b) => b - a),
    );
  });

  it("lets the price table override the feed price", () => {
    const table: PriceTable = {
      schemaVersion: PRICE_TABLE_SCHEMA_VERSION,
      currency: "exalted",
      entries: [{ id: "my-divine", match: { name: "Divine Orb" }, value: 1 }],
    };
    const ranking = farmRanking(reports, { priceTable: table });
    const divine = ranking.find((candidate) => candidate.key === "divine")!;
    expect(divine.price).toBe(1);
    expect(ranking[0]!.key).not.toBe("divine");
  });

  it("skips items with no volume", () => {
    const quiet = summarizeTrends(
      [{ key: "q", name: "Quiet", points: [{ time: "2026-09-06T00:00:00Z", price: 3, quantity: 0 }] }],
      NOW,
    );
    expect(farmRanking(quiet)).toEqual([]);
  });
});
