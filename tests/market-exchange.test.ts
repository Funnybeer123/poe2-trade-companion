import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { emptyPriceTable, type PriceTable } from "../src/core/priceTable.js";
import { parseExchangeResult } from "../src/core/tradeListings.js";
import {
  exchangeCurrencyOptions,
  exchangeRateStrip,
  formatRatio,
  groupOffersBySeller,
  shouldGroupBySeller,
} from "../src/core/marketExchange.js";

const curated = JSON.parse(
  readFileSync(path.join(process.cwd(), "src", "data", "market", "exchange-currencies.json"), "utf8"),
) as unknown;
const exchange = JSON.parse(
  readFileSync(path.join(process.cwd(), "fixtures", "market", "exchange-divine-exalted.json"), "utf8"),
) as unknown;

const parsed = parseExchangeResult(exchange, "Runes of Aldur");

function table(): PriceTable {
  const value = emptyPriceTable();
  value.entries.push({ id: "divine", match: { name: "Divine Orb" }, value: 404.62 });
  return value;
}

describe("exchangeCurrencyOptions", () => {
  it("reads the curated list and marks what the price table can price", () => {
    const options = exchangeCurrencyOptions(curated, table());
    const divine = options.find((option) => option.id === "divine");
    expect(divine).toMatchObject({ label: "Divine Orb", verified: true, rateKnown: true });
    expect(options.find((option) => option.id === "exalted")?.rateKnown).toBe(true);
    expect(options.find((option) => option.id === "breach-splinter")?.verified).toBe(false);
  });

  it("reads the /data/static shape too", () => {
    const options = exchangeCurrencyOptions([
      { id: "Currency", label: "Currency", entries: [{ id: "divine", text: "Divine Orb" }] },
    ]);
    expect(options).toEqual([{ id: "divine", label: "Divine Orb", category: "Currency", verified: true, rateKnown: true }]);
  });

  it("unwraps a { result: [...] } payload and refuses junk ids", () => {
    const options = exchangeCurrencyOptions({
      result: [{ id: "x", label: "X", entries: [{ id: "NOT AN ID", text: "n" }, { id: "chaos", text: "Chaos Orb" }] }],
    });
    expect(options.map((option) => option.id)).toEqual(["chaos"]);
    expect(exchangeCurrencyOptions("nope")).toEqual([]);
  });
});

describe("offers", () => {
  it("parses the fixture into four offers over three sellers", () => {
    expect(parsed.offers).toHaveLength(4);
    expect(parsed.offers[0]!.id).toBe("listing-a#0");
    expect(parsed.offers[2]!.id).toBe("listing-b");
  });

  it("groups by seller in arrival order", () => {
    const groups = groupOffersBySeller(parsed.offers);
    expect(groups.map((group) => group.seller.account)).toEqual(["BulkOne", "BulkTwo", "BulkThree"]);
    expect(groups[0]!.offers).toHaveLength(2);
    expect(groups[0]!.whisper).toContain("BulkChar");
  });

  it("groups automatically once more than two currencies are in play", () => {
    expect(shouldGroupBySeller({ have: ["divine"], want: ["exalted"] })).toBe(false);
    expect(shouldGroupBySeller({ have: ["divine"], want: ["exalted", "chaos"] })).toBe(true);
  });

  it("phrases a ratio the way round it reads best", () => {
    expect(formatRatio(parsed.offers[0]!)).toBe("1 Divine Orb → 402 Exalted Orb");
    const inverse = parsed.offers.find((offer) => offer.have.currency === "exalted");
    expect(formatRatio(inverse!)).toBe("410 Exalted Orb per Divine Orb");
  });

  it("never divides by zero", () => {
    expect(
      formatRatio({
        id: "x",
        seller: { account: "a" },
        have: { currency: "divine", amount: 0 },
        want: { currency: "exalted", amount: 1 },
        stock: 0,
        ratio: 0,
      }),
    ).toBe("Divine Orb → Exalted Orb");
  });
});

describe("exchangeRateStrip", () => {
  it("prices both sides from the feed, once each", () => {
    const strip = exchangeRateStrip({ have: ["divine", "Divine"], want: ["exalted"] }, table());
    expect(strip.map((row) => row.id)).toEqual(["divine", "exalted"]);
    expect(strip[0]!.exalted).toBe(404.62);
    expect(strip[0]!.divine).toBe(1);
    expect(strip[1]!.exalted).toBe(1);
  });

  it("says nothing rather than guessing an unknown currency", () => {
    const strip = exchangeRateStrip({ have: ["not-a-currency"], want: [] }, emptyPriceTable());
    expect(strip[0]!.exalted).toBeUndefined();
  });
});
