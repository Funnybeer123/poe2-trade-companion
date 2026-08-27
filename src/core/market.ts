import type { MarketComparable, MarketProvider, MarketQuote, NormalizedItem, ProviderHealth, QuoteContext } from "./types.js";

export class FixtureMarketProvider implements MarketProvider {
  readonly id = "fixture";

  constructor(private readonly quotes: Record<string, MarketComparable[]>) {}

  supports(): boolean {
    return true;
  }

  async quote(item: NormalizedItem, _context: QuoteContext): Promise<MarketQuote> {
    const comparables = this.quotes[item.fingerprint] ?? this.quotes[item.baseType] ?? [];
    return {
      providerId: this.id,
      fetchedAt: "1970-01-01T00:00:00.000Z",
      comparables,
    };
  }

  async health(): Promise<ProviderHealth> {
    return { id: this.id, ok: true };
  }
}

export class CachedMarketProvider implements MarketProvider {
  private readonly cache = new Map<string, { quote: MarketQuote; storedAt: number }>();
  private consecutiveFailures = 0;

  constructor(
    readonly inner: MarketProvider,
    private readonly ttlMs: number,
    private readonly minIntervalMs: number,
    private lastCallAt = 0,
  ) {}

  get id(): string {
    return this.inner.id;
  }

  supports(item: NormalizedItem): boolean {
    return this.inner.supports(item);
  }

  async quote(item: NormalizedItem, context: QuoteContext): Promise<MarketQuote> {
    const key = `${item.fingerprint}:${context.league}:${context.currency}`;
    const cached = this.cache.get(key);
    const now = Date.now();
    if (cached && now - cached.storedAt < this.ttlMs) {
      return cached.quote;
    }
    const wait = this.minIntervalMs * (this.consecutiveFailures + 1) - (now - this.lastCallAt);
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 5_000)));
    }
    this.lastCallAt = Date.now();
    try {
      const quote = await this.inner.quote(item, context);
      this.consecutiveFailures = 0;
      this.cache.set(key, { quote, storedAt: Date.now() });
      return quote;
    } catch (error) {
      this.consecutiveFailures += 1;
      if (cached) return cached.quote;
      throw error;
    }
  }

  async health(): Promise<ProviderHealth> {
    return this.inner.health();
  }
}

export class TradeApiMarketProvider implements MarketProvider {
  readonly id = "poe-trade2-disabled";

  /**
   * Retained as a compatibility shell. The Trade2 search/fetch flow used by
   * the source project is undocumented and search result IDs do not contain
   * prices, so this provider deliberately performs no network requests.
   */
  constructor(
    _fetchImpl?: typeof fetch,
    _searchUrl?: string,
  ) {}

  supports(_item: NormalizedItem): boolean {
    return false;
  }

  async quote(
    _item: NormalizedItem,
    _context: QuoteContext,
  ): Promise<MarketQuote> {
    throw new Error("trade-provider-disabled-undocumented-api");
  }

  async health(): Promise<ProviderHealth> {
    return {
      id: this.id,
      ok: false,
      detail:
        "Disabled: no documented authorized provider is configured; no market request was made.",
    };
  }
}
