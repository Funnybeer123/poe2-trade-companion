import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadTriageExport } from "../src/adapters/triageLoader.js";
import { loadTriageConfig } from "../src/adapters/bagKit.js";
import { DEFAULT_ORB_COSTS, orbCosts } from "../src/core/crafting.js";
import { PRICE_TABLE_SCHEMA_VERSION, starterPriceTable } from "../src/core/priceTable.js";
import { DEFAULT_TIER_THRESHOLDS, starterValueTierRules } from "../src/core/valueTiers.js";
import { DEFAULT_MIN_DETOUR_CONFIDENCE } from "../src/core/sortTriage.js";

const DIVINE_ORB_TEXT = [
  "Item Class: Stackable Currency",
  "Rarity: Currency",
  "Divine Orb",
  "--------",
  "Stack Size: 1/10",
].join("\n");

/** The app's export as of 2026-08-31: placeholder divine (40) still in it. */
function legacyExport() {
  return {
    exportedAt: "2026-08-31T20:00:00.000Z",
    rules: starterValueTierRules(),
    thresholds: { keepAtOrAbove: 10, sellAtOrAbove: 1 },
    routing: { reviewTab: "Keep", dumpTab: "Trash", sellTab: "Sell" },
    minDetourConfidence: 70,
    priceTable: {
      schemaVersion: PRICE_TABLE_SCHEMA_VERSION,
      currency: "exalted",
      entries: [
        { id: "divine-orb", match: { name: "Divine Orb" }, value: 40, note: "Edit to the current rate." },
        { id: "exalted-orb", match: { name: "Exalted Orb" }, value: 1 },
        { id: "chaos-orb", match: { name: "Chaos Orb" }, value: 0.5 },
        { id: "manual-1", match: { name: "My Thing" }, value: 9, note: "mine" },
      ],
    },
  };
}

function feedSnapshot(fetchedAt: string, league = "Runes of Aldur") {
  return {
    source: "poe2scout",
    league,
    fetchedAt,
    prices: [
      { key: "divine", name: "Divine Orb", value: 404.62, quantity: 1200 },
      { key: "chaos", name: "Chaos Orb", value: 35.91 },
    ],
  };
}

function makeRoot(files: Record<string, unknown> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), "triage-loader-"));
  const dir = path.join(root, "artifacts", "tab-admin");
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
  }
  return root;
}

const NOW = new Date("2026-09-07T12:00:00Z");

describe("loadTriageExport", () => {
  it("falls back to starter tiers and prices without an export", () => {
    const lines: string[] = [];
    const triage = loadTriageExport(makeRoot(), { log: (line) => lines.push(line), now: NOW });
    expect(triage.source).toBe("starter tiers (no artifacts/tab-admin/triage.json export)");
    expect(triage.rules).toEqual(starterValueTierRules());
    expect(triage.thresholds).toEqual(DEFAULT_TIER_THRESHOLDS);
    expect(triage.routing).toEqual({ reviewTab: "Review", dumpTab: "Dump" });
    expect(triage.minDetourConfidence).toBe(DEFAULT_MIN_DETOUR_CONFIDENCE);
    expect(triage.priceTable).toEqual(starterPriceTable());
    expect(triage.feedSnapshot).toBeUndefined();
    expect(orbCosts(triage.priceTable)).toEqual(DEFAULT_ORB_COSTS);
    expect(lines).toEqual([]);
  });

  it("loads the export, strips placeholders and merges the feed snapshot", () => {
    const root = makeRoot({
      "triage.json": legacyExport(),
      "feed-snapshot.json": feedSnapshot("2026-09-06T23:30:00Z"),
    });
    const triage = loadTriageExport(root, { now: NOW });
    expect(triage.source).toBe("artifacts/tab-admin/triage.json");
    expect(triage.thresholds).toEqual({ keepAtOrAbove: 10, sellAtOrAbove: 1 });
    expect(triage.routing).toEqual({ reviewTab: "Keep", dumpTab: "Trash", sellTab: "Sell" });
    expect(triage.minDetourConfidence).toBe(70);
    expect(triage.feedSnapshot).toEqual({ league: "Runes of Aldur", fetchedAt: "2026-09-06T23:30:00Z" });

    const ids = triage.priceTable.entries.map((entry) => entry.id);
    expect(ids).not.toContain("divine-orb");
    expect(ids).not.toContain("chaos-orb");
    expect(ids).toContain("manual-1");
    expect(ids).toContain("feed:poe2scout:divine");
    expect(orbCosts(triage.priceTable).divine).toBe(404.62);
    expect(orbCosts(triage.priceTable).chaos).toBe(35.91);

    // The evaluator prices off the merged table: a divine clears the keep bar.
    const verdict = triage.evaluate(DIVINE_ORB_TEXT);
    expect(verdict.tier).toBe("keep");
    expect(verdict.source).toBe("price-table");
    expect(verdict.price).toBe(404.62);
  });

  it("prices off the crafting defaults when there is no snapshot", () => {
    const triage = loadTriageExport(makeRoot({ "triage.json": legacyExport() }), { now: NOW });
    expect(triage.feedSnapshot).toBeUndefined();
    expect(orbCosts(triage.priceTable).divine).toBe(DEFAULT_ORB_COSTS.divine);
    expect(triage.evaluate(DIVINE_ORB_TEXT).source).not.toBe("price-table");
  });

  it("keeps a placeholder row the user edited", () => {
    const edited = legacyExport();
    edited.priceTable.entries[0]!.value = 55;
    const triage = loadTriageExport(makeRoot({ "triage.json": edited }), { now: NOW });
    expect(orbCosts(triage.priceTable).divine).toBe(55);
    expect(orbCosts(triage.priceTable).chaos).toBe(DEFAULT_ORB_COSTS.chaos);
  });

  it("does not merge a snapshot for a different pinned league", () => {
    const root = makeRoot({
      "triage.json": legacyExport(),
      "feed-snapshot.json": feedSnapshot("2026-09-06T23:30:00Z"),
      "price-feed.json": { league: "Standard", autoRefreshDaily: false, poesessid: "" },
    });
    const triage = loadTriageExport(root, { now: NOW });
    expect(triage.feedSnapshot).toBeUndefined();
    expect(orbCosts(triage.priceTable).divine).toBe(DEFAULT_ORB_COSTS.divine);
  });

  it("leaves fresher feed rows in the export alone", () => {
    const fresh = legacyExport();
    fresh.priceTable.entries.push({
      id: "feed:poe2scout:divine",
      match: { name: "Divine Orb" },
      value: 623.76,
      note: "poe2scout · Runes of Aldur · 2026-09-07",
    });
    const root = makeRoot({
      "triage.json": fresh,
      "feed-snapshot.json": feedSnapshot("2026-09-05T08:00:00Z"),
    });
    const triage = loadTriageExport(root, { now: NOW });
    expect(triage.feedSnapshot).toBeUndefined();
    expect(orbCosts(triage.priceTable).divine).toBe(623.76);
  });

  it("reports unreadable files and keeps going", () => {
    const lines: string[] = [];
    const root = makeRoot({ "triage.json": "{not json", "feed-snapshot.json": "[]" });
    const triage = loadTriageExport(root, { log: (line) => lines.push(line), now: NOW });
    expect(triage.source).toContain("starter tiers");
    expect(triage.priceTable).toEqual(starterPriceTable());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("triage.json unreadable");
  });

  it("is what bagKit's loadTriageConfig now delegates to", () => {
    const root = makeRoot({ "triage.json": legacyExport() });
    const viaKit = loadTriageConfig(root, { now: NOW });
    const direct = loadTriageExport(root, { now: NOW });
    expect(viaKit.routing).toEqual(direct.routing);
    expect(viaKit.priceTable).toEqual(direct.priceTable);
  });
});
