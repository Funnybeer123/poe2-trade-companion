import { describe, expect, it } from "vitest";
import { buildRewardTradeQuery, buildRewardTradeUrl, identifyHelperReward, parseRewardCatalog, parseRewardListingPrices, type RewardIdentity } from "../src/core/helperReward.js";

const skills = ["Rain of Blades", "Wardbound Minions", "Voltaic Barrier", "Hollow Shell", "Explosive Transmutation", "Animus Splinters"];
const catalog = parseRewardCatalog({ result: [
  { id: "gem", entries: skills.map(type => ({ type })) },
  { id: "currency", entries: [{ type: "Mystic Alloy" }, { type: "Masterwork Rune" }] },
  { id: "armour", entries: [{ type: "Leather Belt", name: "Headhunter", flags: { unique: true } }] },
] });
const gem: RewardIdentity = { name: "Rain of Blades", type: "Rain of Blades", kind: "gem", gemLevel: 20, quantity: 1 };
const listing = (amount: unknown = 3, currency: unknown = "chaos", gemLevel: unknown = "20 (Max)") => ({
  item: { name: "", typeLine: "Rain of Blades", baseType: "Rain of Blades", properties: [{ name: "Level", values: [[gemLevel, 0]] }] },
  listing: { price: { amount, currency } },
});

describe("helper reward identities", () => {
  it("parses official groups, retains unique bases and ignores malformed or discriminator-only variants", () => {
    expect(parseRewardCatalog({ result: [{ id: "gem", entries: [
      { type: "Rain of Blades" }, { type: "Rain of Blades" }, { type: 3 }, { type: "Bad\nName" }, { type: "Legacy Gem", disc: "legacy" },
    ] }, { id: "weapon", entries: [{ type: "Glass Shank", name: "Winter's Bite", flags: { unique: true } }, { type: "Glass Shank", flags: { unique: true } }] }] })).toEqual([
      { name: "Rain of Blades", type: "Rain of Blades", kind: "gem" }, { name: "Winter's Bite", type: "Glass Shank", kind: "unique" },
    ]);
    expect(parseRewardCatalog(null)).toEqual([]);
    expect(parseRewardCatalog({ result: [{ entries: Array(20001).fill({ type: "A Rune" }) }] })).toEqual([]);
  });
  it.each(skills)("recognizes the screenshot's exact level-20 %s", name => {
    expect(identifyHelperReward(`Skill Level 20: ${name}`, catalog)).toEqual({ name, type: name, kind: "gem", gemLevel: 20, quantity: 1 });
  });
  it.each(["0", "41", "2O", "O", "020", "20.5", "-20", "20 (Max)"])("does not guess skill level %s", value => {
    expect(identifyHelperReward(`Skill Level ${value}: Rain of Blades`, catalog)).toBeUndefined();
  });
  it("accepts only levels 1 through 40 and requires a gem identity", () => {
    expect(identifyHelperReward("Skill Level 1: Rain of Blades", catalog)?.gemLevel).toBe(1);
    expect(identifyHelperReward("Skill Level 40: Rain of Blades", catalog)?.gemLevel).toBe(40);
    expect(identifyHelperReward("Skill Level 20: Mystic Alloy", catalog)).toBeUndefined();
    expect(identifyHelperReward("Skill Level 20: Rain of Blades Extra", catalog)).toBeUndefined();
    expect(identifyHelperReward("Skill Level 20: Rain-of-Blades", catalog)).toBeUndefined();
    const uncut = { name: "Uncut Skill Gem (Level 19)", type: "Uncut Skill Gem (Level 19)", kind: "gem" as const };
    expect(identifyHelperReward("Skill Level 20: Uncut Skill Gem (Level 19)", [uncut])).toBeUndefined();
  });
  it.each(["3x Mystic Alloy", "Mystic Alloy x3", "Mystic Alloy (3)"])("retains a verified stack from %s", text => {
    expect(identifyHelperReward(text, catalog)).toEqual({ name: "Mystic Alloy", type: "Mystic Alloy", kind: "item", quantity: 3 });
  });
  it.each(["IX Mystic Alloy", "-lx Masterwork Rune", "– lX Mystic Alloy", "—I× Masterwork Rune"])("never guesses the quantity in %s", text => {
    const reward = identifyHelperReward(text, catalog);
    expect(reward?.quantityUncertain).toBe(true); expect(reward?.quantity).toBeUndefined();
  });
  it.each(["2x Mystic Alloy x3", "IX Mystic Alloy (2)", "IX 2x Mystic Alloy", "--lx Mystic Alloy", "0x Mystic Alloy", "Ox Mystic Alloy", "?x Mystic Alloy", "Unknown Rune", "Mystic Alloy?", "Mystic\nAlloy"])("rejects ambiguous or unmatched reward %s", text => {
    expect(identifyHelperReward(text, catalog)).toBeUndefined();
  });
  it("does not select an arbitrary base for a unique name shared by multiple entries", () => {
    const entries = [...catalog, { name: "Headhunter", type: "Runeforged Leather Belt", kind: "unique" as const }];
    expect(identifyHelperReward("Headhunter", entries)).toBeUndefined();
    expect(identifyHelperReward("Headhunter Leather Belt", entries)).toEqual({ name: "Headhunter", type: "Leather Belt", kind: "unique", quantity: 1 });
  });
});

describe("helper reward trade queries", () => {
  it("specifies the exact gem level without inventing quality, corruption or sockets", () => {
    expect(buildRewardTradeQuery(gem)).toEqual({ query: { status: { option: "online" }, type: "Rain of Blades", filters: { misc_filters: { filters: { gem_level: { min: 20, max: 20 } } } } }, sort: { price: "asc" } });
    expect(buildRewardTradeQuery({ name: "Headhunter", type: "Leather Belt", kind: "unique" })).toEqual({ query: { status: { option: "online" }, name: "Headhunter", type: "Leather Belt" }, sort: { price: "asc" } });
    expect(buildRewardTradeQuery(identifyHelperReward("IX Mystic Alloy", catalog)!)).toEqual({ query: { status: { option: "online" }, type: "Mystic Alloy" }, sort: { price: "asc" } });
  });
  it("recognizes unknown-level gems but refuses a cross-level price query", () => {
    const reward = identifyHelperReward("Rain of Blades", catalog);
    expect(reward).toMatchObject({ name: "Rain of Blades", kind: "gem" });
    expect(buildRewardTradeQuery(reward!)).toBeUndefined();
    expect(buildRewardTradeUrl(reward!, "Runes of Aldur")).toBeUndefined();
  });
  it("constructs a fixed official HTTPS URL with an encoded query and league", () => {
    const url = new URL(buildRewardTradeUrl(gem, "HC Runes of Aldur")!);
    expect(url.origin).toBe("https://www.pathofexile.com");
    expect(url.pathname).toBe("/trade2/search/poe2/HC%20Runes%20of%20Aldur");
    expect(JSON.parse(url.searchParams.get("q")!)).toEqual(buildRewardTradeQuery(gem));
    expect(url.hash).toBe(""); expect([...url.searchParams.keys()]).toEqual(["q"]);
  });
  it.each(["../evil", "Runes?redirect=https://evil.test", "Runes#fragment", "Runes\nInjected", "https://evil.test"])("rejects URL injection in league %s", league => {
    expect(buildRewardTradeUrl(gem, league)).toBeUndefined();
  });
  it.each([
    { ...gem, type: "https://evil.test" }, { ...gem, name: "Wrong Name" }, { ...gem, gemLevel: 41 },
    { ...gem, gemLevel: NaN }, { ...gem, quantity: 0 }, { ...gem, quantityUncertain: true },
    { ...gem, name: "Rain of Blades\nInjected" },
  ])("rejects malformed identity %#", identity => {
    expect(buildRewardTradeQuery(identity)).toBeUndefined();
    expect(buildRewardTradeUrl(identity, "Runes of Aldur")).toBeUndefined();
  });
});

describe("helper reward listing validation", () => {
  it("accepts exact-level mixed variants and returns only original unit asking prices", () => {
    const a = { ...listing(50, "exalted"), id: "a" };
    const b = { ...listing(1, "divine", "20"), id: "b", item: { ...listing().item, corrupted: true, sockets: [{ group: 0 }], properties: [...listing().item.properties, { name: "[Quality]", values: [["+20%", 1]] }] } };
    const c = listing(2.5, "chaos");
    expect(parseRewardListingPrices({ result: [a, b, c] }, { ...gem, quantity: 3 })).toEqual([
      { amount: 50, currency: "exalted" }, { amount: 1, currency: "divine" }, { amount: 2.5, currency: "chaos" },
    ]);
  });
  it.each(["19 (Max)", "21", "2O", 20, "20 (+1)", "20 (Max) Extra", "020", "40 (Max)"])("rejects mismatched or ambiguous listing level %s", value => {
    expect(parseRewardListingPrices({ result: [listing(3, "chaos", value)] }, gem)).toEqual([]);
  });
  it("requires exactly one Level property rather than required level or arbitrary numbers", () => {
    const original = listing();
    for (const properties of [[], [{ name: "Required Level", values: [["20", 0]] }], [...original.item.properties, ...original.item.properties], [{ name: "Level", values: [["20", 0], ["21", 0]] }]]) {
      expect(parseRewardListingPrices({ result: [{ ...original, item: { ...original.item, properties } }] }, gem)).toEqual([]);
    }
  });
  it("checks exact item type and unique name, and cannot price an unknown-level gem", () => {
    const wrong = { ...listing(), item: { ...listing().item, baseType: "Wardbound Minions" } };
    expect(parseRewardListingPrices({ result: [wrong] }, gem)).toEqual([]);
    expect(parseRewardListingPrices({ result: [listing()] }, { ...gem, gemLevel: undefined })).toEqual([]);
    const unique: RewardIdentity = { name: "Headhunter", type: "Leather Belt", kind: "unique" };
    const good = { item: { name: "Headhunter", baseType: "Leather Belt" }, listing: { price: { amount: 4, currency: "divine" } } };
    expect(parseRewardListingPrices({ result: [good, { ...good, item: { ...good.item, name: "Wrong Unique" } }] }, unique)).toEqual([{ amount: 4, currency: "divine" }]);
  });
  it.each([0, -1, NaN, Infinity, "3", 1e13])("rejects invalid price amount %s", amount => {
    expect(parseRewardListingPrices({ result: [listing(amount)] }, gem)).toEqual([]);
  });
  it.each(["gold", "usd", "div", "Chaos", undefined, { toString: () => "chaos" }])("rejects unsupported currency %#", currency => {
    const entry = listing(); entry.listing.price.currency = currency;
    expect(parseRewardListingPrices({ result: [entry] }, gem)).toEqual([]);
  });
  it("deduplicates listing and seller identities without returning personal data, capped at ten", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({ ...listing(i + 1), id: `listing-${i}`, listing: { ...listing(i + 1).listing, account: { name: `Seller-${i}` } } }));
    entries[1]!.id = entries[0]!.id;
    entries[2]!.listing.account.name = "SELLER-0";
    const prices = parseRewardListingPrices({ result: entries }, gem);
    expect(prices).toHaveLength(10);
    expect(prices.map(price => price.amount)).toEqual([1, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(prices.every(price => Object.keys(price).sort().join(",") === "amount,currency")).toBe(true);
    expect(parseRewardListingPrices({ result: null }, gem)).toEqual([]);
  });
});
