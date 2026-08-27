import {
  createOfficialCurrencyExchangeProvider,
  createMemoryMarketCache,
  failedQuote,
  marketCacheKey,
  parseRetryAfterMs,
  rateLimitFetch,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";

const item = {
  fingerprint: "divine",
  name: "Divine Orb",
  rarity: "currency",
  class: "Currency",
  modifiers: [],
  pseudos: {},
};

const context = { league: "Standard", realm: "poe2" as const, maxAgeMs: 3_600_000 };

function jsonResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

describe("rateLimitFetch and official provider failure modes", () => {
  it("parses Retry-After seconds and HTTP dates", () => {
    expect(parseRetryAfterMs("2", 0)).toBe(2_000);
    expect(parseRetryAfterMs("Thu, 01 Jan 1970 00:00:05 GMT", 0)).toBe(5_000);
  });

  it("does not retry on 429 and exposes Retry-After", async () => {
    let calls = 0;
    const result = await rateLimitFetch("https://web.poecdn.com/api/currency-exchange/poe2", {
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(429, "", { "Retry-After": "3" });
      },
    });
    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(429);
    expect(result.retryAfterMs).toBe(3_000);
  });

  it("maps 5xx and offline to failed quotes, using cache when fresh", async () => {
    const cache = createMemoryMarketCache();
    const cached = failedQuote("official-currency-exchange", 1_000, "seed");
    cached.confidence = "medium";
    cached.fair = 15;
    cached.candidateCount = 3;
    cached.comparableCount = 3;
    cache.set(
      marketCacheKey({
        providerId: "official-currency-exchange",
        league: "Standard",
        realm: "poe2",
        fingerprint: "divine",
      }),
      cached,
      1_000,
      10_000,
    );

    const throttled = createOfficialCurrencyExchangeProvider({
      cache,
      nowMs: () => 1_500,
      fetchImpl: async () => jsonResponse(429, "", { "Retry-After": "1" }),
    });
    const fromCache = await throttled.quote(item, context);
    expect(fromCache.fair).toBe(15);
    expect(fromCache.lowConfidenceReason).toContain("http-429");
    expect(fromCache.lowConfidenceReason).toContain("using-cache");

    const offline = createOfficialCurrencyExchangeProvider({
      nowMs: () => 1,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const failed = await offline.quote(item, context);
    expect(failed.confidence).toBe("none");
    expect(failed.lowConfidenceReason).toBe("offline");

    const serverError = createOfficialCurrencyExchangeProvider({
      nowMs: () => 1,
      fetchImpl: async () => jsonResponse(503, "nope"),
    });
    const five = await serverError.quote(item, context);
    expect(five.confidence).toBe("none");
    expect(five.lowConfidenceReason).toBe("http-503");
  });
});
