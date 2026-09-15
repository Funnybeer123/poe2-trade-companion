import { describe, expect, it } from "vitest";
import {
  entryForTierNumber,
  isLowerIsBetter,
  maxTierAtLevel,
  nextTierAboveLevel,
  rankForValue,
  rollPercent,
  statIdsForInspect,
  tierLadderFor,
} from "../src/core/inspectTiers.js";
import { buildStatCatalogue } from "../src/core/statIds.js";
import { MOD_FAMILIES } from "../src/core/modKnowledge.js";
import { parseLearnedTiers, type LearnedTiers } from "../src/core/tierLearning.js";
import { readFileSync } from "node:fs";

const LEARNED: LearnedTiers = parseLearnedTiers(
  JSON.parse(readFileSync(new URL("../fixtures/inspect/learned-tiers-sample.json", import.meta.url), "utf8")),
);

const LIFE = "explicit.stat_3299347043";
const FIRE = "explicit.stat_3372524247";

/** An ascending store: the highest tier number is the best roll. */
function ascendingStore(): LearnedTiers {
  return {
    version: 1,
    stats: {
      "explicit.demo": {
        tiers: {
          "1": { min: 10, max: 19, count: 4, level: 20 },
          "2": { min: 20, max: 29, count: 4, level: 45 },
          "3": { min: 30, max: 39, count: 4, level: 70 },
        },
      },
    },
    classes: {},
  };
}

describe("tierLadderFor", () => {
  it("prefers the item class's own table and ranks 1 = best for a descending store", () => {
    const ladder = tierLadderFor(LEARNED, [LIFE], "Rings");
    expect(ladder?.scope).toBe("class");
    expect(ladder?.direction).toBe("desc");
    expect(ladder?.entries.map((entry) => entry.rank)).toEqual([1, 2, 3]);
    expect(ladder?.entries[0]).toMatchObject({ tierNumber: 1, min: 130, max: 149, level: 82, trusted: true });
  });

  it("falls back to the class-less table for another class", () => {
    const ladder = tierLadderFor(LEARNED, [LIFE], "Amulets");
    expect(ladder?.scope).toBe("global");
    expect(ladder?.statId).toBe(LIFE);
  });

  it("maps ranks the other way for an ascending store", () => {
    const ladder = tierLadderFor(ascendingStore(), ["explicit.demo"]);
    expect(ladder?.direction).toBe("asc");
    expect(ladder?.entries.map((entry) => [entry.tierNumber, entry.rank])).toEqual([
      [3, 1],
      [2, 2],
      [1, 3],
    ]);
  });

  it("prefers a class ladder for a later stat id over a class-less one for an earlier id", () => {
    // Stat ids are tried in order, but scope beats order: the class table
    // was learned from listings of this very base.
    const ladder = tierLadderFor(LEARNED, [FIRE, LIFE], "Rings");
    expect(ladder?.scope).toBe("class");
    expect(ladder?.statId).toBe(LIFE);
  });

  it("answers undefined without a store or a known stat", () => {
    expect(tierLadderFor(undefined, [LIFE])).toBeUndefined();
    expect(tierLadderFor(LEARNED, ["explicit.nothing"])).toBeUndefined();
  });
});

describe("rankForValue", () => {
  const ladder = tierLadderFor(LEARNED, [LIFE], "Rings")!;

  it("places a roll inside its observed range", () => {
    expect(rankForValue(ladder, 101)?.tierNumber).toBe(3);
    expect(rankForValue(ladder, 135)?.tierNumber).toBe(1);
  });

  it("gives a roll above every observed range the best trusted tier", () => {
    expect(rankForValue(ladder, 160)?.rank).toBe(1);
  });

  it("answers undefined under every trusted range", () => {
    expect(rankForValue(ladder, 12)).toBeUndefined();
  });

  it("does not promote a mediocre roll when learned ranges overlap", () => {
    // Learned ranges come from listings, so one low-rolled T1 listing can
    // widen T1 down over the whole of T3. The worst-ranked range that
    // actually contains the value is the honest answer.
    const overlapping: LearnedTiers = {
      version: 1,
      stats: {
        "explicit.demo": {
          tiers: {
            "1": { min: 100, max: 149, count: 5, level: 82 },
            "2": { min: 110, max: 129, count: 5, level: 76 },
            "3": { min: 95, max: 110, count: 5, level: 68 },
          },
        },
      },
      classes: {},
    };
    const ladder = tierLadderFor(overlapping, ["explicit.demo"])!;
    expect(rankForValue(ladder, 105)?.tierNumber).toBe(3);
    expect(rankForValue(ladder, 120)?.tierNumber).toBe(2);
    expect(rankForValue(ladder, 140)?.tierNumber).toBe(1);
    expect(rankForValue(ladder, 200)?.tierNumber).toBe(1);
  });

  it("ignores untrusted entries", () => {
    const thin: LearnedTiers = {
      version: 1,
      stats: { "explicit.demo": { tiers: { "1": { min: 10, max: 20, count: 1 } } } },
      classes: {},
    };
    const thinLadder = tierLadderFor(thin, ["explicit.demo"])!;
    expect(thinLadder.entries[0]!.trusted).toBe(false);
    expect(rankForValue(thinLadder, 15)).toBeUndefined();
  });
});

describe("entryForTierNumber and maxTierAtLevel", () => {
  const ladder = tierLadderFor(LEARNED, [LIFE], "Rings")!;

  it("finds the entry the game's own tier number names", () => {
    expect(entryForTierNumber(ladder, 2)).toMatchObject({ min: 110, max: 129, level: 76 });
    expect(entryForTierNumber(ladder, 9)).toBeUndefined();
  });

  it("picks the best tier the item level allows", () => {
    expect(maxTierAtLevel(ladder, 73)?.tierNumber).toBe(3);
    expect(maxTierAtLevel(ladder, 80)?.tierNumber).toBe(2);
    expect(maxTierAtLevel(ladder, 84)?.tierNumber).toBe(1);
    expect(maxTierAtLevel(ladder, 10)).toBeUndefined();
  });

  it("ignores entries without a required level", () => {
    const levelless: LearnedTiers = {
      version: 1,
      stats: { "explicit.demo": { tiers: { "1": { min: 10, max: 20, count: 4 } } } },
      classes: {},
    };
    const ladderWithoutLevels = tierLadderFor(levelless, ["explicit.demo"])!;
    expect(maxTierAtLevel(ladderWithoutLevels, 99)).toBeUndefined();
    expect(nextTierAboveLevel(ladderWithoutLevels, 10)).toBeUndefined();
  });

  it("names the cheapest better tier the item level cannot hold yet", () => {
    expect(nextTierAboveLevel(ladder, 73)).toMatchObject({ tierNumber: 2, level: 76 });
    expect(nextTierAboveLevel(ladder, 76)).toMatchObject({ tierNumber: 1, level: 82 });
    expect(nextTierAboveLevel(ladder, 90)).toBeUndefined();
  });
});

describe("rollPercent", () => {
  it("scales a roll into its range", () => {
    expect(rollPercent(95, 95, 110)).toBe(0);
    expect(rollPercent(101, 95, 110)).toBe(40);
    expect(rollPercent(110, 95, 110)).toBe(100);
  });

  it("clamps outside the range and flips for lower-is-better modifiers", () => {
    expect(rollPercent(160, 95, 110)).toBe(100);
    expect(rollPercent(10, 95, 110)).toBe(0);
    expect(rollPercent(101, 95, 110, true)).toBe(60);
  });

  it("answers undefined for a single-value range or unusable numbers", () => {
    expect(rollPercent(5, 5, 5)).toBeUndefined();
    expect(rollPercent(Number.NaN, 1, 2)).toBeUndefined();
  });
});

describe("isLowerIsBetter", () => {
  it("recognises penalty modifiers only", () => {
    expect(isLowerIsBetter("15% reduced Movement Speed")).toBe(true);
    expect(isLowerIsBetter("+101 to maximum Life")).toBe(false);
  });
});

describe("statIdsForInspect", () => {
  const catalogue = buildStatCatalogue(
    JSON.parse(readFileSync(new URL("../fixtures/trade/stats-subset.json", import.meta.url), "utf8")),
    MOD_FAMILIES,
  );

  it("resolves a mod line to its catalogue id", () => {
    expect(statIdsForInspect(catalogue, "+101 to maximum Life")).toContain(LIFE);
    expect(statIdsForInspect(catalogue, "+28% to Fire Resistance")).toContain(FIRE);
  });

  it("adds the family's siblings when a family is known", () => {
    const ids = statIdsForInspect(catalogue, "+101 to maximum Life", "life");
    expect(ids).toContain(LIFE);
  });

  it("answers nothing without a catalogue", () => {
    expect(statIdsForInspect(undefined, "+101 to maximum Life")).toEqual([]);
  });
});
