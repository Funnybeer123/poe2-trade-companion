import { describe, expect, it } from "vitest";
import { parseItemText } from "../src/core/parseItem.js";
import { buildStashTradeQuery, parseStashTradeStats, stashUnsupportedReason, stashQuoteFresh, stashMarketBaseType, summarizeStashListings } from "../src/core/stashMarket.js";

const TEXT = "Item Class: Rings\nRarity: Rare\nDoom Loop\nRuby Ring\n--------\nItem Level: 81\n--------\n+120 to maximum Life\n+38% to Fire Resistance";
const parsed = parseItemText(TEXT);
const stats = parseStashTradeStats({ result: [{ entries: [{ id: "explicit.stat_3299347043", text: "# to maximum Life" }, { id: "explicit.stat_3372524247", text: "#% to Fire Resistance" }] }] });
const query = buildStashTradeQuery(parsed, stats);
const context = { league: "Forbidden Rites", fetchedAt: "2026-09-14T12:00:00.000Z", query, tradeUrl: "https://www.pathofexile.com/trade2/search/poe2/Forbidden%20Rites" };
function listing(n: number, price = n + 2) {
  return { id: String(n), item: { baseType: "Ruby Ring", rarity: "Rare", ilvl: 81, explicitMods: [{ description: "+118 to maximum Life" }, { description: "+36% to [Resistances|Fire Resistance]" }] }, listing: { price: { amount: price, currency: "chaos" }, account: { name: `seller-${n}` } } };
}

describe("strict stash market matching", () => {
  it("resolves one-word and multiword magic bases from exact advanced affix annotations", () => {
    const jewel = parseItemText('Item Class: Jewels\nRarity: Magic\nOvergrown Sapphire of Infusion\n--------\nItem Level: 73\n--------\n{ Prefix Modifier "Overgrown" (Tier: 1) — Damage }\n14(5-15)% increased Damage with Plant Skills\n{ Suffix Modifier "of Infusion" (Tier: 1) — Life }\n3(2-3)% of Damage taken Recouped as Life');
    expect(stashMarketBaseType(jewel)).toBe("Sapphire");
    expect(buildStashTradeQuery(jewel, []).body).toMatchObject({ query: { type: "Sapphire" } });
    const amulet = parseItemText('Item Class: Amulets\nRarity: Magic\nButtressed Lunar Amulet of the Sage\n--------\n{ Prefix Modifier "Buttressed" (Tier: 4) — Armour }\n31% increased Armour\n{ Suffix Modifier "of the Sage" (Tier: 3) — Attribute }\n+26 to Intelligence');
    expect(stashMarketBaseType(amulet)).toBe("Lunar Amulet");
  });
  it("does not guess when advanced affix names contradict the copied item header", () => {
    const item = parseItemText('Item Class: Jewels\nRarity: Magic\nOvergrown Sapphire\n--------\n{ Prefix Modifier "Other Prefix" (Tier: 1) }\n14% increased Damage with Plant Skills');
    expect(stashMarketBaseType(item)).toBeUndefined();
    expect(stashUnsupportedReason(item)).toMatch(/no exact searchable/);
  });
  it.each(["  Mirrored", "\tTwice   Corrupted", "  Sanctified"])("recognizes whitespace-prefixed special status %s", status => {
    expect(stashUnsupportedReason(parseItemText(`${TEXT}\n--------\n${status}`))).toMatch(/special item variant/);
  });
  it("uses current stat IDs, close rolls, exact rarity and native chaos currency", () => {
    expect(query.body).toMatchObject({ query: { type: "Ruby Ring", filters: { type_filters: { filters: { rarity: { option: "rare" }, ilvl: { min: 81, max: 86 } } }, trade_filters: { filters: { price: { option: "chaos" } } } }, stats: [{ type: "and", filters: [{ id: "explicit.stat_3299347043", value: { min: 102, max: 138 } }, { id: "explicit.stat_3372524247" }] }] } });
  });
  it("prices actual matching offers and records independent sample size", () => {
    const result = summarizeStashListings(parsed, { result: [listing(1), listing(2), listing(3)] }, context);
    expect(result).toMatchObject({ state: "priced", currency: "chaos", league: "Forbidden Rites", low: 3, fair: 4, sampleSize: 3, candidateCount: 3, confidence: 65 });
  });
  it("rejects low rolls even when the modifier families match", () => {
    const row = listing(1); row.item.explicitMods[0]!.description = "+30 to maximum Life";
    expect(summarizeStashListings(parsed, { result: [row] }, context).state).toBe("no-comparables");
  });
  it.each([
    ["wrong base", { baseType: "Gold Ring" }], ["wrong rarity", { rarity: "Magic" }], ["corrupted", { corrupted: true }],
    ["wrong league", { league: "Standard" }],
    ["mirrored", { mirrored: true }], ["wrong item level", { ilvl: 65 }], ["extra affix", { explicitMods: ["+120 to maximum Life", "+38% to Fire Resistance", "+30 to maximum Mana"] }],
    ["different quality", { properties: [{ name: "Quality", values: [["+20%", 1]] }] }],
  ])("rejects %s", (_label, different) => {
    const row = listing(1);
    expect(summarizeStashListings(parsed, { result: [{ ...row, item: { ...row.item, ...different } }] }, context).sampleSize).toBe(0);
  });
  it("never converts divine or exalted listings using starter or fallback rates", () => {
    const row = listing(1); row.listing.price.currency = "divine";
    const quote = summarizeStashListings(parsed, { result: [row] }, context);
    expect(quote.state).toBe("no-comparables");
    expect(quote.fair).toBeUndefined();
  });
  it("uses only fresh same-league verified currency rates", () => {
    const row = listing(1, 20); row.listing.price.currency = "exalted";
    const rates = { league: "Forbidden Rites", fetchedAt: context.fetchedAt, chaosPerCurrency: { exalted: 0.2 } };
    expect(summarizeStashListings(parsed, { result: [row] }, { ...context, rates }).fair).toBe(4);
    expect(summarizeStashListings(parsed, { result: [row] }, { ...context, rates: { ...rates, league: "Standard" } }).state).toBe("no-comparables");
    expect(summarizeStashListings(parsed, { result: [row] }, { ...context, rates: { ...rates, fetchedAt: "2026-09-14T11:20:00Z" } }).state).toBe("no-comparables");
  });
  it("sets structured quote expiry to the earlier listing or conversion deadline", () => {
    const row = listing(1, 20); row.listing.price.currency = "exalted";
    const rates = { league: context.league, fetchedAt: "2026-09-14T11:40:00Z", chaosPerCurrency: { exalted: 0.2 } };
    const quote = summarizeStashListings(parsed, { result: [row] }, { ...context, rates });
    expect(quote.validUntil).toBe("2026-09-14T12:10:00.000Z");
    const earlier = summarizeStashListings(parsed, { result: [row] }, { ...context, rates: { ...rates, validUntil: "2026-09-14T12:02:00Z" } });
    expect(earlier.validUntil).toBe("2026-09-14T12:02:00.000Z");
    expect(summarizeStashListings(parsed, { result: [listing(1)] }, { ...context, rates }).validUntil).toBe("2026-09-14T12:15:00.000Z");
    expect(summarizeStashListings(parsed, { result: [row] }, { ...context, rates: { ...rates, validUntil: context.fetchedAt } }).state).toBe("no-comparables");
  });
  it("enforces quote expiry boundaries while retaining legacy quote compatibility", () => {
    const legacy = { fetchedAt: context.fetchedAt };
    expect(stashQuoteFresh(legacy, Date.parse("2026-09-14T12:14:59Z"))).toBe(true);
    expect(stashQuoteFresh(legacy, Date.parse("2026-09-14T12:15:00Z"))).toBe(false);
    const expiring = { ...legacy, validUntil: "2026-09-14T12:02:00Z" };
    expect(stashQuoteFresh(expiring, Date.parse("2026-09-14T12:02:00Z"))).toBe(false);
    expect(stashQuoteFresh({ ...legacy, validUntil: "2026-09-14T13:00:00Z" }, Date.parse("2026-09-14T12:16:00Z"))).toBe(false);
    expect(stashQuoteFresh({ ...legacy, validUntil: "invalid" }, Date.parse(context.fetchedAt))).toBe(false);
    expect(stashQuoteFresh(legacy, Date.parse("2026-09-14T11:59:59Z"))).toBe(false);
  });
  it("rejects premium socketed listing variants when source socket metadata is absent", () => {
    const gem = parseItemText("Item Class: Skill Gems\nRarity: Gem\nFireball\n--------\nLevel: 20");
    const gemContext = { ...context, query: buildStashTradeQuery(gem, []) };
    const row = { id: "gem", item: { baseType: "Fireball", rarity: "Gem", properties: [{ name: "Level", values: [["20", 0]] }] }, listing: { account: { name: "seller" }, price: { amount: 5, currency: "chaos" } } };
    expect(summarizeStashListings(gem, { result: [row] }, gemContext).state).toBe("priced");
    for (const variant of [{ sockets: [{ group: 0 }] }, { socketedItems: [{ name: "Support" }] }, { sockets: "unreadable" }, { properties: [...row.item.properties, { name: "Gem Sockets", values: [["5", 0]] }] }]) {
      expect(summarizeStashListings(gem, { result: [{ ...row, item: { ...row.item, ...variant } }] }, gemContext).state).toBe("no-comparables");
    }
    expect(summarizeStashListings(gem, { result: [{ ...row, item: { ...row.item, sockets: [], socketedItems: [] } }] }, gemContext).state).toBe("priced");
  });
  it("deduplicates sellers and keeps tiny samples low-confidence", () => {
    const one = listing(1), two = listing(2); two.listing.account.name = one.listing.account.name;
    expect(summarizeStashListings(parsed, { result: [one, two, one] }, context)).toMatchObject({ sampleSize: 1, confidence: 35 });
  });
  it("does not turn extreme price dispersion into high confidence", () => {
    expect(summarizeStashListings(parsed, { result: [listing(1, 1), listing(2, 2), listing(3, 80)] }, context).confidence).toBe(40);
  });
  it("rejects materially different weapon properties despite matching modifier text", () => {
    const weapon = parseItemText("Item Class: Bows\nRarity: Rare\nDoom String\nCrude Bow\n--------\nPhysical Damage: 100-200\nAttacks per Second: 1.5\n--------\nItem Level: 81\n--------\n100% increased Physical Damage");
    const weaponQuery = buildStashTradeQuery(weapon, []);
    const row = { id: "weapon", item: { baseType: "Crude Bow", frameType: 2, ilvl: 81, explicitMods: ["100% increased Physical Damage"], properties: [{ name: "Physical Damage", values: [["20-40", 0]] }, { name: "Attacks per Second", values: [["1.5", 0]] }] }, listing: { account: { name: "seller" }, price: { amount: 2, currency: "chaos" } } };
    expect(summarizeStashListings(weapon, { result: [row] }, { ...context, query: weaponQuery }).state).toBe("no-comparables");
  });
  it("keeps special and unidentified variants unpriced", () => {
    expect(stashUnsupportedReason(parseItemText(`${TEXT}\n--------\nUnidentified`))).toMatch(/Identify/);
    expect(stashUnsupportedReason(parseItemText(`${TEXT}\n--------\nMirrored`))).toMatch(/special/);
    expect(stashUnsupportedReason(parseItemText(`${TEXT}\n--------\nSockets: S S`))).toMatch(/Socketed/);
  });
  it("values the whole currency stack from native chaos offers", () => {
    const currency = parseItemText("Item Class: Stackable Currency\nRarity: Currency\nExalted Orb\n--------\nStack Size: 10/20");
    const q = buildStashTradeQuery(currency, []);
    const rows = [1, 2, 3].map(id => ({ id: String(id), item: { baseType: "Exalted Orb", frameType: 5 }, listing: { account: { name: `seller-${id}` }, price: { amount: 0.2, currency: "chaos" } } }));
    expect(summarizeStashListings(currency, { result: rows }, { ...context, query: q })).toMatchObject({ state: "priced", fair: 2, sampleSize: 3 });
  });
});
