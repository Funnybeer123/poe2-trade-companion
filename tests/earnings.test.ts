import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ShopKeeper } from "../src/adapters/shopKeeper.js";
import type { GearSorter } from "../src/adapters/gearSorter.js";
import type { SortHarness } from "../src/adapters/sortHarness.js";
import type { StashTabKit, StripEntry } from "../src/adapters/stashTabKit.js";
import { isRemoveOnlyTabLabel } from "../src/core/stashTabAdmin.js";
import { starterPriceTable, type PriceTable } from "../src/core/priceTable.js";
import {
  buildShopSnapshot,
  currencyUnitExalted,
  defaultShopConfig,
  diffEarnings,
  parseListingEvents,
  verifySalesWithEarnings,
  type EarningsDelta,
  type EarningsSnapshot,
  type ListingEvent,
} from "../src/core/shopListings.js";
import { salesStats } from "../src/core/shopPricing.js";

/**
 * Verified sales from the Merchant's "Earnings (Remove-only)" sub-tab
 * (docs/HANDOFF-shop-listings.md, GROUND TRUTH): sale proceeds land there
 * as currency stacks, so the delta between two scans is the only real
 * evidence behind a "sold" row. The heuristic stays the fallback.
 */

const TABLE: PriceTable = {
  ...starterPriceTable(),
  entries: [
    ...starterPriceTable().entries,
    // Pinned explicitly: the starter table no longer ships placeholder rates.
    { id: "test-divine", match: { name: "Divine Orb" }, value: 40 },
    { id: "test-chaos", match: { name: "Chaos Orb" }, value: 0.5 },
  ],
};

function snap(at: string, stacks: Array<[string, number]>): EarningsSnapshot {
  return { at, stacks: stacks.map(([name, count]) => ({ name, count })) };
}

function soldEvent(overrides: Partial<ListingEvent> = {}): ListingEvent {
  return {
    at: "2026-09-06T10:00:00.000Z",
    kind: "sold",
    fingerprint: "f1",
    name: "Doom Loop",
    itemClass: "Rings",
    count: 1,
    by: "unknown",
    certainty: "heuristic",
    realized: { amount: 5, currency: "exalted", exalted: 5 },
    reason: "gone from the shop tab and nowhere else we looked — presumed sold",
    ...overrides,
  };
}

describe("currency unit values", () => {
  it("prices currency names by the table first, then the orb rates", () => {
    expect(currencyUnitExalted("Divine Orb", TABLE)).toBe(40);
    expect(currencyUnitExalted("Exalted Orb", TABLE)).toBe(1);
    expect(currencyUnitExalted("Chaos Orb", TABLE)).toBe(0.5);
    // Not in the starter table: falls through to the crafting economy's rate.
    expect(currencyUnitExalted("Orb of Alchemy", TABLE)).toBeGreaterThan(0);
    expect(currencyUnitExalted("Scroll of Wisdom", TABLE)).toBeUndefined();
  });
});

describe("diffEarnings", () => {
  it("reports per-currency deltas and the proceeds total in exalted", () => {
    const delta = diffEarnings(
      snap("2026-09-05T10:00:00.000Z", [["Exalted Orb", 3]]),
      snap("2026-09-06T10:00:00.000Z", [["Exalted Orb", 8], ["Divine Orb", 1]]),
      TABLE,
    );
    expect(delta.previousAt).toBe("2026-09-05T10:00:00.000Z");
    expect(delta.perCurrency).toEqual([
      { name: "Divine Orb", before: 0, after: 1, delta: 1, unitExalted: 40, deltaExalted: 40 },
      { name: "Exalted Orb", before: 3, after: 8, delta: 5, unitExalted: 1, deltaExalted: 5 },
    ]);
    expect(delta.totalExalted).toBe(45);
    expect(delta.unpriced).toEqual([]);
  });

  it("treats the first scan as the baseline and sums split stacks", () => {
    const delta = diffEarnings(undefined, snap("2026-09-06T10:00:00.000Z", [["Exalted Orb", 20], ["Exalted Orb", 2]]), TABLE);
    expect(delta.previousAt).toBeUndefined();
    expect(delta.perCurrency[0]).toMatchObject({ name: "Exalted Orb", before: 0, after: 22, delta: 22 });
    expect(delta.totalExalted).toBe(22);
  });

  it("ignores collected stacks (negative deltas) in the total and flags unpriced arrivals", () => {
    const delta = diffEarnings(
      snap("a", [["Exalted Orb", 10]]),
      snap("b", [["Exalted Orb", 2], ["Scroll of Wisdom", 4]]),
      TABLE,
    );
    expect(delta.perCurrency.find((entry) => entry.name === "Exalted Orb")?.delta).toBe(-8);
    expect(delta.totalExalted).toBe(0);
    expect(delta.unpriced).toEqual(["Scroll of Wisdom"]);
  });
});

describe("verifySalesWithEarnings", () => {
  const deltaOf = (exalted: number, divine = 0): EarningsDelta =>
    diffEarnings(
      snap("a", []),
      snap("b", [
        ...(exalted > 0 ? ([["Exalted Orb", exalted]] as Array<[string, number]>) : []),
        ...(divine > 0 ? ([["Divine Orb", divine]] as Array<[string, number]>) : []),
      ]),
      TABLE,
    );

  it("upgrades the one gone listing whose price matches the delta exactly", () => {
    const sold = soldEvent();
    const { events, report } = verifySalesWithEarnings({
      events: [sold],
      goneListings: [{ fingerprint: "f1", name: "Doom Loop", count: 1, price: sold.realized }],
      earningsDelta: deltaOf(5),
    });
    expect(events[0]).toMatchObject({ certainty: "verified", realized: { amount: 5, currency: "exalted" } });
    expect(report.some((line) => /verified 1 sale/.test(line))).toBe(true);
  });

  it("verifies exactly one gone listing AT the delta when the amounts differ", () => {
    const { events } = verifySalesWithEarnings({
      events: [soldEvent()],
      goneListings: [{ fingerprint: "f1", name: "Doom Loop", count: 1 }],
      earningsDelta: deltaOf(0, 1),
    });
    expect(events[0]).toMatchObject({
      certainty: "verified",
      realized: { amount: 1, currency: "divine", exalted: 40 },
    });
    expect(events[0]!.reason).toMatch(/listed at 5 ex/);
  });

  it("verifies several gone listings whose sum lands within 5% of the delta", () => {
    const a = soldEvent({ fingerprint: "a", name: "A", realized: { amount: 5, currency: "exalted", exalted: 5 } });
    const b = soldEvent({ fingerprint: "b", name: "B", realized: { amount: 10, currency: "exalted", exalted: 10 } });
    const c = soldEvent({ fingerprint: "c", name: "C", realized: { amount: 1, currency: "divine", exalted: 40 } });
    const { events, report } = verifySalesWithEarnings({
      events: [a, b, c],
      goneListings: [],
      earningsDelta: deltaOf(15),
    });
    expect(events.filter((event) => event.certainty === "verified").map((event) => event.name)).toEqual(["A", "B"]);
    expect(events.find((event) => event.name === "C")?.certainty).toBe("heuristic");
    expect(report.some((line) => /does not account for 1x C/.test(line))).toBe(true);
  });

  it("keeps the realized price when it comes from the gone listing rather than the event", () => {
    const { realized: _dropped, ...bare } = soldEvent();
    const { events } = verifySalesWithEarnings({
      events: [bare],
      goneListings: [{ fingerprint: "f1", name: "Doom Loop", count: 1, price: { amount: 5, currency: "exalted", exalted: 5 } }],
      earningsDelta: deltaOf(5),
    });
    expect(events[0]).toMatchObject({ certainty: "verified", realized: { amount: 5, currency: "exalted", exalted: 5 } });
  });

  it("splits a delta across the copies of one listing — realized is per copy", () => {
    // Two copies listed at 5 ex, 8 ex arrived: not the exact 10, so the one
    // gone listing is verified AT the delta, 4 ex a copy (salesStats × count).
    const { events } = verifySalesWithEarnings({
      events: [soldEvent({ count: 2 })],
      goneListings: [],
      earningsDelta: deltaOf(8),
    });
    expect(events[0]).toMatchObject({ certainty: "verified", count: 2, realized: { amount: 4, currency: "exalted", exalted: 4 } });
    expect(salesStats(events).find((entry) => entry.itemClass === "Rings")?.realizedExalted).toBe(8);
  });

  it("leaves everything heuristic when nothing arrived, and says so", () => {
    const { events, report } = verifySalesWithEarnings({
      events: [soldEvent(), soldEvent({ fingerprint: "f2", name: "Other" })],
      goneListings: [],
      earningsDelta: deltaOf(0),
    });
    expect(events.every((event) => event.certainty === "heuristic")).toBe(true);
    expect(report[0]).toMatch(/stay heuristic/);
  });

  it("never touches non-sold events and explains an unmatched delta", () => {
    const listed: ListingEvent = { ...soldEvent(), kind: "listed", by: "app", certainty: "verified" };
    const { events, report } = verifySalesWithEarnings({
      events: [listed],
      goneListings: [],
      earningsDelta: deltaOf(7),
    });
    expect(events).toEqual([listed]);
    expect(report[0]).toMatch(/no listing left the shop/);
  });
});

/* ---------------- the keeper against fakes: strip label, scan source, persist ---------------- */

const EXALTED_TEXT = [
  "Item Class: Stackable Currency",
  "Rarity: Currency",
  "Exalted Orb",
  "--------",
  "Stack Size: 7/20",
  "--------",
  "Augments a Rare item with a new random modifier",
].join("\n");

function fakeKeeper(root: string, options: { strip?: StripEntry[]; items?: string[] } = {}) {
  const calls: Array<{ op: string; payload: Record<string, unknown> }> = [];
  const clicks: string[] = [];
  const scans: Array<{ source: unknown; options: unknown }> = [];
  const host = {
    async send(payload: Record<string, unknown>) {
      calls.push({ op: String(payload.op), payload });
      if (payload.op === "ocr") return { ok: true, text: "MERCHANT INVENTORY", lines: [] };
      return { ok: true };
    },
  };
  const harness = {
    async click(_x: number, _y: number, why: string) {
      clicks.push(why);
      return "clicked" as const;
    },
    async sleep() {},
    async checkpoint() {},
    async confirmPlan() {
      return "good" as const;
    },
    async burst() {
      return 1;
    },
  } as unknown as SortHarness;
  const strip = options.strip ?? [
    { label: "Shop", row: "top", point: { x: 428, y: 217 }, width: 90 },
    { label: "Earnings (Remove-only)", row: "top", point: { x: 739, y: 217 }, width: 320 },
  ];
  const kit = {
    async readStrip() {
      return { top: strip, folder: [] };
    },
    async settledOcr() {
      return [];
    },
  } as unknown as StashTabKit;
  const sorter = {
    async scanTab(source: unknown, scanOptions: unknown) {
      scans.push({ source, options: scanOptions });
      const items = options.items ?? [EXALTED_TEXT];
      return {
        ok: true,
        occupiedCount: items.length,
        modelItems: items.map((text, index) => ({
          dest: "junk",
          itemClass: "Stackable Currency",
          text,
          cells: [{ row: 0, col: index, x: 100 + index * 100, y: 400 }],
        })),
        reads: [],
        unread: [],
        region: { x: 35, y: 317, w: 1273, h: 1277 },
        cols: 12,
        rows: 12,
      };
    },
  } as unknown as GearSorter;
  const keeper = new ShopKeeper(host, harness, kit, sorter, {
    root,
    config: { ...defaultShopConfig(), shopTab: "1Ex" },
    dryRun: true,
    stepMode: false,
    priceTable: TABLE,
    log: () => {},
    now: () => new Date("2026-09-06T12:00:00.000Z"),
  });
  return { keeper, calls, clicks, scans };
}

describe("ShopKeeper.scanEarnings", () => {
  it("selects the Earnings sub-tab by its (Remove-only) label without the stash refusal, scans it, and diffs", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "earnings-"));
    try {
      const { keeper, clicks, scans } = fakeKeeper(root);
      // The label IS a Remove-only label by the stash rule — the shop path must not consult it.
      expect(isRemoveOnlyTabLabel("Earnings (Remove-only)")).toBe(true);
      const result = await keeper.scanEarnings();
      expect(result.found).toBe(true);
      expect(clicks[0]).toMatch(/Earnings \(Remove-only\)/);
      expect(clicks[clicks.length - 1]).toMatch(/"Shop"/);
      expect(scans).toHaveLength(1);
      expect(scans[0]!.source).toMatchObject({ label: "Earnings", occurrence: 0, shop: true });
      expect(scans[0]!.options).toMatchObject({ navigate: false });
      expect(result.snapshot?.stacks).toEqual([{ name: "Exalted Orb", count: 7, exalted: 7 }]);
      expect(result.previous).toBeUndefined();
      expect(result.delta?.totalExalted).toBe(7);
      expect(result.report.some((line) => /no previous snapshot/.test(line))).toBe(true);
      // Nothing persisted by the scan itself; the caller saves on --record.
      expect(existsSync(path.join(root, "artifacts", "tab-admin", "earnings-snapshot.json"))).toBe(false);
      keeper.saveEarningsSnapshot(result.snapshot!);
      const saved = JSON.parse(
        readFileSync(path.join(root, "artifacts", "tab-admin", "earnings-snapshot.json"), "utf8"),
      ) as EarningsSnapshot;
      expect(saved).toEqual({ at: "2026-09-06T12:00:00.000Z", stacks: [{ name: "Exalted Orb", count: 7, exalted: 7 }] });
      expect(keeper.loadEarningsSnapshot()).toEqual(saved);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back (found: false) when the sub-tab label cannot be read — never prompts", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "earnings-"));
    try {
      const { keeper, clicks } = fakeKeeper(root, {
        strip: [{ label: "Shop", row: "top", point: { x: 428, y: 217 }, width: 90 }],
      });
      const result = await keeper.scanEarnings();
      expect(result.found).toBe(false);
      expect(clicks).toHaveLength(0);
      expect(result.report[0]).toMatch(/stays heuristic/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reconcile() upgrades a presumed sale the Earnings delta accounts for", () => {
    const root = mkdtempSync(path.join(tmpdir(), "earnings-"));
    try {
      const dir = path.join(root, "artifacts", "tab-admin");
      mkdirSync(dir, { recursive: true });
      const listed: ListingEvent = {
        at: "2026-09-01T10:00:00.000Z",
        kind: "listed",
        fingerprint: "ring",
        name: "Doom Loop",
        itemClass: "Rings",
        count: 1,
        by: "app",
        certainty: "verified",
        price: { amount: 5, currency: "exalted", exalted: 5 },
      };
      writeFileSync(path.join(dir, "listings.jsonl"), `${JSON.stringify(listed)}\n`);
      const { keeper } = fakeKeeper(root);
      const snapshot = buildShopSnapshot([], { at: "2026-09-06T12:00:00.000Z", tab: "1Ex", priceTable: TABLE });
      const earningsDelta = diffEarnings(snap("a", []), snap("b", [["Exalted Orb", 5]]), TABLE);
      const { events, report } = keeper.reconcile(snapshot, { record: true, earningsDelta });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: "sold", certainty: "verified", realized: { amount: 5 } });
      expect(report.some((line) => /verified 1 sale/.test(line))).toBe(true);
      const ledger = parseListingEvents(readFileSync(path.join(dir, "listings.jsonl"), "utf8"));
      expect(ledger[1]).toMatchObject({ kind: "sold", certainty: "verified" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reconcile() without a delta keeps the heuristic and says so", () => {
    const root = mkdtempSync(path.join(tmpdir(), "earnings-"));
    try {
      const dir = path.join(root, "artifacts", "tab-admin");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "listings.jsonl"),
        `${JSON.stringify({
          at: "2026-09-01T10:00:00.000Z",
          kind: "listed",
          fingerprint: "ring",
          name: "Doom Loop",
          itemClass: "Rings",
          count: 1,
          by: "app",
          certainty: "verified",
        })}\n`,
      );
      const { keeper } = fakeKeeper(root);
      const snapshot = buildShopSnapshot([], { at: "2026-09-06T12:00:00.000Z", tab: "1Ex" });
      const { events, report } = keeper.reconcile(snapshot, { record: false });
      expect(events[0]).toMatchObject({ kind: "sold", certainty: "heuristic" });
      expect(report.some((line) => /no Earnings delta/.test(line))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
