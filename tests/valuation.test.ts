import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseItemText } from "../src/core/parseItem.js";
import { CachedMarketProvider, FixtureMarketProvider } from "../src/core/market.js";
import { valueItem } from "../src/core/valuation.js";
import { scoreDesirability } from "../src/core/desirability.js";

const quotes = JSON.parse(
  readFileSync(path.join(process.cwd(), "fixtures", "market", "quotes.json"), "utf8"),
) as Record<string, Array<{ listingId: string; priceAmount: number; priceCurrency: string }>>;

describe("valuation and desirability", () => {
  it("filters outliers and explains scores", async () => {
    const item = parseItemText(
      readFileSync(path.join(process.cwd(), "fixtures", "items", "rare-body.txt"), "utf8"),
    );
    const provider = new CachedMarketProvider(new FixtureMarketProvider(quotes), 60_000, 0);
    const quote = await provider.quote(item, { league: "Standard", currency: "exalted" });
    const valuation = valueItem(item, quote);
    expect(valuation.comparablesUsed).toBeLessThan(valuation.candidateCount);
    expect(valuation.fair).toBeGreaterThan(0);
    expect(valuation.recommendedListing).toBeLessThanOrEqual(valuation.fair);
    const desire = scoreDesirability(item, valuation);
    expect(desire.score).toBeGreaterThanOrEqual(0);
    expect(desire.score).toBeLessThanOrEqual(100);
    expect(desire.reasons.length).toBeGreaterThan(0);
  });

  it("is deterministic for identical inputs", async () => {
    const item = parseItemText(
      readFileSync(path.join(process.cwd(), "fixtures", "items", "unique-bow.txt"), "utf8"),
    );
    const provider = new FixtureMarketProvider(quotes);
    const quote = await provider.quote(item, { league: "Standard", currency: "exalted" });
    const a = scoreDesirability(item, valueItem(item, quote));
    const b = scoreDesirability(item, valueItem(item, quote));
    expect(a).toEqual(b);
  });
});
