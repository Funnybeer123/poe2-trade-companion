import { FrozenClock, failedQuote, marketCacheKey } from "@poe2tc/core";
import { SqliteMarketCache, applyMigrations, openSqliteDatabase } from "@poe2tc/persistence-sqlite";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "../helpers/fixturePaths.js";

describe("SqliteMarketCache", () => {
  it("stores and returns a quote within maxAge", () => {
    const clock = new FrozenClock(1_000);
    const db = openSqliteDatabase(":memory:");
    applyMigrations(db, MIGRATIONS_DIR, clock);
    const cache = new SqliteMarketCache(db);
    const key = marketCacheKey({
      providerId: "fixture",
      league: "Standard",
      realm: "poe2",
      fingerprint: "abc",
    });
    const quote = failedQuote("fixture", 1_000, "seed");
    quote.fair = 4;
    quote.confidence = "medium";
    cache.set(key, quote, 1_000, 10_000);
    cache.insertValuation("v1", "abc", quote, 1_000);

    expect(cache.get(key, 2_000, 3_600_000)?.fair).toBe(4);
    expect(cache.get(key, 20_000, 3_600_000)).toBeUndefined();
  });
});
