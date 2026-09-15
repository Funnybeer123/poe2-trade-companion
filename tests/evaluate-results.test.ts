import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { itemSummary } from "../src/core/evaluateItem.js";
import {
  currencyCounts,
  estimateFor,
  exchangeSummary,
  feedPriceExalted,
  filterRows,
  groupBySeller,
  historyFor,
  listingRow,
  sortRows,
  toCompListing,
} from "../src/core/evaluateResults.js";
import { parseItemText } from "../src/core/parseItem.js";
import { PRICE_TABLE_SCHEMA_VERSION, type PriceTable } from "../src/core/priceTable.js";
import type { TrendSeries } from "../src/core/priceTrends.js";
import { parseExchangeResult, parseTradeListings } from "../src/core/tradeListings.js";

const NOW = new Date("2026-09-07T12:00:00Z");

const TABLE: PriceTable = {
  schemaVersion: PRICE_TABLE_SCHEMA_VERSION,
  currency: "exalted",
  entries: [
    { id: "feed:poe2scout:divine", match: { name: "Divine Orb" }, value: 400 },
    { id: "feed:poe2scout:chaos", match: { name: "Chaos Orb" }, value: 36 },
  ],
};

function json(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/evaluate/${name}`, import.meta.url), "utf8")) as unknown;
}

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/evaluate/${name}`, import.meta.url), "utf8");
}

const LISTINGS = parseTradeListings(json("fetch-rare-ring.json"), "Runes of Aldur", { priceTable: TABLE });
const ROWS = LISTINGS.map((listing) => listingRow(listing, NOW.getTime(), TABLE));

describe("listingRow", () => {
  it("reads the price, the exalted equivalent, the age band and the stash notes", () => {
    const first = ROWS[0]!;
    expect(first.price).toEqual({ amount: 5, currency: "exalted" });
    expect(first.priceExalted).toBe(5);
    expect(first.stale).toBe("fresh");
    expect(first.stashNote).toBe("~price 5 exalted");
    expect(first.buyoutNote).toBe("~b/o 5 exalted");
    expect(first.presence).toBe("online");
    expect(first.seller).toBe("SellerA");
    expect(first.quality).toBe(14);
    expect(first.requiredLevel).toBe(62);

    const divine = ROWS[1]!;
    expect(divine.priceExalted).toBe(400);
    expect(divine.presence).toBe("afk");
    expect(divine.stale).toBe("aging");

    const secure = ROWS[2]!;
    expect(secure.listingType).toBe("secure");
    expect(secure.stale).toBe("stale");
    expect(secure.presence).toBe("offline");

    const unpriced = ROWS[3]!;
    expect(unpriced.priceText).toBe("");
    expect(unpriced.stashNote).toBe("");
  });

  it("keeps the listing's own mods for the peek popover and never the raw payload", () => {
    expect(ROWS[0]!.mods.explicit).toEqual(["+70 to maximum Life", "+30% to Fire Resistance"]);
    expect(ROWS[0]!.mods.implicit).toEqual(["+9% to all Elemental Resistances"]);
    expect(JSON.stringify(ROWS[0]).includes("psapi")).toBe(false);
  });
});

describe("toCompListing", () => {
  it("keeps only priced rows — an unpriced listing says nothing about value", () => {
    expect(toCompListing(LISTINGS[0]!)?.priceAmount).toBe(5);
    expect(toCompListing(LISTINGS[3]!)).toBeUndefined();
  });
});

describe("sortRows / filterRows / groupBySeller / currencyCounts", () => {
  it("sorts by every key and always puts the unknown value last", () => {
    expect(sortRows(ROWS, "price", "asc").map((row) => row.id)).toEqual([
      "row-a",
      "row-c",
      "row-b",
      "row-d",
    ]);
    expect(sortRows(ROWS, "price", "desc")[0]!.id).toBe("row-b");
    expect(sortRows(ROWS, "ilvl", "desc").at(-1)!.id).toBe("row-d");
    expect(sortRows(ROWS, "age", "asc")[0]!.id).toBe("row-a");
  });

  it("filters by currency, presence, age and listing type", () => {
    expect(filterRows(ROWS, { currency: "divine" }).map((row) => row.id)).toEqual(["row-b"]);
    expect(filterRows(ROWS, { onlineOnly: true }).map((row) => row.id)).toEqual(["row-a"]);
    expect(filterRows(ROWS, { secureOnly: true }).map((row) => row.id)).toEqual(["row-c"]);
    expect(filterRows(ROWS, { maxAgeMs: 24 * 60 * 60 * 1000 }).map((row) => row.id)).toEqual([
      "row-a",
      "row-d",
    ]);
  });

  it("groups by seller, cheapest group first", () => {
    const groups = groupBySeller(ROWS);
    expect(groups.map((group) => group.seller)).toEqual(["SellerD", "SellerA", "SellerC", "SellerB"]);
    expect(groups.every((group) => group.rows.length === 1)).toBe(true);
  });

  it("counts the currencies present", () => {
    expect(currencyCounts(ROWS)).toEqual([
      { currency: "exalted", count: 2 },
      { currency: "divine", count: 1 },
    ]);
  });
});

describe("estimateFor", () => {
  const parsed = parseItemText(fixture("rare-ring-resists.txt"));

  it("prices from the fetched listings and reports its sample", () => {
    const estimate = estimateFor({
      parsed,
      listings: LISTINGS,
      basis: "stat-filtered",
      priceTable: TABLE,
      now: NOW,
    });
    expect(estimate.candidateCount).toBe(4);
    expect(estimate.sampleSize).toBe(3);
    expect(estimate.basis).toBe("stat-filtered");
    expect(estimate.valuation.providerName).toBe("trade2-comps");
    expect(estimate.valuation.low).toBeLessThanOrEqual(estimate.valuation.fair);
    expect(estimate.valuation.fair).toBeLessThanOrEqual(estimate.valuation.high);
    expect(["high", "medium", "low", "none"]).toContain(estimate.confidence);
  });

  it("says so instead of guessing when no listing came back", () => {
    const estimate = estimateFor({ parsed, listings: [], basis: "base-type", now: NOW });
    expect(estimate.sampleSize).toBe(0);
    expect(estimate.candidateCount).toBe(0);
    expect(["appraisal", "none"]).toContain(estimate.valuation.providerName);
  });
});

describe("exchangeSummary", () => {
  it("prices one unit of the wanted item in the have-side currency", () => {
    const parsed = parseExchangeResult(json("exchange-divine.json"), "Runes of Aldur");
    const summary = exchangeSummary(parsed.offers, "https://example.invalid/exchange", NOW);
    expect(summary.offers.map((offer) => offer.perUnitQuoted)).toEqual([400, 410, 450]);
    expect(summary.bestAskQuoted).toBe(400);
    expect(summary.medianAskQuoted).toBe(410);
    expect(summary.stockTotal).toBe(60);
    expect(summary.quoteCurrency).toBe("exalted");
    expect(summary.offers[0]!.ratio).toBe("400 exalted : 1 divine");
    expect(summary.fetchedAt).toBe(NOW.toISOString());
  });

  it("quotes in whatever have-side currency the caller used", () => {
    const summary = exchangeSummary([], "https://example.invalid/exchange", NOW, "divine");
    expect(summary.quoteCurrency).toBe("divine");
    expect(summary.bestAskQuoted).toBeUndefined();
    expect(summary.stockTotal).toBe(0);
  });

  it("never claims a unit it was not given: the fields say Quoted, not exalted", () => {
    const parsed = parseExchangeResult(json("exchange-divine.json"), "Runes of Aldur");
    const summary = exchangeSummary(parsed.offers, "https://example.invalid/exchange", NOW, "divine");
    // Same numbers, a different unit — which is exactly why the field names
    // must not say "Exalted" (an exalted stack is quoted in divine).
    expect(summary.quoteCurrency).toBe("divine");
    expect(summary.medianAskQuoted).toBe(410);
    expect(summary.caution).toBeUndefined();
  });
});

describe("feedPriceExalted", () => {
  it("cross-checks the exchange against the price feed", () => {
    const summary = itemSummary(parseItemText(fixture("currency-divine.txt")));
    expect(feedPriceExalted(summary, TABLE)).toBe(400);
    expect(feedPriceExalted(summary, undefined)).toBeUndefined();
  });
});

describe("historyFor", () => {
  const series: TrendSeries[] = [
    {
      key: "feed:poe2scout:divine",
      name: "Divine Orb",
      current: 410,
      points: Array.from({ length: 9 }, (_, index) => ({
        time: new Date(NOW.getTime() - (8 - index) * 24 * 60 * 60 * 1000).toISOString(),
        price: 380 + index * 5,
        quantity: 100 + index,
      })),
    },
    { key: "feed:poe2scout:other", name: "Widowhail", unique: true, baseType: "Short Bow", points: [] },
  ];

  it("takes the last seven bars and the trend for the matching series", () => {
    const summary = itemSummary(parseItemText(fixture("currency-divine.txt")));
    const history = historyFor(series, summary, "2026-09-07T11:00:00Z", false, NOW);
    expect(history?.points).toHaveLength(7);
    expect(history?.current).toBe(410);
    expect(history?.change7d).toBeGreaterThan(0);
    expect(history?.fetchedAt).toBe("2026-09-07T11:00:00Z");
    expect(history?.stale).toBe(false);
  });

  it("refuses a unique whose base type disagrees, and an item with no series", () => {
    const bow = itemSummary(parseItemText(fixture("unidentified-unique-bow.txt")));
    expect(historyFor(series, { ...bow, name: "Widowhail" }, undefined, true, NOW)).toBeUndefined();
    expect(historyFor(series, bow, undefined, true, NOW)).toBeUndefined();
  });
});
