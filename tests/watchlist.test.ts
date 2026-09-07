import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MOD_FAMILIES } from "../src/core/modKnowledge.js";
import { PRICE_TABLE_SCHEMA_VERSION, type PriceTable } from "../src/core/priceTable.js";
import { buildStatCatalogue, type StatCatalogue } from "../src/core/statIds.js";
import type { CompListing } from "../src/core/tradeComps.js";
import {
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_MIN_SAMPLE,
  DEFAULT_THRESHOLD_PERCENT,
  alertTitle,
  buildWatchQuery,
  evaluateWatch,
  nextScanEtaMs,
  parseDealAlerts,
  parseWatchlist,
  sanitizeWatch,
  scheduleNextWatch,
  seenAsks,
  serializeDealAlert,
  serializeWatchlist,
  summarizeWatch,
  watchForItem,
  type DealAlert,
  type Watch,
} from "../src/core/watchlist.js";

const STATS: unknown = JSON.parse(
  readFileSync(new URL("../fixtures/trade/stats-subset.json", import.meta.url), "utf8"),
);
const LIFE_ID = "explicit.stat_3299347043";
const FIRE_ID = "explicit.stat_3372524247";
const catalogue = buildStatCatalogue(STATS, MOD_FAMILIES);

function watch(partial: Partial<Watch> & Pick<Watch, "kind">): Watch {
  return {
    id: "w1",
    label: "test",
    enabled: true,
    query: {},
    thresholdPercent: DEFAULT_THRESHOLD_PERCENT,
    minSample: DEFAULT_MIN_SAMPLE,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    ...partial,
  };
}

function listing(id: string, amount: number, currency = "exalted", extra: Partial<CompListing> = {}): CompListing {
  return {
    id,
    name: "Temporalis",
    baseType: "Silk Robe",
    mods: [],
    priceAmount: amount,
    priceCurrency: currency,
    ...extra,
  };
}

const table: PriceTable = {
  schemaVersion: PRICE_TABLE_SCHEMA_VERSION,
  currency: "exalted",
  entries: [
    { id: "feed:poe2scout:temporalis", match: { name: "Temporalis", baseType: "Silk Robe", rarity: "Unique" }, value: 200 },
    { id: "feed:poe2scout:divine", match: { name: "Divine Orb" }, value: 100 },
    { id: "manual-1", match: { name: "Hand Priced", rarity: "Unique" }, value: 50 },
  ],
};

describe("buildWatchQuery", () => {
  it("searches a unique by name and base, cheapest online first", () => {
    const body = buildWatchQuery(watch({ kind: "unique", query: { name: "Temporalis", baseType: "Silk Robe" } }));
    expect(body).toEqual({
      query: { status: { option: "online" }, name: "Temporalis", type: "Silk Robe" },
      sort: { price: "asc" },
    });
    expect(buildWatchQuery(watch({ kind: "unique", query: { name: "Temporalis" } }))).toEqual({
      query: { status: { option: "online" }, name: "Temporalis" },
      sort: { price: "asc" },
    });
    expect(buildWatchQuery(watch({ kind: "unique", query: { baseType: "Silk Robe" } }))).toBeUndefined();
  });

  it("searches a base type as non-unique with an item-level floor", () => {
    const body = buildWatchQuery(
      watch({ kind: "base-type", query: { baseType: "Ruby Ring", itemClass: "Rings", minItemLevel: 80 } }),
    );
    expect(body).toEqual({
      query: {
        status: { option: "online" },
        type: "Ruby Ring",
        filters: {
          type_filters: { filters: { rarity: { option: "nonunique" } } },
          misc_filters: { filters: { ilvl: { min: 80 } } },
        },
      },
      sort: { price: "asc" },
    });
  });

  it("falls back to a trade category when only a class is named", () => {
    const body = buildWatchQuery(watch({ kind: "base-type", query: { itemClass: "Rings" } }));
    expect(body?.query).toEqual({
      status: { option: "online" },
      filters: { type_filters: { filters: { rarity: { option: "nonunique" }, category: { option: "accessory.ring" } } } },
    });
    expect(buildWatchQuery(watch({ kind: "base-type", query: { itemClass: "Mystery Things" } }))).toBeUndefined();
    expect(buildWatchQuery(watch({ kind: "base-type", query: {} }))).toBeUndefined();
  });

  it("turns stat rows into trade2 stat filters via the catalogue", () => {
    const body = buildWatchQuery(
      watch({
        kind: "stat-filtered",
        query: {
          baseType: "Ruby Ring",
          stats: [
            { familyId: "life", min: 100, text: "+110 to maximum Life" },
            { familyId: "fire-res", min: 30 },
            { familyId: "no-such-family", min: 5 },
          ],
        },
      }),
      catalogue,
    );
    expect(body?.query).toMatchObject({
      type: "Ruby Ring",
      stats: [
        {
          type: "and",
          filters: [
            { id: LIFE_ID, value: { min: 100 } },
            { id: FIRE_ID, value: { min: 30 } },
          ],
        },
      ],
      filters: { type_filters: { filters: { rarity: { option: "nonunique" } } } },
    });
  });

  it("ORs a small family's ids in a count group and omits a zero minimum", () => {
    const small: StatCatalogue = {
      byFamily: new Map([["attack-speed", ["explicit.a", "explicit.b"]]]),
      byText: new Map(),
      entryCount: 2,
    };
    const body = buildWatchQuery(
      watch({ kind: "stat-filtered", query: { baseType: "Bow", stats: [{ familyId: "attack-speed", min: 0 }] } }),
      small,
    );
    expect(body?.query).toMatchObject({
      stats: [{ type: "count", value: { min: 1 }, filters: [{ id: "explicit.a" }, { id: "explicit.b" }] }],
    });
  });

  it("refuses a stat watch without a catalogue or without resolvable stats", () => {
    const stat = watch({ kind: "stat-filtered", query: { baseType: "Ruby Ring", stats: [{ familyId: "life", min: 1 }] } });
    expect(buildWatchQuery(stat)).toBeUndefined();
    expect(
      buildWatchQuery(watch({ kind: "stat-filtered", query: { baseType: "Ruby Ring", stats: [{ familyId: "nope", min: 1 }] } }), catalogue),
    ).toBeUndefined();
    expect(buildWatchQuery(watch({ kind: "stat-filtered", query: { stats: [{ familyId: "life", min: 1 }] } }), catalogue)).toBeUndefined();
  });
});

describe("evaluateWatch", () => {
  const unique = watch({ kind: "unique", query: { name: "Temporalis", baseType: "Silk Robe" } });

  it("uses the feed price as the reference for a unique the table lists", () => {
    const listings = [listing("a", 100), listing("b", 130), listing("c", 150), listing("d", 210)];
    const summary = summarizeWatch(unique, listings, { priceTable: table });
    expect(summary).toMatchObject({ sample: 4, referenceExalted: 200, referenceBasis: "feed" });
    const alerts = evaluateWatch(unique, listings, { priceTable: table, now: new Date("2026-09-07T10:00:00Z") });
    // 60% of 200 = 120: only the 100 ex listing qualifies.
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      id: "w1:a:100",
      at: "2026-09-07T10:00:00.000Z",
      watchId: "w1",
      listingId: "a",
      name: "Temporalis",
      baseType: "Silk Robe",
      askExalted: 100,
      ask: { amount: 100, currency: "exalted" },
      referenceExalted: 200,
      discountPercent: 50,
    });
  });

  it("falls back to the sample median when the feed has no row", () => {
    const rare = watch({ kind: "base-type", query: { baseType: "Ruby Ring" } });
    const listings = [listing("a", 1), listing("b", 2), listing("c", 3), listing("d", 10)];
    const summary = summarizeWatch(rare, listings, { priceTable: table });
    expect(summary).toMatchObject({ sample: 4, referenceExalted: 2.5, referenceBasis: "median" });
    const alerts = evaluateWatch(rare, listings, { priceTable: table });
    expect(alerts.map((alert) => alert.listingId)).toEqual(["a"]);
    expect(alerts[0]?.discountPercent).toBe(60);
    // A manual row is not a feed row: still the median.
    const manual = watch({ kind: "unique", query: { name: "Hand Priced" } });
    expect(summarizeWatch(manual, listings, { priceTable: table }).referenceBasis).toBe("median");
  });

  it("honours an explicit reference and converts other currencies", () => {
    const listings = [listing("a", 0.5, "divine"), listing("b", 1, "divine"), listing("c", 90), listing("d", 95)];
    const alerts = evaluateWatch(unique, listings, { priceTable: table, referenceExalted: 150 });
    // Ceiling 60% × 150 = 90: 0.5 divine = 50 ex (−67%) and 90 ex (−40%, at the
    // line) alert, cheapest first; 95 ex and 1 divine (100 ex) do not.
    expect(alerts.map((alert) => [alert.listingId, alert.askExalted, alert.discountPercent])).toEqual([
      ["a", 50, 67],
      ["c", 90, 40],
    ]);
  });

  it("gates on the threshold and the minimum sample", () => {
    const listings = [listing("a", 100), listing("b", 130), listing("c", 150), listing("d", 210)];
    const strict = { ...unique, thresholdPercent: 40 };
    expect(evaluateWatch(strict, listings, { priceTable: table })).toEqual([]);
    const loose = { ...unique, thresholdPercent: 70 };
    expect(evaluateWatch(loose, listings, { priceTable: table }).map((alert) => alert.listingId)).toEqual(["a", "b"]);
    // Three priced listings against minSample 4: nothing, even at a deep discount.
    expect(evaluateWatch(unique, listings.slice(0, 3), { priceTable: table })).toEqual([]);
    // Unpriced currencies do not count toward the sample.
    const withJunk = [...listings.slice(0, 3), listing("z", 1, "mirror-shard")];
    expect(evaluateWatch(unique, withJunk, { priceTable: table })).toEqual([]);
  });

  it("does not re-raise a listing already alerted unless its ask dropped", () => {
    const listings = [listing("a", 100), listing("b", 110), listing("c", 150), listing("d", 210)];
    const first = evaluateWatch(unique, listings, { priceTable: table });
    expect(first.map((alert) => alert.listingId)).toEqual(["a", "b"]);
    const seen = seenAsks(first);
    expect(evaluateWatch(unique, listings, { priceTable: table, seen })).toEqual([]);
    const dropped = [listing("a", 80), listing("b", 110), listing("c", 150), listing("d", 210)];
    const again = evaluateWatch(unique, dropped, { priceTable: table, seen });
    expect(again.map((alert) => [alert.listingId, alert.askExalted])).toEqual([["a", 80]]);
    expect(again[0]?.id).toBe("w1:a:80");
  });

  it("carries the seller, index time and whisper through to the alert", () => {
    const listings = [
      listing("a", 100, "exalted", { accountName: "seller", indexed: "2026-09-07T09:00:00Z", whisper: "@seller Hi, I would like to buy your Temporalis" }),
      listing("b", 180),
      listing("c", 190),
      listing("d", 200),
    ];
    const [alert] = evaluateWatch(unique, listings, { priceTable: table });
    expect(alert).toMatchObject({
      accountName: "seller",
      indexed: "2026-09-07T09:00:00Z",
      whisper: "@seller Hi, I would like to buy your Temporalis",
    });
    expect(alertTitle(alert!)).toBe("Deal: Temporalis 100 exalted (−50%)");
  });
});

describe("scheduleNextWatch", () => {
  const now = Date.parse("2026-09-07T10:00:00Z");
  const never = watch({ kind: "unique", id: "never", query: { name: "A" } });
  const old = watch({ kind: "unique", id: "old", query: { name: "B" }, lastScanAt: "2026-09-07T09:00:00Z" });
  const recent = watch({ kind: "unique", id: "recent", query: { name: "C" }, lastScanAt: "2026-09-07T09:55:00Z" });
  const off = watch({ kind: "unique", id: "off", enabled: false, query: { name: "D" } });

  it("prefers a never-scanned watch, then the longest overdue", () => {
    expect(scheduleNextWatch([recent, old, never, off], now)?.id).toBe("never");
    expect(scheduleNextWatch([recent, old, off], now)?.id).toBe("old");
  });

  it("returns nothing while every enabled watch is inside its interval", () => {
    expect(scheduleNextWatch([recent, off], now)).toBeUndefined();
    expect(scheduleNextWatch([off], now)).toBeUndefined();
    expect(scheduleNextWatch([recent], now + 5 * 60_000)?.id).toBe("recent");
    // A custom interval is respected.
    const hourly = { ...old, intervalMinutes: 120 };
    expect(scheduleNextWatch([hourly], now)).toBeUndefined();
    expect(scheduleNextWatch([hourly], now + 61 * 60_000)?.id).toBe("old");
  });

  it("reports the ETA of the next due watch", () => {
    expect(nextScanEtaMs([recent, off], now)).toBe(5 * 60_000);
    expect(nextScanEtaMs([recent, old], now)).toBe(0);
    expect(nextScanEtaMs([off], now)).toBeUndefined();
  });
});

describe("watchForItem", () => {
  it("builds a unique watch from a unique item", () => {
    const built = watchForItem({ name: "Temporalis", baseType: "Silk Robe", rarity: "Unique", itemClass: "Body Armours" }, undefined, "id-1");
    expect(built).toMatchObject({
      id: "id-1",
      kind: "unique",
      label: "Temporalis (Silk Robe)",
      query: { name: "Temporalis", baseType: "Silk Robe" },
      thresholdPercent: 60,
      minSample: 4,
      intervalMinutes: 10,
    });
  });

  it("builds a stat watch from a rare's top notable mods, one family each", () => {
    const built = watchForItem(
      { name: "Doom Loop", baseType: "Ruby Ring", rarity: "Rare", itemClass: "Rings", itemLevel: 81 },
      {
        mods: [
          { text: "+120 to maximum Life", familyId: "life", judgedValue: 120, tier: 1, points: 24 },
          { text: "+38% to Fire Resistance", familyId: "fire-res", judgedValue: 38, tier: 2, points: 10 },
          { text: "+30% to Cold Resistance", familyId: "cold-res", judgedValue: 30, tier: 3, points: 6 },
          { text: "+25% to Lightning Resistance", familyId: "lightning-res", judgedValue: 25, tier: 3, points: 5 },
          { text: "+10 to Strength", familyId: "strength", judgedValue: 10, tier: 0, points: 0 },
          { text: "5% increased Light Radius", points: 0 },
        ],
      },
      "id-2",
    );
    expect(built.kind).toBe("stat-filtered");
    expect(built.query).toEqual({
      baseType: "Ruby Ring",
      itemClass: "Rings",
      rarity: "nonunique",
      minItemLevel: 78,
      stats: [
        { familyId: "life", min: 102, text: "+120 to maximum Life" },
        { familyId: "fire-res", min: 32, text: "+38% to Fire Resistance" },
        { familyId: "cold-res", min: 25, text: "+30% to Cold Resistance" },
      ],
    });
    expect(built.label).toBe("Ruby Ring · 3 stats · ilvl 78+");
  });

  it("falls back to a base watch, deriving a magic item's base", () => {
    const plain = watchForItem({ name: "Doom Loop", baseType: "Ruby Ring", rarity: "Rare", itemClass: "Rings", itemLevel: 60 }, { mods: [] }, "id-3");
    expect(plain).toMatchObject({ kind: "base-type", query: { baseType: "Ruby Ring", itemClass: "Rings", rarity: "nonunique" } });
    expect(plain.query.minItemLevel).toBeUndefined();
    const magic = watchForItem(
      { name: "Entombing Bandit Mace of the Champion", baseType: "Entombing Bandit Mace of the Champion", rarity: "Magic" },
      undefined,
      "id-4",
    );
    expect(magic.query.baseType).toBe("Bandit Mace");
  });
});

describe("serializers", () => {
  it("sanitizes junk into a usable watch or nothing", () => {
    expect(sanitizeWatch(null)).toBeUndefined();
    expect(sanitizeWatch("nope")).toBeUndefined();
    expect(sanitizeWatch({ kind: "weird" })).toBeUndefined();
    expect(sanitizeWatch({ kind: "unique" })).toBeUndefined(); // no id, no fallback
    const cleaned = sanitizeWatch(
      {
        id: "  w9 ",
        kind: "base-type",
        enabled: "yes",
        query: { baseType: " Ruby Ring ", minItemLevel: "82.7", stats: [{ familyId: "life", min: -4 }, { min: 3 }, "x"] },
        thresholdPercent: 250,
        minSample: 0,
        intervalMinutes: "abc",
        lastScanAt: "not a date",
        lastReferenceExalted: -1,
      },
      "fallback",
    );
    expect(cleaned).toEqual({
      id: "w9",
      label: "Ruby Ring · ilvl 82+",
      enabled: true,
      kind: "base-type",
      query: { baseType: "Ruby Ring", minItemLevel: 82, stats: [{ familyId: "life", min: 0 }] },
      thresholdPercent: 100,
      minSample: 1,
      intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    });
    expect(sanitizeWatch({ kind: "unique", enabled: false, query: { name: "X" } }, "fb")).toMatchObject({
      id: "fb",
      enabled: false,
      label: "X",
    });
  });

  it("round-trips the watchlist file and shrugs off junk", () => {
    expect(parseWatchlist(undefined)).toEqual({ enabled: false, notifications: true, watches: [], dismissed: [], scanLog: [] });
    expect(parseWatchlist("{not json")).toMatchObject({ enabled: false, watches: [] });
    expect(parseWatchlist("[1,2]")).toMatchObject({ enabled: false, watches: [] });
    const file = {
      enabled: true,
      notifications: false,
      watches: [
        watch({ kind: "unique", id: "a", query: { name: "Temporalis" }, lastScanAt: "2026-09-07T09:00:00.000Z", lastReferenceExalted: 200 }),
        watch({ kind: "unique", id: "a", query: { name: "Duplicate id" } }),
        { junk: true },
      ] as unknown as Watch[],
      dismissed: ["x:1:2", 5, ""] as unknown as string[],
      scanLog: [1, "two", 3] as unknown as number[],
    };
    const parsed = parseWatchlist(serializeWatchlist(file));
    expect(parsed.enabled).toBe(true);
    expect(parsed.notifications).toBe(false);
    expect(parsed.watches).toHaveLength(1);
    expect(parsed.watches[0]).toMatchObject({ id: "a", lastScanAt: "2026-09-07T09:00:00.000Z", lastReferenceExalted: 200 });
    expect(parsed.dismissed).toEqual(["x:1:2"]);
    expect(parsed.scanLog).toEqual([1, 3]);
  });

  it("parses alert lines and skips torn ones", () => {
    const alert: DealAlert = {
      id: "w1:a:100",
      at: "2026-09-07T10:00:00.000Z",
      watchId: "w1",
      listingId: "a",
      name: "Temporalis",
      baseType: "Silk Robe",
      askExalted: 100,
      ask: { amount: 100, currency: "exalted" },
      referenceExalted: 200,
      discountPercent: 50,
      whisper: "@seller Hi",
    };
    const text = [serializeDealAlert(alert), "{torn", "", JSON.stringify({ watchId: "w1" }), JSON.stringify({ ...alert, id: undefined, discountPercent: undefined })].join("\n");
    const parsed = parseDealAlerts(text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual(alert);
    // Missing id/discount are derived.
    expect(parsed[1]).toMatchObject({ id: "w1:a:100", discountPercent: 50 });
    expect(parseDealAlerts(undefined)).toEqual([]);
  });
});
