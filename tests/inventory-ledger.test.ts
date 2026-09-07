import { describe, expect, it } from "vitest";
import type { IdentifiedItem } from "../src/core/gearSort.js";
import {
  describeAge,
  inventoryRecordsFor,
  latestObservations,
  locationStaleness,
  netWorth,
  parseInventoryRecords,
  searchObservations,
  sellCandidates,
  valueObservation,
  type InventoryRecord,
} from "../src/core/inventoryLedger.js";
import { emptyPriceTable, type PriceTable } from "../src/core/priceTable.js";
import type { TierVerdict } from "../src/core/valueTiers.js";

const RING = [
  "Item Class: Rings",
  "Rarity: Rare",
  "Storm Loop",
  "Iron Ring",
  "--------",
  "Item Level: 72",
  "--------",
  "+62 to maximum Life",
  "+31% to Fire Resistance",
].join("\n");

const AMULET = [
  "Item Class: Amulets",
  "Rarity: Rare",
  "Doom Noose",
  "Jade Amulet",
  "--------",
  "Item Level: 68",
  "--------",
  "+40 to maximum Mana",
].join("\n");

const UNIQUE = [
  "Item Class: Belts",
  "Rarity: Unique",
  "Headhunter",
  "Heavy Belt",
  "--------",
  "Item Level: 80",
  "--------",
  "+40 to Strength",
].join("\n");

const exalted = (stack: number): string =>
  ["Item Class: Stackable Currency", "Rarity: Currency", "Exalted Orb", "--------", `Stack Size: ${stack}/20`].join(
    "\n",
  );

function identified(text: string, row: number, col: number, extraCells = 0): IdentifiedItem {
  const cells = [{ row, col, x: 0, y: 0 }];
  for (let i = 1; i <= extraCells; i += 1) cells.push({ row: row + i, col, x: 0, y: 0 });
  return { dest: "Rings", itemClass: "Rings", text, cells };
}

function table(entries: PriceTable["entries"]): PriceTable {
  return { ...emptyPriceTable(), entries };
}

const PRICES = table([
  { id: "divine", match: { name: "Divine Orb" }, value: 50 },
  { id: "exalt", match: { name: "Exalted Orb" }, value: 1 },
  { id: "hh", match: { name: "Headhunter" }, value: 120 },
]);

function verdictWithEstimate(amount: number): TierVerdict {
  return {
    tier: "sell",
    source: "heuristic",
    reasons: [],
    matchedRules: [],
    appraisal: {
      valueScore: 60,
      confidence: 70,
      band: "high",
      evidence: "mods",
      reasons: [],
      mods: [],
      estimatedValue: { amount, currency: "exalted", basis: "price-table", unitValue: amount },
    },
  };
}

describe("inventoryRecordsFor", () => {
  it("shapes one record per fingerprint with merged cells and counts", () => {
    const records = inventoryRecordsFor(
      [identified(RING, 0, 0), identified(RING, 5, 5), identified(AMULET, 2, 2, 1)],
      { location: "Rings", runId: "r1", at: "2026-09-07T10:00:00.000Z" },
    );
    expect(records).toHaveLength(2);
    const ring = records.find((record) => record.name === "Storm Loop")!;
    expect(ring).toMatchObject({
      location: "Rings",
      runId: "r1",
      itemClass: "Rings",
      rarity: "Rare",
      itemLevel: 72,
      identified: true,
      baseType: "Iron Ring",
      count: 2,
    });
    expect(ring.cells).toEqual([
      { row: 0, col: 0 },
      { row: 5, col: 5 },
    ]);
    expect(ring.stackCount).toBeUndefined();
    const amulet = records.find((record) => record.name === "Doom Noose")!;
    expect(amulet.cells).toHaveLength(2);
    expect(amulet.count).toBe(1);
  });

  it("sums currency stacks and carries the evaluator's estimate", () => {
    const records = inventoryRecordsFor(
      [identified(exalted(12), 0, 0), identified(exalted(3), 0, 1)],
      {
        location: "bag",
        runId: "r1",
        at: "2026-09-07T10:00:00.000Z",
        evaluate: (text) => verdictWithEstimate(text.includes("12/20") ? 12 : 3),
      },
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      name: "Exalted Orb",
      count: 2,
      stackCount: 15,
      estimate: { amount: 15, currency: "exalted" },
      valueScore: 60,
      confidence: 70,
      tier: "sell",
    });
  });

  it("skips text that is not an item and flags partial deposits", () => {
    const records = inventoryRecordsFor(
      [identified("garbage", 0, 0), identified(RING, 1, 1)],
      { location: "Rings", runId: "r1", at: "now", partial: true },
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.partial).toBe(true);
  });
});

describe("parseInventoryRecords", () => {
  it("keeps well-formed lines and drops truncated or shapeless ones", () => {
    const good: InventoryRecord = {
      at: "2026-09-07T10:00:00.000Z",
      location: "Rings",
      cells: [{ row: 0, col: 0 }],
      fingerprint: "abc",
      name: "Storm Loop",
      itemClass: "Rings",
      rarity: "Rare",
      identified: true,
      runId: "r1",
    };
    const parsed = parseInventoryRecords(
      `${JSON.stringify(good)}\n{"at":"x"}\n{"at":"trunc\n${JSON.stringify({ ...good, cells: "nope" })}\n`,
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ name: "Storm Loop", cells: [{ row: 0, col: 0 }] });
    expect(parsed[1]?.cells).toEqual([]);
  });
});

function record(
  overrides: Partial<InventoryRecord> & Pick<InventoryRecord, "at" | "location" | "fingerprint" | "runId">,
): InventoryRecord {
  return {
    cells: [{ row: 0, col: 0 }],
    name: overrides.fingerprint,
    itemClass: "Rings",
    rarity: "Rare",
    identified: true,
    count: 1,
    ...overrides,
  };
}

describe("latestObservations", () => {
  it("lets a later sighting elsewhere supersede the earlier one (the item moved)", () => {
    const observations = latestObservations([
      record({ at: "2026-09-07T10:00:00.000Z", location: "Dump", fingerprint: "ring", runId: "r1" }),
      record({ at: "2026-09-07T10:05:00.000Z", location: "bag", fingerprint: "ring", runId: "r1" }),
      record({ at: "2026-09-07T10:06:00.000Z", location: "Rings", fingerprint: "ring", runId: "r1", partial: true }),
    ]);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ location: "Rings", partial: true });
  });

  it("retires a fingerprint when a newer full scan of its location lacks it", () => {
    const observations = latestObservations([
      record({ at: "2026-09-07T10:00:00.000Z", location: "Rings", fingerprint: "sold", runId: "r1" }),
      record({ at: "2026-09-07T10:00:00.000Z", location: "Rings", fingerprint: "kept", runId: "r1" }),
      record({ at: "2026-09-08T10:00:00.000Z", location: "Rings", fingerprint: "kept", runId: "r2" }),
    ]);
    expect(observations.map((entry) => entry.fingerprint)).toEqual(["kept"]);
    expect(observations[0]?.runId).toBe("r2");
  });

  it("keeps partial deposits newer than the last full scan, drops older ones", () => {
    const observations = latestObservations([
      record({ at: "2026-09-07T09:00:00.000Z", location: "Rings", fingerprint: "old-deposit", runId: "r0", partial: true }),
      record({ at: "2026-09-07T10:00:00.000Z", location: "Rings", fingerprint: "scanned", runId: "r1" }),
      record({ at: "2026-09-07T10:30:00.000Z", location: "Rings", fingerprint: "new-deposit", runId: "r1", partial: true }),
    ]);
    expect(observations.map((entry) => entry.fingerprint).sort()).toEqual(["new-deposit", "scanned"]);
  });

  it("lets currency stacks coexist across locations", () => {
    const observations = latestObservations([
      record({ at: "2026-09-07T10:00:00.000Z", location: "Currency", fingerprint: "ex", runId: "r1", stackCount: 200, itemClass: "Stackable Currency" }),
      record({ at: "2026-09-07T10:05:00.000Z", location: "bag", fingerprint: "ex", runId: "r1", stackCount: 3, itemClass: "Stackable Currency" }),
    ]);
    expect(observations).toHaveLength(2);
  });

  it("uses only partials when a location was never fully scanned", () => {
    const observations = latestObservations([
      record({ at: "2026-09-07T10:00:00.000Z", location: "Amulets", fingerprint: "a", runId: "r1", partial: true }),
      record({ at: "2026-09-07T11:00:00.000Z", location: "Amulets", fingerprint: "b", runId: "r2", partial: true }),
    ]);
    expect(observations.map((entry) => entry.fingerprint).sort()).toEqual(["a", "b"]);
  });
});

describe("netWorth", () => {
  const observations = [
    record({ at: "2026-09-07T10:00:00.000Z", location: "Currency", fingerprint: "ex", runId: "r1", name: "Exalted Orb", itemClass: "Stackable Currency", rarity: "Currency", stackCount: 25, count: 2 }),
    record({ at: "2026-09-07T10:00:00.000Z", location: "Belts", fingerprint: "hh", runId: "r1", name: "Headhunter", itemClass: "Belts", rarity: "Unique", baseType: "Heavy Belt" }),
    record({ at: "2026-09-07T11:00:00.000Z", location: "Belts", fingerprint: "est", runId: "r1", name: "Doom Strap", itemClass: "Belts", estimate: { amount: 4, currency: "exalted", basis: "price-table" } }),
    record({ at: "2026-09-07T10:00:00.000Z", location: "Rings", fingerprint: "none", runId: "r1", name: "Plain Loop", itemClass: "Rings" }),
    record({ at: "2026-09-07T10:00:00.000Z", location: "Rings", fingerprint: "div", runId: "r1", name: "Whatever", itemClass: "Rings", estimate: { amount: 1, currency: "divine", basis: "price-table" } }),
  ];

  it("prices stacks by the table, falls back to estimates, and counts the unpriced", () => {
    const summary = netWorth(observations, PRICES);
    expect(summary.divineRate).toBe(50);
    // 25 ex + 120 ex + 4 ex + 1 div (50 ex) = 199 ex
    expect(summary.totalExalted).toBe(199);
    expect(summary.totalDivine).toBe(3.98);
    expect(summary.priced).toBe(5);
    expect(summary.unpriced).toBe(1);
    expect(summary.items).toBe(6);
    const belts = summary.locations.find((entry) => entry.location === "Belts")!;
    expect(belts).toMatchObject({ items: 2, priced: 2, unpriced: 0, valueExalted: 124, lastScanAt: "2026-09-07T11:00:00.000Z" });
    const rings = summary.locations.find((entry) => entry.location === "Rings")!;
    expect(rings).toMatchObject({ items: 2, priced: 1, unpriced: 1, valueExalted: 50 });
    expect(summary.locations[0]?.location).toBe("Belts");
  });

  it("prefers the table over a stored estimate", () => {
    const valued = valueObservation(
      record({ at: "now", location: "Belts", fingerprint: "hh", runId: "r1", name: "Headhunter", itemClass: "Belts", rarity: "Unique", estimate: { amount: 1, currency: "exalted", basis: "price-table" } }),
      PRICES,
    );
    expect(valued).toMatchObject({ valueExalted: 120, source: "price-table" });
  });

  it("falls back to the default divine rate when the table has none", () => {
    expect(netWorth([], emptyPriceTable()).divineRate).toBe(40);
  });
});

describe("sellCandidates", () => {
  const observations = [
    record({ at: "now", location: "Belts", fingerprint: "hh", runId: "r1", name: "Headhunter", itemClass: "Belts", rarity: "Unique" }),
    record({ at: "now", location: "Rings", fingerprint: "r3", runId: "r1", name: "Three Loop", itemClass: "Rings", estimate: { amount: 3, currency: "exalted", basis: "price-table" } }),
    record({ at: "now", location: "Review", fingerprint: "r4", runId: "r1", name: "Review Loop", itemClass: "Rings", estimate: { amount: 4, currency: "exalted", basis: "price-table" } }),
    record({ at: "now", location: "Rings", fingerprint: "pair", runId: "r1", name: "Twin Loop", itemClass: "Rings", count: 2, estimate: { amount: 4, currency: "exalted", basis: "price-table" } }),
    record({ at: "now", location: "Rings", fingerprint: "unid", runId: "r1", name: "Unknown Loop", itemClass: "Rings", identified: false, estimate: { amount: 2, currency: "exalted", basis: "price-table" } }),
    record({ at: "now", location: "Currency", fingerprint: "ex", runId: "r1", name: "Exalted Orb", itemClass: "Stackable Currency", rarity: "Currency", stackCount: 3 }),
    record({ at: "now", location: "Rings", fingerprint: "cheap", runId: "r1", name: "Cheap Loop", itemClass: "Rings", estimate: { amount: 0.5, currency: "exalted", basis: "price-table" } }),
  ];

  it("keeps identified non-currency items inside the per-copy band, skipping excluded tabs", () => {
    const candidates = sellCandidates(observations, {
      priceTable: PRICES,
      minExalted: 1,
      maxExalted: 5,
      excludeLocations: ["review"],
    });
    expect(candidates.map((entry) => entry.observation.name)).toEqual(["Twin Loop", "Three Loop"]);
    expect(candidates[0]?.valueExalted).toBe(4);
  });

  it("defaults to the 1–5 exalted band", () => {
    const names = sellCandidates(observations, { priceTable: PRICES }).map((entry) => entry.observation.name);
    expect(names).toContain("Review Loop");
    expect(names).not.toContain("Headhunter");
    expect(names).not.toContain("Cheap Loop");
  });
});

describe("searchObservations, staleness, ages", () => {
  it("ANDs whitespace-separated terms across name, class, rarity, and location", () => {
    const observations = [
      record({ at: "now", location: "Rings", fingerprint: "a", runId: "r1", name: "Storm Loop", itemClass: "Rings", baseType: "Iron Ring" }),
      record({ at: "now", location: "Belts", fingerprint: "b", runId: "r1", name: "Storm Strap", itemClass: "Belts" }),
    ];
    expect(searchObservations(observations, "storm").map((entry) => entry.name)).toEqual(["Storm Loop", "Storm Strap"]);
    expect(searchObservations(observations, "storm belts").map((entry) => entry.name)).toEqual(["Storm Strap"]);
    expect(searchObservations(observations, "iron").map((entry) => entry.name)).toEqual(["Storm Loop"]);
    expect(searchObservations(observations, "  ")).toHaveLength(2);
  });

  it("reports how old each location's last full scan is, oldest first", () => {
    const stale = locationStaleness(
      [
        record({ at: "2026-09-07T10:00:00.000Z", location: "Rings", fingerprint: "a", runId: "r1" }),
        record({ at: "2026-09-07T11:00:00.000Z", location: "Rings", fingerprint: "b", runId: "r2" }),
        record({ at: "2026-09-06T10:00:00.000Z", location: "Belts", fingerprint: "c", runId: "r0" }),
        record({ at: "2026-09-07T11:30:00.000Z", location: "Belts", fingerprint: "d", runId: "r2", partial: true }),
      ],
      "2026-09-07T12:00:00.000Z",
    );
    expect(stale.map((entry) => entry.location)).toEqual(["Belts", "Rings"]);
    expect(stale[1]).toMatchObject({ runId: "r2", ageMs: 60 * 60 * 1000 });
    expect(describeAge(stale[1]!.ageMs)).toBe("1h ago");
    expect(describeAge(stale[0]!.ageMs)).toBe("26h ago");
    expect(describeAge(5_000)).toBe("just now");
    expect(describeAge(3 * 24 * 3_600_000)).toBe("3d ago");
  });
});
