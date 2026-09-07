import { describe, expect, it } from "vitest";
import { evaluateWithAppraisal } from "../src/core/appraisal.js";
import { exaltedFromScore } from "../src/core/crafting.js";
import { valueItemLocally } from "../src/core/localValuation.js";
import { parseItemText } from "../src/core/parseItem.js";
import { PRICE_TABLE_SCHEMA_VERSION, type PriceTable } from "../src/core/priceTable.js";
import type { CompsSummary } from "../src/core/tradeComps.js";
import { emptyValueTierRules } from "../src/core/valueTiers.js";

const NOW = new Date("2026-09-07T10:00:00.000Z");

const EXALTED_STACK = [
  "Item Class: Currency",
  "Rarity: Currency",
  "Exalted Orb",
  "--------",
  "Stack Size: 12/20",
].join("\n");

const WIDOWHAIL = [
  "Item Class: Bows",
  "Rarity: Unique",
  "Widowhail",
  "Crude Bow",
  "--------",
  "Item Level: 81",
  "--------",
  "+200% increased bonuses gained from Equipped Quiver",
].join("\n");

const GREAT_RARE = [
  "Item Class: Body Armours",
  "Rarity: Rare",
  "Storm Carapace",
  "Advanced Maraketh Coat",
  "--------",
  "Item Level: 82",
  "--------",
  "+162 to maximum Life",
  "+92 to Spirit",
  "+14% to all Elemental Resistances",
  "+31% to Chaos Resistance",
  "28% increased Rarity of Items found",
].join("\n");

const DULL_RARE = [
  "Item Class: Rings",
  "Rarity: Rare",
  "Dusk Loop",
  "Iron Ring",
  "--------",
  "Item Level: 40",
  "--------",
  "5% increased Light Radius",
].join("\n");

function table(entries: PriceTable["entries"], updatedAt?: string): PriceTable {
  return {
    schemaVersion: PRICE_TABLE_SCHEMA_VERSION,
    currency: "exalted",
    ...(updatedAt ? { updatedAt } : {}),
    entries,
  };
}

function comps(prices: number[], overrides: Partial<CompsSummary> = {}): CompsSummary {
  const sorted = [...prices].sort((a, b) => a - b);
  const median =
    sorted.length === 0
      ? undefined
      : sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  return {
    sampleSize: sorted.length,
    candidateCount: sorted.length + 2,
    ...(sorted[0] !== undefined ? { lowest: sorted[0] } : {}),
    ...(median !== undefined ? { median } : {}),
    currency: "exalted",
    basis: "base-type",
    comps: sorted.slice(0, 8).map((price) => ({
      price,
      similarity: 1,
      name: "Comp",
      baseType: "Advanced Maraketh Coat",
    })),
    ...overrides,
  };
}

function verdictFor(text: string, priceTable?: PriceTable) {
  return evaluateWithAppraisal(text, {
    rules: emptyValueTierRules(),
    ...(priceTable ? { priceTable } : {}),
  });
}

describe("valueItemLocally", () => {
  it("prices a currency stack from the price table, stack-aware", () => {
    const priceTable = table(
      [{ id: "exalted-orb", match: { name: "Exalted Orb" }, value: 1 }],
      "2026-09-06T00:00:00.000Z",
    );
    const valuation = valueItemLocally({
      parsed: parseItemText(EXALTED_STACK),
      priceTable,
      now: NOW,
    });
    expect(valuation).toMatchObject({
      providerName: "price-table",
      low: 12,
      fair: 12,
      high: 12,
      recommendedListing: 12,
      confidence: "high",
      candidateCount: 1,
      comparablesUsed: 1,
      currency: "exalted",
      marketTimestamp: "2026-09-06T00:00:00.000Z",
    });
    expect(valuation.lowConfidenceReason).toBeUndefined();
  });

  it("uses a unique's name entry from the table over comps and appraisal", () => {
    const priceTable = table([
      { id: "feed:poe2scout:widowhail", match: { name: "Widowhail", baseType: "Crude Bow", rarity: "Unique" }, value: 30 },
    ]);
    const parsed = parseItemText(WIDOWHAIL);
    const valuation = valueItemLocally({
      parsed,
      priceTable,
      verdict: verdictFor(WIDOWHAIL, priceTable),
      comps: comps([3, 4, 5, 6, 7, 8, 9, 10, 11]),
      now: NOW,
    });
    expect(valuation.providerName).toBe("price-table");
    expect(valuation.fair).toBe(30);
    // The table has no timestamp, so the valuation is stamped with `now`.
    expect(valuation.marketTimestamp).toBe(NOW.toISOString());
  });

  it("treats a rarity-only floor row as no price-table evidence (exact names/bases only)", () => {
    // The starter table's "any unique = 1 ex" floor: a triage floor, not a price.
    const priceTable = table([
      { id: "any-unique", match: { rarity: "Unique" }, value: 1, note: "Floor for unreviewed uniques." },
    ]);
    const parsed = parseItemText(WIDOWHAIL);
    const withComps = valueItemLocally({
      parsed,
      priceTable,
      verdict: verdictFor(WIDOWHAIL, priceTable),
      comps: comps([3, 4, 5, 6, 7, 8, 9, 10, 11]),
      now: NOW,
    });
    expect(withComps.providerName).toBe("trade2-comps");
    expect(withComps.fair).toBe(7);
    const alone = valueItemLocally({ parsed, priceTable, verdict: verdictFor(WIDOWHAIL, priceTable), now: NOW });
    expect(alone.providerName).not.toBe("price-table");
    expect(alone.confidence).not.toBe("high");
    // A base-type row is real evidence, graded below a name match.
    const byBase = valueItemLocally({
      parsed,
      priceTable: table([{ id: "crude-bows", match: { baseType: "Crude Bow" }, value: 2 }]),
      now: NOW,
    });
    expect(byBase).toMatchObject({ providerName: "price-table", fair: 2, confidence: "medium" });
    expect(byBase.lowConfidenceReason).toContain("base type");
  });

  it("builds a band from trade2 comps: lowest / median / max, confidence by sample size", () => {
    const parsed = parseItemText(GREAT_RARE);
    const valuation = valueItemLocally({
      parsed,
      comps: comps([3, 4, 5, 6, 9]),
      now: NOW,
    });
    expect(valuation).toMatchObject({
      providerName: "trade2-comps",
      low: 3,
      fair: 5,
      high: 9,
      candidateCount: 7,
      comparablesUsed: 5,
      confidence: "medium",
      currency: "exalted",
      marketTimestamp: NOW.toISOString(),
    });
    expect(valuation.lowConfidenceReason).toContain("thin sample");
    // The shop policy anchors on the 25th percentile (4 ex) minus a 5% undercut.
    expect(valuation.recommendedListing).toBe(3.8);
  });

  it("grades comps confidence high at eight comparables and low under four", () => {
    const parsed = parseItemText(GREAT_RARE);
    const high = valueItemLocally({
      parsed,
      comps: comps([5, 5, 6, 6, 7, 7, 8, 8]),
      now: NOW,
    });
    expect(high.confidence).toBe("high");
    expect(high.lowConfidenceReason).toBeUndefined();

    const low = valueItemLocally({ parsed, comps: comps([5, 6]), now: NOW });
    expect(low.confidence).toBe("low");
    expect(low.lowConfidenceReason).toContain("very few comparables");
  });

  it("falls back to fair × 0.95 when the shop policy refuses to price", () => {
    const parsed = parseItemText(GREAT_RARE);
    // One comparable: sample-too-small for the listing policy.
    const valuation = valueItemLocally({ parsed, comps: comps([8]), now: NOW });
    expect(valuation.providerName).toBe("trade2-comps");
    expect(valuation.fair).toBe(8);
    expect(valuation.recommendedListing).toBe(7.6);
  });

  it("surfaces the comps caution alongside the thin-sample reason", () => {
    const parsed = parseItemText(GREAT_RARE);
    const valuation = valueItemLocally({
      parsed,
      comps: comps([1, 20, 22, 24, 26], { caution: "Floor sits far under the median." }),
      now: NOW,
    });
    expect(valuation.lowConfidenceReason).toContain("thin sample");
    expect(valuation.lowConfidenceReason).toContain("Floor sits far under the median.");
  });

  it("ignores comps with no comparable listings and falls through to the appraisal", () => {
    const parsed = parseItemText(GREAT_RARE);
    const verdict = verdictFor(GREAT_RARE);
    const valuation = valueItemLocally({
      parsed,
      verdict,
      comps: comps([]),
      now: NOW,
    });
    expect(valuation.providerName).toBe("appraisal");
  });

  it("maps a heuristic appraisal onto the crafting value curve with a wide band", () => {
    const parsed = parseItemText(GREAT_RARE);
    const verdict = verdictFor(GREAT_RARE);
    const score = verdict.appraisal!.valueScore;
    expect(score).toBeGreaterThan(40);
    const fair = exaltedFromScore(score);
    const valuation = valueItemLocally({ parsed, verdict, now: NOW });
    expect(valuation).toMatchObject({
      providerName: "appraisal",
      fair,
      low: Math.round(fair * 0.6 * 100) / 100,
      high: Math.round(fair * 1.6 * 100) / 100,
      candidateCount: 0,
      comparablesUsed: 0,
      lowConfidenceReason: "heuristic appraisal — no listings",
    });
    expect(["medium", "low"]).toContain(valuation.confidence);
    expect(valuation.recommendedListing).toBeLessThanOrEqual(fair);
  });

  it("bands appraisal confidence from the appraisal band", () => {
    const parsed = parseItemText(GREAT_RARE);
    const verdict = verdictFor(GREAT_RARE);
    const appraisal = verdict.appraisal!;
    const asBand = (band: typeof appraisal.band) =>
      valueItemLocally({
        parsed,
        verdict: { ...verdict, appraisal: { ...appraisal, band } },
        now: NOW,
      }).confidence;
    expect(asBand("very-high")).toBe("medium");
    expect(asBand("high")).toBe("medium");
    expect(asBand("medium")).toBe("low");
    expect(asBand("low")).toBe("none");
  });

  it("reports none with zeros when nothing prices the item", () => {
    const parsed = parseItemText(DULL_RARE);
    const verdict = verdictFor(DULL_RARE);
    expect(verdict.appraisal?.valueScore).toBe(0);
    const valuation = valueItemLocally({ parsed, verdict, now: NOW });
    expect(valuation).toMatchObject({
      providerName: "none",
      low: 0,
      fair: 0,
      high: 0,
      recommendedListing: 0,
      confidence: "none",
      candidateCount: 0,
      comparablesUsed: 0,
    });
    expect(valueItemLocally({ parsed, now: NOW }).providerName).toBe("none");
  });

  it("is deterministic for identical inputs", () => {
    const parsed = parseItemText(GREAT_RARE);
    const input = { parsed, verdict: verdictFor(GREAT_RARE), comps: comps([3, 4, 5, 6]), now: NOW };
    expect(valueItemLocally(input)).toEqual(valueItemLocally(input));
  });
});
