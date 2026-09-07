import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findCycles,
  findDirectEdges,
  parseExchangeQuotesFile,
  priceLookupFromTable,
  type ExchangeQuote,
  type PriceLookup,
} from "../src/core/exchangeArbitrage.js";
import { PRICE_TABLE_SCHEMA_VERSION, type PriceTable } from "../src/core/priceTable.js";

const PRICES: Record<string, number> = {
  "Divine Orb": 600,
  "Chaos Orb": 40,
  "Exalted Orb": 1,
  "Orb of Annulment": 200,
};
const prices: PriceLookup = (name) => PRICES[name];

/** Quotes that agree with the market exactly, minus a 2 % house spread. */
function consistentQuotes(spread = 0.02): ExchangeQuote[] {
  const names = Object.keys(PRICES);
  const quotes: ExchangeQuote[] = [];
  for (const have of names) {
    for (const want of names) {
      if (have === want) continue;
      quotes.push({ have, want, ratio: (PRICES[have]! / PRICES[want]!) * (1 - spread) });
    }
  }
  return quotes;
}

describe("direct edges", () => {
  it("flags a pair whose ratio beats the market-implied ratio", () => {
    const edges = findDirectEdges(
      [
        { have: "Divine Orb", want: "Chaos Orb", ratio: 18, quantity: 50, feeGoldPerTrade: 900 }, // market 15
        { have: "Chaos Orb", want: "Exalted Orb", ratio: 39 }, // market 40 → worse
        { have: "Divine Orb", want: "Unknown Shard", ratio: 5 }, // unpriced → skipped
      ],
      prices,
      2,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      have: "Divine Orb",
      want: "Chaos Orb",
      marketRatio: 15,
      gainPercent: 20,
      gainExPerHave: 120,
      quantity: 50,
      feeGoldPerTrade: 900,
    });
  });

  it("respects the threshold and sorts by gain", () => {
    const quotes: ExchangeQuote[] = [
      { have: "Divine Orb", want: "Chaos Orb", ratio: 15.15 }, // +1 %
      { have: "Divine Orb", want: "Exalted Orb", ratio: 660 }, // +10 %
    ];
    expect(findDirectEdges(quotes, prices, 2).map((edge) => edge.want)).toEqual(["Exalted Orb"]);
    expect(findDirectEdges(quotes, prices, 0.5).map((edge) => edge.want)).toEqual([
      "Exalted Orb",
      "Chaos Orb",
    ]);
  });
});

describe("cycles", () => {
  it("finds a profitable 3-cycle once, with its limiting stock", () => {
    const quotes: ExchangeQuote[] = [
      { have: "A", want: "B", ratio: 2, quantity: 100 },
      { have: "B", want: "C", ratio: 3, quantity: 90 },
      { have: "C", want: "A", ratio: 0.2, quantity: 1000 },
      // The reverse direction loses money.
      { have: "A", want: "C", ratio: 4.5 },
      { have: "C", want: "B", ratio: 0.3 },
      { have: "B", want: "A", ratio: 0.45 },
    ];
    const cycles = findCycles(quotes, { maxLength: 3, minGainPercent: 2 });
    expect(cycles).toHaveLength(1);
    const [cycle] = cycles;
    expect(cycle!.sequence).toEqual(["A", "B", "C", "A"]);
    expect(cycle!.multiplier).toBeCloseTo(1.2, 6);
    expect(cycle!.grossGainPercent).toBe(20);
    expect(cycle!.netGainPercent).toBe(20); // no fee data → gross
    expect(cycle!.feeApplied).toBe(false);
    // Hop B→C stocks 90 C: 90 / (2 × 3) = 15 A at most.
    expect(cycle!.limit).toEqual({ maxStartAmount: 15, limitedBy: { have: "B", want: "C" } });
  });

  it("finds 2-cycles and caps at maxLength", () => {
    const quotes: ExchangeQuote[] = [
      { have: "A", want: "B", ratio: 2 },
      { have: "B", want: "A", ratio: 0.55 }, // 1.1
      { have: "B", want: "C", ratio: 1 },
      { have: "C", want: "A", ratio: 0.6 }, // A→B→C→A = 1.2
    ];
    const two = findCycles(quotes, { maxLength: 2 });
    expect(two.map((cycle) => cycle.sequence)).toEqual([["A", "B", "A"]]);
    const three = findCycles(quotes, { maxLength: 3 });
    expect(three.map((cycle) => cycle.sequence)).toEqual([
      ["A", "B", "C", "A"],
      ["A", "B", "A"],
    ]);
  });

  it("lets the gold fee kill a marginal cycle at small size", () => {
    const quotes: ExchangeQuote[] = [
      { have: "Chaos Orb", want: "Exalted Orb", ratio: 41.2, feeGoldPerTrade: 500 },
      { have: "Exalted Orb", want: "Chaos Orb", ratio: 0.025, feeGoldPerTrade: 500 }, // ×1.03
    ];
    const gross = findCycles(quotes, { minGainPercent: 2 });
    expect(gross).toHaveLength(1);
    expect(gross[0]!.grossGainPercent).toBe(3);
    expect(gross[0]!.feeGold).toBe(1000);
    expect(gross[0]!.feeApplied).toBe(false);

    // 1 chaos (40 ex) gains 1.2 ex, the two trades cost 1000 gold = 1 ex.
    const small = findCycles(quotes, { minGainPercent: 2, prices, goldPerExalted: 1000, startAmount: 1 });
    expect(small).toEqual([]);

    // 100 chaos: the same flat fee is noise.
    const large = findCycles(quotes, {
      minGainPercent: 2,
      prices,
      goldPerExalted: 1000,
      startAmount: 100,
    });
    expect(large).toHaveLength(1);
    expect(large[0]!.feeApplied).toBe(true);
    expect(large[0]!.startValueEx).toBe(4000);
    expect(large[0]!.netGainEx).toBe(119);
    expect(large[0]!.netGainPercent).toBeCloseTo(2.98, 2);
  });

  it("reports no cycles on market-consistent quotes", () => {
    expect(findCycles(consistentQuotes(0.02), { minGainPercent: 0 })).toEqual([]);
    expect(findCycles(consistentQuotes(0), { minGainPercent: 0 })).toEqual([]);
    expect(findDirectEdges(consistentQuotes(0.02), prices, 0)).toEqual([]);
  });

  it("keeps the best ratio when a pair is quoted twice", () => {
    const quotes: ExchangeQuote[] = [
      { have: "A", want: "B", ratio: 1 },
      { have: "A", want: "B", ratio: 2 },
      { have: "B", want: "A", ratio: 0.6 },
    ];
    const [cycle] = findCycles(quotes);
    expect(cycle!.multiplier).toBeCloseTo(1.2, 6);
  });
});

describe("prices and quote files", () => {
  it("prices from the table, then orb defaults, then overrides", () => {
    const table: PriceTable = {
      schemaVersion: PRICE_TABLE_SCHEMA_VERSION,
      currency: "exalted",
      entries: [{ id: "feed:poe2scout:chaos", match: { name: "Chaos Orb" }, value: 44.8 }],
    };
    const lookup = priceLookupFromTable(table, { "Divine Orb": 650 });
    expect(lookup("Chaos Orb")).toBe(44.8);
    expect(lookup("Exalted Orb")).toBe(1);
    expect(lookup("Divine Orb")).toBe(650);
    expect(lookup("divine orb")).toBe(650);
    expect(lookup("Orb of Annulment")).toBeGreaterThan(0); // orb default
    expect(lookup("Mystery Shard")).toBeUndefined();
  });

  it("parses the sample quotes file and finds its planted opportunities", () => {
    const file = parseExchangeQuotesFile(
      JSON.parse(readFileSync(path.resolve("fixtures/exchange/sample-quotes.json"), "utf8")),
    );
    expect(file.quotes).toHaveLength(7);
    expect(file.goldPerExalted).toBe(5000);
    const lookup = priceLookupFromTable(undefined, file.prices);
    const edges = findDirectEdges(file.quotes, lookup, 2);
    // The planted cycle's first hop also beats the market on its own.
    expect(edges.map((edge) => `${edge.have}→${edge.want}`)).toEqual([
      "Chaos Orb→Orb of Annulment",
      "Divine Orb→Chaos Orb",
    ]);
    const cycles = findCycles(file.quotes, {
      minGainPercent: 2,
      prices: lookup,
      goldPerExalted: file.goldPerExalted,
      startAmount: 10,
    });
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.sequence).toEqual(["Chaos Orb", "Orb of Annulment", "Exalted Orb", "Chaos Orb"]);
    expect(cycles[0]!.feeApplied).toBe(true);
    expect(cycles[0]!.limit?.limitedBy).toEqual({ have: "Orb of Annulment", want: "Exalted Orb" });
  });

  it("accepts a bare quote array", () => {
    expect(parseExchangeQuotesFile([{ have: "A", want: "B", ratio: 1 }, "junk"]).quotes).toHaveLength(1);
    expect(parseExchangeQuotesFile(null).quotes).toEqual([]);
  });
});
