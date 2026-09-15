import { describe, expect, it } from "vitest";
import { PRICE_TABLE_SCHEMA_VERSION, type PriceTable } from "../src/core/priceTable.js";
import {
  currencyRateInExalted,
  describeListing,
  listingToNormalizedItem,
  normalizeTradeCurrency,
  parseExchangeResult,
  parseTradeListing,
  parseTradeListings,
  priceInExalted,
  priceNote,
  splitFractionalPrice,
} from "../src/core/tradeListings.js";

const TABLE: PriceTable = {
  schemaVersion: PRICE_TABLE_SCHEMA_VERSION,
  currency: "exalted",
  entries: [
    { id: "feed:poe2scout:divine", match: { name: "Divine Orb" }, value: 404.62 },
    { id: "feed:poe2scout:chaos", match: { name: "Chaos Orb" }, value: 35.91 },
    { id: "feed:poe2scout:mirror", match: { name: "Mirror of Kalandra" }, value: 120000 },
  ],
};

/** A fetch row in the live PoE2 shape (2026-09-07): tiered explicitMods, bracket markup, stash + whisper. */
const FETCH_JSON = {
  result: [
    {
      id: "aaa111",
      listing: {
        method: "psapi",
        indexed: "2026-09-07T10:00:00Z",
        stash: { name: "~price 1 exalted", x: 10, y: 3 },
        whisper: "@Seller Hi, I would like to buy your Doom Loop Ruby Ring listed for 3 exalted in Runes of Aldur (stash tab \"~price 1 exalted\"; position: left 11, top 4)",
        whisper_token: "tok-123",
        account: {
          name: "Seller",
          lastCharacterName: "SellerChar",
          online: { league: "Runes of Aldur", status: "afk" },
          language: "en_US",
          realm: "poe2",
        },
        price: { type: "~price", amount: 3, currency: "exalted" },
      },
      item: {
        realm: "poe2",
        verified: true,
        icon: "https://web.poecdn.com/gen/image/ring.png",
        league: "Runes of Aldur",
        name: "<<set:MS>><<set:M>><<set:S>>Doom Loop",
        typeLine: "Ruby Ring",
        baseType: "Ruby Ring",
        rarity: "Rare",
        ilvl: 81,
        identified: true,
        corrupted: true,
        fractured: true,
        properties: [{ name: "[Quality]", values: [["+20%", 1]], displayMode: 0, type: 6 }],
        requirements: [{ name: "Level", values: [["62", 0]], displayMode: 0 }, { name: "[Strength|Str]", values: [["64", 0]] }],
        sockets: [{ group: 0, type: "rune", item: "rune" }, { group: 1, type: "rune" }],
        implicitMods: ["+20% to [Resistances|Fire Resistance]"],
        explicitMods: [
          { description: "+110 to maximum Life", domain: "explicit", hash: "stat.explicit.stat_3299347043", mods: [{ name: "Robust", tier: "P2" }] },
          "+35% to [Resistances|Lightning Resistance]",
        ],
        enchantMods: ["Allocates [Passive]"],
        runeMods: ["+12% to [Resistances|Cold Resistance] (rune)"],
        desecratedMods: ["+31% to [Resistances|Chaos Resistance]"],
        fracturedMods: ["+15 to [Strength]"],
        extended: { dps: 0, pdps: 0, edps: 0, hashes: { explicit: [["explicit.stat_3299347043", [0]]] }, mods: { explicit: [] } },
      },
    },
    {
      id: "bbb222",
      listing: {
        indexed: "2026-09-07T09:00:00Z",
        account: { name: "Offline", online: null },
        price: { amount: 2, currency: "divine" },
      },
      item: { name: "", typeLine: "Ruby Ring", frameType: 2, identified: false },
    },
    {
      id: "ccc333",
      listing: {
        account: { name: "Merchant", online: { league: "Runes of Aldur" } },
        price: { type: "secure", amount: 5, currency: "chaos" },
        fee: 2,
      },
      item: {
        typeLine: "Widowhail",
        baseType: "Crude Bow",
        rarity: "Unique",
        properties: [{ name: "[Physical] Damage", values: [["5-9", 0]] }, { name: "Attacks per Second", values: [["1.20", 0]] }],
        extended: { dps: 8.4, pdps: 8.4, edps: 0 },
        stackSize: 1,
      },
    },
    {
      id: "ddd444",
      listing: { account: { name: "NoPrice" } },
      item: { typeLine: "Divine Orb", rarity: "Currency", stackSize: 12 },
    },
    { id: "", listing: {}, item: {} },
    "junk",
  ],
};

describe("parseTradeListings", () => {
  it("parses a realistic fetch payload: price, seller, whisper, stash, item fields, mods by kind", () => {
    const listings = parseTradeListings(FETCH_JSON, "Fallback League", { priceTable: TABLE });
    expect(listings.map((listing) => listing.id)).toEqual(["aaa111", "bbb222", "ccc333", "ddd444"]);

    const rich = listings[0]!;
    expect(rich.league).toBe("Runes of Aldur");
    expect(rich.price).toEqual({ amount: 3, currency: "exalted", type: "~price" });
    expect(rich.priceExalted).toBe(3);
    expect(rich.seller).toEqual({
      account: "Seller",
      character: "SellerChar",
      online: true,
      afk: true,
      hideout: false,
      league: "Runes of Aldur",
    });
    expect(rich.indexedAt).toBe("2026-09-07T10:00:00Z");
    expect(rich.whisper).toContain("@Seller Hi, I would like to buy your Doom Loop Ruby Ring");
    expect(rich.whisperToken).toBe("tok-123");
    expect(rich.listingType).toBe("whisper");
    expect(rich.secureFee).toBeUndefined();
    expect(rich.stash).toEqual({ tab: "~price 1 exalted", left: 10, top: 3 });
    expect(rich.raw).toBeUndefined();
    expect(rich.item).toEqual({
      name: "Doom Loop",
      typeLine: "Ruby Ring",
      baseType: "Ruby Ring",
      rarity: "Rare",
      itemLevel: 81,
      identified: true,
      corrupted: true,
      fractured: true,
      quality: 20,
      sockets: 2,
      runeSockets: 2,
      properties: [{ name: "Quality", values: ["+20%"] }],
      requirements: [
        { name: "Level", value: "62" },
        { name: "Str", value: "64" },
      ],
      implicitMods: ["+20% to Fire Resistance"],
      explicitMods: ["+110 to maximum Life", "+35% to Lightning Resistance"],
      enchantMods: ["Allocates Passive"],
      runeMods: ["+12% to Cold Resistance (rune)"],
      desecratedMods: ["+31% to Chaos Resistance"],
      fracturedMods: ["+15 to Strength"],
      extended: { dps: 0, pdps: 0, edps: 0, mods: { explicit: [] }, hashes: { explicit: [["explicit.stat_3299347043", [0]]] } },
      iconUrl: "https://web.poecdn.com/gen/image/ring.png",
    });

    const offline = listings[1]!;
    expect(offline.league).toBe("Fallback League");
    expect(offline.seller).toEqual({ account: "Offline", online: false });
    expect(offline.price).toEqual({ amount: 2, currency: "divine" });
    expect(offline.priceExalted).toBe(809.24);
    expect(offline.item.name).toBeUndefined();
    expect(offline.item.rarity).toBe("Rare"); // frameType 2
    expect(offline.item.identified).toBe(false);
    expect(offline.stash).toBeUndefined();

    const secure = listings[2]!;
    expect(secure.listingType).toBe("secure");
    expect(secure.secureFee).toBe(2);
    expect(secure.price).toEqual({ amount: 5, currency: "chaos", type: "secure" });
    expect(secure.priceExalted).toBe(179.55);
    expect(secure.seller).toEqual({ account: "Merchant", online: true, afk: false, hideout: false, league: "Runes of Aldur" });
    expect(secure.item.extended).toEqual({ dps: 8.4, pdps: 8.4, edps: 0 });
    expect(secure.item.properties).toEqual([
      { name: "Physical Damage", values: ["5-9"] },
      { name: "Attacks per Second", values: ["1.20"] },
    ]);
    expect(secure.item.stackSize).toBe(1);

    const unpriced = listings[3]!;
    expect(unpriced.price).toBeUndefined();
    expect(unpriced.priceExalted).toBeUndefined();
    expect(unpriced.seller).toEqual({ account: "NoPrice" });
    expect(unpriced.item.stackSize).toBe(12);
  });

  it("keeps the raw row on request and prices unknown currencies as undefined", () => {
    const listings = parseTradeListings(FETCH_JSON, "L", { keepRaw: true });
    expect(listings[0]!.raw).toBe(FETCH_JSON.result[0]);
    // No table: divine falls back to the crafting default; an unknown id has no rate.
    expect(listings[1]!.priceExalted).toBe(810);
    expect(currencyRateInExalted("mirror")).toBeUndefined();
    expect(currencyRateInExalted("mirror", TABLE)).toBe(120000);
    expect(currencyRateInExalted("exalted")).toBe(1);
    expect(currencyRateInExalted("divine", TABLE)).toBe(404.62);
  });

  it("returns nothing for foreign shapes", () => {
    expect(parseTradeListings(null, "L")).toEqual([]);
    expect(parseTradeListings({ result: "nope" }, "L")).toEqual([]);
    expect(parseTradeListings([], "L")).toEqual([]);
  });
});

const EXCHANGE_JSON = {
  id: "ex-1",
  complexity: null,
  result: {
    "list-a": {
      id: "list-a",
      item: null,
      listing: {
        indexed: "2026-09-07T10:00:00Z",
        account: { name: "Bulk", online: { league: "Standard" }, lastCharacterName: "BulkChar" },
        whisper: "@Bulk Hi, I'd like to buy your {0} for my {1} in Standard.",
        offers: [
          {
            exchange: { currency: "divine", amount: 1, whisper: "{0} Divine Orb" },
            item: { currency: "exalted", amount: 130, stock: 2600, id: "off-1", whisper: "{0} Exalted Orb" },
          },
          {
            exchange: { currency: "divine", amount: 2, whisper: "{0} Divine Orb" },
            item: { currency: "chaos", amount: 15, stock: 45, id: "off-2", whisper: "{0} Chaos Orb" },
          },
          { exchange: { currency: "divine" }, item: { currency: "exalted", amount: 0 } },
        ],
      },
    },
    "list-b": {
      id: "list-b",
      listing: {
        account: { name: "Solo", online: null },
        whisper: "@Solo Hi, I'd like to buy your 125 Exalted Orb for my 1 Divine Orb in Standard.",
        offers: [{ exchange: { currency: "divine", amount: 1 }, item: { currency: "exalted", amount: 125, stock: 125 } }],
      },
    },
  },
  total: 2,
};

describe("parseExchangeResult", () => {
  it("expands every offer with have/want/stock/ratio and a filled-in whisper", () => {
    const result = parseExchangeResult(EXCHANGE_JSON, "Standard");
    expect(result.id).toBe("ex-1");
    expect(result.total).toBe(2);
    expect(result.offers).toEqual([
      {
        id: "list-a#0",
        seller: { account: "Bulk", character: "BulkChar", online: true, afk: false, hideout: false, league: "Standard" },
        whisper: "@Bulk Hi, I'd like to buy your 130 Exalted Orb for my 1 Divine Orb in Standard.",
        have: { currency: "divine", amount: 1 },
        want: { currency: "exalted", amount: 130 },
        stock: 2600,
        indexedAt: "2026-09-07T10:00:00Z",
        ratio: 130,
      },
      {
        id: "list-a#1",
        seller: { account: "Bulk", character: "BulkChar", online: true, afk: false, hideout: false, league: "Standard" },
        whisper: "@Bulk Hi, I'd like to buy your 15 Chaos Orb for my 2 Divine Orb in Standard.",
        have: { currency: "divine", amount: 2 },
        want: { currency: "chaos", amount: 15 },
        stock: 45,
        indexedAt: "2026-09-07T10:00:00Z",
        ratio: 7.5,
      },
      {
        id: "list-b",
        seller: { account: "Solo", online: false, league: "Standard" },
        whisper: "@Solo Hi, I'd like to buy your 125 Exalted Orb for my 1 Divine Orb in Standard.",
        have: { currency: "divine", amount: 1 },
        want: { currency: "exalted", amount: 125 },
        stock: 125,
        ratio: 125,
      },
    ]);
  });

  it("accepts an array result and tolerates garbage", () => {
    const result = parseExchangeResult({ id: "x", result: [EXCHANGE_JSON.result["list-b"], null, 3] }, "L");
    expect(result.total).toBe(1);
    expect(result.offers).toHaveLength(1);
    expect(parseExchangeResult(undefined, "L")).toEqual({ id: "", total: 0, offers: [] });
  });
});

// ---------------------------------------------------------------------------
// Currency, notes and fractional prices (P3 §7.3 worked examples)
// ---------------------------------------------------------------------------

/** P3's worked examples price the Divine Orb at a round 500 exalted. */
const DIVINE_500: PriceTable = {
  schemaVersion: PRICE_TABLE_SCHEMA_VERSION,
  currency: "exalted",
  entries: [
    { id: "feed:poe2scout:divine", match: { name: "Divine Orb" }, value: 500 },
    { id: "feed:poe2scout:chaos", match: { name: "Chaos Orb" }, value: 0.5 },
  ],
};

describe("normalizeTradeCurrency", () => {
  it("maps ids, in-game names and whisper shorthand onto the trade2 id", () => {
    expect(normalizeTradeCurrency("Exalted Orb")).toBe("exalted");
    expect(normalizeTradeCurrency("exalted")).toBe("exalted");
    expect(normalizeTradeCurrency(" EX ")).toBe("exalted");
    expect(normalizeTradeCurrency("Divine Orb")).toBe("divine");
    expect(normalizeTradeCurrency("div")).toBe("divine");
    expect(normalizeTradeCurrency("Chaos Orb")).toBe("chaos");
    expect(normalizeTradeCurrency("c")).toBe("chaos");
    expect(normalizeTradeCurrency("Mirror of Kalandra")).toBe("mirror");
    expect(normalizeTradeCurrency("Orb of Annulment")).toBe("annul");
    expect(normalizeTradeCurrency("Regal Orb")).toBe("regal");
    expect(normalizeTradeCurrency("Vaal Orb")).toBe("vaal");
    expect(normalizeTradeCurrency("Orb of Alchemy")).toBe("alch");
    expect(normalizeTradeCurrency("Orb of Transmutation")).toBe("transmute");
    expect(normalizeTradeCurrency("Orb of Augmentation")).toBe("aug");
    expect(normalizeTradeCurrency("Fracturing Orb")).toBe("fracturing");
    expect(normalizeTradeCurrency("Perfect Jeweller's Orb")).toBe("perfect-jewellers");
  });

  it("returns undefined for anything the economy does not know", () => {
    expect(normalizeTradeCurrency("gold")).toBeUndefined();
    expect(normalizeTradeCurrency("")).toBeUndefined();
    expect(normalizeTradeCurrency("   ")).toBeUndefined();
  });
});

describe("priceInExalted", () => {
  it("converts amounts by id or by name, to two decimals", () => {
    expect(priceInExalted(1.5, "divine", DIVINE_500)).toBe(750);
    expect(priceInExalted(2, "divine", DIVINE_500)).toBe(1000);
    expect(priceInExalted(1.5, "exalted", DIVINE_500)).toBe(1.5);
    expect(priceInExalted(20, "Exalted Orb", DIVINE_500)).toBe(20);
    expect(priceInExalted(3, "divine", TABLE)).toBe(1213.86);
  });

  it("has no answer for an unknown currency or a non-numeric amount", () => {
    expect(priceInExalted(5, "gold", DIVINE_500)).toBeUndefined();
    expect(priceInExalted(Number.NaN, "divine", DIVINE_500)).toBeUndefined();
    // Without a table the crafting defaults still price the known orbs.
    expect(priceInExalted(2, "divine")).toBe(810);
  });
});

describe("splitFractionalPrice", () => {
  it("splits a fractional divine price at the table's rate", () => {
    expect(splitFractionalPrice(1.5, "divine", DIVINE_500)).toEqual({
      parts: [
        { amount: 1, currency: "divine" },
        { amount: 250, currency: "exalted" },
      ],
      rate: 500,
      rateSource: "price-table",
      text: "1 div + 250 ex",
    });
    expect(splitFractionalPrice(0.5, "divine", DIVINE_500)).toEqual({
      parts: [{ amount: 250, currency: "exalted" }],
      rate: 500,
      rateSource: "price-table",
      text: "250 ex",
    });
    expect(splitFractionalPrice(1.5, "divine", TABLE)?.text).toBe("1 div + 202 ex");
  });

  it("refuses whole amounts, exalted prices, sub-exalted remainders and unknown currencies", () => {
    expect(splitFractionalPrice(2, "divine", DIVINE_500)).toBeUndefined();
    expect(splitFractionalPrice(1.5, "exalted", DIVINE_500)).toBeUndefined();
    expect(splitFractionalPrice(1.25, "chaos", DIVINE_500)).toBeUndefined();
    expect(splitFractionalPrice(1.5, "gold", DIVINE_500)).toBeUndefined();
    expect(splitFractionalPrice(-1.5, "divine", DIVINE_500)).toBeUndefined();
  });

  it("falls back to the crafting defaults and says so when the table has no row", () => {
    const split = splitFractionalPrice(1.5, "Divine Orb", { ...DIVINE_500, entries: [] })!;
    expect(split.rateSource).toBe("fallback");
    expect(split.rate).toBe(405);
    expect(split.text).toBe("1 div + 203 ex");
  });
});

describe("priceNote", () => {
  it("writes the stash-tab note the game reads", () => {
    expect(priceNote({ amount: 5, currency: "exalted" })).toBe("~price 5 exalted");
    expect(priceNote({ amount: 5, currency: "exalted" }, "b/o")).toBe("~b/o 5 exalted");
    expect(priceNote({ amount: 1.5, currency: "divine" }, "price")).toBe("~price 1.5 divine");
  });
});

// ---------------------------------------------------------------------------
// Row display
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-09-07T12:00:00Z");

describe("describeListing", () => {
  const listings = parseTradeListings(FETCH_JSON, "L", { priceTable: TABLE });

  it("describes a priced, afk, corrupted listing with rune sockets", () => {
    expect(describeListing(listings[0]!, { now: NOW, priceTable: TABLE })).toEqual({
      priceText: "3 exalted",
      priceExalted: 3,
      ageMs: 2 * 60 * 60 * 1000,
      stale: "fresh",
      online: "afk",
      requiredLevel: 62,
      flags: ["corrupted", "fractured", "2 rune sockets"],
    });
  });

  it("reports offline sellers, secure fees and the DPS trade2 computed", () => {
    const offline = describeListing(listings[1]!, { now: NOW, priceTable: TABLE });
    expect(offline.online).toBe("offline");
    expect(offline.priceText).toBe("2 divine");
    expect(offline.priceExalted).toBe(809.24);
    expect(offline.flags).toEqual(["unidentified"]);

    const secure = describeListing(listings[2]!, { now: NOW, priceTable: TABLE });
    expect(secure.online).toBe("online");
    expect(secure.ageMs).toBeUndefined();
    expect(secure.stale).toBe("fresh");
    expect(secure.dps).toBe(8.4);
    expect(secure.pdps).toBe(8.4);
    expect(secure.edps).toBeUndefined();
    expect(secure.flags).toEqual(["secure fee 2"]);
  });

  it("bands the age into fresh, aging and stale", () => {
    const listing = listings[0]!;
    const at = (days: number) =>
      describeListing(listing, { now: NOW + days * 24 * 60 * 60 * 1000, priceTable: TABLE }).stale;
    expect(at(0)).toBe("fresh");
    expect(at(4)).toBe("aging");
    expect(at(20)).toBe("stale");
    expect(describeListing(listing, { now: NOW, agingAfterMs: 60 * 60 * 1000, priceTable: TABLE }).stale).toBe(
      "aging",
    );
  });

  it("splits a fractional price, normalises defences to Q20 and derives DPS from properties", () => {
    const row = parseTradeListing(
      {
        id: "eee555",
        listing: {
          indexed: "2026-09-07T11:00:00Z",
          account: { name: "Smith", online: { league: "L" } },
          price: { amount: 1.5, currency: "divine" },
        },
        item: {
          typeLine: "Advanced Maraketh Coat",
          rarity: "Rare",
          identified: true,
          properties: [
            { name: "Quality", values: [["+12%", 1]] },
            { name: "Armour", values: [["412", 0]] },
            { name: "Energy Shield", values: [["100", 0]] },
            { name: "Physical Damage", values: [["30-50", 0]] },
            { name: "Elemental Damage", values: [["12-24", 0], ["5-60", 0]] },
            { name: "Attacks per Second", values: [["1.40", 0]] },
          ],
        },
      },
      "L",
      { priceTable: DIVINE_500 },
    )!;
    const display = describeListing(row, { now: NOW, priceTable: DIVINE_500 });
    expect(display.priceText).toBe("1.5 divine");
    expect(display.priceExalted).toBe(750);
    expect(display.fractional).toBe("1 div + 250 ex");
    expect(display.arQ20).toBe(441.4);
    expect(display.esQ20).toBe(107.1);
    expect(display.evQ20).toBeUndefined();
    expect(display.pdps).toBe(56);
    expect(display.edps).toBe(70.7);
    expect(display.dps).toBe(126.7);
  });

  it("has no price text and an unknown presence when the row carries neither", () => {
    const display = describeListing(listings[3]!, { now: NOW, priceTable: TABLE });
    expect(display.priceText).toBe("");
    expect(display.priceExalted).toBeUndefined();
    expect(display.online).toBe("unknown");
  });
});

describe("listingToNormalizedItem", () => {
  it("renders a fetched listing as the item shape a Ctrl+C copy produces", () => {
    const listing = parseTradeListings(FETCH_JSON, "L", { priceTable: TABLE })[0]!;
    const item = listingToNormalizedItem(listing);
    expect(item.itemClass).toBe("");
    expect(item.name).toBe("Doom Loop");
    expect(item.baseType).toBe("Ruby Ring");
    expect(item.rarity).toBe("Rare");
    expect(item.itemLevel).toBe(81);
    expect(item.quality).toBe(20);
    expect(item.sockets).toBe("S S");
    expect(item.identified).toBe(true);
    expect(item.corrupted).toBe(true);
    expect(item.requirements).toEqual({ Level: 62, Str: 64 });
    expect(item.fingerprint).toHaveLength(16);
    expect(item.mods.map((mod) => [mod.kind, mod.text])).toEqual([
      ["enchant", "Allocates Passive"],
      ["implicit", "+20% to Fire Resistance"],
      ["explicit", "+110 to maximum Life"],
      ["explicit", "+35% to Lightning Resistance"],
      ["fractured", "+15 to Strength"],
      ["desecrated", "+31% to Chaos Resistance"],
      ["rune", "+12% to Cold Resistance"],
    ]);
    expect(item.mods[2]!.value).toBe(110);
    expect(item.properties).toEqual([
      {
        name: "Quality",
        value: "+20%",
        text: "Quality: +20%",
        rawText: "Quality: +20%",
        block: 1,
        order: 0,
        line: 0,
        values: [20],
        rolls: [{ index: 0, value: 20, raw: "+20", unit: "%", start: 0, end: 3 }],
      },
    ]);
  });
});
