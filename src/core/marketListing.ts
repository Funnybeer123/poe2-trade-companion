/**
 * Result-row helpers Market owns: the actions a row offers (whisper text,
 * /hideout), "use this listing's mods as filters", local column sorting of
 * the rows already fetched, and the collapse-by-seller fold.
 *
 * The row *description* (price text, age band, online state, Q20 defences,
 * DPS, flags) is F4's `describeListing` in `src/core/tradeListings.ts` and
 * is re-exported here so a Market file has one import.
 *
 * Pure: no Electron, no DOM, no network. Nothing here sends anything — a
 * whisper is only ever typed by `ChatCommandService`, one line per click.
 */
import type { StatCatalogue } from "./statIds.js";
import { statIdsForModText } from "./statIds.js";
import type { TradeStatFilter, TradeStatGroup } from "./tradeQuery.js";
import {
  describeListing,
  listingToNormalizedItem,
  priceInExalted,
  priceNote,
  splitFractionalPrice,
  type ExchangeOffer,
  type ListingDisplay,
  type TradeListing,
} from "./tradeListings.js";

export {
  describeListing,
  listingToNormalizedItem,
  priceInExalted,
  priceNote,
  splitFractionalPrice,
  type ListingDisplay,
};

/**
 * The whisper the site handed us. Secure ("Secure Item") listings are never
 * whispered or bought by the app — they open on the trade site instead — so
 * this refuses them even when the payload carries a template.
 */
export function whisperText(listing: Pick<TradeListing, "whisper" | "listingType">): string | undefined {
  if (listing.listingType === "secure") return undefined;
  const text = listing.whisper?.trim();
  return text ? text : undefined;
}

/** "/hideout SellerChar" — undefined when the row names no character. */
export function hideoutCommand(listing: { seller: { character?: string } }): string | undefined {
  const character = listing.seller.character?.trim();
  if (!character) return undefined;
  return `/hideout ${character}`;
}

/** The whisper for one bulk-exchange offer (same secure rule does not apply). */
export function offerWhisperText(offer: Pick<ExchangeOffer, "whisper">): string | undefined {
  const text = offer.whisper?.trim();
  return text ? text : undefined;
}

// ---------------------------------------------------------------------------
// "Use as filters"
// ---------------------------------------------------------------------------

export interface StatFiltersFromListingOptions {
  includeImplicit?: boolean;
  /** Fraction of the listed roll used as the minimum (default 0.9). */
  slack?: number;
}

const NUMBER_IN_TEXT = /-?\d+(?:\.\d+)?/g;

/** The roll a mod line shows: one number, or the average of a "12 to 24" pair. */
function rollOf(text: string): number | undefined {
  const numbers = text.match(NUMBER_IN_TEXT);
  if (!numbers || numbers.length === 0) return undefined;
  const values = numbers.map(Number).filter((value) => Number.isFinite(value));
  if (values.length === 0) return undefined;
  if (values.length === 1) return values[0]!;
  return (values[0]! + values[1]!) / 2;
}

/**
 * Turn a listing's mods into stat filters — the "copy item stats as
 * filters" gesture. Each line becomes an `and` filter at `slack ×` its
 * roll; a line the catalogue maps to several ids becomes its own `count`
 * group asking for at least one of them (the site does the same when a mod
 * exists in local and global forms).
 *
 * Rune mods are skipped: they are the buyer's sockets, not the item.
 */
export function statFiltersFromListing(
  listing: TradeListing,
  catalogue: StatCatalogue,
  opts: StatFiltersFromListingOptions = {},
): TradeStatGroup[] {
  const slack = Number.isFinite(opts.slack) ? Math.min(1, Math.max(0, opts.slack as number)) : 0.9;
  const lines: string[] = [
    ...listing.item.explicitMods,
    ...(opts.includeImplicit ? listing.item.implicitMods : []),
    ...listing.item.fracturedMods,
    ...listing.item.desecratedMods,
  ];

  const single: TradeStatFilter[] = [];
  const groups: TradeStatGroup[] = [];
  const used = new Set<string>();
  for (const line of lines) {
    const ids = statIdsForModText(catalogue, line);
    if (ids.length === 0) continue;
    const roll = rollOf(line);
    const min = roll === undefined ? undefined : Math.floor(roll * slack);
    const value = min === undefined ? undefined : { min };
    if (ids.length === 1) {
      const id = ids[0]!;
      if (used.has(id)) continue;
      used.add(id);
      single.push({ id, ...(value ? { value } : {}) });
      continue;
    }
    groups.push({
      type: "count",
      value: { min: 1 },
      filters: ids.map((id) => ({ id, ...(value ? { value } : {}) })),
    });
  }

  return [...(single.length > 0 ? [{ type: "and" as const, filters: single }] : []), ...groups];
}

// ---------------------------------------------------------------------------
// Local sorting and the seller fold
// ---------------------------------------------------------------------------

export type LocalSortKey = "price" | "age" | "seller" | "dps" | "ilvl" | "quality" | "sockets";

/** Sort keys that can be applied to rows already in hand (no new search). */
export const LOCAL_SORT_KEYS: readonly LocalSortKey[] = [
  "price",
  "age",
  "seller",
  "dps",
  "ilvl",
  "quality",
  "sockets",
];

function sortValue(listing: TradeListing, key: LocalSortKey): number | string | undefined {
  switch (key) {
    case "price":
      return listing.priceExalted ?? listing.price?.amount;
    case "age":
      return listing.indexedAt ? Date.parse(listing.indexedAt) : undefined;
    case "seller":
      return listing.seller.account.toLowerCase();
    case "dps":
      return listing.item.extended?.dps;
    case "ilvl":
      return listing.item.itemLevel;
    case "quality":
      return listing.item.quality;
    case "sockets":
      return listing.item.runeSockets ?? listing.item.sockets;
    default:
      return undefined;
  }
}

/**
 * Sort the loaded rows locally. Rows with no value for the key sink to the
 * bottom in both directions — an unpriced listing is not "cheapest".
 */
export function sortListings(
  listings: readonly TradeListing[],
  key: LocalSortKey,
  direction: "asc" | "desc",
): TradeListing[] {
  const factor = direction === "desc" ? -1 : 1;
  return [...listings].sort((left, right) => {
    const a = sortValue(left, key);
    const b = sortValue(right, key);
    if (a === undefined && b === undefined) return 0;
    if (a === undefined) return 1;
    if (b === undefined) return -1;
    if (typeof a === "string" || typeof b === "string") {
      return String(a).localeCompare(String(b)) * factor;
    }
    return (a - b) * factor;
  });
}

export interface CollapsedRow {
  listing: TradeListing;
  /** How many further rows from this seller are folded behind this one. */
  hiddenSiblings: number;
}

/**
 * Fold the rows of every collapsed account into their first row. Used by
 * "collapse after offer" (once you whispered a seller, their other rows are
 * noise) and by the trade filter "collapse listings by account".
 */
export function collapseBySeller(
  listings: readonly TradeListing[],
  collapsed: readonly string[],
): CollapsedRow[] {
  const folded = new Set(collapsed.map((account) => account.toLowerCase()));
  const shown = new Map<string, number>();
  const rows: CollapsedRow[] = [];
  for (const listing of listings) {
    const account = listing.seller.account.toLowerCase();
    if (!folded.has(account)) {
      rows.push({ listing, hiddenSiblings: 0 });
      continue;
    }
    const at = shown.get(account);
    if (at === undefined) {
      shown.set(account, rows.length);
      rows.push({ listing, hiddenSiblings: 0 });
      continue;
    }
    rows[at]!.hiddenSiblings += 1;
  }
  return rows;
}
