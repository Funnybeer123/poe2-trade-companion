import { describe, expect, it } from "vitest";
import { parseItemText } from "../src/core/parseItem.js";
import {
  ITEM_INTELLIGENCE_IPC_VERSION,
  type ParsedItemEvaluation,
} from "../src/shared/ipc.js";
import { ItemIntelligenceService } from "../src/main/itemIntelligenceService.js";
import { openLocalPersistence } from "../src/main/persistence/index.js";

const NOW = "2026-08-27T15:00:00.000Z";
const ITEM_TEXT = [
  "Item Class: Rings",
  "Rarity: Rare",
  "Storm Loop",
  "Ruby Ring",
  "--------",
  "Item Level: 71",
  "--------",
  "+31 to maximum Life",
  "+24% to Fire Resistance",
].join("\n");

function evaluation(): ParsedItemEvaluation {
  const item = parseItemText(ITEM_TEXT);
  return {
    schemaVersion: ITEM_INTELLIGENCE_IPC_VERSION,
    parsed: true,
    raw: ITEM_TEXT,
    item,
    valuation: {
      itemIdentifier: item.fingerprint,
      itemType: item.baseType,
      normalizedKeyStats: {},
      providerName: "fixture",
      marketTimestamp: NOW,
      candidateCount: 12,
      comparablesUsed: 10,
      low: 8,
      fair: 10,
      high: 14,
      recommendedListing: 11,
      currency: "exalted",
      confidence: "high",
    },
    desirability: {
      score: 72,
      category: "keep",
      reasons: ["build target"],
    },
  };
}

describe("item intelligence application service", () => {
  it("persists evaluations and emits typed catalog snapshots", () => {
    const persistence = openLocalPersistence(":memory:", { clock: () => NOW });
    const events: string[] = [];
    const service = new ItemIntelligenceService({
      persistence,
      now: () => NOW,
      publish: (channel) => events.push(channel),
    });

    const saved = service.recordEvaluation(evaluation(), "clipboard");

    expect(saved).toMatchObject({
      fingerprint: evaluation().item.fingerprint,
      fairValue: 10,
      recommendation: "keep",
      item: { name: "Storm Loop", baseType: "Ruby Ring" },
      valuation: { providerName: "fixture", fair: 10 },
    });
    expect(service.listCatalog()).toEqual([saved]);
    expect(persistence.itemObservations.listForCatalogItem(saved.id)).toHaveLength(1);
    expect(persistence.valuations.listForCatalogItem(saved.id)).toHaveLength(1);
    expect(events).toEqual(["catalog:changed"]);
    expect(service.removeCatalogItem(saved.id)).toBe(true);
    expect(service.listCatalog()).toEqual([]);
    persistence.close();
  });

  it("validates rule sets, generates safe searches, and surfaces legacy regex imports", () => {
    const persistence = openLocalPersistence(":memory:", { clock: () => NOW });
    const service = new ItemIntelligenceService({ persistence, now: () => NOW });

    const rules = service.saveRuleSet({
      name: "Life and resistance",
      rules: [
        {
          name: "Life + fire",
          regex: "maximum Life\nFire Resistance",
        },
      ],
      active: true,
    });
    expect(rules.rules).toHaveLength(1);
    expect(service.validateRule(rules.rules[0]!.regex).valid).toBe(true);
    const renamed = service.saveRuleSet({
      id: rules.id,
      name: "Renamed rules",
      rules: rules.rules,
      active: true,
    });
    expect(renamed.id).toBe(rules.id);
    expect(service.listRuleSets().map((entry) => entry.name)).toEqual([
      "Renamed rules",
    ]);
    expect(() =>
      service.saveRuleSet({
        name: "Unsafe",
        rules: [{ name: "Unsafe", regex: "(a+)+$" }],
      }),
    ).toThrow("invalid-rule");

    const generated = service.generateSearch({
      selections: ["maximum Life", "Fire Resistance"],
    });
    expect(generated.conflicts).toEqual([]);
    expect(generated.queries.length).toBeGreaterThan(0);

    service.importLegacy({
      kind: "regex-history",
      input: JSON.stringify([
        { name: "Imported cold", regex: "Cold Resistance" },
      ]),
      sourceKey: "test:legacy-rules",
    });
    expect(service.listRuleSets().map((entry) => entry.name)).toEqual([
      "Renamed rules",
      "Imported cold",
    ]);
    persistence.close();
  });

  it("imports local trade queries into one gear target and exposes scan details", () => {
    const persistence = openLocalPersistence(":memory:", { clock: () => NOW });
    const service = new ItemIntelligenceService({ persistence, now: () => NOW });
    const sourceText = JSON.stringify({
      query: {
        type: "Ruby Ring",
        stats: [{ type: "and", filters: [] }],
      },
      sort: { price: "asc" },
    });

    const imported = service.importBuildTargets({
      profile: { name: "Fire build", active: true },
      sourceText,
    });
    expect(imported.tradeImport.errors).toEqual([]);
    expect(imported.profile?.gearTargets).toHaveLength(1);
    expect(imported.profile?.gearTargets[0]).toMatchObject({
      slot: "ring",
      itemClass: "Rings",
      name: "Ruby Ring target",
      importedQuery: { query: { type: "Ruby Ring" } },
    });

    const session = persistence.scanSessions.upsert({
      profileId: imported.profile!.id,
      source: "offline-replay",
      status: "finished",
      startedAt: NOW,
      endedAt: NOW,
      summary: { matched: 1 },
    });
    persistence.scanSlots.upsert({
      sessionId: session.id,
      slotKey: "0,0",
      ordinal: 0,
      status: "matched",
      scannedAt: NOW,
      itemFingerprint: evaluation().item.fingerprint,
    });

    expect(service.listScans()).toHaveLength(1);
    expect(service.getScan(session.id)).toMatchObject({
      session: { id: session.id, status: "finished" },
      slots: [{ slotKey: "0,0", status: "matched" }],
    });
    persistence.close();
  });
});
