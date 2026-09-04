/**
 * Market comps for one specific item via the official trade2 API.
 *
 * The aggregator feed (priceFeed.ts) prices currency and uniques, but only
 * real listings can price a RARE — so this module builds a polite trade2
 * search from the parsed item, and turns the returned listings into an
 * exalted price band by comparing mod families locally.
 *
 * Everything here is pure: query building, listing parsing, similarity, and
 * summary math. The main-process service owns HTTP, rate limits, and cache.
 *
 * Endpoints (verified in use by open-source PoE2 tools, 2026-08-30):
 *   POST https://www.pathofexile.com/api/trade2/search/poe2/{league}
 *   GET  https://www.pathofexile.com/api/trade2/fetch/{ids}?query={searchId}
 * Etiquette: ~1 request per 1.5-2s, parse rate-limit headers, POESESSID
 * optional. On-demand single-item lookups only — never bulk scans.
 */

import { matchModFamily } from "./modKnowledge.js";
import { orbCosts, type OrbId } from "./crafting.js";
import type { PriceTable } from "./priceTable.js";
import type { ParsedItem } from "./types.js";

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

export interface CompsQuery {
  /** POST body for /api/trade2/search/poe2/{league}. */
  body: Record<string, unknown>;
  /** What the query keyed on, for the UI/logs. */
  basis: "unique-name" | "base-type";
}

/**
 * Build the search body. Uniques search by name+type (tight); rares search
 * by base type + rarity + item-level floor (broad on purpose — the local
 * mod-similarity pass does the narrowing the stat-id filter system would
 * otherwise need).
 */
/**
 * A MAGIC item's copy text has no base-type line — the single header line is
 * "[Prefix] Base [of Suffix]" — so the base is derived: the words before
 * " of " (or all of them), minus a leading prefix word when three or more
 * remain. "Entombing Bandit Mace of the Champion" → "Bandit Mace";
 * "Bandit Mace of the Champion" → "Bandit Mace"; "Flaming Adherent Bow of
 * the Parched" → "Adherent Bow". trade2 rejects the full name (HTTP 400).
 */
export function magicBaseType(name: string): string {
  const beforeOf = name.split(/\s+of\s+/i)[0]!.trim();
  const words = beforeOf.split(/\s+/).filter(Boolean);
  return (words.length >= 3 ? words.slice(1) : words).join(" ");
}

export function buildCompsQuery(parsed: ParsedItem): CompsQuery | undefined {
  const status = { option: "online" };
  const sort = { price: "asc" };
  if (/^unique$/i.test(parsed.rarity) && parsed.name && parsed.baseType) {
    return {
      basis: "unique-name",
      body: {
        query: { status, name: parsed.name, type: parsed.baseType },
        sort,
      },
    };
  }
  const baseType =
    /^magic$/i.test(parsed.rarity) && parsed.baseType === parsed.name
      ? magicBaseType(parsed.name)
      : parsed.baseType;
  if (!baseType) return undefined;
  const itemLevel = parsed.itemLevel ?? 0;
  const filters: Record<string, unknown> = {
    type_filters: {
      filters: { rarity: { option: "nonunique" } },
    },
  };
  if (itemLevel >= 78) {
    filters.misc_filters = { filters: { ilvl: { min: 78 } } };
  }
  return {
    basis: "base-type",
    body: {
      query: { status, type: baseType, filters },
      sort,
    },
  };
}

// ---------------------------------------------------------------------------
// Listing parsing
// ---------------------------------------------------------------------------

export interface CompListing {
  id: string;
  name: string;
  baseType: string;
  mods: string[];
  priceAmount: number;
  priceCurrency: string;
  accountName?: string;
  indexed?: string;
}

/** trade currency ids (and note-currency words) → the crafting economy's orb ids. */
const TRADE_CURRENCY_TO_ORB: Record<string, OrbId> = {
  exalted: "exalted",
  exalt: "exalted",
  ex: "exalted",
  divine: "divine",
  div: "divine",
  chaos: "chaos",
  regal: "regal",
  annul: "annulment",
  annulment: "annulment",
  vaal: "vaal",
  alch: "alchemy",
  alchemy: "alchemy",
  transmute: "transmutation",
  transmutation: "transmutation",
  aug: "augmentation",
  augmentation: "augmentation",
  "fracturing-orb": "fracturing",
  fracturing: "fracturing",
};

/** Fold a trade/note currency token to its orb id, when it is one. */
export function tradeCurrencyToOrb(token: string): OrbId | undefined {
  return TRADE_CURRENCY_TO_ORB[token.trim().toLowerCase()];
}

/**
 * PoE2 fetch payloads annotate game terms as `[Token]` or `[Token|Display]`
 * inside mod descriptions ("+23% to [Resistances|Fire Resistance]"). Strip
 * the markup down to the display text so mod-family matching sees the same
 * line a Ctrl+C copy produces.
 */
export function normalizeTradeModText(description: string): string {
  return description
    .replace(/\[([^\]|]*)\|([^\]]*)\]/g, "$2")
    .replace(/\[([^\]]*)\]/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * trade2 explicitMods entries are objects with a `description` (and real
 * tier data like "P3"/"S0" — future similarity fuel); older shapes were
 * plain strings. Accept both.
 */
function modTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const texts: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      texts.push(normalizeTradeModText(entry));
      continue;
    }
    if (typeof entry === "object" && entry !== null) {
      const description = (entry as { description?: unknown }).description;
      if (typeof description === "string") texts.push(normalizeTradeModText(description));
    }
  }
  return texts;
}

/** Parse /api/trade2/fetch results into flat listings. Unknown shapes skip. */
export function parseCompListings(payload: unknown): CompListing[] {
  if (typeof payload !== "object" || payload === null) return [];
  const results = (payload as { result?: unknown }).result;
  if (!Array.isArray(results)) return [];
  const listings: CompListing[] = [];
  for (const raw of results) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as {
      id?: unknown;
      item?: {
        name?: unknown;
        typeLine?: unknown;
        baseType?: unknown;
        explicitMods?: unknown;
        implicitMods?: unknown;
      };
      listing?: {
        indexed?: unknown;
        account?: { name?: unknown };
        price?: { amount?: unknown; currency?: unknown };
      };
    };
    const amount = row.listing?.price?.amount;
    const currency = row.listing?.price?.currency;
    if (typeof amount !== "number" || amount <= 0 || typeof currency !== "string") continue;
    const explicit = modTexts(row.item?.explicitMods);
    listings.push({
      id: typeof row.id === "string" ? row.id : `listing-${listings.length}`,
      name: typeof row.item?.name === "string" ? row.item.name : "",
      baseType:
        typeof row.item?.baseType === "string"
          ? row.item.baseType
          : typeof row.item?.typeLine === "string"
            ? row.item.typeLine
            : "",
      mods: explicit,
      priceAmount: amount,
      priceCurrency: currency,
      ...(typeof row.listing?.account?.name === "string"
        ? { accountName: row.listing.account.name }
        : {}),
      ...(typeof row.listing?.indexed === "string" ? { indexed: row.listing.indexed } : {}),
    });
  }
  return listings;
}

/** Listing price → exalted, via the same economy the crafting engine uses. */
export function listingPriceInExalted(
  listing: CompListing,
  priceTable?: PriceTable,
): number | undefined {
  const orb = TRADE_CURRENCY_TO_ORB[listing.priceCurrency.toLowerCase()];
  if (!orb) return undefined;
  const rate = orbCosts(priceTable)[orb];
  if (!Number.isFinite(rate) || rate <= 0) return undefined;
  return Math.round(listing.priceAmount * rate * 100) / 100;
}

// ---------------------------------------------------------------------------
// Similarity + summary
// ---------------------------------------------------------------------------

function familiesOf(mods: readonly string[], itemClass?: string): Set<string> {
  const families = new Set<string>();
  for (const mod of mods) {
    const match = matchModFamily(mod, { itemClass });
    if (match && match.tier !== 0) families.add(match.family.id);
  }
  return families;
}

/**
 * 0-1: how much of OUR item's notable substance the listing shares. An item
 * with no notable families compares on base type alone (similarity 1) so
 * plain bases still get a floor price.
 */
export function listingSimilarity(
  ourMods: readonly string[],
  listing: CompListing,
  itemClass?: string,
): number {
  // Comps share our item's class (the query is by base type), so both sides
  // are judged with that class's families.
  const ours = familiesOf(ourMods, itemClass);
  if (ours.size === 0) return 1;
  const theirs = familiesOf(listing.mods, itemClass);
  let shared = 0;
  for (const family of ours) if (theirs.has(family)) shared += 1;
  return shared / ours.size;
}

export interface CompsSummary {
  /** Listings that passed the similarity bar and priced in exalted. */
  sampleSize: number;
  /** Total listings returned before filtering. */
  candidateCount: number;
  lowest?: number;
  median?: number;
  currency: "exalted";
  basis: CompsQuery["basis"];
  /** The comps used, cheapest first, for display. */
  comps: Array<{ price: number; similarity: number; name: string; baseType: string }>;
  /**
   * Set when the floor and median diverge hard — live testing showed unique
   * floors sitting 40x under the median (bait or terrible rolls). The median
   * is the trustworthy number then.
   */
  caution?: string;
}

export function summarizeComps(
  ourMods: readonly string[],
  listings: readonly CompListing[],
  basis: CompsQuery["basis"],
  options: { priceTable?: PriceTable; minSimilarity?: number; itemClass?: string } = {},
): CompsSummary {
  const minSimilarity = options.minSimilarity ?? 0.5;
  const priced = listings
    .map((listing) => ({
      listing,
      price: listingPriceInExalted(listing, options.priceTable),
      similarity: listingSimilarity(ourMods, listing, options.itemClass),
    }))
    .filter(
      (entry): entry is { listing: CompListing; price: number; similarity: number } =>
        entry.price !== undefined && entry.similarity >= minSimilarity,
    )
    .sort((a, b) => a.price - b.price);
  const prices = priced.map((entry) => entry.price);
  const median =
    prices.length === 0
      ? undefined
      : prices.length % 2 === 1
        ? prices[(prices.length - 1) / 2]
        : Math.round(((prices[prices.length / 2 - 1]! + prices[prices.length / 2]!) / 2) * 100) /
          100;
  const lowest = prices[0];
  const caution =
    lowest !== undefined && median !== undefined && lowest > 0 && median / lowest > 3
      ? `Floor (${lowest} ex) sits far under the median (${median} ex) — the cheapest listings are likely bait or badly rolled. Trust the median.`
      : undefined;
  return {
    sampleSize: priced.length,
    candidateCount: listings.length,
    ...(lowest !== undefined ? { lowest } : {}),
    ...(median !== undefined ? { median } : {}),
    currency: "exalted",
    basis,
    comps: priced.slice(0, 8).map((entry) => ({
      price: entry.price,
      similarity: Math.round(entry.similarity * 100) / 100,
      name: entry.listing.name,
      baseType: entry.listing.baseType,
    })),
    ...(caution ? { caution } : {}),
  };
}
