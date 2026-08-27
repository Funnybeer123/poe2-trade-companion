import type { MarketProvider, MarketQuote, NormalizedItem, QuoteContext } from "../items/types.js";
import type { MarketCachePort } from "./marketCache.js";
import { createMemoryMarketCache, marketCacheKey } from "./marketCache.js";
import {
  DEFAULT_OFFICIAL_USER_AGENT,
  isThrottleStatus,
  isTransientStatus,
  rateLimitFetch,
  type RateLimitFetchOptions,
} from "./rateLimitFetch.js";
import { failedQuote, valueFromPrices } from "./valuation.js";

export const OFFICIAL_CURRENCY_EXCHANGE_ID = "official-currency-exchange";
export const CURRENCY_EXCHANGE_BASE_URL = "https://web.poecdn.com/api/currency-exchange";

export interface CurrencyExchangeMarket {
  league: string;
  market_id: string;
  market_pair: string[];
  volume_traded: Record<string, number>;
  lowest_stock?: Record<string, number>;
  highest_stock?: Record<string, number>;
  lowest_ratio: Record<string, number>;
  highest_ratio: Record<string, number>;
}

export interface CurrencyExchangeDigest {
  next_change_id: number;
  markets: CurrencyExchangeMarket[];
}

export const CURRENCY_METADATA_IDS: Record<string, string> = {
  "divine orb": "Metadata/Items/Currency/CurrencyDivine",
  "exalted orb": "Metadata/Items/Currency/CurrencyAddModToRare",
  "chaos orb": "Metadata/Items/Currency/CurrencyRerollRare",
  "orb of alchemy": "Metadata/Items/Currency/CurrencyUpgradeToRare",
  "orb of transmutation": "Metadata/Items/Currency/CurrencyUpgradeToMagic",
  "orb of augmentation": "Metadata/Items/Currency/CurrencyAddModToMagic",
  "regal orb": "Metadata/Items/Currency/CurrencyUpgradeMagicToRare",
  "vaal orb": "Metadata/Items/Currency/CurrencyCorrupt",
};

export const QUOTE_CURRENCY_ID = CURRENCY_METADATA_IDS["exalted orb"];
export const QUOTE_CURRENCY_NAME = "exalted";

export function currencyMetadataId(item: NormalizedItem): string | undefined {
  const key = (item.name ?? item.base ?? "").toLowerCase();
  return CURRENCY_METADATA_IDS[key];
}

export function isCurrencyItem(item: NormalizedItem): boolean {
  const className = item.class?.toLowerCase() ?? "";
  const rarity = item.rarity?.toLowerCase() ?? "";
  return (
    rarity === "currency" ||
    className.includes("currency") ||
    currencyMetadataId(item) !== undefined
  );
}

export function parseCurrencyExchangeDigest(jsonText: string): CurrencyExchangeDigest {
  const parsed = JSON.parse(jsonText) as CurrencyExchangeDigest;
  if (typeof parsed.next_change_id !== "number" || !Array.isArray(parsed.markets)) {
    throw new Error("currency-exchange-malformed");
  }
  return parsed;
}

function ratioPrice(
  ratio: Record<string, number>,
  itemId: string,
  quoteId: string,
): number | undefined {
  const itemUnits = ratio[itemId];
  const quoteUnits = ratio[quoteId];
  if (itemUnits === undefined || quoteUnits === undefined || itemUnits === 0) {
    return undefined;
  }
  return quoteUnits / itemUnits;
}

export function quoteFromDigest(
  item: NormalizedItem,
  digest: CurrencyExchangeDigest,
  context: QuoteContext,
  quotedAtMs: number,
): MarketQuote {
  const itemId = currencyMetadataId(item);
  if (itemId === undefined) {
    return failedQuote(OFFICIAL_CURRENCY_EXCHANGE_ID, quotedAtMs, "unsupported-currency");
  }
  const markets = digest.markets.filter(
    (market) =>
      market.league === context.league &&
      market.market_pair.includes(itemId) &&
      market.market_pair.includes(QUOTE_CURRENCY_ID),
  );
  if (markets.length === 0) {
    return failedQuote(OFFICIAL_CURRENCY_EXCHANGE_ID, quotedAtMs, "no-market-pair");
  }

  const points = markets.flatMap((market, index) => {
    const low = ratioPrice(market.lowest_ratio, itemId, QUOTE_CURRENCY_ID);
    const high = ratioPrice(market.highest_ratio, itemId, QUOTE_CURRENCY_ID);
    const volume = ratioPrice(market.volume_traded, itemId, QUOTE_CURRENCY_ID);
    const rows: Array<{ id: string; price: number; currency: string }> = [];
    if (low !== undefined) {
      rows.push({ id: `${market.market_id}:low:${String(index)}`, price: low, currency: QUOTE_CURRENCY_NAME });
    }
    if (volume !== undefined) {
      rows.push({
        id: `${market.market_id}:volume:${String(index)}`,
        price: volume,
        currency: QUOTE_CURRENCY_NAME,
      });
    }
    if (high !== undefined) {
      rows.push({ id: `${market.market_id}:high:${String(index)}`, price: high, currency: QUOTE_CURRENCY_NAME });
    }
    return rows;
  });

  return valueFromPrices(item, {
    providerId: OFFICIAL_CURRENCY_EXCHANGE_ID,
    quotedAtMs,
    currency: QUOTE_CURRENCY_NAME,
    points,
  }).quote;
}

export interface OfficialCurrencyExchangeProviderOptions {
  fetchImpl?: RateLimitFetchOptions["fetchImpl"];
  cache?: MarketCachePort;
  nowMs?: () => number;
  changeId?: number;
  timeoutMs?: number;
}

export class OfficialCurrencyExchangeProvider implements MarketProvider {
  readonly id = OFFICIAL_CURRENCY_EXCHANGE_ID;
  readonly #fetchImpl?: RateLimitFetchOptions["fetchImpl"];
  readonly #cache: MarketCachePort;
  readonly #nowMs: () => number;
  readonly #changeId?: number;
  readonly #timeoutMs?: number;

  constructor(options: OfficialCurrencyExchangeProviderOptions = {}) {
    this.#fetchImpl = options.fetchImpl;
    this.#cache = options.cache ?? createMemoryMarketCache();
    this.#nowMs = options.nowMs ?? (() => Date.now());
    this.#changeId = options.changeId;
    this.#timeoutMs = options.timeoutMs;
  }

  supports(item: NormalizedItem): boolean {
    return isCurrencyItem(item);
  }

  url(): string {
    const base = `${CURRENCY_EXCHANGE_BASE_URL}/poe2`;
    return this.#changeId === undefined ? base : `${base}/${String(this.#changeId)}`;
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: "documented-hourly-digest; realm=poe2" };
  }

  async quote(item: NormalizedItem, context: QuoteContext): Promise<MarketQuote> {
    const nowMs = this.#nowMs();
    const cacheKey = marketCacheKey({
      providerId: this.id,
      league: context.league,
      realm: context.realm,
      fingerprint: item.fingerprint,
    });
    const cached = this.#cache.get(cacheKey, nowMs, context.maxAgeMs);

    if (!this.supports(item)) {
      return failedQuote(this.id, nowMs, "not-currency");
    }
    if (context.realm !== "poe2") {
      return failedQuote(this.id, nowMs, "realm-not-poe2");
    }

    try {
      const response = await rateLimitFetch(this.url(), {
        fetchImpl: this.#fetchImpl,
        timeoutMs: this.#timeoutMs,
        headers: { "user-agent": DEFAULT_OFFICIAL_USER_AGENT },
      });

      if (!response.ok) {
        const reason = isThrottleStatus(response.status)
          ? "http-429"
          : isTransientStatus(response.status)
            ? (response.error ?? `http-${String(response.status || "offline")}`)
            : `http-${String(response.status)}`;
        if (cached !== undefined) {
          return {
            ...cached,
            lowConfidenceReason: `${reason};using-cache`,
          };
        }
        return failedQuote(this.id, nowMs, reason);
      }

      if (response.body === undefined) {
        return cached ?? failedQuote(this.id, nowMs, "empty-body");
      }
      const digest = parseCurrencyExchangeDigest(response.body);
      const quote = quoteFromDigest(item, digest, context, nowMs);
      this.#cache.set(cacheKey, quote, nowMs, nowMs + context.maxAgeMs);
      return quote;
    } catch {
      return cached ?? failedQuote(this.id, nowMs, "offline");
    }
  }
}

export function createOfficialCurrencyExchangeProvider(
  options: OfficialCurrencyExchangeProviderOptions = {},
): OfficialCurrencyExchangeProvider {
  return new OfficialCurrencyExchangeProvider(options);
}
