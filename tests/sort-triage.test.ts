import { describe, expect, it } from "vitest";
import type { IdentifiedItem } from "../src/core/gearSort.js";
import {
  DEFAULT_MIN_DETOUR_CONFIDENCE,
  findRecordFor,
  isTriageTabLabel,
  parseFindRecords,
  routeIdentifiedItem,
  triageTabLabels,
  type SortTriageConfig,
} from "../src/core/sortTriage.js";
import type { TierVerdict } from "../src/core/valueTiers.js";
import type { ItemAppraisal } from "../src/core/appraisal.js";

const ROUTING = { reviewTab: "Review", dumpTab: "Dump" };

function identified(dest: string | "junk", text = "Item Class: Rings\nRarity: Rare\nStorm Loop"): IdentifiedItem {
  return { dest, itemClass: "Rings", text, cells: [{ row: 0, col: 0, x: 100, y: 400 }] };
}

function verdictWith(
  tier: TierVerdict["tier"],
  source: TierVerdict["source"],
  confidence: number,
  extra: Partial<ItemAppraisal> = {},
): TierVerdict {
  return {
    tier,
    source,
    reasons: ["test reason"],
    matchedRules: source === "rule" ? ["test rule"] : [],
    appraisal: {
      valueScore: 75,
      confidence,
      band: confidence >= 65 ? "high" : "low",
      evidence: "mods",
      reasons: ["test reason"],
      mods: [],
      ...extra,
    },
  };
}

function config(verdict: TierVerdict, minConfidence = DEFAULT_MIN_DETOUR_CONFIDENCE): SortTriageConfig {
  return { evaluate: () => verdict, routing: ROUTING, minDetourConfidence: minConfidence };
}

describe("value-aware sorter routing", () => {
  it("routes normally without a config", () => {
    const routed = routeIdentifiedItem(identified("Rings"));
    expect(routed).toMatchObject({ dest: "Rings", detoured: false });
  });

  it("detours confident keeps to Review, remembering the class fallback", () => {
    const routed = routeIdentifiedItem(identified("Rings"), config(verdictWith("keep", "rule", 80)));
    expect(routed.dest).toBe("Review");
    expect(routed.fallbackDest).toBe("Rings");
    expect(routed.detoured).toBe(true);
  });

  it("holds low-confidence verdicts in the normal flow", () => {
    const routed = routeIdentifiedItem(identified("Rings"), config(verdictWith("keep", "heuristic", 40)));
    expect(routed.dest).toBe("Rings");
    expect(routed.detoured).toBe(false);
  });

  it("lets only rule/price verdicts reach the Dump tab", () => {
    const ruled = routeIdentifiedItem(identified("junk"), config(verdictWith("dump", "rule", 80)));
    expect(ruled.dest).toBe("Dump");

    const heuristic = routeIdentifiedItem(
      identified("junk"),
      config(verdictWith("dump", "heuristic", 90)),
    );
    expect(heuristic.dest).toBe("junk");
    expect(heuristic.detoured).toBe(false);
  });

  it("sends sells to the sell tab when configured, else Review", () => {
    const toReview = routeIdentifiedItem(identified("Rings"), config(verdictWith("sell", "rule", 80)));
    expect(toReview.dest).toBe("Review");
    const withSell = routeIdentifiedItem(identified("Rings"), {
      evaluate: () => verdictWith("sell", "rule", 80),
      routing: { ...ROUTING, sellTab: "Sell" },
      minDetourConfidence: 55,
    });
    expect(withSell.dest).toBe("Sell");
  });

  it("recognizes triage tab labels case-insensitively", () => {
    expect(triageTabLabels({ ...ROUTING, sellTab: "Sell" }).size).toBe(3);
    expect(isTriageTabLabel("review", ROUTING)).toBe(true);
    expect(isTriageTabLabel("Rings", ROUTING)).toBe(false);
  });
});

describe("find records", () => {
  it("logs detoured keeps with score, confidence, and destination", () => {
    const routed = routeIdentifiedItem(
      identified("Rings"),
      config(verdictWith("keep", "rule", 82, { estimatedValue: { amount: 12, currency: "exalted", basis: "price-table", unitValue: 12 } })),
    );
    const record = findRecordFor(routed, "Rings", "2026-08-30T00:00:00.000Z");
    expect(record).toMatchObject({
      location: "Rings",
      name: "Storm Loop",
      tier: "keep",
      valueScore: 75,
      confidence: 82,
      estimatedValue: 12,
      routedTo: "Review",
    });
  });

  it("skips non-detours and dump routings", () => {
    const normal = routeIdentifiedItem(identified("Rings"), config(verdictWith("keep", "rule", 30)));
    expect(findRecordFor(normal, "Rings", "now")).toBeUndefined();
    const dumped = routeIdentifiedItem(identified("junk"), config(verdictWith("dump", "rule", 80)));
    expect(findRecordFor(dumped, "T3", "now")).toBeUndefined();
  });

  it("parses a finds journal, skipping truncated lines", () => {
    const good = JSON.stringify({ at: "now", name: "Storm Loop", tier: "keep", location: "bag", itemClass: "Rings", source: "rule", routedTo: "Review" });
    const records = parseFindRecords(`${good}\n{"at":"truncat`);
    expect(records).toHaveLength(1);
    expect(records[0]?.name).toBe("Storm Loop");
  });
});
