import { parseHelperStack, record } from "./priceHelper.js";

export interface RewardCatalogEntry { name: string; type: string; kind: "item" | "gem" | "unique" }
export interface RewardIdentity extends RewardCatalogEntry { gemLevel?: number; quantity?: number; quantityUncertain?: boolean }
export interface RewardListingPrice { amount: number; currency: "chaos" | "divine" | "exalted" }

const unreadableMarker = /^(?:[-–—]\s*)?[lI][xX×]\s+/;
const quantityPrefix = /^\d{1,5}\s*[x×]\s*/i;
const quantitySuffix = /\s+(?:[x×]\s*\d{1,5}|\(\d{1,5}\))\s*$/i;
const key = (value: string): string => value.normalize("NFKC").replace(/’/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
function label(value: unknown): value is string {
  return typeof value === "string" && !/[\x00-\x1f\x7f]/.test(value) && /^[\p{L}\p{N}][\p{L}\p{N} '’(),.:–—-]{0,179}$/u.test(value.trim());
}
function level(value: unknown): value is number { return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 40; }
function validIdentity(value: RewardIdentity): boolean {
  return label(value.name) && label(value.type) && ["item", "gem", "unique"].includes(value.kind) &&
    (value.kind === "unique" || key(value.name) === key(value.type)) &&
    (value.gemLevel === undefined || value.kind === "gem" && level(value.gemLevel)) &&
    (value.quantity === undefined || Number.isInteger(value.quantity) && value.quantity >= 1 && value.quantity <= 99999) &&
    (value.quantityUncertain === undefined || typeof value.quantityUncertain === "boolean") &&
    !(value.quantityUncertain && value.quantity !== undefined);
}

/** Only explicit catalogue identities are retained; a discriminator cannot be silently discarded. */
export function parseRewardCatalog(payload: unknown): RewardCatalogEntry[] {
  const groups = record(payload).result;
  if (!Array.isArray(groups) || groups.length > 100) return [];
  const entries = new Map<string, RewardCatalogEntry>();
  let count = 0;
  for (const rawGroup of groups) {
    const group = record(rawGroup);
    if (!Array.isArray(group.entries)) continue;
    count += group.entries.length;
    if (count > 20000) return [];
    for (const raw of group.entries) {
      const item = record(raw);
      if (!label(item.type) || item.disc !== undefined) continue;
      const unique = record(item.flags).unique === true;
      if (unique && !label(item.name)) continue;
      const entry: RewardCatalogEntry = {
        name: unique ? (item.name as string).trim() : item.type.trim(),
        type: item.type.trim(), kind: unique ? "unique" : group.id === "gem" ? "gem" : "item",
      };
      entries.set(JSON.stringify([entry.kind, entry.name, entry.type]), entry);
    }
  }
  return [...entries.values()];
}

export function identifyHelperReward(text: string, catalog: RewardCatalogEntry[]): RewardIdentity | undefined {
  if (typeof text !== "string" || text.length > 300 || /[\x00-\x1f\x7f]/.test(text) || catalog.length > 20000) return undefined;
  const uncertain = unreadableMarker.test(text.trim());
  const clean = uncertain ? text.trim().replace(unreadableMarker, "") : text.trim();
  const stack = parseHelperStack(clean);
  if (!stack || uncertain && (quantityPrefix.test(clean) || quantitySuffix.test(clean))) return undefined;
  const rawName = clean.replace(quantityPrefix, "").replace(quantitySuffix, "").trim();
  const skill = rawName.match(/^Skill\s+Level\s+([1-9]\d?):\s*(.+)$/i);
  const gemLevel = skill ? Number(skill[1]) : undefined;
  if (skill && !level(gemLevel)) return undefined;
  const name = skill ? skill[2]! : rawName;
  if (!label(name)) return undefined;
  const matches = catalog.filter(entry => label(entry.name) && label(entry.type) &&
    (!skill || entry.kind === "gem") &&
    (key(entry.name) === key(name) || entry.kind === "unique" && key(`${entry.name} ${entry.type}`) === key(name)));
  if (matches.length !== 1) return undefined;
  const embeddedLevel = matches[0]!.type.match(/\(Level ([1-9]\d?)\)$/i);
  if (skill && embeddedLevel && Number(embeddedLevel[1]) !== gemLevel) return undefined;
  const identity: RewardIdentity = { ...matches[0]!, ...(gemLevel === undefined ? {} : { gemLevel }),
    ...(uncertain ? { quantityUncertain: true } : { quantity: stack.quantity }) };
  return validIdentity(identity) ? identity : undefined;
}

/** Gem variants stay unrestricted because reward text does not expose quality, corruption or sockets. */
export function buildRewardTradeQuery(identity: RewardIdentity): Record<string, unknown> | undefined {
  if (!validIdentity(identity) || identity.kind === "gem" && !level(identity.gemLevel)) return undefined;
  const query: Record<string, unknown> = { status: { option: "online" }, type: identity.type };
  if (identity.kind === "unique") query.name = identity.name;
  if (identity.kind === "gem") query.filters = { misc_filters: { filters: { gem_level: { min: identity.gemLevel, max: identity.gemLevel } } } };
  return { query, sort: { price: "asc" } };
}

export function buildRewardTradeUrl(identity: RewardIdentity, league: string): string | undefined {
  const query = buildRewardTradeQuery(identity);
  if (!query || typeof league !== "string" || !/^[\p{L}\p{N}][\p{L}\p{N} '()-]{0,79}$/u.test(league)) return undefined;
  return `https://www.pathofexile.com/trade2/search/poe2/${encodeURIComponent(league)}?q=${encodeURIComponent(JSON.stringify(query))}`;
}

function listingGemLevel(item: Record<string, unknown>): number | undefined {
  if (!Array.isArray(item.properties) || item.properties.length > 100) return undefined;
  const levels = item.properties.map(record).filter(property => property.name === "Level");
  if (levels.length !== 1) return undefined;
  const values = levels[0]!.values;
  if (!Array.isArray(values) || values.length !== 1 || !Array.isArray(values[0])) return undefined;
  const value = values[0][0];
  const match = typeof value === "string" && value.match(/^([1-9]\d?)(?: \(Max\))?$/);
  return match && level(Number(match[1])) ? Number(match[1]) : undefined;
}

/** Returns unit asking prices only; account information is used transiently for deduplication. */
export function parseRewardListingPrices(payload: unknown, identity: RewardIdentity): RewardListingPrice[] {
  const result = record(payload).result;
  if (!buildRewardTradeQuery(identity) || !Array.isArray(result)) return [];
  const prices: RewardListingPrice[] = [], ids = new Set<string>(), sellers = new Set<string>();
  for (const raw of result.slice(0, 100)) {
    const entry = record(raw), item = record(entry.item), listing = record(entry.listing), price = record(listing.price);
    const type = item.baseType ?? item.typeLine;
    if (!label(type) || key(type) !== key(identity.type)) continue;
    if (identity.kind === "unique" ? !label(item.name) || key(item.name) !== key(identity.name) : item.name !== undefined && item.name !== "") continue;
    if (identity.kind === "gem" && listingGemLevel(item) !== identity.gemLevel) continue;
    if (typeof price.amount !== "number" || !Number.isFinite(price.amount) || price.amount <= 0 || price.amount > 1e12 ||
      typeof price.currency !== "string" || !["chaos", "divine", "exalted"].includes(price.currency)) continue;
    const id = typeof entry.id === "string" && entry.id.length <= 200 ? entry.id : undefined;
    const sellerName = record(listing.account).name;
    const seller = typeof sellerName === "string" && sellerName.length <= 200 ? sellerName.trim().toLowerCase() : undefined;
    if (id && ids.has(id) || seller && sellers.has(seller)) continue;
    if (id) ids.add(id);
    if (seller) sellers.add(seller);
    prices.push({ amount: price.amount, currency: price.currency as RewardListingPrice["currency"] });
    if (prices.length === 10) break;
  }
  return prices;
}
