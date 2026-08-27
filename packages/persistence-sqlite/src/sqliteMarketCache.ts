import type { MarketCachePort, MarketQuote } from "@poe2tc/core";
import type { Database } from "better-sqlite3";

interface CacheRow {
  payload_json: string;
  fetched_at_ms: number;
  expires_at_ms: number;
}

export class SqliteMarketCache implements MarketCachePort {
  constructor(private readonly db: Database) {}

  get(cacheKey: string, nowMs: number, maxAgeMs: number): MarketQuote | undefined {
    const row = this.db
      .prepare(
        `SELECT payload_json, fetched_at_ms, expires_at_ms
         FROM market_comparables_cache
         WHERE cache_key = ?`,
      )
      .get(cacheKey) as CacheRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    if (nowMs > row.expires_at_ms || nowMs - row.fetched_at_ms > maxAgeMs) {
      return undefined;
    }
    return JSON.parse(row.payload_json) as MarketQuote;
  }

  set(cacheKey: string, quote: MarketQuote, fetchedAtMs: number, expiresAtMs: number): void {
    this.db
      .prepare(
        `INSERT INTO market_comparables_cache (cache_key, payload_json, fetched_at_ms, expires_at_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           payload_json = excluded.payload_json,
           fetched_at_ms = excluded.fetched_at_ms,
           expires_at_ms = excluded.expires_at_ms`,
      )
      .run(cacheKey, JSON.stringify(quote), fetchedAtMs, expiresAtMs);
  }

  insertValuation(id: string, fingerprint: string, quote: MarketQuote, createdAtMs: number): void {
    this.db
      .prepare(
        `INSERT INTO valuations (id, fingerprint, quote_json, created_at_ms)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, fingerprint, JSON.stringify(quote), createdAtMs);
  }
}
