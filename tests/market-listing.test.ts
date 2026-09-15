import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildStatCatalogue } from "../src/core/statIds.js";
import { MOD_FAMILIES } from "../src/core/modKnowledge.js";
import { parseTradeListings, type TradeListing } from "../src/core/tradeListings.js";
import {
  collapseBySeller,
  describeListing,
  hideoutCommand,
  listingToNormalizedItem,
  offerWhisperText,
  priceNote,
  sortListings,
  splitFractionalPrice,
  statFiltersFromListing,
  whisperText,
} from "../src/core/marketListing.js";

const LEAGUE = "Runes of Aldur";
const NOW = Date.parse("2026-09-07T10:00:00Z");

const fetched = JSON.parse(
  readFileSync(path.join(process.cwd(), "fixtures", "market", "fetch-ruby-ring.json"), "utf8"),
) as unknown;
const statsPayload = JSON.parse(
  readFileSync(path.join(process.cwd(), "fixtures", "trade", "stats-subset.json"), "utf8"),
) as unknown;

const listings = parseTradeListings(fetched, LEAGUE);
const catalogue = buildStatCatalogue(statsPayload, MOD_FAMILIES, ["explicit", "implicit"]);

function byId(id: string): TradeListing {
  const hit = listings.find((listing) => listing.id === id);
  if (!hit) throw new Error(`fixture row ${id} is missing`);
  return hit;
}

describe("the fixture parses", () => {
  it("into ten rows", () => {
    expect(listings).toHaveLength(10);
    expect(listings.map((listing) => listing.id)).toContain("ring-5");
  });
});

describe("describeListing (F4) on the Market fixture", () => {
  it("reads price, age and online state", () => {
    const display = describeListing(byId("ring-1"), { now: NOW });
    expect(display.priceText).toBe("5 exalted");
    expect(display.priceExalted).toBe(5);
    expect(display.online).toBe("online");
    expect(display.ageMs).toBe(3_600_000);
    expect(display.stale).toBe("fresh");
  });

  it("marks afk, offline and unknown sellers", () => {
    expect(describeListing(byId("ring-2"), { now: NOW }).online).toBe("afk");
    expect(describeListing(byId("ring-3"), { now: NOW }).online).toBe("offline");
  });

  it("bands an old row as stale", () => {
    const display = describeListing(byId("ring-6"), { now: NOW, agingAfterMs: 3_600_000, staleAfterMs: 86_400_000 });
    expect(display.stale).toBe("stale");
  });

  it("shows no price for an unpriced row", () => {
    const display = describeListing(byId("ring-4"), { now: NOW });
    expect(display.priceText).toBe("");
    expect(display.priceExalted).toBeUndefined();
    expect(display.flags).toContain("unidentified");
  });

  it("carries the secure fee as a flag", () => {
    const display = describeListing(byId("ring-5"), { now: NOW });
    expect(display.flags.some((flag) => flag.startsWith("secure fee"))).toBe(true);
  });

  it("prefers the extended DPS block", () => {
    const display = describeListing(byId("weapon-1"), { now: NOW });
    expect(display.dps).toBe(210.4);
    expect(display.pdps).toBe(184.2);
  });

  it("normalises a sub-Q20 armour without lowering a Q20 one", () => {
    const display = describeListing(byId("armour-1"), { now: NOW });
    expect(display.arQ20).toBeGreaterThan(500);
    expect(display.flags.some((flag) => flag.includes("rune socket"))).toBe(true);
  });

  it("splits a fractional divine price", () => {
    const display = describeListing(byId("ring-2"), { now: NOW });
    expect(display.fractional).toBeDefined();
    const split = splitFractionalPrice(1.5, "divine");
    expect(split?.parts[0]).toEqual({ amount: 1, currency: "divine" });
    expect(split?.rateSource).toBe("fallback");
    expect(splitFractionalPrice(2, "divine")).toBeUndefined();
    expect(splitFractionalPrice(1.5, "exalted")).toBeUndefined();
  });
});

describe("row actions", () => {
  it("hands back the whisper for a normal row and refuses a secure one", () => {
    expect(whisperText(byId("ring-1"))).toContain("@OneChar");
    expect(whisperText(byId("ring-5"))).toBeUndefined();
  });

  it("builds a /hideout command only when a character is known", () => {
    expect(hideoutCommand(byId("ring-1"))).toBe("/hideout OneChar");
    expect(hideoutCommand(byId("ring-4"))).toBeUndefined();
  });

  it("writes the stash note the game reads", () => {
    expect(priceNote({ amount: 5, currency: "exalted" })).toBe("~price 5 exalted");
    expect(priceNote({ amount: 5, currency: "exalted" }, "b/o")).toBe("~b/o 5 exalted");
  });

  it("keeps an exchange offer's own whisper", () => {
    expect(offerWhisperText({ whisper: "@Bulk hi" })).toBe("@Bulk hi");
    expect(offerWhisperText({})).toBeUndefined();
  });
});

describe("statFiltersFromListing", () => {
  it("turns the listing's mods into filters at 90 % of the roll", () => {
    const groups = statFiltersFromListing(byId("ring-1"), catalogue);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.type).toBe("and");
    expect(groups[0]!.filters).toEqual([
      { id: "explicit.stat_3299347043", value: { min: 99 } },
      { id: "explicit.stat_1671376347", value: { min: 31 } },
    ]);
  });

  it("skips the implicit unless asked, and never a rune mod", () => {
    const without = statFiltersFromListing(byId("ring-1"), catalogue);
    const with_ = statFiltersFromListing(byId("ring-1"), catalogue, { includeImplicit: true });
    expect(with_[0]!.filters.length).toBeGreaterThanOrEqual(without[0]!.filters.length);
    const armour = statFiltersFromListing(byId("armour-1"), catalogue);
    expect(JSON.stringify(armour)).not.toContain("stat_3372524247");
  });

  it("answers nothing when no mod matches the catalogue", () => {
    expect(statFiltersFromListing(byId("ring-4"), catalogue)).toEqual([]);
  });

  it("honours a custom slack", () => {
    const groups = statFiltersFromListing(byId("ring-1"), catalogue, { slack: 1 });
    expect(groups[0]!.filters[0]!.value).toEqual({ min: 110 });
  });
});

describe("listingToNormalizedItem", () => {
  it("produces the shape ItemDetail expects", () => {
    const item = listingToNormalizedItem(byId("ring-1"));
    expect(item.baseType).toBe("Ruby Ring");
    expect(item.rarity.toLowerCase()).toBe("rare");
    expect(item.mods.some((mod) => mod.text.includes("maximum Life"))).toBe(true);
    expect(typeof item.fingerprint).toBe("string");
  });
});

describe("local sorting", () => {
  it("orders by price with unpriced rows last in both directions", () => {
    const asc = sortListings(listings, "price", "asc").map((listing) => listing.id);
    const desc = sortListings(listings, "price", "desc").map((listing) => listing.id);
    expect(asc.at(-1)).toBe("ring-4");
    expect(desc.at(-1)).toBe("ring-4");
    expect(asc[0]).toBe("ring-6");
  });

  it("orders by seller name", () => {
    const sorted = sortListings(listings, "seller", "asc").map((listing) => listing.seller.account);
    expect(sorted[0]).toBe("SellerEight");
  });

  it("orders by age, dps, ilvl and quality without throwing on gaps", () => {
    for (const key of ["age", "dps", "ilvl", "quality", "sockets"] as const) {
      expect(sortListings(listings, key, "desc")).toHaveLength(listings.length);
    }
  });
});

describe("collapseBySeller", () => {
  it("folds a collapsed account's extra rows into the first one", () => {
    const rows = collapseBySeller(listings, ["SellerOne"]);
    expect(rows).toHaveLength(listings.length - 1);
    const first = rows.find((row) => row.listing.id === "ring-1");
    expect(first?.hiddenSiblings).toBe(1);
    expect(rows.some((row) => row.listing.id === "ring-7")).toBe(false);
  });

  it("leaves everything alone when nothing is collapsed", () => {
    expect(collapseBySeller(listings, [])).toHaveLength(listings.length);
  });
});
