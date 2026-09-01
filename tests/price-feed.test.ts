import { describe, expect, it } from "vitest";
import { orbCosts } from "../src/core/crafting.js";
import {
  currentScoutLeague,
  feedAgeHours,
  feedEntryId,
  isFeedEntry,
  mergeFeedSnapshot,
  normalizeScoutCurrencies,
  normalizeScoutItems,
  type PriceFeedSnapshot,
} from "../src/core/priceFeed.js";
import { PRICE_TABLE_SCHEMA_VERSION, lookupPrice, type PriceTable } from "../src/core/priceTable.js";
import {
  buildCompsQuery,
  listingPriceInExalted,
  listingSimilarity,
  normalizeTradeModText,
  parseCompListings,
  summarizeComps,
  type CompListing,
} from "../src/core/tradeComps.js";
import { parseItemText } from "../src/core/parseItem.js";

// Fixture shapes mirror live api.poe2scout.com responses captured 2026-08-30.
const SCOUT_LEAGUES = [
  { Value: "Standard", IsCurrent: false, DivinePrice: 230.6 },
  { Value: "HC Runes of Aldur", IsCurrent: true, DivinePrice: 164.4 },
  { Value: "Runes of Aldur", IsCurrent: true, DivinePrice: 404.6 },
];

const SCOUT_ITEMS = [
  // Currency row: Text + ApiId, no Name.
  { ItemId: 295, Text: "Divine Orb", ApiId: "divine", CurrentPrice: 404.62 },
  { ItemId: 296, Text: "Orb of Transmutation", ApiId: "transmute", CurrentPrice: 0.17 },
  // Unique row: Name + Type.
  {
    ItemId: 25,
    CategoryApiId: "accessory",
    Text: "Igniferis Crimson Amulet",
    Name: "Igniferis",
    Type: "Crimson Amulet",
    ApiId: null,
    CurrentPrice: 12.5,
  },
  // Cheap unique: filtered by the value floor.
  { ItemId: 26, Text: "Trash Ring", Name: "Trashy", Type: "Iron Ring", CurrentPrice: 1 },
  // Zero-priced rows never enter the table.
  { ItemId: 27, Text: "Unpriced Orb", ApiId: "unpriced", CurrentPrice: 0 },
];

function emptyTable(): PriceTable {
  return { schemaVersion: PRICE_TABLE_SCHEMA_VERSION, currency: "exalted", entries: [] };
}

function snapshot(prices: PriceFeedSnapshot["prices"]): PriceFeedSnapshot {
  return { source: "poe2scout", league: "Runes of Aldur", fetchedAt: "2026-08-30T12:00:00Z", prices };
}

describe("poe2scout normalization", () => {
  it("picks the current softcore league, never hardcore", () => {
    expect(currentScoutLeague(SCOUT_LEAGUES)).toBe("Runes of Aldur");
    expect(currentScoutLeague([])).toBeUndefined();
    expect(currentScoutLeague("nope")).toBeUndefined();
  });

  it("keeps cheap currency but floors cheap uniques", () => {
    const prices = normalizeScoutItems(SCOUT_ITEMS);
    const names = prices.map((price) => price.name);
    expect(names).toContain("Divine Orb");
    expect(names).toContain("Orb of Transmutation"); // 0.17 ex — kept
    expect(names).toContain("Igniferis");
    expect(names).not.toContain("Trashy"); // 1 ex unique — floored
    expect(names).not.toContain("Unpriced Orb");
    const igniferis = prices.find((price) => price.name === "Igniferis")!;
    expect(igniferis.baseType).toBe("Crimson Amulet");
    expect(igniferis.unique).toBe(true);
  });

  it("normalizes currency category pages", () => {
    const prices = normalizeScoutCurrencies({
      Items: [
        { ApiId: "chaos", Text: "Chaos Orb", CurrentPrice: 35.91, CurrentQuantity: 384361 },
        { ApiId: "bad", Text: "", CurrentPrice: 3 },
      ],
    });
    expect(prices).toHaveLength(1);
    expect(prices[0]).toMatchObject({ key: "chaos", name: "Chaos Orb", value: 35.91 });
  });
});

describe("feed merge", () => {
  it("replaces its own entries and never touches manual ones", () => {
    const manual = {
      id: "my-divine",
      match: { name: "Divine Orb" },
      value: 500,
      note: "my price",
    };
    const first = mergeFeedSnapshot(
      { ...emptyTable(), entries: [manual] },
      snapshot([{ key: "divine", name: "Divine Orb", value: 404.62 }]),
    );
    expect(first.added).toBe(1);
    expect(first.table.entries).toHaveLength(2);

    const second = mergeFeedSnapshot(
      first.table,
      snapshot([{ key: "divine", name: "Divine Orb", value: 410 }]),
    );
    expect(second.updated).toBe(1);
    expect(second.table.entries).toHaveLength(2);
    expect(second.table.entries.find((entry) => entry.id === "my-divine")?.value).toBe(500);
    const feedRow = second.table.entries.find((entry) => isFeedEntry(entry))!;
    expect(feedRow.id).toBe(feedEntryId("poe2scout", "divine"));
    expect(feedRow.value).toBe(410);
    expect(feedRow.note).toContain("poe2scout");
    expect(feedRow.note).toContain("2026-08-30");
  });

  it("drops feed entries missing from the fresh snapshot", () => {
    const first = mergeFeedSnapshot(
      emptyTable(),
      snapshot([
        { key: "divine", name: "Divine Orb", value: 404 },
        { key: "gone", name: "Delisted Orb", value: 2 },
      ]),
    );
    const second = mergeFeedSnapshot(
      first.table,
      snapshot([{ key: "divine", name: "Divine Orb", value: 404 }]),
    );
    expect(second.removed).toBe(1);
    expect(second.table.entries.map((entry) => entry.match.name)).not.toContain("Delisted Orb");
  });

  it("feeds the crafting economy through the price table", () => {
    const merged = mergeFeedSnapshot(
      emptyTable(),
      snapshot([
        { key: "divine", name: "Divine Orb", value: 404.62 },
        { key: "chaos", name: "Chaos Orb", value: 35.91 },
      ]),
    );
    const costs = orbCosts(merged.table);
    expect(costs.divine).toBe(404.62);
    expect(costs.chaos).toBe(35.91);
  });

  it("marks unique entries with rarity so rares never match them", () => {
    const merged = mergeFeedSnapshot(
      emptyTable(),
      snapshot([{ key: "igniferis", name: "Igniferis", baseType: "Crimson Amulet", value: 12.5, unique: true }]),
    );
    const asUnique = lookupPrice(merged.table, {
      name: "Igniferis",
      baseType: "Crimson Amulet",
      itemClass: "Amulets",
      rarity: "Unique",
    });
    expect(asUnique?.value).toBe(12.5);
    const asRare = lookupPrice(merged.table, {
      name: "Igniferis",
      baseType: "Crimson Amulet",
      itemClass: "Amulets",
      rarity: "Rare",
    });
    expect(asRare).toBeUndefined();
  });

  it("reports feed age from the note stamps", () => {
    const merged = mergeFeedSnapshot(
      emptyTable(),
      snapshot([{ key: "divine", name: "Divine Orb", value: 404 }]),
    );
    const age = feedAgeHours(merged.table, "poe2scout", new Date("2026-08-31T12:00:00Z"));
    expect(age).toBeGreaterThan(30);
    expect(age).toBeLessThan(40);
    expect(feedAgeHours(emptyTable(), "poe2scout")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// trade2 comps
// ---------------------------------------------------------------------------

const RARE_RING_TEXT = [
  "Item Class: Rings",
  "Rarity: Rare",
  "Doom Loop",
  "Ruby Ring",
  "--------",
  "Item Level: 81",
  "--------",
  "+120 to maximum Life",
  "+38% to Fire Resistance",
].join("\n");

function listing(overrides: Partial<CompListing>): CompListing {
  return {
    id: "a",
    name: "Comp Ring",
    baseType: "Ruby Ring",
    mods: ["+110 to maximum Life", "+35% to Fire Resistance"],
    priceAmount: 5,
    priceCurrency: "exalted",
    ...overrides,
  };
}

describe("trade comps", () => {
  it("builds a base-type query with an ilvl floor for high-level rares", () => {
    const query = buildCompsQuery(parseItemText(RARE_RING_TEXT))!;
    expect(query.basis).toBe("base-type");
    const body = query.body as { query: { type: string; filters: Record<string, unknown> } };
    expect(body.query.type).toBe("Ruby Ring");
    expect(JSON.stringify(body.query.filters)).toContain("nonunique");
    expect(JSON.stringify(body.query.filters)).toContain("78");
  });

  it("builds a name query for uniques", () => {
    const unique = parseItemText(
      "Item Class: Amulets\nRarity: Unique\nIgniferis\nCrimson Amulet\n--------\nItem Level: 80\n--------\n+20 to Spirit",
    );
    const query = buildCompsQuery(unique)!;
    expect(query.basis).toBe("unique-name");
    expect((query.body as { query: { name: string } }).query.name).toBe("Igniferis");
  });

  it("parses fetch payloads defensively, both string and object mods", () => {
    const listings = parseCompListings({
      result: [
        {
          id: "abc",
          item: {
            name: "Comp",
            typeLine: "Ruby Ring",
            // Real PoE2 shape: objects with bracket-annotated descriptions.
            explicitMods: [
              { description: "+84 to maximum Life", domain: "explicit" },
              { description: "+23% to [Resistances|Fire Resistance]" },
              "+10% to [Chaos Resistance]",
            ],
          },
          listing: { price: { amount: 3, currency: "divine" }, account: { name: "seller" } },
        },
        { id: "no-price", item: {}, listing: {} },
        "garbage",
      ],
    });
    expect(listings).toHaveLength(1);
    expect(listings[0]!.priceCurrency).toBe("divine");
    expect(listings[0]!.mods).toEqual([
      "+84 to maximum Life",
      "+23% to Fire Resistance",
      "+10% to Chaos Resistance",
    ]);
  });

  it("strips trade markup down to display text", () => {
    expect(normalizeTradeModText("+23% to [Resistances|Fire Resistance]")).toBe(
      "+23% to Fire Resistance",
    );
    expect(normalizeTradeModText("21% increased [Critical|Critical Hit Chance] for [Spell|Spells]")).toBe(
      "21% increased Critical Hit Chance for Spells",
    );
    expect(normalizeTradeModText("plain text")).toBe("plain text");
  });

  it("converts listing currencies through the crafting economy", () => {
    const table = mergeFeedSnapshot(
      emptyTable(),
      snapshot([{ key: "divine", name: "Divine Orb", value: 400 }]),
    ).table;
    expect(listingPriceInExalted(listing({ priceCurrency: "divine", priceAmount: 2 }), table)).toBe(800);
    expect(listingPriceInExalted(listing({ priceCurrency: "exalted", priceAmount: 7 }))).toBe(7);
    expect(listingPriceInExalted(listing({ priceCurrency: "weird-orb" }))).toBeUndefined();
  });

  it("scores similarity by shared notable mod families", () => {
    const ours = ["+120 to maximum Life", "+38% to Fire Resistance"];
    expect(listingSimilarity(ours, listing({}))).toBe(1);
    expect(listingSimilarity(ours, listing({ mods: ["+110 to maximum Life"] }))).toBe(0.5);
    expect(listingSimilarity(ours, listing({ mods: ["4% increased Quantity"] }))).toBe(0);
  });

  it("flags a suspicious floor far under the median as bait", () => {
    const summary = summarizeComps(
      [],
      [
        listing({ id: "bait", priceAmount: 10 }),
        listing({ id: "real-1", priceAmount: 380 }),
        listing({ id: "real-2", priceAmount: 403 }),
        listing({ id: "real-3", priceAmount: 500 }),
      ],
      "unique-name",
    );
    expect(summary.lowest).toBe(10);
    expect(summary.caution).toContain("Trust the median");
    const sane = summarizeComps([], [listing({ priceAmount: 5 }), listing({ id: "b", priceAmount: 7 })], "unique-name");
    expect(sane.caution).toBeUndefined();
  });

  it("summarizes only sufficiently similar priced listings", () => {
    const summary = summarizeComps(
      ["+120 to maximum Life", "+38% to Fire Resistance"],
      [
        listing({ id: "cheap-dissimilar", mods: ["irrelevant"], priceAmount: 1 }),
        listing({ id: "match-a", priceAmount: 6 }),
        listing({ id: "match-b", priceAmount: 4 }),
        listing({ id: "match-c", priceAmount: 10 }),
      ],
      "base-type",
    );
    expect(summary.candidateCount).toBe(4);
    expect(summary.sampleSize).toBe(3);
    expect(summary.lowest).toBe(4);
    expect(summary.median).toBe(6);
    expect(summary.comps[0]!.price).toBe(4);
  });
});
