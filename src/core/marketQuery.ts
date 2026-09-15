/**
 * The Market draft: what one browser tab is editing, plus the pure helpers
 * that turn it into a trade2 body, a stable fingerprint (dirty detection and
 * favourite equality), a tab label and a colour.
 *
 * The inverse of `toTradeSearchBody` lives in `src/core/tradeQuery.ts` (F4
 * owns it, P1 and P3 want it too); it is re-exported here so Market code has
 * one import for the whole draft surface.
 *
 * Pure: no Electron, no DOM, no I/O. `sanitizeDraft` never throws — a draft
 * read back from `market-tabs.json` or a favourite file is untrusted input.
 */
import {
  exchangeQueryFromBody,
  toExchangeBody,
  toTradeSearchBody,
  tradeQueryFromBody,
  type EquipmentFilterKey,
  type ExchangeQuery,
  type MiscBooleanKey,
  type MiscRangeKey,
  type TradeQuery,
  type TradeRange,
  type TradeStatFilter,
  type TradeStatGroup,
} from "./tradeQuery.js";
import { stableTradeQueryJson } from "./tradeQueryImport.js";
import type { MarketSettings } from "./marketSettings.js";

export { exchangeQueryFromBody, tradeQueryFromBody };

export type MarketDraft =
  | { kind: "search"; query: TradeQuery }
  | { kind: "exchange"; query: ExchangeQuery };

export interface MarketSortKey {
  key: string;
  label: string;
  /** Only offered once the query narrows to this kind of item. */
  needsCategory?: "weapon" | "armour" | "gem" | "stackable";
}

/**
 * The sort keys trade2 accepts on a search. Any of them may be sent as
 * `sort: { <key>: "asc" | "desc" }`; the ones flagged with `needsCategory`
 * only mean anything once the category narrows the result set.
 */
export const MARKET_SORT_KEYS: readonly MarketSortKey[] = [
  { key: "price", label: "Price" },
  { key: "indexed", label: "Listed" },
  { key: "ilvl", label: "Item level" },
  { key: "quality", label: "Quality" },
  { key: "dps", label: "DPS", needsCategory: "weapon" },
  { key: "pdps", label: "Physical DPS", needsCategory: "weapon" },
  { key: "edps", label: "Elemental DPS", needsCategory: "weapon" },
  { key: "aps", label: "Attacks per second", needsCategory: "weapon" },
  { key: "crit", label: "Critical chance", needsCategory: "weapon" },
  { key: "ar", label: "Armour", needsCategory: "armour" },
  { key: "ev", label: "Evasion", needsCategory: "armour" },
  { key: "es", label: "Energy shield", needsCategory: "armour" },
  { key: "block", label: "Block", needsCategory: "armour" },
  { key: "spirit", label: "Spirit" },
  { key: "ward", label: "Ward", needsCategory: "armour" },
  { key: "rune_sockets", label: "Rune sockets" },
  { key: "gem_sockets", label: "Gem sockets", needsCategory: "gem" },
  { key: "gem_level", label: "Gem level", needsCategory: "gem" },
  { key: "stack_size", label: "Stack size", needsCategory: "stackable" },
  { key: "map_tier", label: "Waystone tier" },
];

const SORT_KEY_SET = new Set(MARKET_SORT_KEYS.map((entry) => entry.key));

/**
 * Tab colours, as CSS token names the renderer maps to `var(--…)`. Eight
 * is enough to tell favourites apart without inventing a colour picker.
 */
export const MARKET_COLOURS: readonly string[] = [
  "gold",
  "blue",
  "green",
  "amber",
  "red",
  "purple",
  "teal",
  "grey",
];

const COLOUR_SET = new Set(MARKET_COLOURS);

export function emptySearchDraft(defaults?: Partial<MarketSettings>): MarketDraft {
  const query: TradeQuery = { stats: [], status: defaults?.defaultStatus ?? "online" };
  const saleType = defaults?.defaultSaleType;
  if (saleType && saleType !== "any") query.trade = { sale_type: saleType };
  if (defaults?.defaultInstantBuyout) query.trade = { ...(query.trade ?? {}), sale_type: "priced_with_price" };
  query.sort = { key: "price", direction: "asc" };
  return { kind: "search", query };
}

export function emptyExchangeDraft(): MarketDraft {
  return { kind: "exchange", query: { have: [], want: [], status: "online" } };
}

/** The POST body this draft would send (search or exchange). */
export function draftBody(draft: MarketDraft): Record<string, unknown> {
  return draft.kind === "exchange" ? toExchangeBody(draft.query) : toTradeSearchBody(draft.query);
}

/**
 * A stable string for "is this draft still the favourite's draft?" and
 * "has the user edited the tab?". Sorted keys, so key order never lies.
 */
export function draftFingerprint(draft: MarketDraft): string {
  try {
    return `${draft.kind}:${stableTradeQueryJson(draftBody(draft))}`;
  } catch {
    // A draft too deep or too large to canonicalise is still comparable by
    // its own shape; never let fingerprinting throw into a UI path.
    return `${draft.kind}:unhashable`;
  }
}

export interface MarketCatalogueLabels {
  categories: Record<string, string>;
}

function titleCase(text: string): string {
  return text.replace(/(^|[\s.-])([a-z])/g, (_all, lead: string, letter: string) => `${lead}${letter.toUpperCase()}`);
}

/**
 * What the tab chip says before the user renames it. Uniques search by
 * name, so the name alone is the clearest label; otherwise the base type,
 * then the category, then the free-text term.
 */
export function defaultTabLabel(draft: MarketDraft, catalogueLabels?: MarketCatalogueLabels): string {
  if (draft.kind === "exchange") {
    const have = draft.query.have.join(", ");
    const want = draft.query.want.join(", ");
    if (!have && !want) return "Exchange";
    return `${have || "anything"} → ${want || "anything"}`;
  }
  const query = draft.query;
  const name = query.name?.trim();
  if (name) return name;
  const type = query.type?.trim();
  if (type) return type;
  const category = query.category?.trim();
  if (category) {
    const label = catalogueLabels?.categories[category];
    return label ?? titleCase(category.replace(/^[a-z]+\./, "").replace(/[._]/g, " "));
  }
  const term = query.term?.trim();
  if (term) return term;
  if (query.stats.some((group) => group.filters.length > 0)) return "Stat search";
  return "New search";
}

/** A deterministic swatch so two favourites of the same kind do not clash. */
export function defaultColour(draft: MarketDraft): string {
  if (draft.kind === "exchange") return "teal";
  const rarity = draft.query.rarity?.trim().toLowerCase();
  if (rarity === "unique") return "amber";
  if (rarity === "rare") return "gold";
  if (rarity === "magic") return "blue";
  if (draft.query.name?.trim()) return "purple";
  if (draft.query.category?.trim()) return "green";
  return "grey";
}

/**
 * Twice-corrupted implies corrupted: the UI offers them as one exclusive
 * pair so a query can never ask for "twice corrupted but not corrupted".
 */
export function isTwiceCorruptedExclusive(misc: TradeQuery["misc"]): TradeQuery["misc"] {
  if (!misc) return misc;
  if (misc.twice_corrupted === true) return { ...misc, corrupted: true };
  return misc;
}

// ---------------------------------------------------------------------------
// Sanitizer — a draft read from disk, an IPC argument, or an imported URL
// ---------------------------------------------------------------------------

const MAX_TEXT = 120;
const MAX_STAT_GROUPS = 20;
const MAX_STAT_FILTERS = 40;
const MAX_EXCHANGE_IDS = 20;
const STAT_ID = /^[a-z_]+\.[a-z0-9_]+$/;
const EXCHANGE_ID = /^[a-z0-9-]{1,40}$/;

const EQUIPMENT_KEYS: readonly EquipmentFilterKey[] = [
  "damage",
  "pdps",
  "edps",
  "dps",
  "aps",
  "crit",
  "ar",
  "ev",
  "es",
  "block",
  "spirit",
  "rune_sockets",
  "empty_rune_sockets",
  "gem_sockets",
  "ward",
];

const MISC_RANGE_KEYS: readonly MiscRangeKey[] = [
  "ilvl",
  "quality",
  "gem_level",
  "gem_sockets",
  "stack_size",
  "area_level",
  "map_tier",
  "unidentified_tier",
];

const MISC_BOOLEAN_KEYS: readonly MiscBooleanKey[] = [
  "corrupted",
  "mirrored",
  "identified",
  "sanctified",
  "fractured_item",
  "desecrated_item",
  "twice_corrupted",
  "crafted",
  "veiled",
  "alternate_art",
];

/** Per-key numeric bounds; anything outside is clamped, not dropped. */
const RANGE_BOUNDS: Readonly<Record<string, [number, number]>> = {
  ilvl: [1, 100],
  quality: [0, 30],
  gem_level: [1, 40],
  gem_sockets: [0, 6],
  stack_size: [1, 100_000],
  area_level: [1, 100],
  map_tier: [1, 20],
  unidentified_tier: [0, 10],
  rune_sockets: [0, 6],
  empty_rune_sockets: [0, 6],
  default: [0, 100_000],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function boundedNumber(value: unknown, low: number, high: number): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(high, Math.max(low, parsed));
}

function sanitizeRange(value: unknown, key: string): TradeRange | undefined {
  if (!isRecord(value)) return undefined;
  const [low, high] = RANGE_BOUNDS[key] ?? RANGE_BOUNDS.default!;
  const min = boundedNumber(value.min, low, high);
  const max = boundedNumber(value.max, low, high);
  if (min === undefined && max === undefined) return undefined;
  return {
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
  };
}

function sanitizeStatFilter(value: unknown): TradeStatFilter | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!STAT_ID.test(id)) return undefined;
  const filter: TradeStatFilter = { id };
  if (isRecord(value.value)) {
    const min = boundedNumber(value.value.min, -100_000, 100_000);
    const max = boundedNumber(value.value.max, -100_000, 100_000);
    const weight = boundedNumber(value.value.weight, 0, 1000);
    const bound: TradeStatFilter["value"] = {
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(weight !== undefined ? { weight } : {}),
    };
    if (Object.keys(bound).length > 0) filter.value = bound;
  }
  if (value.disabled === true) filter.disabled = true;
  return filter;
}

function sanitizeStatGroup(value: unknown): TradeStatGroup | undefined {
  if (!isRecord(value)) return undefined;
  const type = value.type;
  if (type !== "and" && type !== "not" && type !== "count" && type !== "weight" && type !== "weight2") {
    return undefined;
  }
  const rawFilters = Array.isArray(value.filters) ? value.filters : [];
  const filters: TradeStatFilter[] = [];
  for (const raw of rawFilters.slice(0, MAX_STAT_FILTERS)) {
    const filter = sanitizeStatFilter(raw);
    if (filter) filters.push(filter);
  }
  const group: TradeStatGroup = { type, filters };
  const bound = sanitizeRange(value.value, "default");
  if (bound) group.value = bound;
  if (value.disabled === true) group.disabled = true;
  return group;
}

function sanitizeTradeQuery(raw: Record<string, unknown>): TradeQuery {
  const query: TradeQuery = { stats: [] };
  const name = text(raw.name);
  if (name) query.name = name;
  const type = text(raw.type);
  if (type) query.type = type;
  const term = text(raw.term);
  if (term) query.term = term;
  const category = text(raw.category, 60);
  if (category) query.category = category;
  const rarity = text(raw.rarity, 40);
  if (rarity) query.rarity = rarity;
  if (raw.status === "online" || raw.status === "onlineleague" || raw.status === "any") {
    query.status = raw.status;
  }

  const statsRaw = Array.isArray(raw.stats) ? raw.stats : [];
  for (const entry of statsRaw.slice(0, MAX_STAT_GROUPS)) {
    const group = sanitizeStatGroup(entry);
    if (group) query.stats.push(group);
  }

  if (isRecord(raw.equipment)) {
    const equipment: Partial<Record<EquipmentFilterKey, TradeRange>> = {};
    for (const key of EQUIPMENT_KEYS) {
      const range = sanitizeRange(raw.equipment[key], key);
      if (range) equipment[key] = range;
    }
    if (Object.keys(equipment).length > 0) query.equipment = equipment;
  }

  if (isRecord(raw.misc)) {
    const misc: NonNullable<TradeQuery["misc"]> = {};
    for (const key of MISC_RANGE_KEYS) {
      const range = sanitizeRange(raw.misc[key], key);
      if (range) misc[key] = range;
    }
    for (const key of MISC_BOOLEAN_KEYS) {
      const flag = raw.misc[key];
      if (typeof flag === "boolean") misc[key] = flag;
    }
    if (Object.keys(misc).length > 0) query.misc = isTwiceCorruptedExclusive(misc);
  }

  if (isRecord(raw.trade)) {
    const trade: NonNullable<TradeQuery["trade"]> = {};
    if (isRecord(raw.trade.price)) {
      const price: NonNullable<NonNullable<TradeQuery["trade"]>["price"]> = {};
      const option = text(raw.trade.price.option, 40);
      if (option) price.option = option;
      const min = boundedNumber(raw.trade.price.min, 0, 1_000_000);
      const max = boundedNumber(raw.trade.price.max, 0, 1_000_000);
      if (min !== undefined) price.min = min;
      if (max !== undefined) price.max = max;
      if (Object.keys(price).length > 0) trade.price = price;
    }
    const indexed = text(raw.trade.indexed, 20);
    if (indexed) trade.indexed = indexed;
    const saleType = raw.trade.sale_type;
    if (saleType === "priced" || saleType === "priced_with_price" || saleType === "unpriced" || saleType === "any") {
      trade.sale_type = saleType;
    }
    const account = text(raw.trade.account, 60);
    if (account) trade.account = account;
    if (raw.trade.collapse === true) trade.collapse = true;
    if (Object.keys(trade).length > 0) query.trade = trade;
  }

  if (isRecord(raw.sort)) {
    const key = typeof raw.sort.key === "string" ? raw.sort.key.trim() : "";
    if (SORT_KEY_SET.has(key)) {
      query.sort = { key, direction: raw.sort.direction === "desc" ? "desc" : "asc" };
    }
  }
  return query;
}

function sanitizeExchangeQuery(raw: Record<string, unknown>): ExchangeQuery {
  const ids = (value: unknown): string[] => {
    const out: string[] = [];
    for (const entry of Array.isArray(value) ? value : []) {
      const id = typeof entry === "string" ? entry.trim().toLowerCase() : "";
      if (EXCHANGE_ID.test(id) && !out.includes(id)) out.push(id);
      if (out.length >= MAX_EXCHANGE_IDS) break;
    }
    return out;
  };
  const query: ExchangeQuery = { have: ids(raw.have), want: ids(raw.want) };
  const minimum = boundedNumber(raw.minimum, 0, 100_000);
  if (minimum !== undefined && minimum > 0) query.minimum = Math.floor(minimum);
  if (raw.status === "online" || raw.status === "onlineleague") query.status = raw.status;
  if (raw.collapse === true) query.collapse = true;
  if (raw.fulfillable === true) query.fulfillable = true;
  return query;
}

/**
 * A draft from disk, IPC or an import. Returns undefined only when the
 * value is not a draft at all; anything salvageable is clamped rather than
 * refused, so a hand-edited favourites file still opens.
 */
export function sanitizeDraft(raw: unknown): MarketDraft | undefined {
  if (!isRecord(raw)) return undefined;
  const query = isRecord(raw.query) ? raw.query : undefined;
  if (!query) return undefined;
  if (raw.kind === "exchange") return { kind: "exchange", query: sanitizeExchangeQuery(query) };
  if (raw.kind === "search") return { kind: "search", query: sanitizeTradeQuery(query) };
  return undefined;
}

/** True when the colour is one of ours (a persisted file may hold anything). */
export function isMarketColour(value: unknown): value is string {
  return typeof value === "string" && COLOUR_SET.has(value);
}
