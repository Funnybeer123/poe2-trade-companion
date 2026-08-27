import type { MarketQuote } from "../items/types.js";

export interface MarketCacheEntry {
  quote: MarketQuote;
  fetchedAtMs: number;
  expiresAtMs: number;
}

export interface MarketCachePort {
  get(cacheKey: string, nowMs: number, maxAgeMs: number): MarketQuote | undefined;
  set(cacheKey: string, quote: MarketQuote, fetchedAtMs: number, expiresAtMs: number): void;
}

export function marketCacheKey(parts: {
  providerId: string;
  league: string;
  realm: string;
  fingerprint: string;
}): string {
  return [parts.providerId, parts.realm, parts.league, parts.fingerprint].join("|");
}

export class MemoryMarketCache implements MarketCachePort {
  readonly #entries = new Map<string, MarketCacheEntry>();

  get(cacheKey: string, nowMs: number, maxAgeMs: number): MarketQuote | undefined {
    const entry = this.#entries.get(cacheKey);
    if (entry === undefined) {
      return undefined;
    }
    if (nowMs > entry.expiresAtMs) {
      return undefined;
    }
    if (nowMs - entry.fetchedAtMs > maxAgeMs) {
      return undefined;
    }
    return entry.quote;
  }

  set(cacheKey: string, quote: MarketQuote, fetchedAtMs: number, expiresAtMs: number): void {
    this.#entries.set(cacheKey, { quote, fetchedAtMs, expiresAtMs });
  }
}

export function createMemoryMarketCache(): MemoryMarketCache {
  return new MemoryMarketCache();
}
