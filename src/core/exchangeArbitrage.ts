/**
 * Currency Exchange arbitrage maths (pure, no game input).
 *
 * The in-game exchange (Ange → Currency Exchange) quotes a ratio per
 * have/want pair, a stock figure and a gold fee per trade. Two things are
 * worth knowing from a set of quotes:
 *
 *   1. Direct edges — a pair whose exchange ratio beats the ratio the market
 *      prices imply (price table, exalted per unit). Buying there and
 *      selling on the market pockets the difference.
 *   2. Cycles — chains of 2–3 trades that come back to the start currency
 *      with more of it than you began with. Found by enumerating simple
 *      cycles on the quote graph with log-summed ratios (products of many
 *      small ratios underflow; sums of logs do not).
 *
 * Gold fees are flat per trade, so whether a cycle survives them depends on
 * how much is traded: `startAmount` sizes the trade and `goldPerExalted`
 * converts the fee. Without both, fees are reported but not netted.
 *
 * No panel recording exists yet, so quotes come from a hand-captured JSON
 * file (docs/EXCHANGE_ARBITRAGE.md). The reader that will OCR the panel
 * only has to produce ExchangeQuote[].
 */

import { ORB_NAMES, orbCosts, type OrbId } from "./crafting.js";
import { lookupPrice, type PriceTable } from "./priceTable.js";

export interface ExchangeQuote {
  have: string;
  want: string;
  /** Units of `want` received per 1 `have`, exactly as the panel shows it. */
  ratio: number;
  /** Units of `want` in stock at this ratio, when captured. */
  quantity?: number;
  /** Gold charged for one trade on this pair, when captured. */
  feeGoldPerTrade?: number;
}

/** Exalted orbs per unit of a currency, or undefined when unknown. */
export type PriceLookup = (name: string) => number | undefined;

function findCaseInsensitive(record: Record<string, number>, name: string): number | undefined {
  const wanted = name.trim().toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.trim().toLowerCase() === wanted) return value;
  }
  return undefined;
}

/**
 * Market prices from the price table (currency rows by exact name), with
 * the crafting economy's orb defaults filling gaps so "Exalted Orb" always
 * resolves to 1. `overrides` (a quotes file's `prices`) win over both.
 */
export function priceLookupFromTable(
  table?: PriceTable,
  overrides: Record<string, number> = {},
): PriceLookup {
  const costs = orbCosts(table);
  const orbByName = new Map<string, number>();
  for (const [id, name] of Object.entries(ORB_NAMES) as Array<[OrbId, string]>) {
    orbByName.set(name.toLowerCase(), costs[id]);
  }
  return (name) => {
    const override = findCaseInsensitive(overrides, name);
    if (override !== undefined && Number.isFinite(override) && override > 0) return override;
    if (table) {
      const hit = lookupPrice(table, {
        name,
        baseType: name,
        itemClass: "Stackable Currency",
        rarity: "Currency",
      });
      if (hit && hit.entry.match.name !== undefined && hit.value > 0) return hit.value;
    }
    return orbByName.get(name.trim().toLowerCase());
  };
}

function validQuote(quote: ExchangeQuote): boolean {
  return (
    typeof quote.have === "string" &&
    typeof quote.want === "string" &&
    quote.have.trim() !== "" &&
    quote.want.trim() !== "" &&
    quote.have.trim().toLowerCase() !== quote.want.trim().toLowerCase() &&
    typeof quote.ratio === "number" &&
    Number.isFinite(quote.ratio) &&
    quote.ratio > 0
  );
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Ratios can be tiny (exalted → divine ≈ 0.0015): keep four decimals. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
// Direct edges
// ---------------------------------------------------------------------------

export interface DirectEdge {
  have: string;
  want: string;
  ratio: number;
  /** want per 1 have implied by market prices. */
  marketRatio: number;
  gainPercent: number;
  /** Exalted gained per 1 `have` traded, before gold fees. */
  gainExPerHave: number;
  quantity?: number;
  feeGoldPerTrade?: number;
}

/** Quotes whose ratio beats the market-implied ratio by more than the threshold. */
export function findDirectEdges(
  quotes: ExchangeQuote[],
  prices: PriceLookup,
  minGainPercent = 2,
): DirectEdge[] {
  const edges: DirectEdge[] = [];
  for (const quote of quotes) {
    if (!validQuote(quote)) continue;
    const havePrice = prices(quote.have);
    const wantPrice = prices(quote.want);
    if (!havePrice || !wantPrice || havePrice <= 0 || wantPrice <= 0) continue;
    const marketRatio = havePrice / wantPrice;
    const gainPercent = (quote.ratio / marketRatio - 1) * 100;
    if (gainPercent <= minGainPercent) continue;
    edges.push({
      have: quote.have,
      want: quote.want,
      ratio: quote.ratio,
      marketRatio: round4(marketRatio) || marketRatio,
      gainPercent: round2(gainPercent),
      gainExPerHave: round2(quote.ratio * wantPrice - havePrice),
      ...(quote.quantity !== undefined ? { quantity: quote.quantity } : {}),
      ...(quote.feeGoldPerTrade !== undefined ? { feeGoldPerTrade: quote.feeGoldPerTrade } : {}),
    });
  }
  return edges.sort((a, b) => b.gainPercent - a.gainPercent);
}

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

export interface CycleHop {
  have: string;
  want: string;
  ratio: number;
  quantity?: number;
  feeGoldPerTrade?: number;
}

export interface CycleLimit {
  /** Most of the start currency the stock along the cycle can absorb. */
  maxStartAmount: number;
  limitedBy: { have: string; want: string };
}

export interface ExchangeCycle {
  /** Currency names in trade order, the start repeated at the end. */
  sequence: string[];
  hops: CycleHop[];
  /** Units of the start currency per 1 unit put in. */
  multiplier: number;
  grossGainPercent: number;
  /** Sum of the known per-trade gold fees along the cycle. */
  feeGold: number;
  /** Whether feeGold was converted to exalted and netted. */
  feeApplied: boolean;
  netGainPercent: number;
  startAmount: number;
  /** Exalted value of startAmount, when the start currency is priced. */
  startValueEx?: number;
  netGainEx?: number;
  limit?: CycleLimit;
}

export interface CycleOptions {
  /** Longest cycle to consider (2 or 3). */
  maxLength?: number;
  minGainPercent?: number;
  /** Units of the start currency traded; sizes the flat gold fee. */
  startAmount?: number;
  /** Market prices, needed to net gold fees and value the gain. */
  prices?: PriceLookup;
  /** Gold per exalted, to convert fees. */
  goldPerExalted?: number;
}

interface Edge {
  to: number;
  quote: ExchangeQuote;
}

function bestQuotesPerPair(quotes: ExchangeQuote[]): ExchangeQuote[] {
  const best = new Map<string, ExchangeQuote>();
  for (const quote of quotes) {
    if (!validQuote(quote)) continue;
    const key = `${quote.have.trim().toLowerCase()}→${quote.want.trim().toLowerCase()}`;
    const existing = best.get(key);
    if (!existing || quote.ratio > existing.ratio) best.set(key, quote);
  }
  return [...best.values()];
}

function buildCycle(path: ExchangeQuote[], options: Required<Pick<CycleOptions, "startAmount">> & CycleOptions): ExchangeCycle {
  const logSum = path.reduce((sum, quote) => sum + Math.log(quote.ratio), 0);
  const multiplier = Math.exp(logSum);
  const grossGainPercent = (multiplier - 1) * 100;
  const feeGold = path.reduce((sum, quote) => sum + (quote.feeGoldPerTrade ?? 0), 0);
  const start = path[0]!.have;
  const startPrice = options.prices?.(start);
  const startAmount = options.startAmount;
  const canNet =
    startPrice !== undefined &&
    startPrice > 0 &&
    options.goldPerExalted !== undefined &&
    options.goldPerExalted > 0;
  const startValueEx = startPrice !== undefined && startPrice > 0 ? startAmount * startPrice : undefined;
  const feeEx = canNet ? feeGold / options.goldPerExalted! : 0;
  const netGainEx = startValueEx !== undefined ? (multiplier - 1) * startValueEx - feeEx : undefined;
  const netGainPercent =
    canNet && startValueEx !== undefined && startValueEx > 0
      ? (netGainEx! / startValueEx) * 100
      : grossGainPercent;

  let limit: CycleLimit | undefined;
  let running = 1;
  for (const quote of path) {
    running *= quote.ratio;
    if (quote.quantity === undefined || !Number.isFinite(quote.quantity)) continue;
    const maxStart = quote.quantity / running;
    if (!limit || maxStart < limit.maxStartAmount) {
      limit = { maxStartAmount: maxStart, limitedBy: { have: quote.have, want: quote.want } };
    }
  }
  if (limit) limit.maxStartAmount = Math.floor(limit.maxStartAmount * 1000) / 1000;

  return {
    sequence: [...path.map((quote) => quote.have), start],
    hops: path.map((quote) => ({
      have: quote.have,
      want: quote.want,
      ratio: quote.ratio,
      ...(quote.quantity !== undefined ? { quantity: quote.quantity } : {}),
      ...(quote.feeGoldPerTrade !== undefined ? { feeGoldPerTrade: quote.feeGoldPerTrade } : {}),
    })),
    multiplier: Math.round(multiplier * 1_000_000) / 1_000_000,
    grossGainPercent: round2(grossGainPercent),
    feeGold,
    feeApplied: canNet,
    netGainPercent: round2(netGainPercent),
    startAmount,
    ...(startValueEx !== undefined ? { startValueEx: round2(startValueEx) } : {}),
    ...(netGainEx !== undefined ? { netGainEx: round2(netGainEx) } : {}),
    ...(limit ? { limit } : {}),
  };
}

/**
 * Best 2- and 3-cycles by net gain. Each simple cycle is enumerated once
 * per direction: the walk starts at the cycle's lowest-indexed currency and
 * only visits higher-indexed ones, so rotations never repeat.
 */
export function findCycles(quotes: ExchangeQuote[], options: CycleOptions = {}): ExchangeCycle[] {
  const maxLength = Math.max(2, Math.min(3, Math.floor(options.maxLength ?? 3)));
  const minGainPercent = options.minGainPercent ?? 2;
  const startAmount = options.startAmount !== undefined && options.startAmount > 0 ? options.startAmount : 1;
  const usable = bestQuotesPerPair(quotes);
  const names = [...new Set(usable.flatMap((quote) => [quote.have, quote.want]))].sort((a, b) =>
    a.localeCompare(b),
  );
  const index = new Map(names.map((name, i) => [name, i] as const));
  const adjacency: Edge[][] = names.map(() => []);
  for (const quote of usable) {
    adjacency[index.get(quote.have)!]!.push({ to: index.get(quote.want)!, quote });
  }

  const cycles: ExchangeCycle[] = [];
  const walk = (start: number, node: number, path: ExchangeQuote[]): void => {
    for (const edge of adjacency[node]!) {
      if (edge.to === start) {
        if (path.length + 1 >= 2) {
          const cycle = buildCycle([...path, edge.quote], { ...options, startAmount });
          if (cycle.multiplier > 1 + 1e-9 && cycle.netGainPercent > minGainPercent) cycles.push(cycle);
        }
        continue;
      }
      if (edge.to <= start || path.length + 1 >= maxLength) continue;
      if (path.some((quote) => index.get(quote.have) === edge.to)) continue;
      walk(start, edge.to, [...path, edge.quote]);
    }
  };
  for (let start = 0; start < names.length; start += 1) walk(start, start, []);

  return cycles.sort(
    (a, b) => b.netGainPercent - a.netGainPercent || a.hops.length - b.hops.length,
  );
}

// ---------------------------------------------------------------------------
// Quotes file
// ---------------------------------------------------------------------------

export interface ExchangeQuotesFile {
  league?: string;
  capturedAt?: string;
  note?: string;
  goldPerExalted?: number;
  /** Exalted per unit, overriding the price table for these names. */
  prices?: Record<string, number>;
  quotes: ExchangeQuote[];
}

/** Accept a bare quote array or the documented { quotes, prices, … } object. */
export function parseExchangeQuotesFile(input: unknown): ExchangeQuotesFile {
  if (Array.isArray(input)) return { quotes: input.filter(isQuoteLike) };
  if (typeof input !== "object" || input === null) return { quotes: [] };
  const record = input as Record<string, unknown>;
  const quotes = Array.isArray(record.quotes) ? record.quotes.filter(isQuoteLike) : [];
  const prices: Record<string, number> = {};
  if (typeof record.prices === "object" && record.prices !== null) {
    for (const [name, value] of Object.entries(record.prices as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) prices[name] = value;
    }
  }
  return {
    ...(typeof record.league === "string" ? { league: record.league } : {}),
    ...(typeof record.capturedAt === "string" ? { capturedAt: record.capturedAt } : {}),
    ...(typeof record.note === "string" ? { note: record.note } : {}),
    ...(typeof record.goldPerExalted === "number" && record.goldPerExalted > 0
      ? { goldPerExalted: record.goldPerExalted }
      : {}),
    ...(Object.keys(prices).length ? { prices } : {}),
    quotes,
  };
}

function isQuoteLike(value: unknown): value is ExchangeQuote {
  if (typeof value !== "object" || value === null) return false;
  const quote = value as Partial<ExchangeQuote>;
  return (
    typeof quote.have === "string" &&
    typeof quote.want === "string" &&
    typeof quote.ratio === "number" &&
    Number.isFinite(quote.ratio) &&
    quote.ratio > 0
  );
}
