/** Conservative, versioned matching of copied stash items against real trade listings. */
import { normalizeTradeModText, magicBaseType } from "./tradeComps.js";
import type { ParsedItem } from "./types.js";
import type { StashMarketQuote } from "./stashValuation.js";

export const STASH_MARKET_MODEL = "stash-comparables-4";
export const STASH_QUOTE_TTL_MS = 15 * 60_000;
export const STASH_RATE_TTL_MS = 30 * 60_000;
export interface StashTradeStat { id: string; text: string }
export interface StashTradeQuery { body: Record<string, unknown>; baseType: string; reasons: string[] }
export interface StashCurrencyRates { league: string; fetchedAt: string; validUntil?: string; chaosPerCurrency: Record<string, number> }
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1e12;
const folded = (value: string): string => normalizeTradeModText(value).replace(/\s*\((?:implicit|crafted|fractured|enchant(?:ed)?)\)\s*$/i, "").trim().toLowerCase();
const numericPattern = /[+-]?\d+(?:\.\d+)?/g;
function modShape(text: string): { template: string; values: number[] } {
  const normalized = folded(text);
  return { template: normalized.replace(numericPattern, "#").replace(/\+#/g, "#"), values: [...normalized.matchAll(numericPattern)].map(match => Number(match[0])) };
}
function catalogTemplate(text: string): string { return folded(text).replace(/\+#/g, "#"); }
function modKind(mod: ParsedItem["mods"][number]): string {
  return mod.implicit ? "implicit" : mod.kind && mod.kind !== "unknown" ? mod.kind : "explicit";
}
function tradeModTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => { const text = typeof entry === "string" ? entry : record(entry).description; return typeof text === "string" ? [text] : []; });
}

/** Explicit expiry can shorten the normal quote lifetime, never extend it. */
export function stashQuoteFresh(quote: Pick<StashMarketQuote, "fetchedAt" | "validUntil">, now: number): boolean {
  const fetched = Date.parse(quote.fetchedAt);
  const expires = Math.min(fetched + STASH_QUOTE_TTL_MS, quote.validUntil === undefined ? Infinity : Date.parse(quote.validUntil));
  return Number.isFinite(fetched) && Number.isFinite(expires) && now >= fetched && now < expires;
}

/** Advanced copy text names the actual prefix/suffix; remove those exact names. */
export function stashMarketBaseType(parsed: ParsedItem): string | undefined {
  if (!/^magic$/i.test(parsed.rarity) || parsed.baseType !== parsed.name) return parsed.baseType;
  const annotationNames = (kind: "Prefix" | "Suffix"): string[] => [...new Set([...parsed.rawText.matchAll(new RegExp(`^\\s*\\{\\s*${kind} Modifier\\s+["“]([^"”]+)["”]`, "gim"))].map(match => match[1]!.trim()))];
  const prefixes = annotationNames("Prefix"), suffixes = annotationNames("Suffix");
  if (prefixes.length > 1 || suffixes.length > 1) return undefined;
  if (prefixes.length || suffixes.length) {
    let base = parsed.name.trim();
    const prefix = prefixes[0], suffix = suffixes[0];
    if (prefix) {
      if (!base.toLowerCase().startsWith(`${prefix.toLowerCase()} `)) return undefined;
      base = base.slice(prefix.length).trim();
    }
    if (suffix) {
      if (!base.toLowerCase().endsWith(` ${suffix.toLowerCase()}`)) return undefined;
      base = base.slice(0, -suffix.length).trim();
    }
    return base || undefined;
  }
  return magicBaseType(parsed.name);
}

export function parseStashTradeStats(payload: unknown): StashTradeStat[] {
  const groups = record(payload).result;
  if (!Array.isArray(groups)) return [];
  return groups.flatMap(group => {
    const entries = record(group).entries;
    return Array.isArray(entries) ? entries.flatMap(raw => {
      const entry = record(raw);
      return typeof entry.id === "string" && /^[a-z]+\.stat_\d+$/.test(entry.id) && typeof entry.text === "string" && entry.text.length <= 1000
        ? [{ id: entry.id, text: entry.text }] : [];
    }) : [];
  });
}

/** Unhandled variants remain unpriced instead of receiving a base-type floor. */
export function stashUnsupportedReason(parsed: ParsedItem): string | undefined {
  if (!parsed.identified) return "Identify the item before a roll-specific market comparison.";
  if (parsed.sockets) return "Socketed item variants require manual market review until their socket effects can be compared exactly.";
  if (/^\s*(?:Mirrored|Sanctified|Twice\s+Corrupted|Unrevealed|Desecrated|Mutated)\b/im.test(parsed.rawText)) return "This special item variant needs manual market review.";
  if (!/^(normal|magic|rare|unique|currency|gem)$/i.test(parsed.rarity)) return "This item rarity is not supported by strict market matching.";
  if (/waystone|tablet|logbook|relic|barya|ultimatum/i.test(parsed.itemClass)) return "This endgame item has variant properties requiring manual market review.";
  if (!stashMarketBaseType(parsed) || parsed.baseType === "Unknown") return "The item has no exact searchable base type.";
  return undefined;
}

export function buildStashTradeQuery(parsed: ParsedItem, stats: StashTradeStat[], allowConvertedPrices = false): StashTradeQuery {
  const baseType = stashMarketBaseType(parsed) ?? "";
  const rarity = parsed.rarity.toLowerCase();
  const typeFilters: Record<string, unknown> = {};
  if (["normal", "magic", "rare", "unique"].includes(rarity)) typeFilters.rarity = { option: rarity };
  if (parsed.itemLevel !== undefined) typeFilters.ilvl = { min: parsed.itemLevel, max: parsed.itemLevel + 5 };
  if (rarity !== "currency") typeFilters.quality = { min: parsed.quality ?? 0, max: parsed.quality ?? 0 };
  const misc: Record<string, unknown> = { corrupted: { option: String(parsed.corrupted) }, identified: { option: "true" }, mirrored: { option: "false" }, sanctified: { option: "false" } };
  const level = parsed.properties.find(property => /^level$/i.test(property.name))?.rolls?.[0]?.value;
  if (rarity === "gem" && level !== undefined) misc.gem_level = { min: level, max: level };
  const filters = parsed.mods.flatMap(mod => {
    const shape = modShape(mod.text);
    const candidates = stats.filter(stat => stat.id.startsWith(`${modKind(mod)}.`) && catalogTemplate(stat.text) === shape.template);
    if (candidates.length !== 1) return [];
    const average = shape.values.reduce((sum, value) => sum + value, 0) / shape.values.length;
    const margin = Math.abs(average) * 0.15;
    return [{ id: candidates[0]!.id, ...(shape.values.length ? { value: { min: average - margin, max: average + margin } } : {}) }];
  });
  const query: Record<string, unknown> = {
    status: { option: "online" }, type: baseType,
    filters: { type_filters: { filters: typeFilters }, ...(rarity === "currency" ? {} : { misc_filters: { filters: misc } }), trade_filters: { filters: { ...(allowConvertedPrices ? {} : { price: { option: "chaos" } }), collapse: { option: "true" } } } },
    ...(filters.length ? { stats: [{ type: "and", filters }] } : {}),
  };
  if (rarity === "unique") query.name = parsed.name;
  return { baseType, body: { query, sort: { price: "asc" } }, reasons: [
    `${filters.length}/${parsed.mods.length} modifier lines constrained by the current trade stat catalog; all returned modifiers are checked locally.`,
    allowConvertedPrices ? "Live asking prices are converted with a fresh currency snapshot for this league. Asking prices are estimates, not completed sales." : "Only native chaos asking prices are sampled; exalted/divine listings are excluded. Asking prices are estimates, not completed sales.",
  ] };
}

function sameMods(ours: string[], theirs: string[]): boolean {
  if (ours.length !== theirs.length) return false;
  const remaining = theirs.map(modShape);
  for (const text of ours) {
    const expected = modShape(text);
    const index = remaining.findIndex(actual => actual.template === expected.template && actual.values.length === expected.values.length && actual.values.every((value, i) => Math.abs(value - expected.values[i]!) <= Math.abs(expected.values[i]!) * 0.15 + 0.00001));
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return true;
}

/** Reject mismatched states, rolls, affix counts and duplicate sellers before estimating. */
export function summarizeStashListings(parsed: ParsedItem, payload: unknown, context: { league: string; fetchedAt: string; query: StashTradeQuery; tradeUrl: string; rates?: StashCurrencyRates }): StashMarketQuote {
  const rows = record(payload).result;
  const candidates = Array.isArray(rows) ? rows.slice(0, 100) : [];
  const prices: number[] = [], ids = new Set<string>(), sellers = new Set<string>();
  const nativeCurrencies = new Map<string, number>();
  const fetchedAt = Date.parse(context.fetchedAt);
  const ratesAt = context.rates ? Date.parse(context.rates.fetchedAt) : Number.NaN;
  const ratesExpiry = Math.min(ratesAt + STASH_RATE_TTL_MS, context.rates?.validUntil === undefined ? Infinity : Date.parse(context.rates.validUntil));
  const rates = context.rates?.league === context.league && fetchedAt >= ratesAt && fetchedAt < ratesExpiry ? context.rates : undefined;
  const expectedFrame: Record<string, number> = { normal: 0, magic: 1, rare: 2, unique: 3, gem: 4, currency: 5 };
  for (const raw of candidates) {
    const row = record(raw), item = record(row.item), listing = record(row.listing), price = record(listing.price);
    if (item.league !== undefined && item.league !== context.league) continue;
    if (typeof row.id !== "string" || ids.has(row.id) || typeof price.currency !== "string" || !positive(price.amount)) continue;
    const rate = price.currency === "chaos" ? 1 : rates?.chaosPerCurrency[price.currency];
    if (!positive(rate) || !positive(price.amount * rate)) continue;
    const seller = record(listing.account).name;
    if (typeof seller !== "string" || !seller.trim() || sellers.has(seller.trim().toLowerCase())) continue;
    const type = item.baseType ?? item.typeLine;
    if (typeof type !== "string" || folded(type) !== folded(context.query.baseType)) continue;
    if (item.frameType !== expectedFrame[parsed.rarity.toLowerCase()] && (typeof item.rarity !== "string" || item.rarity.toLowerCase() !== parsed.rarity.toLowerCase())) continue;
    if (/^unique$/i.test(parsed.rarity) && (typeof item.name !== "string" || folded(item.name) !== folded(parsed.name))) continue;
    if (item.identified === false || Boolean(item.corrupted) !== parsed.corrupted || item.mirrored || item.sanctified || item.twiceCorrupted || item.veiled || item.desecrated || item.mutated) continue;
    if (parsed.itemLevel !== undefined && (typeof item.ilvl !== "number" || item.ilvl < parsed.itemLevel || item.ilvl > parsed.itemLevel + 5)) continue;
    const listingProperties = Array.isArray(item.properties) ? item.properties.map(record) : [];
    const propertyValue = (name: string): number | undefined => {
      const entry = listingProperties.find(property => typeof property.name === "string" && folded(property.name) === name);
      const values = entry?.values;
      const text = Array.isArray(values) && Array.isArray(values[0]) ? values[0][0] : undefined;
      return typeof text === "string" ? Number(text.match(/[+-]?\d+(?:\.\d+)?/)?.[0]) : undefined;
    };
    // Missing source socket metadata cannot be priced from a premium socketed
    // variant. Reject both sockets and socketed contents until exact support exists.
    if ([item.sockets, item.socketedItems].some(value => value !== undefined && (!Array.isArray(value) || value.length > 0)) ||
      listingProperties.some(property => typeof property.name === "string" && /^(?:gem )?sockets$/i.test(folded(property.name)) && propertyValue(folded(property.name)) !== 0)) continue;
    if ((propertyValue("quality") ?? 0) !== (parsed.quality ?? 0)) continue;
    const materialProperties = parsed.properties.filter(property => /^(?:armour|evasion rating|energy shield|physical damage|elemental damage|attacks per second|critical hit chance|block chance)$/i.test(property.name));
    if (materialProperties.some(property => {
      const actual = listingProperties.find(entry => typeof entry.name === "string" && folded(entry.name) === folded(property.name));
      const values = actual?.values;
      const text = Array.isArray(values) ? values.flatMap(value => Array.isArray(value) && typeof value[0] === "string" ? [value[0]] : []).join(" ") : "";
      // Damage intervals use a dash separator; it is not a negative roll.
      const actualRolls = (text.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
      const expectedRolls = (property.rolls ?? []).map(roll => Math.abs(roll.value));
      return actualRolls.length !== expectedRolls.length || actualRolls.some((value, i) => Math.abs(value - expectedRolls[i]!) > expectedRolls[i]! * 0.15 + 0.00001);
    })) continue;
    if (/^gem$/i.test(parsed.rarity)) {
      const expectedLevel = parsed.properties.find(property => /^level$/i.test(property.name))?.rolls?.[0]?.value;
      if (expectedLevel === undefined || propertyValue("level") !== expectedLevel || parsed.sockets) continue;
    }
    // Socket/augment effects and defensive/weapon properties must not hide differences.
    if (parsed.sockets || tradeModTexts(item.runeMods).length || tradeModTexts(item.enchantMods).length) continue;
    const fields: Record<string, string> = { explicit: "explicitMods", implicit: "implicitMods", fractured: "fracturedMods", crafted: "craftedMods", enchant: "enchantMods" };
    if (Object.entries(fields).some(([kind, field]) => !sameMods(parsed.mods.filter(mod => modKind(mod) === kind).map(mod => mod.text), tradeModTexts(item[field])))) continue;
    ids.add(row.id); sellers.add(seller.trim().toLowerCase()); prices.push(price.amount * rate);
    nativeCurrencies.set(price.currency, (nativeCurrencies.get(price.currency) ?? 0) + 1);
  }
  prices.sort((a, b) => a - b);
  const usesConversion = [...nativeCurrencies.keys()].some(currency => currency !== "chaos");
  const expires = Math.min(fetchedAt + STASH_QUOTE_TTL_MS, usesConversion && rates ? ratesExpiry : Infinity);
  const validUntil = Number.isFinite(expires) ? new Date(expires).toISOString() : context.fetchedAt;
  const quote: StashMarketQuote = { state: prices.length ? "priced" : "no-comparables", league: context.league, provider: "pathofexile-trade2", fetchedAt: context.fetchedAt, validUntil, currency: "chaos", sampleSize: prices.length, candidateCount: candidates.length, confidence: prices.length >= 5 ? 80 : prices.length >= 3 ? 65 : prices.length ? 35 : 0, reasons: [...context.query.reasons, "Comparables require the same base, rarity, quality and corruption, every modifier family, affix count, and rolls within 15%."], tradeUrl: context.tradeUrl };
  if (!prices.length) { quote.reasons.push("No independently offered listings matched the item closely enough. This does not mean the item is worthless."); return quote; }
  quote.reasons.push(`Observed asking currencies: ${[...nativeCurrencies].map(([currency, count]) => `${currency} (${count})`).join(", ")}.`);
  if (usesConversion && rates) quote.reasons.push(`Currency conversion: poe.ninja · ${rates.league} · ${rates.fetchedAt}; ${Object.entries(rates.chaosPerCurrency).map(([currency, rate]) => `1 ${currency} = ${rate} chaos`).join("; ")}.`);
  const stack = parsed.properties.find(property => /^stack size$/i.test(property.name))?.rolls?.[0]?.value;
  const count = /^currency$/i.test(parsed.rarity) && positive(stack) ? Math.floor(stack) : 1;
  const percentile = (p: number): number => Math.round(prices[Math.floor((prices.length - 1) * p)]! * count * 10000) / 10000;
  quote.low = percentile(0.1); quote.fair = percentile(0.5); quote.high = percentile(0.9);
  if (count > 1) quote.reasons.push(`Whole stack estimate: ${count} × unit asking price.`);
  if (prices.length < 3) quote.reasons.push("Fewer than three independent sellers: low-confidence comparison.");
  if (prices.at(-1)! / prices[0]! > 3) { quote.confidence = Math.min(quote.confidence, 40); quote.reasons.push("Wide asking-price dispersion; review before treating the estimate as market value."); }
  return quote;
}
