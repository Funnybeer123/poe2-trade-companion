import { describe, expect, it } from "vitest";
import {
  ageDays,
  bucketFor,
  bucketTabs,
  buildShopSnapshot,
  defaultShopConfig,
  deriveShopState,
  formatPriceNote,
  maxAutoListExalted,
  normalizeNoteCurrency,
  noteExalted,
  notesEqual,
  parseListingEvents,
  parsePriceNote,
  parseShopConfig,
  priceFromTabLabel,
  reconcileShopScan,
  type ListingEvent,
  type ShopSnapshot,
} from "../src/core/shopListings.js";
import { starterPriceTable } from "../src/core/priceTable.js";

/**
 * Pure ground truth behind docs/HANDOFF-shop-listings.md: the Note line is
 * the listing's state, the ledger is append-only, and every heuristic
 * inference (sold vs. removed, hand-listed, hand-repriced) is reported.
 */

const RING_TEXT = [
  "Item Class: Rings",
  "Rarity: Rare",
  "Doom Loop",
  "Gold Ring",
  "--------",
  "Item Level: 78",
  "--------",
  "+25% to Fire Resistance",
  "+41 to maximum Life",
  "--------",
  "Note: ~price 5 exalted",
].join("\n");

const RING_TEXT_REPRICED = RING_TEXT.replace("~price 5 exalted", "~price 3 exalted");
const RING_TEXT_UNPRICED = RING_TEXT.split("\n").slice(0, -2).join("\n");

const AMULET_TEXT = [
  "Item Class: Amulets",
  "Rarity: Rare",
  "Corpse Noose",
  "Gold Amulet",
  "--------",
  "Item Level: 80",
  "--------",
  "+30 to Spirit",
  "--------",
  "Note: ~price 2 divine",
].join("\n");

function snapshotOf(items: Array<{ text: string; cells?: Array<{ row: number; col: number }> }>, at = "2026-09-02T10:00:00.000Z"): ShopSnapshot {
  return buildShopSnapshot(
    items.map((item, index) => ({
      text: item.text,
      cells: (item.cells ?? [{ row: 0, col: index }]).map((cell) => ({ ...cell, x: 0, y: 0 })),
    })),
    { at, tab: "Shop", priceTable: starterPriceTable() },
  );
}

describe("price-note ground truth", () => {
  it("parses the Note line out of a full Ctrl+C copy", () => {
    const note = parsePriceNote(RING_TEXT);
    expect(note).toMatchObject({ kind: "price", amount: 5, currency: "exalted" });
  });

  it("parses buyout notes, fractions, and currency aliases", () => {
    expect(parsePriceNote("Note: ~b/o 3 divine")).toMatchObject({ kind: "bo", amount: 3, currency: "divine" });
    expect(parsePriceNote("Note: ~price 5/2 chaos")).toMatchObject({ amount: 2.5, currency: "chaos" });
    expect(parsePriceNote("Note: ~price 10 exalt")).toMatchObject({ currency: "exalted" });
    expect(parsePriceNote("Note: ~price 2 div")).toMatchObject({ currency: "divine" });
  });

  it("keeps unrecognized notes as kind other (user-priced, read-only)", () => {
    expect(parsePriceNote("Note: offers welcome")).toMatchObject({ kind: "other" });
    expect(parsePriceNote("Note: ~price banana")).toMatchObject({ kind: "other" });
    expect(parsePriceNote("Note: ~price 0 exalted")).toMatchObject({ kind: "other" });
  });

  it("returns undefined when there is no note at all", () => {
    expect(parsePriceNote(RING_TEXT_UNPRICED)).toBeUndefined();
  });

  it("round-trips through formatPriceNote", () => {
    const formatted = formatPriceNote(5, "exalted");
    expect(parsePriceNote(`Note: ${formatted}`)).toMatchObject({ kind: "price", amount: 5, currency: "exalted" });
  });

  it("values notes in exalted through the crafting economy", () => {
    const table = starterPriceTable(); // divine = 40 exalted in the starter set
    expect(noteExalted(parsePriceNote(RING_TEXT), table)).toBe(5);
    expect(noteExalted(parsePriceNote("Note: ~price 2 divine"), table)).toBe(80);
    expect(noteExalted(parsePriceNote("Note: gibberish"), table)).toBeUndefined();
  });

  it("compares notes by substance", () => {
    expect(notesEqual(parsePriceNote(RING_TEXT), parsePriceNote("Note: ~price 5 exalted"))).toBe(true);
    expect(notesEqual(parsePriceNote(RING_TEXT), parsePriceNote(RING_TEXT_REPRICED))).toBe(false);
  });

  it("folds currency aliases", () => {
    expect(normalizeNoteCurrency("Exalt")).toBe("exalted");
    expect(normalizeNoteCurrency("div")).toBe("divine");
    expect(normalizeNoteCurrency("mirror")).toBe("mirror"); // unknown stays itself
  });
});

describe("shop config", () => {
  it("defaults match the handoff's open-question defaults", () => {
    const config = defaultShopConfig();
    expect(config.returnTab).toBe("Dump");
    expect(config.undercutPercent).toBe(5);
    expect(config.compsPercentile).toBe(25);
    expect(config.staleDays).toBe(3);
    expect(config.maxAutoList).toEqual({ amount: 1, currency: "divine" });
    expect(config.sources).toEqual(["bag"]);
  });

  it("refuses to run without a designated shop tab", () => {
    const { config, issues } = parseShopConfig({});
    expect(config.shopTab).toBe("");
    expect(issues.some((issue) => /shopTab is not set/.test(issue))).toBe(true);
  });

  it("sanitizes a hostile config to safe values", () => {
    const { config } = parseShopConfig({
      shopTab: "  Shop  ",
      undercutPercent: 500,
      compsPercentile: -3,
      ladder: [{ afterDays: -1, stepPercent: 8 }, { afterDays: 4, stepPercent: 10 }],
      maxAutoList: { amount: 2, currency: "Div" },
      sources: ["bag", "review", "nonsense"],
    });
    expect(config.shopTab).toBe("Shop");
    expect(config.undercutPercent).toBe(90);
    expect(config.compsPercentile).toBe(1);
    expect(config.ladder).toEqual([{ afterDays: 4, stepPercent: 10 }]);
    expect(config.maxAutoList).toEqual({ amount: 2, currency: "divine" });
    expect(config.sources).toEqual(["bag", "review"]);
  });

  it("converts the auto-list cap to exalted at the live rate", () => {
    const { config } = parseShopConfig({ shopTab: "Shop" });
    expect(maxAutoListExalted(config, starterPriceTable())).toBe(40);
  });
});

describe("snapshot building", () => {
  it("attaches parsed notes and exalted values to scanned items", () => {
    const snapshot = snapshotOf([{ text: RING_TEXT }, { text: AMULET_TEXT }, { text: RING_TEXT_UNPRICED }]);
    expect(snapshot.items).toHaveLength(3);
    expect(snapshot.items[0]!.note).toMatchObject({ amount: 5, currency: "exalted" });
    expect(snapshot.items[0]!.priceExalted).toBe(5);
    expect(snapshot.items[1]!.priceExalted).toBe(80);
    expect(snapshot.unpricedCount).toBe(1);
  });

  it("gives repriced copies of one item a stable fingerprint", () => {
    const a = snapshotOf([{ text: RING_TEXT }]).items[0]!;
    const b = snapshotOf([{ text: RING_TEXT_REPRICED }]).items[0]!;
    expect(a.fingerprint).toBe(b.fingerprint);
  });
});

describe("ledger derivation", () => {
  const listed: ListingEvent = {
    at: "2026-09-01T10:00:00.000Z",
    kind: "listed",
    fingerprint: "f1",
    name: "Doom Loop",
    itemClass: "Rings",
    count: 1,
    by: "app",
    certainty: "verified",
    price: { amount: 5, currency: "exalted", exalted: 5 },
  };

  it("folds listed → repriced → sold into an empty shop", () => {
    const events: ListingEvent[] = [
      listed,
      {
        ...listed,
        at: "2026-09-02T10:00:00.000Z",
        kind: "repriced",
        price: { amount: 3, currency: "exalted", exalted: 3 },
      },
      { ...listed, at: "2026-09-03T10:00:00.000Z", kind: "sold", certainty: "heuristic" },
    ];
    expect(deriveShopState(events)).toHaveLength(0);
    const midway = deriveShopState(events.slice(0, 2));
    expect(midway).toHaveLength(1);
    expect(midway[0]!.price?.amount).toBe(3);
    // The reprice resets the staleness clock but not the original listing date.
    expect(midway[0]!.listedAt).toBe("2026-09-01T10:00:00.000Z");
    expect(midway[0]!.pricedAt).toBe("2026-09-02T10:00:00.000Z");
  });

  it("tracks duplicate copies by count", () => {
    const events: ListingEvent[] = [
      { ...listed, count: 3 },
      { ...listed, at: "2026-09-02T00:00:00.000Z", kind: "sold", count: 2, certainty: "heuristic" },
    ];
    const state = deriveShopState(events);
    expect(state).toHaveLength(1);
    expect(state[0]!.count).toBe(1);
  });

  it("a user reprice makes the listing read-only for automation", () => {
    const state = deriveShopState([
      listed,
      {
        ...listed,
        at: "2026-09-02T00:00:00.000Z",
        kind: "repriced",
        by: "user",
        certainty: "heuristic",
        price: { amount: 9, currency: "exalted", exalted: 9 },
      },
    ]);
    expect(state[0]!.by).toBe("user");
  });

  it("an app price write on a hand-listed item takes ownership without double-counting", () => {
    const { price: _unpricedHandListing, ...handListed } = listed;
    const state = deriveShopState([
      { ...handListed, by: "user", certainty: "heuristic" },
      {
        ...listed,
        at: "2026-09-02T00:00:00.000Z",
        kind: "repriced",
        by: "app",
        price: { amount: 4, currency: "exalted", exalted: 4 },
      },
    ]);
    expect(state).toHaveLength(1);
    expect(state[0]!.count).toBe(1);
    expect(state[0]!.by).toBe("app");
    expect(state[0]!.price?.amount).toBe(4);
  });

  it("survives a truncated trailing ledger line", () => {
    const jsonl = `${JSON.stringify(listed)}\n{"at":"2026-09-02","kind":"sol`;
    expect(parseListingEvents(jsonl)).toHaveLength(1);
  });
});

describe("scan reconciliation", () => {
  const ring = snapshotOf([{ text: RING_TEXT }]).items[0]!;
  const baseListing = {
    fingerprint: ring.fingerprint,
    name: "Doom Loop",
    itemClass: "Rings",
    count: 1,
    price: { amount: 5, currency: "exalted", exalted: 5 },
    listedAt: "2026-09-01T10:00:00.000Z",
    pricedAt: "2026-09-01T10:00:00.000Z",
    lastEventAt: "2026-09-01T10:00:00.000Z",
    by: "app" as const,
  };

  it("marks a vanished listing SOLD (heuristic, reported) with its realized price", () => {
    const { events, report } = reconcileShopScan({
      state: [baseListing],
      snapshot: snapshotOf([]),
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "sold",
      certainty: "heuristic",
      realized: { amount: 5, currency: "exalted" },
    });
    expect(report.some((line) => /presumed SOLD/.test(line))).toBe(true);
  });

  it("distinguishes user removal when the item is known elsewhere", () => {
    const { events, report } = reconcileShopScan({
      state: [baseListing],
      snapshot: snapshotOf([]),
      knownElsewhere: new Set([baseListing.fingerprint]),
    });
    expect(events[0]!.kind).toBe("delisted");
    expect(events[0]!.by).toBe("user");
    expect(report.some((line) => /removed by hand/.test(line))).toBe(true);
  });

  it("records a hand-listed item as user-owned", () => {
    const { events, report } = reconcileShopScan({
      state: [],
      snapshot: snapshotOf([{ text: RING_TEXT }]),
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "listed", by: "user", certainty: "heuristic" });
    expect(events[0]!.price).toMatchObject({ amount: 5, currency: "exalted" });
    expect(report.some((line) => /hand-listed/.test(line))).toBe(true);
  });

  it("records a note change this flow did not make as a user reprice", () => {
    const { events, report } = reconcileShopScan({
      state: [baseListing],
      snapshot: snapshotOf([{ text: RING_TEXT_REPRICED }]),
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "repriced",
      by: "user",
      price: { amount: 3 },
      previousPrice: { amount: 5 },
    });
    expect(report.some((line) => /user reprice/.test(line))).toBe(true);
  });

  it("an unchanged shop produces no events", () => {
    const { events, report } = reconcileShopScan({
      state: [baseListing],
      snapshot: snapshotOf([{ text: RING_TEXT }]),
    });
    expect(events).toHaveLength(0);
    expect(report).toHaveLength(0);
  });

  it("handles duplicate-count deltas (one of three sold)", () => {
    const { events } = reconcileShopScan({
      state: [{ ...baseListing, count: 3 }],
      snapshot: snapshotOf([
        { text: RING_TEXT, cells: [{ row: 0, col: 0 }] },
        { text: RING_TEXT, cells: [{ row: 0, col: 1 }] },
      ]),
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "sold", count: 1 });
  });
});

describe("age math", () => {
  it("computes listing age in days", () => {
    const now = Date.parse("2026-09-04T10:00:00.000Z");
    expect(ageDays("2026-09-01T10:00:00.000Z", now)).toBe(3);
    expect(ageDays("not-a-date", now)).toBe(0);
  });
});

describe("price-bucket tabs", () => {
  it("reads the price out of a bucket tab's name", () => {
    expect(priceFromTabLabel("1Ex")).toMatchObject({ amount: 1, currency: "exalted" });
    expect(priceFromTabLabel("10Ex")).toMatchObject({ amount: 10, currency: "exalted" });
    expect(priceFromTabLabel("5D")).toMatchObject({ amount: 5, currency: "divine" });
    expect(priceFromTabLabel(" 2 div ")).toMatchObject({ amount: 2, currency: "divine" });
    expect(priceFromTabLabel("3c")).toMatchObject({ amount: 3, currency: "chaos" });
  });

  it("ignores tabs that are not buckets", () => {
    for (const label of ["8", "9", "Shop", "Earnings (Remove-only)", "0Ex", "Ex"]) {
      expect(priceFromTabLabel(label)).toBeUndefined();
    }
  });

  it("orders the user's buckets cheapest first at the live rate", () => {
    const buckets = bucketTabs(
      ["1Ex", "5Ex", "10Ex", "1D", "2D", "3D", "5D", "8", "9"],
      starterPriceTable(), // divine = 40 exalted
    );
    expect(buckets.map((bucket) => bucket.label)).toEqual(["1Ex", "5Ex", "10Ex", "1D", "2D", "3D", "5D"]);
    expect(buckets.map((bucket) => bucket.exalted)).toEqual([1, 5, 10, 40, 80, 120, 200]);
  });

  it("snaps an estimate DOWN to the dearest bucket it clears", () => {
    const buckets = bucketTabs(["1Ex", "5Ex", "10Ex", "1D", "2D"], starterPriceTable());
    expect(bucketFor(7, buckets)?.label).toBe("5Ex");
    expect(bucketFor(45, buckets)?.label).toBe("1D");
    expect(bucketFor(1, buckets)?.label).toBe("1Ex");
    expect(bucketFor(0.5, buckets)).toBeUndefined();
    expect(bucketFor(500, buckets)?.label).toBe("2D");
  });
});

describe("bucket labels under OCR", () => {
  it("folds confusable digits (IOEx, lEx) but keeps the raw label for clicking", () => {
    expect(priceFromTabLabel("IOEx")).toMatchObject({ amount: 10, currency: "exalted", label: "IOEx" });
    expect(priceFromTabLabel("lEx")).toMatchObject({ amount: 1, currency: "exalted" });
    expect(priceFromTabLabel("5D")).toMatchObject({ amount: 5, currency: "divine" });
  });
});
