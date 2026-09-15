import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  netWorth,
  latestObservations,
  parseInventoryRecords,
  type InventoryRecord,
} from "../src/core/inventoryLedger.js";
import { PRICE_TABLE_SCHEMA_VERSION, type PriceTable } from "../src/core/priceTable.js";
import {
  applyExclusions,
  diffSnapshots,
  effectiveTotal,
  filterSnapshotItems,
  locationTotals,
  parseSnapshotJournal,
  pruneSnapshots,
  sanitizeLabel,
  serializeSnapshot,
  sessionGains,
  shouldAutoSnapshot,
  snapshotFromLedger,
  snapshotMeta,
  trackerSummary,
  type SnapshotKind,
  type WealthSnapshot,
} from "../src/core/stashTrackerSnapshot.js";

function table(): PriceTable {
  return {
    schemaVersion: PRICE_TABLE_SCHEMA_VERSION,
    currency: "exalted",
    entries: [
      { id: "divine", match: { name: "Divine Orb" }, value: 98 },
      { id: "exalted", match: { name: "Exalted Orb" }, value: 1 },
      { id: "storm", match: { name: "Storm Loop" }, value: 3 },
      { id: "hh", match: { name: "Headhunter" }, value: 120 },
    ],
  };
}

function record(partial: Partial<InventoryRecord> & Pick<InventoryRecord, "at" | "location" | "fingerprint" | "name">): InventoryRecord {
  return {
    cells: [{ row: 0, col: 0 }],
    itemClass: "Rings",
    rarity: "Unique",
    identified: true,
    runId: "run-1",
    ...partial,
  };
}

/** The design's worked example: two tabs, a stack, and a bag→tab handover. */
function ledger(): InventoryRecord[] {
  return [
    record({
      at: "2026-09-12T18:20:05.000Z",
      location: "Rings",
      fingerprint: "a1b2c3d4a1b2c3d4",
      name: "Storm Loop",
      cells: [{ row: 3, col: 5 }],
      baseType: "Iron Ring",
      itemLevel: 72,
    }),
    record({
      at: "2026-09-12T18:20:06.000Z",
      location: "Rings",
      fingerprint: "b2c3d4e5b2c3d4e5",
      name: "Doom Noose",
      itemClass: "Amulets",
      rarity: "Rare",
      cells: [{ row: 0, col: 2 }],
    }),
    record({
      at: "2026-09-12T18:21:10.000Z",
      location: "Currency",
      fingerprint: "ffffffffffffffff",
      name: "Exalted Orb",
      itemClass: "Stackable Currency",
      rarity: "Currency",
      cells: [
        { row: 0, col: 0 },
        { row: 0, col: 1 },
      ],
      count: 2,
      stackCount: 37,
    }),
    record({
      at: "2026-09-12T18:22:00.000Z",
      location: "bag",
      fingerprint: "cafebabecafebabe",
      name: "Headhunter",
      itemClass: "Belts",
      partial: true,
    }),
    record({
      at: "2026-09-12T18:31:55.000Z",
      location: "Belts",
      fingerprint: "cafebabecafebabe",
      name: "Headhunter",
      itemClass: "Belts",
      runId: "run-2",
    }),
  ];
}

function snapshot(
  overrides: Partial<WealthSnapshot> = {},
  input: { at?: string; kind?: SnapshotKind; sessionId?: string; label?: string } = {},
): WealthSnapshot {
  return {
    ...snapshotFromLedger(ledger(), table(), {
      at: input.at ?? "2026-09-12T18:40:03.120Z",
      kind: input.kind ?? "manual",
      sessionId: input.sessionId ?? "s-1",
      ...(input.label !== undefined ? { label: input.label } : {}),
    }),
    ...overrides,
  };
}

describe("snapshotFromLedger", () => {
  it("totals exactly what netWorth totals, with stack units and the bag handover", () => {
    const records = ledger();
    const worth = netWorth(latestObservations(records), table());
    const built = snapshotFromLedger(records, table(), {
      at: "2026-09-12T18:40:03.120Z",
      kind: "manual",
      sessionId: "s-1",
    });
    expect(built.totalExalted).toBe(worth.totalExalted);
    expect(built.totalExalted).toBe(160);
    expect(built.totalDivine).toBe(1.63);
    expect(built.divineRate).toBe(98);
    expect(built.recordCount).toBe(5);
    expect(built.ledgerAt).toBe("2026-09-12T18:31:55.000Z");
    expect(built.id).toBe("snap-2026-09-12T18-40-03-120Z");
    const exalted = built.items.find((item) => item.name === "Exalted Orb")!;
    expect(exalted).toMatchObject({ count: 2, units: 37, stackable: true, valueExalted: 37 });
    // The bag sighting was superseded by the Belts full run.
    const headhunter = built.items.filter((item) => item.name === "Headhunter");
    expect(headhunter).toHaveLength(1);
    expect(headhunter[0]!.location).toBe("Belts");
    const doom = built.items.find((item) => item.name === "Doom Noose")!;
    expect(doom.source).toBe("none");
    expect(doom.valueExalted).toBeUndefined();
  });

  it("sanitizes the label", () => {
    expect(sanitizeLabel("  before   mapping  ")).toBe("before mapping");
    expect(sanitizeLabel("a\nb\tc")).toBe("a b c");
    expect(sanitizeLabel("x".repeat(200))).toHaveLength(60);
    expect(sanitizeLabel("   ")).toBeUndefined();
    expect(sanitizeLabel(42)).toBeUndefined();
    expect(snapshot({}, { label: "  first  " }).label).toBe("first");
  });
});

describe("exclusions", () => {
  it("removes the excluded item from the totals and its location", () => {
    const built = snapshot();
    const excluded = new Set(["cafebabecafebabe"]);
    const applied = applyExclusions(built, excluded);
    expect(applied.totalExalted).toBe(40);
    expect(applied.excludedExalted).toBe(120);
    expect(applied.items.some((item) => item.name === "Headhunter")).toBe(false);
    const belts = applied.locations.find((entry) => entry.location === "Belts")!;
    expect(belts).toMatchObject({ items: 0, valueExalted: 0, excludedItems: 1, excludedExalted: 120 });
  });

  it("ignores unknown fingerprints and reports meta", () => {
    const built = snapshot();
    const meta = snapshotMeta(built, new Set(["not-a-real-fingerprint"]));
    expect(meta.effectiveExalted).toBe(160);
    expect(meta.effectiveDivine).toBe(1.63);
    expect(meta.itemCount).toBe(4);
    expect(meta).not.toHaveProperty("items");
  });

  it("keeps the recorded total for a snapshot whose items were trimmed", () => {
    const built = snapshot({ items: [], itemsTrimmed: true });
    expect(effectiveTotal(built, new Set(["cafebabecafebabe"]))).toBe(160);
  });

  it("counts unpriced items per location", () => {
    const rows = locationTotals(snapshot().items, new Set());
    const rings = rows.find((entry) => entry.location === "Rings")!;
    expect(rings).toMatchObject({ items: 2, priced: 1, unpriced: 1, valueExalted: 3 });
  });
});

describe("filterSnapshotItems", () => {
  const items = snapshot().items;

  it("filters by unit value, total value, location, text and exclusion", () => {
    expect(
      filterSnapshotItems(items, { minUnitExalted: 2 }, new Set())
        .map((i) => i.name)
        .sort(),
    ).toEqual(["Headhunter", "Storm Loop"]);
    expect(filterSnapshotItems(items, { minTotalExalted: 30 }, new Set()).map((i) => i.name).sort()).toEqual([
      "Exalted Orb",
      "Headhunter",
    ]);
    expect(filterSnapshotItems(items, { location: "Rings" }, new Set())).toHaveLength(2);
    expect(filterSnapshotItems(items, { query: "storm" }, new Set()).map((i) => i.name)).toEqual([
      "Storm Loop",
    ]);
    const excluded = new Set(["cafebabecafebabe"]);
    expect(filterSnapshotItems(items, {}, excluded).map((i) => i.name)).not.toContain("Headhunter");
    expect(
      filterSnapshotItems(items, { includeExcluded: true }, excluded).map((i) => i.name),
    ).toContain("Headhunter");
  });
});

describe("diffSnapshots", () => {
  function laterLedger(): InventoryRecord[] {
    return [
      ...ledger(),
      record({
        at: "2026-09-13T09:00:20.000Z",
        location: "Currency",
        fingerprint: "ffffffffffffffff",
        name: "Exalted Orb",
        itemClass: "Stackable Currency",
        rarity: "Currency",
        cells: [
          { row: 0, col: 0 },
          { row: 0, col: 1 },
        ],
        count: 2,
        stackCount: 52,
        runId: "run-3",
      }),
      record({
        at: "2026-09-13T09:01:30.000Z",
        location: "bag",
        fingerprint: "cafebabecafebabe",
        name: "Headhunter",
        itemClass: "Belts",
        runId: "run-4",
      }),
    ];
  }

  it("reports added, removed, changed and moved, and its total equals the effective difference", () => {
    const from = snapshot();
    const to: WealthSnapshot = {
      ...snapshotFromLedger(laterLedger(), table(), {
        at: "2026-09-13T09:10:00.000Z",
        kind: "manual",
        sessionId: "s-1",
      }),
      id: "snap-to",
    };
    const diff = diffSnapshots(from, to);
    expect(diff.changed).toBe(1);
    expect(diff.moved).toBe(1);
    expect(diff.totalDelta).toBe(15);
    expect(diff.totalDelta).toBe(
      Math.round((effectiveTotal(to, new Set()) - effectiveTotal(from, new Set())) * 100) / 100,
    );
    const stack = diff.deltas.find((delta) => delta.name === "Exalted Orb")!;
    expect(stack).toMatchObject({ kind: "changed", unitsDelta: 15, valueDelta: 15 });
    const moved = diff.deltas.find((delta) => delta.name === "Headhunter")!;
    expect(moved).toMatchObject({ kind: "moved", valueDelta: 0 });
    expect(moved.before?.location).toBe("Belts");
    expect(moved.after?.location).toBe("bag");
    // Sorted by |Δ value| first.
    expect(diff.deltas[0]!.name).toBe("Exalted Orb");
  });

  it("reports added and removed items and drops excluded ones from both sides", () => {
    const from = snapshot();
    const to = snapshot({
      id: "snap-to",
      items: from.items.filter((item) => item.name !== "Storm Loop"),
    });
    const diff = diffSnapshots(from, to);
    expect(diff.removed).toBe(1);
    expect(diff.deltas[0]).toMatchObject({ kind: "removed", valueDelta: -3, unitsDelta: -1 });

    const excludedDiff = diffSnapshots(from, to, new Set(["a1b2c3d4a1b2c3d4"]));
    expect(excludedDiff.deltas).toEqual([]);
    expect(excludedDiff.totalDelta).toBe(0);
  });

  it("gives totals only when one side lost its items to pruning", () => {
    const from = snapshot({ items: [], itemsTrimmed: true, totalExalted: 100 });
    const to = snapshot({ id: "snap-to" });
    const diff = diffSnapshots(from, to);
    expect(diff.trimmed).toBe(true);
    expect(diff.deltas).toEqual([]);
    expect(diff.totalDelta).toBe(60);
  });
});

describe("sessionGains", () => {
  it("measures from the newest session-start of the session to the live snapshot", () => {
    const start = snapshot({ id: "snap-start" }, { kind: "session-start", at: "2026-09-12T17:00:00.000Z" });
    const trimmedStart: WealthSnapshot = { ...start, items: start.items.slice(0, 1) };
    const current = snapshot({ id: "current" });
    const gains = sessionGains([trimmedStart], "s-1", current, new Set(), Date.parse("2026-09-12T19:00:00.000Z"));
    expect(gains.start?.id).toBe("snap-start");
    expect(gains.latest?.id).toBe("current");
    expect(gains.deltaExalted).toBe(40);
    expect(gains.elapsedMs).toBe(2 * 60 * 60_000);
    expect(gains.topGains.length).toBeLessThanOrEqual(5);
    expect(gains.topGains.every((delta) => delta.valueDelta > 0)).toBe(true);
  });

  it("reports zero without a session anchor", () => {
    const gains = sessionGains([], "s-1", undefined, new Set(), Date.now());
    expect(gains).toMatchObject({ deltaExalted: 0, deltaDivine: 0, elapsedMs: 0 });
    expect(gains.start).toBeUndefined();
  });
});

describe("the journal", () => {
  it("round-trips on one line and skips junk, torn tails, wrong versions and duplicate ids", () => {
    const built = snapshot({}, { label: "line\nbreak" });
    const line = serializeSnapshot(built);
    expect(line).not.toContain("\n");
    const text = [
      line,
      line, // duplicate id
      "not json at all",
      JSON.stringify({ ...built, version: 2, id: "other" }),
      `{"version":1,"id":"torn`,
    ].join("\n");
    const parsed = parseSnapshotJournal(text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.id).toBe(built.id);
    expect(parsed[0]!.items).toHaveLength(built.items.length);
    expect(parsed[0]!.label).toBe("line break");
  });

  it("drops item rows it cannot vouch for", () => {
    const built = snapshot();
    const broken = JSON.stringify({
      ...built,
      items: [...built.items, { fingerprint: "x", location: "Rings" }, { count: 0 }],
    });
    expect(parseSnapshotJournal(broken)[0]!.items).toHaveLength(built.items.length);
  });
});

describe("pruneSnapshots", () => {
  function at(day: number, kind: SnapshotKind): WealthSnapshot {
    return snapshot({ id: `snap-${day}-${kind}` }, { kind, at: `2026-09-${String(day).padStart(2, "0")}T10:00:00.000Z` });
  }

  it("never drops a named snapshot and takes the oldest disposable ones first", () => {
    const list = [at(1, "auto"), at(2, "manual"), at(3, "session-start"), at(4, "auto")];
    const pruned = pruneSnapshots(list, 2, { now: Date.parse("2026-09-04T12:00:00.000Z") });
    expect(pruned.dropped).toEqual(["snap-1-auto"]);
    expect(pruned.kept.map((entry) => entry.id)).toEqual([
      "snap-2-manual",
      "snap-3-session-start",
      "snap-4-auto",
    ]);
  });

  it("trims the item list of auto snapshots older than a week, keeping their totals", () => {
    const old = at(1, "auto");
    const recent = at(20, "auto");
    const pruned = pruneSnapshots([old, recent], 50, {
      now: Date.parse("2026-09-20T12:00:00.000Z"),
    });
    expect(pruned.trimmed).toEqual(["snap-1-auto"]);
    expect(pruned.kept[0]).toMatchObject({ items: [], itemsTrimmed: true, totalExalted: 160 });
    expect(pruned.kept[1]!.items.length).toBeGreaterThan(0);
  });
});

describe("shouldAutoSnapshot", () => {
  const base = { now: 1_000_000, settleMs: 60_000, recordCount: 10, ledgerAt: "2026-09-12T18:31:55.000Z" };

  it("waits for the settle window, then fires once per ledgerAt", () => {
    expect(shouldAutoSnapshot({ ...base, fileChangedAt: 990_000 })).toBe(false);
    expect(shouldAutoSnapshot({ ...base, fileChangedAt: 900_000 })).toBe(true);
    expect(
      shouldAutoSnapshot({
        ...base,
        fileChangedAt: 900_000,
        latest: { ledgerAt: base.ledgerAt, at: "2026-09-12T18:33:00.000Z" },
      }),
    ).toBe(false);
  });

  it("never fires on an empty or unreadable ledger", () => {
    expect(shouldAutoSnapshot({ ...base, recordCount: 0 })).toBe(false);
    expect(shouldAutoSnapshot({ ...base, ledgerAt: undefined })).toBe(false);
  });
});

describe("trackerSummary", () => {
  it("mirrors the session gain with exclusions applied", () => {
    const start = snapshot({ id: "snap-start" }, { kind: "session-start", at: "2026-09-12T17:00:00.000Z" });
    const current = snapshot({ id: "current" });
    const summary = trackerSummary(
      [start],
      "s-1",
      current,
      new Set(["cafebabecafebabe"]),
      "2026-09-12T19:00:00.000Z",
    );
    expect(summary).toMatchObject({
      version: 1,
      sessionId: "s-1",
      snapshotCount: 1,
      excludedCount: 1,
      sessionGainExalted: 0,
    });
    expect(summary.sessionStart).toMatchObject({ id: "snap-start", totalExalted: 40 });
    expect(summary.latest).toMatchObject({ id: "current", kind: "manual", totalExalted: 40 });
  });

  it("omits the anchor when the session has none", () => {
    const summary = trackerSummary([], "s-9", undefined, new Set(), "2026-09-12T19:00:00.000Z");
    expect(summary.sessionStart).toBeUndefined();
    expect(summary.latest).toBeUndefined();
  });
});

/**
 * The shipped fixtures are the contract for anyone who reads a ledger or a
 * journal written by an older build: parse them here so a shape change cannot
 * land while a stale sample sits unverified in fixtures/.
 */
describe("fixtures/stashTracker", () => {
  const SAMPLE_LEDGER = readFileSync(
    new URL("../fixtures/stashTracker/inventory-sample.jsonl", import.meta.url),
    "utf8",
  );
  const SAMPLE_JOURNAL = readFileSync(
    new URL("../fixtures/stashTracker/stash-snapshots-sample.jsonl", import.meta.url),
    "utf8",
  );

  it("turns inventory-sample.jsonl into the worked snapshot, torn tail dropped", () => {
    const records = parseInventoryRecords(SAMPLE_LEDGER);
    expect(records).toHaveLength(10);
    const snapshot = snapshotFromLedger(records, table(), {
      at: "2026-09-13T10:00:00.000Z",
      kind: "manual",
      sessionId: "s-fixture",
    });
    expect(snapshot.recordCount).toBe(10);
    expect(snapshot.ledgerAt).toBe("2026-09-13T09:01:40.000Z");

    // The bag → Belts handover counts the Headhunter once, where it ended up.
    const headhunter = snapshot.items.filter((item) => item.fingerprint === "cafebabecafebabe");
    expect(headhunter).toHaveLength(1);
    expect(headhunter[0]!.location).toBe("Belts");

    // The stack is the LAST observed size, never 37 + 52.
    const exalted = snapshot.items.find((item) => item.fingerprint === "ffffffffffffffff")!;
    expect(exalted).toMatchObject({ units: 52, stackable: true, valueExalted: 52 });

    expect([...new Set(snapshot.items.map((item) => item.location))].sort()).toEqual([
      "Belts",
      "Currency",
      "Jewels",
      "Rings",
    ]);
    expect(snapshot.totalExalted).toBe(netWorth(latestObservations(records), table()).totalExalted);
  });

  it("reads stash-snapshots-sample.jsonl, skipping the wrong version and the torn tail", () => {
    const journal = parseSnapshotJournal(SAMPLE_JOURNAL);
    expect(journal.map((snapshot) => snapshot.id)).toEqual([
      "snap-2026-09-10T17-02-11-004Z",
      "snap-2026-09-10T21-40-00-000Z",
      "snap-2026-09-11T19-15-00-000Z",
      "snap-2026-09-12T18-40-03-120Z",
      "snap-2026-09-12T19-05-00-000Z",
    ]);
    expect(journal.every((snapshot) => snapshot.version === 1)).toBe(true);
    // The trimmed auto snapshot keeps its totals even with no item list.
    const trimmed = journal.find((snapshot) => snapshot.itemsTrimmed)!;
    expect(trimmed.items).toEqual([]);
    expect(effectiveTotal(trimmed, new Set())).toBe(1330);
    // Every other line must stay self-consistent: `effectiveTotal` recomputes
    // from the item list, so a sample list that does not sum to the recorded
    // total would make the fixture lie about its own worth.
    for (const snapshot of journal) {
      if (snapshot.itemsTrimmed) continue;
      expect(effectiveTotal(snapshot, new Set())).toBe(snapshot.totalExalted);
    }
    expect(journal.map((snapshot) => snapshot.totalExalted)).toEqual([
      1280, 1330, 1400, 1433, 1470,
    ]);
  });
});
