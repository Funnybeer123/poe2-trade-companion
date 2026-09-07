import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appraiseItem, evaluateWithAppraisal } from "../src/core/appraisal.js";
import { MOD_FAMILIES, matchModFamily } from "../src/core/modKnowledge.js";
import { parseItemText } from "../src/core/parseItem.js";
import { buildStatCatalogue } from "../src/core/statIds.js";
import { emptyLearnedTiers, type LearnedTiers } from "../src/core/tierLearning.js";
import {
  buildStatFilteredQuery,
  listingSimilarity,
  summarizeComps,
  type CompListing,
} from "../src/core/tradeComps.js";
import { emptyValueTierRules } from "../src/core/valueTiers.js";

const STATS: unknown = JSON.parse(
  readFileSync(new URL("../fixtures/trade/stats-subset.json", import.meta.url), "utf8"),
);
const statIds = buildStatCatalogue(STATS, MOD_FAMILIES);
const LIFE = "explicit.stat_3299347043";
const FIRE = "explicit.stat_3372524247";

/** Observed life ranges: gear-wide, and rings (where 65 is a top roll). */
function learned(): LearnedTiers {
  const store = emptyLearnedTiers();
  store.stats[LIFE] = {
    tiers: {
      "1": { min: 180, max: 200, count: 2, level: 80 },
      "2": { min: 150, max: 179, count: 2, level: 65 },
      "3": { min: 110, max: 149, count: 2, level: 50 },
    },
  };
  store.classes.Rings = {
    [LIFE]: {
      tiers: { "1": { min: 60, max: 70, count: 2 }, "2": { min: 45, max: 59, count: 2 } },
    },
  };
  return store;
}

const item = (lines: string[]): string => lines.join("\n");
const ring = (name: string, mods: string[]): string =>
  item([
    "Item Class: Rings",
    "Rarity: Rare",
    name,
    "Ruby Ring",
    "--------",
    "Item Level: 81",
    "--------",
    ...mods,
  ]);

const listing = (mods: string[], price = 3): CompListing => ({
  id: mods.join("|"),
  name: "Comp",
  baseType: "Ruby Ring",
  mods,
  priceAmount: price,
  priceCurrency: "exalted",
});

describe("learned tiers in mod matching", () => {
  it("override the hand thresholds when the store covers the stat, and say so", () => {
    const byHand = matchModFamily("+160 to maximum Life")!;
    expect(byHand).toMatchObject({ tier: 1, source: "threshold" });
    const byData = matchModFamily("+160 to maximum Life", { learnedTiers: learned(), statIds })!;
    expect(byData).toMatchObject({ family: { id: "life" }, tier: 2, source: "learned" });
    // The class's own ranges win: 65 life is a top ring roll, a nothing gear roll.
    expect(
      matchModFamily("+65 to maximum Life", { itemClass: "Rings", learnedTiers: learned(), statIds }),
    ).toMatchObject({ tier: 1, source: "learned" });
    expect(matchModFamily("+65 to maximum Life", { learnedTiers: learned(), statIds })).toMatchObject({
      tier: 0,
      source: "learned",
    });
    // Uncovered stats and a missing catalogue fall back to the thresholds.
    expect(
      matchModFamily("+38% to Fire Resistance", { learnedTiers: learned(), statIds }),
    ).toMatchObject({ tier: 2, source: "threshold" });
    expect(matchModFamily("+160 to maximum Life", { learnedTiers: learned() })).toMatchObject({
      tier: 1,
      source: "threshold",
    });
  });

  it("thread through appraiseItem and evaluateWithAppraisal", () => {
    const text = ring("Doom Loop", ["+65 to maximum Life", "+38% to Fire Resistance", "+13 to Intelligence"]);
    const byHand = appraiseItem(text);
    expect(byHand.mods[0]).toMatchObject({ familyId: "life", tier: 3, source: "threshold" });
    const byData = appraiseItem(text, { learnedTiers: learned(), statIds });
    expect(byData.mods[0]).toMatchObject({ familyId: "life", tier: 1, source: "learned" });
    expect(byData.mods[1]).toMatchObject({ familyId: "fire-res", tier: 2, source: "threshold" });
    expect(byData.valueScore).toBeGreaterThan(byHand.valueScore);
    const verdict = evaluateWithAppraisal(text, {
      rules: emptyValueTierRules(),
      learnedTiers: learned(),
      statIds,
    });
    expect(verdict.appraisal?.mods[0]).toMatchObject({ tier: 1, source: "learned" });
  });

  it("judge both sides of a comps comparison", () => {
    const ours = ["+65 to maximum Life"];
    const theirs = listing(["+50 to maximum Life"]);
    // Thresholds: 50 life is not a family hit, so nothing is shared.
    expect(listingSimilarity(ours, theirs, "Rings")).toBe(0);
    // Learned ring ranges: 50 is a tier-2 roll — the same family, shared.
    expect(listingSimilarity(ours, theirs, "Rings", { learnedTiers: learned(), statIds })).toBe(1);
    // A stat-filtered summary keeps zero-similarity listings when told to.
    const summary = summarizeComps(ours, [theirs], "stat-filtered", { itemClass: "Rings", minSimilarity: 0 });
    expect(summary).toMatchObject({ basis: "stat-filtered", sampleSize: 1, lowest: 3 });
    expect(summary.comps[0]?.similarity).toBe(0);
  });
});

describe("buildStatFilteredQuery", () => {
  it("filters on the item's notable mods at 85% of the roll, strongest family first", () => {
    const text = ring("Doom Loop", ["+38% to Fire Resistance", "+120 to maximum Life", "+13 to Intelligence"]);
    const parsed = parseItemText(text);
    const query = buildStatFilteredQuery(parsed, appraiseItem(text, { statIds }), statIds)!;
    expect(query.basis).toBe("stat-filtered");
    expect(query.body).toEqual({
      query: {
        status: { option: "online" },
        type: "Ruby Ring",
        stats: [
          {
            type: "and",
            filters: [
              { id: LIFE, value: { min: 102 } },
              { id: FIRE, value: { min: 32 } },
            ],
          },
        ],
        filters: { type_filters: { filters: { rarity: { option: "nonunique" } } } },
      },
      sort: { price: "asc" },
    });
  });

  it("ORs local/global ids in a count group and drops the value on digit-less mods", () => {
    const gloves = item([
      "Item Class: Gloves",
      "Rarity: Rare",
      "Storm Grip",
      "Jewelled Gloves",
      "--------",
      "Item Level: 80",
      "--------",
      "12% increased Attack Speed",
    ]);
    const speed = buildStatFilteredQuery(parseItemText(gloves), appraiseItem(gloves, { statIds }), statIds)!;
    const group = (speed.body as { query: { stats: Array<{ type: string; value?: unknown; filters: Array<{ id: string; value?: unknown }> }> } }).query.stats;
    expect(group).toHaveLength(1);
    expect(group[0]!.type).toBe("count");
    expect(group[0]!.value).toEqual({ min: 1 });
    expect(group[0]!.filters.map((filter) => filter.id).sort()).toEqual(
      ["explicit.stat_210067635", "explicit.stat_681332047"],
    );
    expect(group[0]!.filters.every((filter) => JSON.stringify(filter.value) === JSON.stringify({ min: 10 }))).toBe(true);

    const quiver = item([
      "Item Class: Quivers",
      "Rarity: Rare",
      "Storm Barb",
      "Broadhead Quiver",
      "--------",
      "Item Level: 80",
      "--------",
      "Bow Attacks fire an additional Arrow",
    ]);
    const arrows = buildStatFilteredQuery(parseItemText(quiver), appraiseItem(quiver, { statIds }), statIds)!;
    expect((arrows.body as { query: { stats: unknown } }).query.stats).toEqual([
      { type: "and", filters: [{ id: "explicit.stat_3885405204" }] },
    ]);
  });

  it("caps the families, and skips uniques and items with nothing notable", () => {
    const text = ring("Doom Loop", [
      "+92 to Spirit",
      "+120 to maximum Life",
      "+38% to Fire Resistance",
      "+35% to Cold Resistance",
    ]);
    const parsed = parseItemText(text);
    const appraisal = appraiseItem(text, { statIds });
    const three = buildStatFilteredQuery(parsed, appraisal, statIds)!;
    const stats = (three.body as { query: { stats: Array<{ type: string; filters: Array<{ id: string }> }> } }).query.stats;
    // Spirit resolves to two ids (a count group); life + fire fill the "and".
    expect(stats.map((group) => group.type)).toEqual(["and", "count"]);
    expect(stats[0]!.filters.map((filter) => filter.id)).toEqual([LIFE, FIRE]);
    expect(stats[1]!.filters).toHaveLength(2);
    const two = buildStatFilteredQuery(parsed, appraisal, statIds, { maxFamilies: 2 })!;
    const fewer = (two.body as { query: { stats: Array<{ type: string; filters: Array<{ id: string }> }> } }).query.stats;
    expect(fewer[0]!.filters.map((filter) => filter.id)).toEqual([LIFE]);
    expect(fewer[1]!.type).toBe("count");

    const unique = item(["Item Class: Rings", "Rarity: Unique", "Kalandra's Touch", "Iron Ring", "--------", "+120 to maximum Life"]);
    expect(buildStatFilteredQuery(parseItemText(unique), appraiseItem(unique, { statIds }), statIds)).toBeUndefined();
    const dull = ring("Dull Loop", ["+13 to Intelligence"]);
    expect(buildStatFilteredQuery(parseItemText(dull), appraiseItem(dull, { statIds }), statIds)).toBeUndefined();
  });
});
