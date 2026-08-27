import {
  createOfficialCurrencyExchangeProvider,
  parseCurrencyExchangeDigest,
  parseItem,
  quoteFromDigest,
} from "@poe2tc/core";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { itemFixturePath, marketFixturePath } from "../../helpers/fixturePaths.js";

describe("official currency-exchange fixture parser", () => {
  const digest = parseCurrencyExchangeDigest(
    readFileSync(marketFixturePath("currency-exchange-hourly.json"), "utf8"),
  );

  it("parses the saved hourly digest without hitting the network", () => {
    expect(digest.next_change_id).toBe(1_756_245_600);
    expect(digest.markets).toHaveLength(2);
    expect(digest.markets[0]?.market_pair).toContain("Metadata/Items/Currency/CurrencyDivine");
  });

  it("quotes Divine Orb in exalted from lowest/highest ratio", async () => {
    const parsed = parseItem({
      rawText: readFileSync(itemFixturePath("currency-divine.txt"), "utf8"),
      source: "fixture",
      capturedAtMs: 1,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const quote = quoteFromDigest(
      parsed.item,
      digest,
      { league: "Standard", realm: "poe2", maxAgeMs: 3_600_000 },
      1_756_245_600_000,
    );
    expect(quote.providerId).toBe("official-currency-exchange");
    expect(quote.currency).toBe("exalted");
    expect(quote.low).toBe(12);
    expect(quote.high).toBe(18);
    expect(quote.fair).toBe(15);
    expect(quote.recommendedListing).toBe(15);
    expect(quote.isGuaranteedSalePrice).toBeUndefined();
    expect(quote.confidence).not.toBe("none");
    expect(quote.candidateCount).toBeGreaterThan(0);
    expect(quote.comparableCount).toBeGreaterThan(0);

    const provider = createOfficialCurrencyExchangeProvider({
      nowMs: () => 1_756_245_600_000,
      fetchImpl: async () =>
        new Response(readFileSync(marketFixturePath("currency-exchange-hourly.json"), "utf8"), {
          status: 200,
        }),
    });
    const live = await provider.quote(parsed.item, {
      league: "Standard",
      realm: "poe2",
      maxAgeMs: 3_600_000,
    });
    expect(live.fair).toBe(15);
    expect(provider.url()).toBe("https://web.poecdn.com/api/currency-exchange/poe2");
  });
});
