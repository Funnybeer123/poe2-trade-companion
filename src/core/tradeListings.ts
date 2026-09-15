/**
 * Rich trade2 listing parsing: everything a Market / Evaluate / live-search
 * result row needs from GET /api/trade2/fetch and POST /api/trade2/exchange.
 *
 * tradeComps.ts keeps its flat CompListing for the comps math; this module
 * keeps seller, online state, indexed time, whisper (+ token), stash tab and
 * position, the item's own fields (mods by kind, properties, requirements,
 * sockets, extended DPS) and the listing type (whisper vs the Merchant's
 * secure listings). Every field is read defensively: trade2 payloads are
 * network input, and the PoE2 shapes are still moving (explicitMods were
 * strings, now objects with tier data — both are accepted).
 *
 * Pure: no HTTP, no fs.
 */

import { orbCosts, type OrbId } from "./crafting.js";
import { fingerprintItem } from "./itemFingerprint.js";
import { extractNumericRolls } from "./parseItem.js";
import { lookupPrice, type PriceTable } from "./priceTable.js";
import { normalizeTradeModText, tradeCurrencyToOrb } from "./tradeComps.js";
import type { ItemMod, ItemModKind, ItemProperty, NormalizedItem } from "./types.js";

export interface TradeListingSeller {
  account: string;
  character?: string;
  online?: boolean;
  afk?: boolean;
  hideout?: boolean;
  league?: string;
}

export interface TradeListingItem {
  name?: string;
  typeLine: string;
  baseType?: string;
  rarity: string;
  itemLevel?: number;
  identified: boolean;
  corrupted?: boolean;
  mirrored?: boolean;
  sanctified?: boolean;
  fractured?: boolean;
  desecrated?: boolean;
  quality?: number;
  sockets?: number;
  runeSockets?: number;
  stackSize?: number;
  gemLevel?: number;
  properties: Array<{ name: string; values: string[] }>;
  requirements: Array<{ name: string; value: string }>;
  implicitMods: string[];
  explicitMods: string[];
  enchantMods: string[];
  runeMods: string[];
  desecratedMods: string[];
  fracturedMods: string[];
  extended?: { dps?: number; pdps?: number; edps?: number; mods?: unknown; hashes?: unknown };
  iconUrl?: string;
}

export interface TradeListing {
  id: string;
  league: string;
  /** Currency ids as trade2 returns them ("exalted", "divine", "chaos" …). */
  price?: { amount: number; currency: string; type?: string };
  /** Via the price table's rates when the currency is known (exalted = 1). */
  priceExalted?: number;
  seller: TradeListingSeller;
  indexedAt?: string;
  whisper?: string;
  whisperToken?: string;
  listingType: "whisper" | "secure";
  secureFee?: number;
  stash?: { tab: string; left: number; top: number };
  item: TradeListingItem;
  /** Kept only when the caller asks (debug). */
  raw?: unknown;
}

export interface ParseTradeListingsOptions {
  priceTable?: PriceTable;
  keepRaw?: boolean;
}

// ---------------------------------------------------------------------------
// Currency → exalted
// ---------------------------------------------------------------------------

/**
 * trade2 currency ids → in-game names, for price-table lookups. The orb ids
 * the crafting economy knows fall back to its defaults (orbCosts) when the
 * table has no feed row yet; anything else prices only from the table.
 */
export const TRADE_CURRENCY_NAMES: Readonly<Record<string, string>> = {
  exalted: "Exalted Orb",
  divine: "Divine Orb",
  chaos: "Chaos Orb",
  mirror: "Mirror of Kalandra",
  annul: "Orb of Annulment",
  regal: "Regal Orb",
  vaal: "Vaal Orb",
  alch: "Orb of Alchemy",
  transmute: "Orb of Transmutation",
  aug: "Orb of Augmentation",
  chance: "Orb of Chance",
  fracturing: "Fracturing Orb",
  "perfect-jewellers": "Perfect Jeweller's Orb",
  "greater-jewellers": "Greater Jeweller's Orb",
  "lesser-jewellers": "Lesser Jeweller's Orb",
  gcp: "Gemcutter's Prism",
  bauble: "Glassblower's Bauble",
  artificers: "Artificer's Orb",
  "hinekoras-lock": "Hinekora's Lock",
};

/** One unit of `currency` in exalted, when the economy knows the rate. */
export function currencyRateInExalted(currency: string, priceTable?: PriceTable): number | undefined {
  const id = currency.trim().toLowerCase();
  if (id === "exalted" || id === "exalt" || id === "ex") return 1;
  const name = TRADE_CURRENCY_NAMES[id];
  if (name && priceTable) {
    const hit = lookupPrice(priceTable, { name });
    if (hit && hit.entry.match.name !== undefined && hit.value > 0) return hit.value;
  }
  const orb: OrbId | undefined = tradeCurrencyToOrb(id);
  if (orb) {
    const rate = orbCosts(priceTable)[orb];
    return Number.isFinite(rate) && rate > 0 ? rate : undefined;
  }
  return undefined;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Field readers
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Rec) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/[^\d.+-]/g, ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** PoE1-era name markup (`<<set:MS>><<set:M>><<set:S>>Name`) never belongs in a row. */
function cleanName(value: unknown): string | undefined {
  const raw = str(value);
  if (!raw) return undefined;
  const cleaned = raw.replace(/<<set:[A-Z]+>>/g, "").trim();
  return cleaned || undefined;
}

/** Mod arrays: strings, or objects with a `description` (PoE2 tier shape). */
function modTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const texts: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const cleaned = normalizeTradeModText(entry);
      if (cleaned) texts.push(cleaned);
      continue;
    }
    const description = rec(entry)?.description;
    if (typeof description === "string") {
      const cleaned = normalizeTradeModText(description);
      if (cleaned) texts.push(cleaned);
    }
  }
  return texts;
}

/** `values: [["+20%", 1], …]` → the display strings, bracket markup stripped. */
function propertyValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (Array.isArray(entry)) {
      const first = entry[0];
      if (typeof first === "string" || typeof first === "number") out.push(normalizeTradeModText(String(first)));
    } else if (typeof entry === "string" || typeof entry === "number") {
      out.push(normalizeTradeModText(String(entry)));
    }
  }
  return out;
}

function properties(value: unknown): Array<{ name: string; values: string[] }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ name: string; values: string[] }> = [];
  for (const entry of value) {
    const row = rec(entry);
    const name = typeof row?.name === "string" ? normalizeTradeModText(row.name) : "";
    if (!name) continue;
    out.push({ name, values: propertyValues(row?.values) });
  }
  return out;
}

function requirements(value: unknown): Array<{ name: string; value: string }> {
  return properties(value).map((entry) => ({ name: entry.name, value: entry.values[0] ?? "" }));
}

const RARITY_BY_FRAME: Readonly<Record<number, string>> = {
  0: "Normal",
  1: "Magic",
  2: "Rare",
  3: "Unique",
  4: "Gem",
  5: "Currency",
  6: "Divination Card",
  9: "Foil",
};

function rarityOf(item: Rec): string {
  const explicit = str(item.rarity);
  if (explicit) return explicit;
  const frame = num(item.frameType);
  return (frame !== undefined ? RARITY_BY_FRAME[frame] : undefined) ?? "Unknown";
}

/** PoE2 sockets: `[{ group, type: "rune" | "gem", item? }]`; PoE1: `[{ group, attr, sColour }]`. */
function socketCounts(value: unknown): { sockets?: number; runeSockets?: number } {
  if (!Array.isArray(value) || value.length === 0) return {};
  let runes = 0;
  for (const entry of value) {
    const type = str(rec(entry)?.type)?.toLowerCase();
    if (type === "rune") runes += 1;
  }
  return { sockets: value.length, ...(runes > 0 ? { runeSockets: runes } : {}) };
}

function firstPropertyNumber(props: ReadonlyArray<{ name: string; values: string[] }>, pattern: RegExp): number | undefined {
  const hit = props.find((entry) => pattern.test(entry.name));
  return hit ? num(hit.values[0]) : undefined;
}

function extendedOf(value: unknown): TradeListingItem["extended"] | undefined {
  const extended = rec(value);
  if (!extended) return undefined;
  const out: NonNullable<TradeListingItem["extended"]> = {};
  const dps = num(extended.dps);
  const pdps = num(extended.pdps);
  const edps = num(extended.edps);
  if (dps !== undefined) out.dps = dps;
  if (pdps !== undefined) out.pdps = pdps;
  if (edps !== undefined) out.edps = edps;
  if (extended.mods !== undefined) out.mods = extended.mods;
  if (extended.hashes !== undefined) out.hashes = extended.hashes;
  return Object.keys(out).length > 0 ? out : undefined;
}

function itemOf(raw: unknown): TradeListingItem {
  const item = rec(raw) ?? {};
  const props = properties(item.properties);
  const name = cleanName(item.name);
  const typeLine = str(item.typeLine) ?? str(item.baseType) ?? "";
  const baseType = str(item.baseType);
  const itemLevel = num(item.ilvl);
  const quality = firstPropertyNumber(props, /^quality$/i);
  const gemLevel = /gem/i.test(rarityOf(item)) ? firstPropertyNumber(props, /^level$/i) : undefined;
  const stackSize = num(item.stackSize);
  const flags = {
    corrupted: bool(item.corrupted),
    mirrored: bool(item.mirrored),
    sanctified: bool(item.sanctified),
    fractured: bool(item.fractured),
    desecrated: bool(item.desecrated),
  };
  const out: TradeListingItem = {
    ...(name ? { name } : {}),
    typeLine,
    ...(baseType ? { baseType } : {}),
    rarity: rarityOf(item),
    ...(itemLevel !== undefined ? { itemLevel } : {}),
    identified: item.identified !== false,
    ...(flags.corrupted !== undefined ? { corrupted: flags.corrupted } : {}),
    ...(flags.mirrored !== undefined ? { mirrored: flags.mirrored } : {}),
    ...(flags.sanctified !== undefined ? { sanctified: flags.sanctified } : {}),
    ...(flags.fractured !== undefined ? { fractured: flags.fractured } : {}),
    ...(flags.desecrated !== undefined ? { desecrated: flags.desecrated } : {}),
    ...(quality !== undefined ? { quality } : {}),
    ...socketCounts(item.sockets),
    ...(stackSize !== undefined ? { stackSize } : {}),
    ...(gemLevel !== undefined ? { gemLevel } : {}),
    properties: props,
    requirements: requirements(item.requirements),
    implicitMods: modTexts(item.implicitMods),
    explicitMods: modTexts(item.explicitMods),
    enchantMods: modTexts(item.enchantMods),
    runeMods: modTexts(item.runeMods),
    desecratedMods: modTexts(item.desecratedMods),
    fracturedMods: modTexts(item.fracturedMods),
  };
  const extended = extendedOf(item.extended);
  if (extended) out.extended = extended;
  const icon = str(item.icon);
  if (icon && /^https:\/\//i.test(icon)) out.iconUrl = icon;
  return out;
}

/**
 * `account.online` is null while the seller is offline, an object while
 * online; its `status` reads "afk" when they are. "hideout" is accepted
 * in case trade2 starts reporting it (the site shows a hideout badge that
 * PoE Overlay II surfaces) — unverified live.
 */
function sellerOf(listing: Rec): TradeListingSeller {
  const account = rec(listing.account) ?? {};
  const online = rec(account.online);
  const status = str(online?.status)?.toLowerCase();
  const league = str(online?.league);
  const character = str(account.lastCharacterName);
  return {
    account: str(account.name) ?? "",
    ...(character ? { character } : {}),
    ...(account.online !== undefined ? { online: online !== undefined } : {}),
    ...(online ? { afk: status === "afk" } : {}),
    ...(online ? { hideout: status === "hideout" } : {}),
    ...(league ? { league } : {}),
  };
}

/**
 * The Merchant's secure listings (buy through Ange without a whisper): the
 * site badges them "Secure Item"; the JSON marks are read tolerantly —
 * `listing.price.type === "secure"`, a `secure` flag, or a numeric `fee`.
 * Unverified live: the first secure row seen should pin the shape.
 */
function listingKind(listing: Rec, priceType: string | undefined): { listingType: "whisper" | "secure"; secureFee?: number } {
  const fee = num(listing.fee);
  const secure =
    priceType?.toLowerCase() === "secure" ||
    listing.secure === true ||
    str(listing.method)?.toLowerCase() === "secure" ||
    fee !== undefined;
  return { listingType: secure ? "secure" : "whisper", ...(fee !== undefined ? { secureFee: fee } : {}) };
}

function stashOf(listing: Rec): TradeListing["stash"] | undefined {
  const stash = rec(listing.stash);
  if (!stash) return undefined;
  const tab = str(stash.name) ?? "";
  const left = num(stash.x);
  const top = num(stash.y);
  if (left === undefined || top === undefined) return undefined;
  return { tab, left, top };
}

/** One fetch row → a listing; undefined when the row has no usable id. */
export function parseTradeListing(
  raw: unknown,
  league: string,
  opts: ParseTradeListingsOptions = {},
): TradeListing | undefined {
  const row = rec(raw);
  if (!row) return undefined;
  const id = str(row.id);
  if (!id) return undefined;
  const listing = rec(row.listing) ?? {};
  const item = rec(row.item) ?? {};
  const priceRec = rec(listing.price);
  const amount = num(priceRec?.amount);
  const currency = str(priceRec?.currency);
  const priceType = str(priceRec?.type);
  const price =
    amount !== undefined && amount > 0 && currency
      ? { amount, currency, ...(priceType ? { type: priceType } : {}) }
      : undefined;
  const rate = price ? currencyRateInExalted(price.currency, opts.priceTable) : undefined;
  const whisper = str(listing.whisper);
  const whisperToken = str(listing.whisper_token);
  const indexedAt = str(listing.indexed);
  const stash = stashOf(listing);
  return {
    id,
    league: str(item.league) ?? league,
    ...(price ? { price } : {}),
    ...(price && rate !== undefined ? { priceExalted: round2(price.amount * rate) } : {}),
    seller: sellerOf(listing),
    ...(indexedAt ? { indexedAt } : {}),
    ...(whisper ? { whisper } : {}),
    ...(whisperToken ? { whisperToken } : {}),
    ...listingKind(listing, priceType),
    ...(stash ? { stash } : {}),
    item: itemOf(item),
    ...(opts.keepRaw ? { raw } : {}),
  };
}

/** Parse GET /api/trade2/fetch results in order. Unknown shapes are skipped. */
export function parseTradeListings(
  json: unknown,
  league: string,
  opts: ParseTradeListingsOptions = {},
): TradeListing[] {
  const results = rec(json)?.result;
  if (!Array.isArray(results)) return [];
  const listings: TradeListing[] = [];
  for (const raw of results) {
    const listing = parseTradeListing(raw, league, opts);
    if (listing) listings.push(listing);
  }
  return listings;
}

// ---------------------------------------------------------------------------
// Exchange results
// ---------------------------------------------------------------------------

/**
 * One bulk-exchange offer, from the BUYER's side (the query's own words):
 * `have` is what you pay, `want` is what you receive, `stock` how much of
 * it the seller holds, `ratio` = want per one have. The listing's whisper
 * template ("… buy your {0} for my {1} …") is filled in per offer.
 */
export interface ExchangeOffer {
  id: string;
  seller: TradeListingSeller;
  whisper?: string;
  have: { currency: string; amount: number };
  want: { currency: string; amount: number };
  stock: number;
  indexedAt?: string;
  ratio: number;
}

function fillWhisper(template: string | undefined, item: Rec, exchange: Rec, want: number, have: number): string | undefined {
  if (!template) return undefined;
  if (!/\{[01]\}/.test(template)) return template;
  const itemText = (str(item.whisper) ?? "{0}").replace("{0}", String(want));
  const exchangeText = (str(exchange.whisper) ?? "{0}").replace("{0}", String(have));
  return template.replace("{0}", itemText).replace("{1}", exchangeText);
}

function offersOf(listingId: string, listing: Rec, seller: TradeListingSeller, indexedAt: string | undefined): ExchangeOffer[] {
  const offers = Array.isArray(listing.offers) ? listing.offers : [];
  const out: ExchangeOffer[] = [];
  offers.forEach((raw, index) => {
    const offer = rec(raw);
    if (!offer) return;
    const exchange = rec(offer.exchange) ?? {};
    const item = rec(offer.item) ?? {};
    const haveCurrency = str(exchange.currency);
    const wantCurrency = str(item.currency);
    const haveAmount = num(exchange.amount);
    const wantAmount = num(item.amount);
    if (!haveCurrency || !wantCurrency || !haveAmount || !wantAmount || haveAmount <= 0 || wantAmount <= 0) return;
    const stock = num(item.stock) ?? 0;
    const whisper = fillWhisper(str(listing.whisper), item, exchange, wantAmount, haveAmount);
    out.push({
      id: offers.length > 1 ? `${listingId}#${index}` : listingId,
      seller,
      ...(whisper ? { whisper } : {}),
      have: { currency: haveCurrency, amount: haveAmount },
      want: { currency: wantCurrency, amount: wantAmount },
      stock: Math.max(0, Math.floor(stock)),
      ...(indexedAt ? { indexedAt } : {}),
      ratio: round2(wantAmount / haveAmount),
    });
  });
  return out;
}

/**
 * POST /api/trade2/exchange results: the new engine keys `result` by
 * listing id (an array is accepted too). Every offer of every listing
 * becomes one row.
 */
export function parseExchangeResult(json: unknown, league: string): { id: string; total: number; offers: ExchangeOffer[] } {
  const root = rec(json) ?? {};
  const id = str(root.id) ?? "";
  const rawResult = root.result;
  const rows: unknown[] = Array.isArray(rawResult)
    ? rawResult
    : rec(rawResult)
      ? Object.values(rec(rawResult)!)
      : [];
  const offers: ExchangeOffer[] = [];
  let listings = 0;
  for (const raw of rows) {
    const row = rec(raw);
    if (!row) continue;
    const listingId = str(row.id);
    if (!listingId) continue;
    listings += 1;
    const listing = rec(row.listing) ?? {};
    const seller = sellerOf(listing);
    offers.push(...offersOf(listingId, listing, { ...seller, league: seller.league ?? league }, str(listing.indexed)));
  }
  const total = num(root.total);
  return { id, total: total !== undefined ? Math.max(0, Math.floor(total)) : listings, offers };
}

// ---------------------------------------------------------------------------
// Currency names, notes and fractional prices
// ---------------------------------------------------------------------------

/** In-game name (lower-cased) → trade2 id, the inverse of TRADE_CURRENCY_NAMES. */
const CURRENCY_ID_BY_NAME: ReadonlyMap<string, string> = new Map(
  Object.entries(TRADE_CURRENCY_NAMES).map(([id, name]) => [name.toLowerCase(), id]),
);

/** Short forms people and whispers actually use. */
const CURRENCY_ALIASES: Readonly<Record<string, string>> = {
  ex: "exalted",
  exalt: "exalted",
  exalts: "exalted",
  div: "divine",
  divines: "divine",
  c: "chaos",
  annulment: "annul",
  annulments: "annul",
  regals: "regal",
  vaals: "vaal",
  alchemy: "alch",
  transmutation: "transmute",
  augmentation: "aug",
  "fracturing-orb": "fracturing",
  kalandra: "mirror",
};

/**
 * Any way a currency shows up — the trade2 id ("exalted"), the in-game name
 * ("Exalted Orb"), or the shorthand a whisper carries ("ex", "div") — to the
 * trade2 id. Unknown text (gold, a typo, a foreign client's name) returns
 * undefined so the caller can show the raw text and no conversion.
 */
export function normalizeTradeCurrency(text: string): string | undefined {
  const token = text.trim().toLowerCase().replace(/’/g, "'");
  if (!token) return undefined;
  if (Object.prototype.hasOwnProperty.call(TRADE_CURRENCY_NAMES, token)) return token;
  const alias = CURRENCY_ALIASES[token];
  if (alias) return alias;
  const byName = CURRENCY_ID_BY_NAME.get(token);
  if (byName) return byName;
  const singular = token.replace(/\s+orbs$/, " orb");
  return CURRENCY_ID_BY_NAME.get(singular) ?? CURRENCY_ALIASES[singular];
}

/** `amount` of `currency` in exalted (2 dp); undefined when no rate is known. */
export function priceInExalted(
  amount: number,
  currency: string,
  priceTable?: PriceTable,
): number | undefined {
  if (!Number.isFinite(amount)) return undefined;
  const id = normalizeTradeCurrency(currency) ?? currency.trim().toLowerCase();
  const rate = currencyRateInExalted(id, priceTable);
  if (rate === undefined) return undefined;
  return round2(amount * rate);
}

export interface FractionalPriceSplit {
  /** Whole units first (dropped when there are none), then the exalted remainder. */
  parts: Array<{ amount: number; currency: string }>;
  rate: number;
  rateSource: "price-table" | "fallback";
  /** "1 div + 250 ex" — always an estimate; render it with a "≈" and the rate. */
  text: string;
}

/** ex/div are the only abbreviations the trade site itself uses. */
const SHORT_CURRENCY_LABELS: Readonly<Record<string, string>> = {
  exalted: "ex",
  divine: "div",
};

function formatAmount(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : String(round2(amount));
}

/**
 * The rate one unit of `id` is worth, and where it came from. A feed or
 * user row in the price table is "price-table"; the crafting engine's
 * documented defaults (`DEFAULT_ORB_COSTS`, divine 405) are the "fallback"
 * — the same numbers `currencyRateInExalted` already uses for
 * `priceExalted`, so a split never disagrees with the row it sits next to.
 */
function rateWithSource(
  id: string,
  priceTable?: PriceTable,
): { rate: number; source: FractionalPriceSplit["rateSource"] } | undefined {
  const name = TRADE_CURRENCY_NAMES[id];
  if (name && priceTable) {
    const hit = lookupPrice(priceTable, { name });
    if (hit && hit.entry.match.name !== undefined && hit.value > 0) {
      return { rate: hit.value, source: "price-table" };
    }
  }
  const fallback = currencyRateInExalted(id, priceTable);
  return fallback !== undefined && fallback > 0 ? { rate: fallback, source: "fallback" } : undefined;
}

/**
 * "1.5 divine" → "1 div + 250 ex": what the buyer actually hands over, since
 * half an orb cannot be traded. Only for a non-exalted currency with a
 * non-integer amount whose remainder is worth at least one exalted; anything
 * else returns undefined and the caller shows the price as listed.
 */
export function splitFractionalPrice(
  amount: number,
  currency: string,
  priceTable?: PriceTable,
): FractionalPriceSplit | undefined {
  if (!Number.isFinite(amount) || amount <= 0 || Number.isInteger(amount)) return undefined;
  const id = normalizeTradeCurrency(currency);
  if (!id || id === "exalted") return undefined;
  const rate = rateWithSource(id, priceTable);
  if (!rate) return undefined;
  const whole = Math.floor(amount);
  const exalted = Math.round((amount - whole) * rate.rate);
  if (exalted < 1) return undefined;
  const parts = [
    ...(whole > 0 ? [{ amount: whole, currency: id }] : []),
    { amount: exalted, currency: "exalted" },
  ];
  const text = parts
    .map((part) => `${formatAmount(part.amount)} ${SHORT_CURRENCY_LABELS[part.currency] ?? part.currency}`)
    .join(" + ");
  return { parts, rate: rate.rate, rateSource: rate.source, text };
}

/** The stash-tab note the game reads: "~price 5 exalted" / "~b/o 5 exalted". */
export function priceNote(
  price: { amount: number; currency: string },
  mode: "price" | "b/o" = "price",
): string {
  return `~${mode === "b/o" ? "b/o" : "price"} ${formatAmount(price.amount)} ${price.currency.trim()}`;
}

// ---------------------------------------------------------------------------
// One listing, described for a result row
// ---------------------------------------------------------------------------

export type ListingStaleness = "fresh" | "aging" | "stale";

export interface ListingDisplay {
  priceText: string;
  priceExalted?: number;
  fractional?: string;
  ageMs?: number;
  stale: ListingStaleness;
  online: "online" | "afk" | "offline" | "unknown";
  dps?: number;
  pdps?: number;
  edps?: number;
  arQ20?: number;
  evQ20?: number;
  esQ20?: number;
  wardQ20?: number;
  requiredLevel?: number;
  flags: string[];
}

const DEFAULT_AGING_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
const DEFAULT_STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function propertyText(item: TradeListingItem, name: string): string {
  const wanted = name.trim().toLowerCase();
  const hit = item.properties.find((property) => property.name.trim().toLowerCase() === wanted);
  return hit ? hit.values.join(", ") : "";
}

function firstNumberIn(text: string): number | undefined {
  const match = /[+-]?\d[\d,]*(?:\.\d+)?/.exec(text);
  if (!match) return undefined;
  const value = Number(match[0].replace(/,/g, ""));
  return Number.isFinite(value) ? value : undefined;
}

/** "12-24, 5-60" → [[12, 24], [5, 60]] (a comma-separated minus is not a sign). */
function damagePairsIn(text: string): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  const rx = /(\d[\d,]*(?:\.\d+)?)\s*[-–]\s*(\d[\d,]*(?:\.\d+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = rx.exec(text)) !== null) {
    const min = Number(match[1]!.replace(/,/g, ""));
    const max = Number(match[2]!.replace(/,/g, ""));
    if (Number.isFinite(min) && Number.isFinite(max)) pairs.push([min, max]);
  }
  return pairs;
}

/**
 * trade2 computes `extended.dps/pdps/edps` itself; only when it sends none
 * do we read the printed properties (aps × the average of each damage pair).
 */
function damageOf(item: TradeListingItem): { dps?: number; pdps?: number; edps?: number } {
  const extended = item.extended;
  const fromExtended = {
    ...(extended?.dps !== undefined && extended.dps > 0 ? { dps: extended.dps } : {}),
    ...(extended?.pdps !== undefined && extended.pdps > 0 ? { pdps: extended.pdps } : {}),
    ...(extended?.edps !== undefined && extended.edps > 0 ? { edps: extended.edps } : {}),
  };
  if (Object.keys(fromExtended).length > 0) return fromExtended;
  const aps = firstNumberIn(propertyText(item, "Attacks per Second"));
  if (aps === undefined || aps <= 0) return {};
  const sum = (pairs: Array<[number, number]>) =>
    pairs.reduce((total, [min, max]) => total + ((min + max) / 2) * aps, 0);
  const physical = sum(damagePairsIn(propertyText(item, "Physical Damage")));
  const elemental = sum(damagePairsIn(propertyText(item, "Elemental Damage")));
  const chaos = sum(damagePairsIn(propertyText(item, "Chaos Damage")));
  const total = physical + elemental + chaos;
  if (total <= 0) return {};
  return {
    dps: round1(total),
    ...(physical > 0 ? { pdps: round1(physical) } : {}),
    ...(elemental > 0 ? { edps: round1(elemental) } : {}),
  };
}

/** A defence at 20 % quality; a Q20+ item keeps its printed number. */
function defenceAtQ20(item: TradeListingItem, name: string): number | undefined {
  const value = firstNumberIn(propertyText(item, name));
  if (value === undefined) return undefined;
  const quality = item.quality ?? 0;
  if (quality >= 20) return value;
  return round1((value * 120) / (100 + quality));
}

function requiredLevelOf(item: TradeListingItem): number | undefined {
  const hit = item.requirements.find((entry) => entry.name.trim().toLowerCase() === "level");
  return hit ? firstNumberIn(hit.value) : undefined;
}

function listingFlags(listing: TradeListing): string[] {
  const item = listing.item;
  const flags: string[] = [];
  if (item.corrupted) flags.push("corrupted");
  if (item.mirrored) flags.push("mirrored");
  if (item.fractured) flags.push("fractured");
  if (item.desecrated) flags.push("desecrated");
  if (item.sanctified) flags.push("sanctified");
  if (!item.identified) flags.push("unidentified");
  if (item.runeSockets !== undefined && item.runeSockets > 0) {
    flags.push(item.runeSockets === 1 ? "1 rune socket" : `${item.runeSockets} rune sockets`);
  }
  if (listing.secureFee !== undefined) flags.push(`secure fee ${formatAmount(listing.secureFee)}`);
  return flags;
}

/**
 * Everything a result row shows, in one pass: the price as listed plus its
 * exalted conversion and the fractional split, the age band, the seller's
 * presence, DPS, quality-normalised defences, the level requirement and the
 * item's flags. Purely derived — the caller supplies `now`, so rows stay
 * deterministic in tests and across a frozen render.
 *
 * Staleness bands follow the trade site's own reading of `indexed`: fresh
 * under 3 days, aging after that, stale past 14. A listing with no `indexed`
 * timestamp reads as fresh — unknown is not evidence of age.
 */
export function describeListing(
  listing: TradeListing,
  opts: { now: number; agingAfterMs?: number; staleAfterMs?: number; priceTable?: PriceTable },
): ListingDisplay {
  const agingAfterMs = opts.agingAfterMs ?? DEFAULT_AGING_AFTER_MS;
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const price = listing.price;
  const priceText = price ? `${formatAmount(price.amount)} ${price.currency}` : "";
  const priceExalted = price
    ? (listing.priceExalted ?? priceInExalted(price.amount, price.currency, opts.priceTable))
    : undefined;
  const fractional = price
    ? splitFractionalPrice(price.amount, price.currency, opts.priceTable)?.text
    : undefined;

  const indexedMs = listing.indexedAt ? Date.parse(listing.indexedAt) : Number.NaN;
  const ageMs = Number.isFinite(indexedMs) ? Math.max(0, opts.now - indexedMs) : undefined;
  const stale: ListingStaleness =
    ageMs === undefined
      ? "fresh"
      : ageMs > staleAfterMs
        ? "stale"
        : ageMs > agingAfterMs
          ? "aging"
          : "fresh";

  const seller = listing.seller;
  const online =
    seller.online === undefined ? "unknown" : !seller.online ? "offline" : seller.afk ? "afk" : "online";

  const damage = damageOf(listing.item);
  const arQ20 = defenceAtQ20(listing.item, "Armour");
  const evQ20 = defenceAtQ20(listing.item, "Evasion Rating");
  const esQ20 = defenceAtQ20(listing.item, "Energy Shield");
  const wardQ20 = defenceAtQ20(listing.item, "Ward");
  const level = requiredLevelOf(listing.item);

  return {
    priceText,
    ...(priceExalted !== undefined ? { priceExalted } : {}),
    ...(fractional ? { fractional } : {}),
    ...(ageMs !== undefined ? { ageMs } : {}),
    stale,
    online,
    ...damage,
    ...(arQ20 !== undefined ? { arQ20 } : {}),
    ...(evQ20 !== undefined ? { evQ20 } : {}),
    ...(esQ20 !== undefined ? { esQ20 } : {}),
    ...(wardQ20 !== undefined ? { wardQ20 } : {}),
    ...(level !== undefined ? { requiredLevel: level } : {}),
    flags: listingFlags(listing),
  };
}

// ---------------------------------------------------------------------------
// A listing as a NormalizedItem (for <ItemDetail compact>)
// ---------------------------------------------------------------------------

/** The trailing kind tag trade2 leaves on rune and other tagged lines. */
const TRAILING_KIND_TAG = /\s*\((?:rune|implicit|crafted|fractured|enchant(?:ed)?|desecrated)\)\s*$/i;

function listingMods(item: TradeListingItem): ItemMod[] {
  const mods: ItemMod[] = [];
  const push = (texts: readonly string[], kind: ItemModKind) => {
    for (const raw of texts) {
      const text = raw.replace(TRAILING_KIND_TAG, "").trim();
      if (!text) continue;
      const rolls = extractNumericRolls(text);
      const values = rolls.map((roll) => roll.value);
      mods.push({
        text,
        kind,
        implicit: kind === "implicit",
        order: mods.length,
        tags: [kind],
        values,
        rolls,
        ...(values[0] !== undefined ? { value: values[0] } : {}),
        ...(values[1] !== undefined ? { value2: values[1] } : {}),
        ...(rolls[0]?.unit !== undefined ? { unit: rolls[0].unit } : {}),
      });
    }
  };
  push(item.enchantMods, "enchant");
  push(item.implicitMods, "implicit");
  push(item.explicitMods, "explicit");
  push(item.fracturedMods, "fractured");
  push(item.desecratedMods, "desecrated");
  push(item.runeMods, "rune");
  return mods;
}

function listingProperties(item: TradeListingItem): ItemProperty[] {
  return item.properties.map((property, order) => {
    const value = property.values.join(", ");
    const text = `${property.name}: ${value}`;
    const rolls = extractNumericRolls(value);
    return {
      name: property.name,
      value,
      text,
      rawText: text,
      block: 1,
      order,
      line: order,
      values: rolls.map((roll) => roll.value),
      rolls,
    };
  });
}

/**
 * A fetched listing rendered as the same `NormalizedItem` a Ctrl+C copy
 * produces, so the existing item components can show it. `itemClass` stays
 * empty: a trade2 fetch row does not carry one (the search query knows the
 * category, the row does not), and guessing one would invent a fact.
 */
export function listingToNormalizedItem(listing: TradeListing): NormalizedItem {
  const item = listing.item;
  const requirements: Record<string, number> = {};
  for (const entry of item.requirements) {
    const value = firstNumberIn(entry.value);
    if (entry.name && value !== undefined) requirements[entry.name] = value;
  }
  const draft = {
    itemClass: "",
    rarity: item.rarity,
    name: item.name ?? item.typeLine,
    baseType: item.baseType ?? item.typeLine,
    ...(item.itemLevel !== undefined ? { itemLevel: item.itemLevel } : {}),
    ...(item.quality !== undefined ? { quality: item.quality } : {}),
    ...(item.runeSockets !== undefined && item.runeSockets > 0
      ? { sockets: Array.from({ length: item.runeSockets }, () => "S").join(" ") }
      : {}),
    requirements,
    mods: listingMods(item),
    identified: item.identified,
    properties: listingProperties(item),
    ...(item.corrupted !== undefined ? { corrupted: item.corrupted } : {}),
  };
  return { ...draft, fingerprint: fingerprintItem(draft) };
}
