/**
 * Typed trade2 query model → the JSON the official trade site posts.
 *
 * Why a model instead of raw bodies: the Evaluate overlay, the Market view,
 * the deals watchlist and URL import/export all need to build, edit and
 * round-trip the same search, and the trade2 body shape is fiddly (nested
 * `filters.<group>.filters.<key>`, booleans as `{ option: "true" }`, stat
 * groups with per-filter weights). One typed builder keeps every caller
 * honest and lets tests pin the exact wire shape.
 *
 * Endpoints the bodies target (verified in use 2026-08-30 / 2026-09-07):
 *   POST /api/trade2/search/poe2/{league}     ← toTradeSearchBody
 *   POST /api/trade2/exchange/poe2/{league}   ← toExchangeBody
 * Site URLs (import/export):
 *   https://www.pathofexile.com/trade2/search/poe2/<league>/<id>
 *   https://www.pathofexile.com/trade2/exchange/poe2/<league>/<id>
 *   https://www.pathofexile.com/trade2/search/poe2/<league>?q=<urlencoded JSON>
 * The `?q=` form is what the repo's own importer (tradeQueryImport.ts)
 * already accepts; the trade site itself only emits the id form, so a
 * `?q=` URL is this app's portable export, decoded locally without a fetch.
 *
 * Pure: no HTTP, no fs.
 */

import { familiesForClass } from "./modKnowledge.js";
import { isAffixMod } from "./parseItem.js";
import { statIdsForModText, type StatCatalogue } from "./statIds.js";
import { magicBaseType, type NotableMod } from "./tradeComps.js";
import { tradeCategoryForClass } from "./watchlist.js";
import type { ParsedItem } from "./types.js";

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export interface TradeStatFilter {
  id: string;
  value?: { min?: number; max?: number; weight?: number };
  disabled?: boolean;
}

export interface TradeStatGroup {
  type: "and" | "not" | "count" | "weight" | "weight2";
  filters: TradeStatFilter[];
  /** Group bound: matches for `count`, the weighted sum for `weight`/`weight2`. */
  value?: { min?: number; max?: number };
  disabled?: boolean;
}

export type TradeRange = { min?: number; max?: number };

export type EquipmentFilterKey =
  | "damage"
  | "pdps"
  | "edps"
  | "dps"
  | "aps"
  | "crit"
  | "ar"
  | "ev"
  | "es"
  | "block"
  | "spirit"
  | "rune_sockets"
  | "empty_rune_sockets"
  | "gem_sockets"
  | "ward";

export type MiscRangeKey =
  | "ilvl"
  | "quality"
  | "gem_level"
  | "gem_sockets"
  | "stack_size"
  | "area_level"
  | "map_tier"
  | "unidentified_tier";

export type MiscBooleanKey =
  | "corrupted"
  | "mirrored"
  | "identified"
  | "sanctified"
  | "fractured_item"
  | "desecrated_item"
  | "twice_corrupted"
  | "crafted"
  | "veiled"
  | "alternate_art";

export interface TradeQuery {
  name?: string;
  type?: string;
  term?: string;
  category?: string;
  rarity?: string;
  status?: "online" | "onlineleague" | "any";
  stats: TradeStatGroup[];
  equipment?: Partial<Record<EquipmentFilterKey, TradeRange>>;
  misc?: Partial<Record<MiscRangeKey, TradeRange>> & Partial<Record<MiscBooleanKey, boolean>>;
  trade?: {
    price?: { option?: string; min?: number; max?: number };
    indexed?: string;
    sale_type?: "priced" | "priced_with_price" | "unpriced" | "any";
    account?: string;
    collapse?: boolean;
  };
  sort?: { key: string; direction: "asc" | "desc" };
}

export interface ExchangeQuery {
  have: string[];
  want: string[];
  minimum?: number;
  status?: "online" | "onlineleague";
  collapse?: boolean;
  fulfillable?: boolean;
}

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

// ---------------------------------------------------------------------------
// Search body
// ---------------------------------------------------------------------------

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** `{ min, max }` with only the finite bounds; undefined when neither is. */
function rangeOf(range: TradeRange | undefined): Record<string, number> | undefined {
  if (!range) return undefined;
  const out: Record<string, number> = {};
  if (finite(range.min)) out.min = range.min;
  if (finite(range.max)) out.max = range.max;
  return Object.keys(out).length > 0 ? out : undefined;
}

function statFilterOf(filter: TradeStatFilter): Record<string, unknown> {
  const out: Record<string, unknown> = { id: filter.id };
  const value: Record<string, number> = {};
  if (finite(filter.value?.min)) value.min = filter.value.min;
  if (finite(filter.value?.max)) value.max = filter.value.max;
  if (finite(filter.value?.weight)) value.weight = filter.value.weight;
  if (Object.keys(value).length > 0) out.value = value;
  if (filter.disabled) out.disabled = true;
  return out;
}

function statGroupOf(group: TradeStatGroup): Record<string, unknown> | undefined {
  const filters = group.filters
    .filter((filter) => typeof filter.id === "string" && filter.id.trim().length > 0)
    .map(statFilterOf);
  if (filters.length === 0) return undefined;
  const out: Record<string, unknown> = { type: group.type, filters };
  const value = rangeOf(group.value);
  if (value) out.value = value;
  if (group.disabled) out.disabled = true;
  return out;
}

function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The POST body for /api/trade2/search/poe2/{league}. Empty filter groups
 * are omitted (the site sends them, the API does not need them); disabled
 * stat groups are kept with `disabled: true` so an exported URL round-trips
 * the user's toggles the way the site's own saved searches do.
 */
export function toTradeSearchBody(query: TradeQuery): Record<string, unknown> {
  const q: Record<string, unknown> = {
    status: { option: query.status ?? "online" },
  };
  const name = text(query.name);
  const type = text(query.type);
  const term = text(query.term);
  if (name) q.name = name;
  if (type) q.type = type;
  if (term) q.term = term;

  const stats = (query.stats ?? []).map(statGroupOf).filter((group) => group !== undefined);
  if (stats.length > 0) q.stats = stats;

  const filters: Record<string, unknown> = {};
  const typeFilters: Record<string, unknown> = {};
  const category = text(query.category);
  const rarity = text(query.rarity);
  if (category) typeFilters.category = { option: category };
  if (rarity) typeFilters.rarity = { option: rarity };
  if (Object.keys(typeFilters).length > 0) filters.type_filters = { filters: typeFilters };

  const equipment: Record<string, unknown> = {};
  for (const key of EQUIPMENT_KEYS) {
    const range = rangeOf(query.equipment?.[key]);
    if (range) equipment[key] = range;
  }
  if (Object.keys(equipment).length > 0) filters.equipment_filters = { filters: equipment };

  const misc: Record<string, unknown> = {};
  for (const key of MISC_RANGE_KEYS) {
    const range = rangeOf(query.misc?.[key]);
    if (range) misc[key] = range;
  }
  for (const key of MISC_BOOLEAN_KEYS) {
    const flag = query.misc?.[key];
    if (typeof flag === "boolean") misc[key] = { option: flag ? "true" : "false" };
  }
  if (Object.keys(misc).length > 0) filters.misc_filters = { filters: misc };

  const trade: Record<string, unknown> = {};
  if (query.trade?.price) {
    const price: Record<string, unknown> = {};
    const option = text(query.trade.price.option);
    if (option) price.option = option;
    if (finite(query.trade.price.min)) price.min = query.trade.price.min;
    if (finite(query.trade.price.max)) price.max = query.trade.price.max;
    if (Object.keys(price).length > 0) trade.price = price;
  }
  const indexed = text(query.trade?.indexed);
  if (indexed) trade.indexed = { option: indexed };
  if (query.trade?.sale_type && query.trade.sale_type !== "any") {
    trade.sale_type = { option: query.trade.sale_type };
  }
  const account = text(query.trade?.account);
  if (account) trade.account = { input: account };
  if (query.trade?.collapse) trade.collapse = { option: "true" };
  if (Object.keys(trade).length > 0) filters.trade_filters = { filters: trade };

  if (Object.keys(filters).length > 0) q.filters = filters;

  const sortKey = text(query.sort?.key) ?? "price";
  const direction = query.sort?.direction === "desc" ? "desc" : "asc";
  return { query: q, sort: { [sortKey]: direction } };
}

// ---------------------------------------------------------------------------
// Exchange body
// ---------------------------------------------------------------------------

function currencyIds(ids: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const id of ids ?? []) {
    const trimmed = typeof id === "string" ? id.trim() : "";
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * The POST body for /api/trade2/exchange/poe2/{league}: the bulk-exchange
 * engine the site's "Bulk Item Exchange" tab uses (`engine: "new"`, sorted
 * by the have side like the site). `have`/`want` are trade2 currency ids
 * ("divine", "exalted", "chaos", …), not item names.
 */
export function toExchangeBody(query: ExchangeQuery): Record<string, unknown> {
  const q: Record<string, unknown> = {
    status: { option: query.status ?? "online" },
    have: currencyIds(query.have),
    want: currencyIds(query.want),
  };
  if (finite(query.minimum) && query.minimum > 0) q.minimum = Math.floor(query.minimum);
  if (query.collapse) q.collapse = true;
  if (query.fulfillable) q.fulfillable = true;
  return { query: q, sort: { have: "asc" }, engine: "new" };
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

const TRADE_SITE = "https://www.pathofexile.com/trade2";
const ALLOWED_HOSTS = new Set(["pathofexile.com", "www.pathofexile.com"]);
const DANGEROUS_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_URL_QUERY_BYTES = 262_144;

export function tradeSearchUrl(league: string, searchId: string): string {
  return `${TRADE_SITE}/search/poe2/${encodeURIComponent(league)}/${encodeURIComponent(searchId)}`;
}

export function exchangeUrl(league: string, searchId: string): string {
  return `${TRADE_SITE}/exchange/poe2/${encodeURIComponent(league)}/${encodeURIComponent(searchId)}`;
}

/**
 * The portable export: the full search body in `?q=`, which the site's
 * search page and this app's importer both decode locally — no search id,
 * so no trade2 request is needed to share or store it.
 */
export function tradeQueryUrl(league: string, body: Record<string, unknown>): string {
  return `${TRADE_SITE}/search/poe2/${encodeURIComponent(league)}?q=${encodeURIComponent(JSON.stringify(body))}`;
}

export interface ParsedTradeUrl {
  kind: "search" | "exchange";
  league: string;
  searchId?: string;
  /** The decoded `?q=` document (`{ query, sort }`), when the URL carried one. */
  query?: unknown;
}

function hasDangerousKeys(value: unknown, depth = 0): boolean {
  if (depth > 40) return true;
  if (Array.isArray(value)) return value.some((entry) => hasDangerousKeys(entry, depth + 1));
  if (typeof value !== "object" || value === null) return false;
  for (const key of Object.keys(value)) {
    if (DANGEROUS_JSON_KEYS.has(key)) return true;
    if (hasDangerousKeys((value as Record<string, unknown>)[key], depth + 1)) return true;
  }
  return false;
}

function decodeQueryParam(url: URL): { ok: true; query?: unknown } | { ok: false } {
  const raw = url.searchParams.getAll("q");
  if (raw.length === 0) return { ok: true };
  if (raw.length > 1) return { ok: false };
  const textValue = raw[0]!;
  if (textValue.length > MAX_URL_QUERY_BYTES) return { ok: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(textValue);
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false };
  if (hasDangerousKeys(parsed)) return { ok: false };
  const document = parsed as Record<string, unknown>;
  // A query-only export (`{ type, stats }`) is wrapped the way the importer does.
  if (typeof document.query === "object" && document.query !== null) return { ok: true, query: document };
  return { ok: true, query: { query: document } };
}

/**
 * Both site URL forms (search and exchange, id or `?q=`), host-checked.
 * Undefined for anything that is not a pathofexile.com trade2 URL —
 * a pasted link is untrusted input.
 */
export function parseTradeUrl(url: string): ParsedTradeUrl | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) return undefined;
  if (parsed.username || parsed.password) return undefined;
  let segments: string[];
  try {
    segments = parsed.pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return undefined;
  }
  const tradeIndex = segments.findIndex((segment) => segment === "trade2" || segment === "trade");
  if (tradeIndex < 0) return undefined;
  const verb = segments[tradeIndex + 1];
  if (verb !== "search" && verb !== "exchange") return undefined;
  let cursor = tradeIndex + 2;
  if (segments[cursor]?.toLowerCase() === "poe2") cursor += 1;
  const league = segments[cursor]?.trim();
  if (!league) return undefined;
  const searchId = segments[cursor + 1]?.trim();
  if (searchId !== undefined && (searchId.length === 0 || searchId.length > 256)) return undefined;
  const decoded = decodeQueryParam(parsed);
  if (!decoded.ok) return undefined;
  if (!searchId && decoded.query === undefined) return undefined;
  return {
    kind: verb,
    league,
    ...(searchId ? { searchId } : {}),
    ...(decoded.query !== undefined ? { query: decoded.query } : {}),
  };
}

// ---------------------------------------------------------------------------
// The Evaluate default query for a parsed item
// ---------------------------------------------------------------------------

export type EvaluateProfileId = "quick-price" | "exact-match" | "crafting-base" | "broad";

/**
 * How much of the item goes into the search. P1 (Evaluate) refines and
 * lets the user edit these; F4 ships the mechanics with PoE Overlay II's
 * four presets as defaults.
 */
export interface EvaluateProfile {
  id: EvaluateProfileId;
  /** Fraction of our roll a listing must reach on each selected mod (0–1). */
  slack: number;
  /** Notable mods to filter on, strongest first; Infinity = every resolvable affix. */
  maxMods: number;
}

export const EVALUATE_PROFILES: Readonly<Record<EvaluateProfileId, EvaluateProfile>> = {
  "quick-price": { id: "quick-price", slack: 0.85, maxMods: 3 },
  "exact-match": { id: "exact-match", slack: 1, maxMods: Number.POSITIVE_INFINITY },
  "crafting-base": { id: "crafting-base", slack: 1, maxMods: 0 },
  broad: { id: "broad", slack: 0.7, maxMods: 0 },
};

/** "Waystone (Tier 11)" / property "Waystone Tier: 11" → 11. */
export function waystoneTierOf(parsed: ParsedItem): number | undefined {
  const property = parsed.properties.find((entry) => /^waystone tier$/i.test(entry.name));
  const fromProperty = property?.rolls?.[0]?.value;
  if (finite(fromProperty) && fromProperty > 0) return Math.floor(fromProperty);
  const match = /\(tier\s+(\d+)\)/i.exec(`${parsed.name} ${parsed.baseType}`);
  return match ? Number(match[1]) : undefined;
}

function searchableBase(parsed: ParsedItem): string | undefined {
  const base =
    /^magic$/i.test(parsed.rarity) && parsed.baseType === parsed.name
      ? magicBaseType(parsed.name)
      : parsed.baseType;
  return text(base);
}

interface SelectedMod {
  text: string;
  familyId?: string;
  min?: number;
}

/**
 * Which mod lines the profile filters on: the appraisal's notable affixes
 * (strongest family first, as buildStatFilteredQuery orders them), then —
 * for Exact Match — every other affix line with a roll. Runes, implicits
 * and enchants are never the item's own substance.
 */
function selectMods(
  parsed: ParsedItem,
  appraisal: { mods: readonly NotableMod[] } | undefined,
  profile: EvaluateProfile,
): SelectedMod[] {
  if (profile.maxMods <= 0) return [];
  const families = familiesForClass(parsed.itemClass);
  const weightOf = (familyId: string | undefined) =>
    families.find((family) => family.id === familyId)?.weight ?? 0;
  const selected: SelectedMod[] = [];
  const seenFamilies = new Set<string>();
  const seenTexts = new Set<string>();
  const minOf = (roll: number | undefined) => {
    if (!finite(roll) || roll <= 0) return undefined;
    const min = Math.floor(roll * profile.slack);
    return min > 0 ? min : undefined;
  };
  const notable = (appraisal?.mods ?? [])
    .filter(
      (mod): mod is NotableMod & { familyId: string; judgedValue: number } =>
        mod.affix !== false &&
        typeof mod.familyId === "string" &&
        typeof mod.judgedValue === "number" &&
        mod.judgedValue > 0 &&
        mod.tier !== undefined &&
        mod.tier >= 1,
    )
    .sort((a, b) => weightOf(b.familyId) - weightOf(a.familyId) || b.judgedValue - a.judgedValue);
  for (const mod of notable) {
    if (selected.length >= profile.maxMods) break;
    if (seenFamilies.has(mod.familyId) || seenTexts.has(mod.text)) continue;
    seenFamilies.add(mod.familyId);
    seenTexts.add(mod.text);
    const min = minOf(mod.judgedValue);
    selected.push({ text: mod.text, familyId: mod.familyId, ...(min !== undefined ? { min } : {}) });
  }
  if (!Number.isFinite(profile.maxMods)) {
    for (const mod of parsed.mods) {
      if (!isAffixMod(mod) || seenTexts.has(mod.text)) continue;
      seenTexts.add(mod.text);
      const min = minOf(mod.value);
      selected.push({ text: mod.text, ...(min !== undefined ? { min } : {}) });
    }
  }
  return selected;
}

/** Selected mods → stat groups; a mod with no catalogue id is left out. */
function statGroupsFor(mods: readonly SelectedMod[], catalogue: StatCatalogue | undefined): TradeStatGroup[] {
  if (!catalogue) return [];
  const andFilters: TradeStatFilter[] = [];
  const groups: TradeStatGroup[] = [];
  for (const mod of mods) {
    const exact = statIdsForModText(catalogue, mod.text);
    const familyIds = mod.familyId ? (catalogue.byFamily.get(mod.familyId) ?? []) : [];
    const ids = exact.length > 0 ? exact : familyIds.length <= 4 ? familyIds : [];
    if (ids.length === 0) continue;
    const filter = (id: string): TradeStatFilter =>
      mod.min !== undefined ? { id, value: { min: mod.min } } : { id };
    if (ids.length === 1) andFilters.push(filter(ids[0]!));
    else groups.push({ type: "count", filters: ids.map(filter), value: { min: 1 } });
  }
  return [...(andFilters.length > 0 ? [{ type: "and" as const, filters: andFilters }] : []), ...groups];
}

/**
 * The default search for one Ctrl+C item:
 *   - unique: name + base (exact already); unidentified → base + rarity only;
 *   - currency / stackables: the item name as `type`;
 *   - waystones: category `map.waystone` + the tier as a range;
 *   - everything else: base type, rarity nonunique, the profile's mods as
 *     stat filters (needs the catalogue), the item level floor at 78+ (or
 *     always for Crafting Base, plus its fractured lines), and the
 *     corrupted flag when the item is corrupted (Quick Price / Exact Match).
 * Online sellers, cheapest first.
 */
export function tradeQueryFromItem(
  parsed: ParsedItem,
  appraisal?: { mods: readonly NotableMod[] },
  catalogue?: StatCatalogue,
  profile: EvaluateProfile = EVALUATE_PROFILES["quick-price"],
): TradeQuery {
  const base: TradeQuery = { status: "online", stats: [], sort: { key: "price", direction: "asc" } };
  const rarity = parsed.rarity.trim().toLowerCase();
  const itemClass = parsed.itemClass.trim().toLowerCase();

  if (rarity === "currency" || /currency/.test(itemClass)) {
    return { ...base, type: parsed.name };
  }
  if (/waystone/.test(itemClass)) {
    const tier = waystoneTierOf(parsed);
    return {
      ...base,
      category: "map.waystone",
      ...(tier !== undefined ? { misc: { map_tier: { min: tier, max: tier } } } : {}),
    };
  }
  if (rarity === "unique") {
    if (!parsed.identified) {
      return { ...base, ...(text(parsed.baseType) ? { type: parsed.baseType } : {}), rarity: "unique" };
    }
    return {
      ...base,
      name: parsed.name,
      ...(text(parsed.baseType) && parsed.baseType !== parsed.name ? { type: parsed.baseType } : {}),
    };
  }
  if (rarity !== "normal" && rarity !== "magic" && rarity !== "rare") {
    return { ...base, ...(text(parsed.baseType) ? { type: parsed.baseType } : {}) };
  }

  const type = searchableBase(parsed);
  const query: TradeQuery = { ...base, ...(type ? { type } : {}), rarity: "nonunique" };
  if (!type) {
    const category = tradeCategoryForClass(parsed.itemClass);
    if (category) query.category = category;
  }
  const misc: NonNullable<TradeQuery["misc"]> = {};
  const itemLevel = parsed.itemLevel ?? 0;
  if (profile.id === "crafting-base" ? itemLevel > 0 : itemLevel >= 78) {
    misc.ilvl = { min: profile.id === "crafting-base" ? itemLevel : 78 };
  }
  if (parsed.corrupted && (profile.id === "quick-price" || profile.id === "exact-match")) {
    misc.corrupted = true;
  }
  if (Object.keys(misc).length > 0) query.misc = misc;

  if (!parsed.identified) return query;
  const mods = selectMods(parsed, appraisal, profile);
  if (profile.id === "crafting-base") {
    for (const mod of parsed.mods) {
      if (mod.kind !== "fractured") continue;
      const min = finite(mod.value) && mod.value > 0 ? Math.floor(mod.value) : undefined;
      mods.push({ text: mod.text, ...(min !== undefined ? { min } : {}) });
    }
    if (mods.length > 0) query.misc = { ...(query.misc ?? {}), fractured_item: true };
  }
  query.stats = statGroupsFor(mods, catalogue);
  return query;
}

// ---------------------------------------------------------------------------
// Body → model (the inverses)
// ---------------------------------------------------------------------------

/**
 * A trade2 body is untrusted input: it arrives from a pasted `?q=` URL, a
 * saved search written by an older build, or a `search/{id}` response. The
 * inverses therefore never throw and never guess — anything they cannot map
 * onto the typed model is listed in `unsupported` (dotted paths) so the UI
 * can say "this search uses filters this app does not edit yet" instead of
 * silently dropping them.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionOf(value: unknown): string | undefined {
  const option = asRecord(value)?.option;
  return typeof option === "string" && option.trim() ? option.trim() : undefined;
}

function booleanOptionOf(value: unknown): boolean | undefined {
  const option = optionOf(value)?.toLowerCase();
  if (option === "true") return true;
  if (option === "false") return false;
  return undefined;
}

function rangeFrom(value: unknown, path: string, unsupported: string[]): TradeRange | undefined {
  const row = asRecord(value);
  if (!row) {
    unsupported.push(path);
    return undefined;
  }
  const range: TradeRange = {};
  for (const [key, entry] of Object.entries(row)) {
    if (key === "min" && finite(entry)) range.min = entry;
    else if (key === "max" && finite(entry)) range.max = entry;
    else unsupported.push(`${path}.${key}`);
  }
  return range.min !== undefined || range.max !== undefined ? range : undefined;
}

const STAT_GROUP_TYPES: readonly TradeStatGroup["type"][] = ["and", "not", "count", "weight", "weight2"];

function statFilterFrom(value: unknown, path: string, unsupported: string[]): TradeStatFilter | undefined {
  const row = asRecord(value);
  const id = typeof row?.id === "string" ? row.id.trim() : "";
  if (!row || !id) {
    unsupported.push(path);
    return undefined;
  }
  const filter: TradeStatFilter = { id };
  for (const [key, entry] of Object.entries(row)) {
    if (key === "id") continue;
    if (key === "disabled") {
      if (entry === true) filter.disabled = true;
      else if (entry !== false) unsupported.push(`${path}.disabled`);
      continue;
    }
    if (key === "value") {
      const bounds = asRecord(entry);
      if (!bounds) {
        unsupported.push(`${path}.value`);
        continue;
      }
      const parsed: NonNullable<TradeStatFilter["value"]> = {};
      for (const [boundKey, bound] of Object.entries(bounds)) {
        if (boundKey === "min" && finite(bound)) parsed.min = bound;
        else if (boundKey === "max" && finite(bound)) parsed.max = bound;
        else if (boundKey === "weight" && finite(bound)) parsed.weight = bound;
        else unsupported.push(`${path}.value.${boundKey}`);
      }
      if (Object.keys(parsed).length > 0) filter.value = parsed;
      continue;
    }
    unsupported.push(`${path}.${key}`);
  }
  return filter;
}

function statGroupsFrom(value: unknown, unsupported: string[]): TradeStatGroup[] {
  if (!Array.isArray(value)) {
    unsupported.push("query.stats");
    return [];
  }
  const groups: TradeStatGroup[] = [];
  value.forEach((raw, index) => {
    const path = `query.stats[${index}]`;
    const row = asRecord(raw);
    if (!row) {
      unsupported.push(path);
      return;
    }
    const type = STAT_GROUP_TYPES.find((candidate) => candidate === row.type);
    if (!type) {
      unsupported.push(`${path}.type`);
      return;
    }
    const filters: TradeStatFilter[] = [];
    if (Array.isArray(row.filters)) {
      row.filters.forEach((rawFilter, filterIndex) => {
        const filter = statFilterFrom(rawFilter, `${path}.filters[${filterIndex}]`, unsupported);
        if (filter) filters.push(filter);
      });
    } else if (row.filters !== undefined) {
      unsupported.push(`${path}.filters`);
    }
    const group: TradeStatGroup = { type, filters };
    for (const key of Object.keys(row)) {
      if (key === "type" || key === "filters") continue;
      if (key === "value") {
        const bound = rangeFrom(row.value, `${path}.value`, unsupported);
        if (bound) group.value = bound;
        continue;
      }
      if (key === "disabled") {
        if (row.disabled === true) group.disabled = true;
        else if (row.disabled !== false) unsupported.push(`${path}.disabled`);
        continue;
      }
      unsupported.push(`${path}.${key}`);
    }
    groups.push(group);
  });
  return groups;
}

function readTypeFilters(filters: Record<string, unknown>, query: TradeQuery, unsupported: string[]): void {
  const base = "query.filters.type_filters.filters";
  for (const [key, value] of Object.entries(filters)) {
    if (key === "category" || key === "rarity") {
      const option = optionOf(value);
      if (option) query[key] = option;
      else unsupported.push(`${base}.${key}`);
      continue;
    }
    unsupported.push(`${base}.${key}`);
  }
}

function readEquipmentFilters(
  filters: Record<string, unknown>,
  query: TradeQuery,
  unsupported: string[],
): void {
  const base = "query.filters.equipment_filters.filters";
  for (const [key, value] of Object.entries(filters)) {
    const known = EQUIPMENT_KEYS.find((candidate) => candidate === key);
    if (!known) {
      unsupported.push(`${base}.${key}`);
      continue;
    }
    const range = rangeFrom(value, `${base}.${key}`, unsupported);
    if (range) query.equipment = { ...(query.equipment ?? {}), [known]: range };
  }
}

function readMiscFilters(filters: Record<string, unknown>, query: TradeQuery, unsupported: string[]): void {
  const base = "query.filters.misc_filters.filters";
  for (const [key, value] of Object.entries(filters)) {
    const range = MISC_RANGE_KEYS.find((candidate) => candidate === key);
    if (range) {
      const bound = rangeFrom(value, `${base}.${key}`, unsupported);
      if (bound) query.misc = { ...(query.misc ?? {}), [range]: bound };
      continue;
    }
    const flagKey = MISC_BOOLEAN_KEYS.find((candidate) => candidate === key);
    if (flagKey) {
      const flag = booleanOptionOf(value);
      if (flag === undefined) unsupported.push(`${base}.${key}`);
      else query.misc = { ...(query.misc ?? {}), [flagKey]: flag };
      continue;
    }
    unsupported.push(`${base}.${key}`);
  }
}

const SALE_TYPES: ReadonlyArray<NonNullable<NonNullable<TradeQuery["trade"]>["sale_type"]>> = [
  "priced",
  "priced_with_price",
  "unpriced",
  "any",
];

function readTradeFilters(filters: Record<string, unknown>, query: TradeQuery, unsupported: string[]): void {
  const base = "query.filters.trade_filters.filters";
  const trade: NonNullable<TradeQuery["trade"]> = {};
  for (const [key, value] of Object.entries(filters)) {
    switch (key) {
      case "price": {
        const row = asRecord(value);
        if (!row) {
          unsupported.push(`${base}.price`);
          break;
        }
        const price: NonNullable<NonNullable<TradeQuery["trade"]>["price"]> = {};
        for (const [priceKey, entry] of Object.entries(row)) {
          if (priceKey === "option" && typeof entry === "string" && entry.trim()) price.option = entry.trim();
          else if (priceKey === "min" && finite(entry)) price.min = entry;
          else if (priceKey === "max" && finite(entry)) price.max = entry;
          else unsupported.push(`${base}.price.${priceKey}`);
        }
        if (Object.keys(price).length > 0) trade.price = price;
        break;
      }
      case "indexed": {
        const option = optionOf(value);
        if (option) trade.indexed = option;
        else unsupported.push(`${base}.indexed`);
        break;
      }
      case "sale_type": {
        const option = optionOf(value);
        const known = SALE_TYPES.find((candidate) => candidate === option);
        if (known) trade.sale_type = known;
        else unsupported.push(`${base}.sale_type`);
        break;
      }
      case "account": {
        const input = asRecord(value)?.input;
        if (typeof input === "string" && input.trim()) trade.account = input.trim();
        else unsupported.push(`${base}.account`);
        break;
      }
      case "collapse": {
        const flag = booleanOptionOf(value);
        if (flag === undefined) unsupported.push(`${base}.collapse`);
        else if (flag) trade.collapse = true;
        break;
      }
      default:
        unsupported.push(`${base}.${key}`);
    }
  }
  if (Object.keys(trade).length > 0) query.trade = trade;
}

function readFilters(value: unknown, query: TradeQuery, unsupported: string[]): void {
  const filters = asRecord(value);
  if (!filters) {
    unsupported.push("query.filters");
    return;
  }
  for (const [group, raw] of Object.entries(filters)) {
    const inner = asRecord(asRecord(raw)?.filters);
    if (!inner) {
      unsupported.push(`query.filters.${group}`);
      continue;
    }
    for (const key of Object.keys(asRecord(raw) ?? {})) {
      if (key !== "filters" && key !== "disabled") unsupported.push(`query.filters.${group}.${key}`);
    }
    switch (group) {
      case "type_filters":
        readTypeFilters(inner, query, unsupported);
        break;
      case "equipment_filters":
        readEquipmentFilters(inner, query, unsupported);
        break;
      case "misc_filters":
        readMiscFilters(inner, query, unsupported);
        break;
      case "trade_filters":
        readTradeFilters(inner, query, unsupported);
        break;
      default:
        unsupported.push(`query.filters.${group}`);
    }
  }
}

/**
 * The inverse of `toTradeSearchBody`: a posted body (or a decoded `?q=`
 * document) back into the editable model. Round-trips every body this
 * module produces; anything else is reported in `unsupported` rather than
 * thrown away in silence.
 */
export function tradeQueryFromBody(body: unknown): { query: TradeQuery; unsupported: string[] } {
  const unsupported: string[] = [];
  const document = asRecord(body) ?? {};
  const query: TradeQuery = { stats: [] };
  for (const key of Object.keys(document)) {
    if (key === "query" || key === "sort") continue;
    unsupported.push(key);
  }
  const q = asRecord(document.query);
  if (document.query !== undefined && !q) unsupported.push("query");
  for (const [key, value] of Object.entries(q ?? {})) {
    switch (key) {
      case "status": {
        const option = optionOf(value);
        if (option === "online" || option === "onlineleague" || option === "any") query.status = option;
        else unsupported.push("query.status");
        break;
      }
      case "name": {
        const name = text(typeof value === "string" ? value : undefined);
        if (name) query.name = name;
        else unsupported.push("query.name");
        break;
      }
      case "type": {
        const type = text(typeof value === "string" ? value : undefined);
        if (type) query.type = type;
        else unsupported.push("query.type");
        break;
      }
      case "term": {
        const term = text(typeof value === "string" ? value : undefined);
        if (term) query.term = term;
        else unsupported.push("query.term");
        break;
      }
      case "stats":
        query.stats = statGroupsFrom(value, unsupported);
        break;
      case "filters":
        readFilters(value, query, unsupported);
        break;
      default:
        unsupported.push(`query.${key}`);
    }
  }
  const sort = asRecord(document.sort);
  if (document.sort !== undefined && !sort) unsupported.push("sort");
  if (sort) {
    const entries = Object.entries(sort);
    const first = entries[0];
    if (first) {
      const [sortKey, direction] = first;
      if (direction !== "asc" && direction !== "desc") unsupported.push(`sort.${sortKey}`);
      query.sort = { key: sortKey, direction: direction === "desc" ? "desc" : "asc" };
    }
    for (const [extraKey] of entries.slice(1)) unsupported.push(`sort.${extraKey}`);
  }
  return { query, unsupported };
}

function currencyList(value: unknown, path: string, unsupported: string[]): string[] {
  if (!Array.isArray(value)) {
    unsupported.push(path);
    return [];
  }
  const ids: string[] = [];
  value.forEach((entry, index) => {
    const id = typeof entry === "string" ? entry.trim() : "";
    if (!id) {
      unsupported.push(`${path}[${index}]`);
      return;
    }
    if (!ids.includes(id)) ids.push(id);
  });
  return ids;
}

/** The inverse of `toExchangeBody`, with the same never-throw contract. */
export function exchangeQueryFromBody(body: unknown): { query: ExchangeQuery; unsupported: string[] } {
  const unsupported: string[] = [];
  const document = asRecord(body) ?? {};
  const query: ExchangeQuery = { have: [], want: [] };
  for (const [key, value] of Object.entries(document)) {
    if (key === "query") continue;
    if (key === "engine") {
      if (value !== "new") unsupported.push("engine");
      continue;
    }
    if (key === "sort") {
      const sort = asRecord(value);
      if (!sort || sort.have !== "asc" || Object.keys(sort).length !== 1) unsupported.push("sort");
      continue;
    }
    unsupported.push(key);
  }
  const q = asRecord(document.query);
  if (document.query !== undefined && !q) unsupported.push("query");
  for (const [key, value] of Object.entries(q ?? {})) {
    switch (key) {
      case "status": {
        const option = optionOf(value);
        if (option === "online" || option === "onlineleague") query.status = option;
        else unsupported.push("query.status");
        break;
      }
      case "have":
        query.have = currencyList(value, "query.have", unsupported);
        break;
      case "want":
        query.want = currencyList(value, "query.want", unsupported);
        break;
      case "minimum": {
        if (finite(value) && value > 0) query.minimum = Math.floor(value);
        else unsupported.push("query.minimum");
        break;
      }
      case "collapse": {
        if (value === true) query.collapse = true;
        else if (value !== false) unsupported.push("query.collapse");
        break;
      }
      case "fulfillable": {
        if (value === true) query.fulfillable = true;
        else if (value !== false) unsupported.push("query.fulfillable");
        break;
      }
      default:
        unsupported.push(`query.${key}`);
    }
  }
  return { query, unsupported };
}
