import { describe, expect, it } from "vitest";
import {
  MIN_OBSERVATIONS,
  addObservations,
  catalogueStatId,
  emptyLearnedTiers,
  learnTiersFromFetch,
  learnedObservationCount,
  mergeLearnedTiers,
  parseLearnedTiers,
  serializeLearnedTiers,
  storeFromObservations,
  tierDirection,
  tierForValue,
  type LearnedTiers,
} from "../src/core/tierLearning.js";

const PHYS = "explicit.stat_3032590688";
const RARITY = "explicit.stat_3917489142";
const CAST = "explicit.stat_2891184298";
const STR = "explicit.stat_4080418644";

/** The PoE2 fetch shape, trimmed from a live Ruby Ring fetch (2026-09-07). */
const FETCH_POE2 = {
  result: [
    {
      id: "8c903f2a",
      item: {
        name: "Empyrean Band",
        typeLine: "Ruby Ring",
        explicitMods: [
          {
            description: "Adds 2 to 5 [Physical|Physical] Damage to [Attack|Attacks]",
            domain: "explicit",
            hash: `stat.${PHYS}`,
            mods: [
              {
                name: "Burnished",
                tier: "P8",
                level: 8,
                magnitudes: [
                  { min: "2", max: "3" },
                  { min: "4", max: "6" },
                ],
              },
            ],
          },
          {
            description: "10% increased [ItemRarity|Rarity of Items] found",
            domain: "explicit",
            hash: `stat.${RARITY}`,
            mods: [{ name: "of Plunder", tier: "S3", level: 3, magnitudes: [{ min: "6", max: "10" }] }],
          },
          {
            description: "18% increased Cast Speed",
            domain: "explicit",
            hash: `stat.${CAST}`,
            mods: [{ name: "of Expertise", tier: "S3", level: 35, magnitudes: [{ min: "16", max: "18" }] }],
          },
        ],
        extended: { hashes: { explicit: [[PHYS, [0]], [RARITY, [1]], [CAST, [2]]] } },
      },
      listing: { price: { amount: 1, currency: "regal" } },
    },
    {
      id: "c226a783",
      item: { name: "", typeLine: "Ruby Ring", extended: { hashes: { implicit: [] } } },
      listing: { price: { amount: 1, currency: "exalted" } },
    },
    {
      id: "d7172157",
      item: {
        name: "Torment Finger",
        typeLine: "Ruby Ring",
        explicitMods: [
          {
            description: "Adds 1 to 3 [Physical|Physical] Damage to [Attack|Attacks]",
            hash: `stat.${PHYS}`,
            mods: [
              {
                name: "Glinting",
                tier: "P9",
                magnitudes: [
                  { min: "1", max: "2" },
                  { min: "3", max: "3" },
                ],
              },
            ],
          },
          {
            description: "+7 to [Strength|Strength]",
            hash: `stat.${STR}`,
            // No level on the lowest tiers — a real omission in the payload.
            mods: [{ name: "of the Brute", tier: "S8", magnitudes: [{ min: "5", max: "8" }] }],
          },
          { description: "no tier data here", hash: "stat.explicit.stat_1", mods: "nope" },
        ],
      },
      listing: { price: { amount: 1, currency: "exalted" } },
    },
  ],
};

function store(
  stats: Record<string, Record<string, { min: number; max: number; count: number; level?: number }>>,
  classes: LearnedTiers["classes"] = {},
): LearnedTiers {
  const out = emptyLearnedTiers();
  for (const [statId, tiers] of Object.entries(stats)) out.stats[statId] = { tiers };
  out.classes = classes;
  return out;
}

describe("learnTiersFromFetch", () => {
  it("reads the PoE2 explicitMods shape: tier, level, averaged two-number magnitudes", () => {
    const observations = learnTiersFromFetch(FETCH_POE2, "Rings");
    const phys = observations.filter((entry) => entry.statId === PHYS);
    expect(phys).toEqual([
      { statId: PHYS, itemClass: "Rings", tierLabel: "P8", tierNumber: 8, level: 8, min: 3, max: 4.5 },
      { statId: PHYS, itemClass: "Rings", tierLabel: "P9", tierNumber: 9, min: 2, max: 2.5 },
    ]);
    expect(observations.find((entry) => entry.statId === RARITY)).toMatchObject({
      tierNumber: 3,
      level: 3,
      min: 6,
      max: 10,
    });
    expect(observations.find((entry) => entry.statId === STR)).toMatchObject({
      tierLabel: "S8",
      tierNumber: 8,
      min: 5,
      max: 8,
    });
    expect(observations.some((entry) => entry.statId === "explicit.stat_1")).toBe(false);
    expect(observations).toHaveLength(5);
    // Without a class, the observations are class-less.
    expect(learnTiersFromFetch(FETCH_POE2)[0]!.itemClass).toBeUndefined();
  });

  it("strips the explicitMods hash prefix down to the catalogue id", () => {
    expect(catalogueStatId("stat.explicit.stat_3032590688")).toBe("explicit.stat_3032590688");
    expect(catalogueStatId("explicit.stat_3032590688")).toBe("explicit.stat_3032590688");
  });

  it("falls back to the extended.mods shape and skips garbage", () => {
    const legacy = {
      result: [
        {
          item: {
            extended: {
              mods: {
                explicit: [
                  {
                    name: "Robust",
                    tier: "P2",
                    level: 60,
                    magnitudes: [{ hash: "explicit.stat_3299347043", min: 100, max: 119 }],
                  },
                  { name: "no tier" },
                ],
              },
            },
          },
        },
        { item: null },
        "junk",
      ],
    };
    expect(learnTiersFromFetch(legacy, "Rings")).toEqual([
      {
        statId: "explicit.stat_3299347043",
        itemClass: "Rings",
        tierLabel: "P2",
        tierNumber: 2,
        level: 60,
        min: 100,
        max: 119,
      },
    ]);
    expect(learnTiersFromFetch(null)).toEqual([]);
    expect(learnTiersFromFetch({ result: "nope" })).toEqual([]);
    expect(learnTiersFromFetch({ result: [{ item: { explicitMods: [{ hash: 1 }] } }] })).toEqual([]);
  });
});

describe("learned tier store", () => {
  it("builds, merges, and counts: ranges widen, counts add, levels keep the max", () => {
    const first = storeFromObservations(learnTiersFromFetch(FETCH_POE2, "Rings"));
    expect(first.stats[PHYS]!.tiers["8"]).toEqual({ min: 3, max: 4.5, count: 1, level: 8 });
    expect(first.classes.Rings![PHYS]!.tiers["9"]).toEqual({ min: 2, max: 2.5, count: 1 });
    const again = addObservations(first, [
      { statId: PHYS, itemClass: "Rings", tierLabel: "P8", tierNumber: 8, level: 12, min: 2.5, max: 5 },
      { statId: PHYS, tierLabel: "P8", tierNumber: 8, min: 3, max: 4 },
    ]);
    expect(again.stats[PHYS]!.tiers["8"]).toEqual({ min: 2.5, max: 5, count: 3, level: 12 });
    expect(again.classes.Rings![PHYS]!.tiers["8"]).toEqual({ min: 2.5, max: 5, count: 2, level: 12 });
    expect(learnedObservationCount(again)).toBe(7);
    // Merging is symmetric on the numbers.
    const merged = mergeLearnedTiers(first, storeFromObservations([
      { statId: CAST, itemClass: "Amulets", tierLabel: "S1", tierNumber: 1, level: 70, min: 25, max: 28 },
    ]));
    expect(merged.stats[CAST]!.tiers["1"]).toEqual({ min: 25, max: 28, count: 1, level: 70 });
    expect(merged.stats[CAST]!.tiers["3"]!.count).toBe(1);
    expect(Object.keys(merged.classes).sort()).toEqual(["Amulets", "Rings"]);
  });

  it("round-trips through JSON and parses garbage as empty", () => {
    const original = addObservations(emptyLearnedTiers(), learnTiersFromFetch(FETCH_POE2, "Rings"));
    const parsed = parseLearnedTiers(serializeLearnedTiers(original));
    expect(parsed).toEqual(original);
    expect(parseLearnedTiers("not json")).toEqual(emptyLearnedTiers());
    expect(parseLearnedTiers(42)).toEqual(emptyLearnedTiers());
    expect(
      parseLearnedTiers({
        stats: {
          ok: { tiers: { "1": { min: 1, max: 2, count: 2 } } },
          bad: { tiers: { x: { min: 1, max: 2, count: 2 }, "2": { min: "1" } } },
        },
        classes: { Rings: { ok: { tiers: { "1": { min: 1, max: 2, count: 1, level: 5 } } } }, Empty: {} },
      }),
    ).toEqual({
      version: 1,
      stats: { ok: { tiers: { "1": { min: 1, max: 2, count: 2 } } } },
      classes: { Rings: { ok: { tiers: { "1": { min: 1, max: 2, count: 1, level: 5 } } } } },
    });
  });

  it("derives the tier numbering direction from mod levels", () => {
    expect(tierDirection(emptyLearnedTiers())).toBeUndefined();
    expect(
      tierDirection(store({ x: { "1": { min: 150, max: 180, count: 2, level: 80 }, "3": { min: 90, max: 119, count: 2, level: 40 } } })),
    ).toBe("desc");
    expect(
      tierDirection(store({ x: { "8": { min: 150, max: 180, count: 2, level: 80 }, "5": { min: 100, max: 120, count: 2, level: 50 } } })),
    ).toBe("asc");
    // The live payload: P8 (level 8) beats the level-less P9 — nothing to compare on yet.
    expect(tierDirection(storeFromObservations(learnTiersFromFetch(FETCH_POE2)))).toBeUndefined();
  });
});

describe("tierForValue", () => {
  const life = "explicit.stat_3299347043";
  const trusted = store({
    [life]: {
      "1": { min: 150, max: 180, count: 2, level: 80 },
      "2": { min: 120, max: 149, count: 2, level: 60 },
      "3": { min: 90, max: 119, count: 2, level: 40 },
    },
  });

  it("ranks a value by the trusted range it falls in (1 = best)", () => {
    expect(tierForValue(trusted, life, 160)).toBe(1);
    expect(tierForValue(trusted, life, 130)).toBe(2);
    expect(tierForValue(trusted, life, 100)).toBe(3);
    expect(tierForValue(trusted, life, 50)).toBe(0);
    // Above every observed range with tier 1 observed: tier 1.
    expect(tierForValue(trusted, life, 400)).toBe(1);
    // Between ranges: at least the lower tier's floor.
    expect(tierForValue(trusted, life, 149.5)).toBe(2);
  });

  it("answers undefined where it cannot know: no entry, untrusted tiers, uncovered lows", () => {
    expect(tierForValue(trusted, "explicit.stat_other", 100)).toBeUndefined();
    expect(tierForValue(trusted, life, Number.NaN)).toBeUndefined();
    const single = store({ [life]: { "1": { min: 150, max: 180, count: MIN_OBSERVATIONS - 1 } } });
    expect(tierForValue(single, life, 160)).toBeUndefined();
    // Only tiers 1-2 trusted: a low value might be tier 3 — let the thresholds decide.
    const top = store({
      [life]: { "1": { min: 150, max: 180, count: 2 }, "2": { min: 120, max: 149, count: 2 } },
    });
    expect(tierForValue(top, life, 50)).toBeUndefined();
    expect(tierForValue(top, life, 125)).toBe(2);
  });

  it("collapses tiers 3-4 to 3, calls worse tiers 0, and never over-promotes", () => {
    const deep = store({
      [life]: {
        "3": { min: 90, max: 119, count: 2 },
        "4": { min: 60, max: 89, count: 2 },
        "5": { min: 30, max: 59, count: 2 },
      },
    });
    expect(tierForValue(deep, life, 100)).toBe(3);
    expect(tierForValue(deep, life, 70)).toBe(3);
    expect(tierForValue(deep, life, 40)).toBe(0);
    // Above tier 3's max with nothing better observed: one tier better = 2.
    expect(tierForValue(deep, life, 130)).toBe(2);
    const onlyFour = store({ [life]: { "4": { min: 60, max: 89, count: 2 } } });
    expect(tierForValue(onlyFour, life, 200)).toBe(3);
  });

  it("prefers the item class's own ranges and falls back to the class-less entry", () => {
    const byClass = store(
      { [life]: { "1": { min: 150, max: 180, count: 2 } } },
      { Rings: { [life]: { tiers: { "1": { min: 60, max: 70, count: 2 } } } } },
    );
    expect(tierForValue(byClass, life, 65, "Rings")).toBe(1);
    expect(tierForValue(byClass, life, 65)).toBeUndefined();
    expect(tierForValue(byClass, life, 160, "Gloves")).toBe(1);
  });

  it("resolves a value inside overlapping ranges to the better tier, whatever the key order", () => {
    const overlapping = {
      "2": { min: 80, max: 120, count: 2, level: 60 },
      "1": { min: 100, max: 150, count: 2, level: 80 },
    };
    const forward = store({ [life]: overlapping });
    const reversed = store({ [life]: { "1": overlapping["1"], "2": overlapping["2"] } });
    for (const candidate of [forward, reversed]) {
      expect(tierForValue(candidate, life, 110)).toBe(1); // in both ranges → tier 1
      expect(tierForValue(candidate, life, 100)).toBe(1); // exactly tier 1's floor
      expect(tierForValue(candidate, life, 99)).toBe(2); // tier 2 only
      expect(tierForValue(candidate, life, 160)).toBe(1); // above every range
    }
  });

  it("never serves one class's ranges to another class", () => {
    const byClass = store(
      {},
      {
        Rings: { [life]: { tiers: { "1": { min: 60, max: 70, count: 2 } } } },
        Gloves: { [life]: { tiers: { "1": { min: 120, max: 140, count: 2 } } } },
      },
    );
    expect(tierForValue(byClass, life, 65, "Rings")).toBe(1);
    expect(tierForValue(byClass, life, 65, "Gloves")).toBeUndefined(); // under Gloves' tier 1, no tier ≥ 3
    expect(tierForValue(byClass, life, 130, "Gloves")).toBe(1);
    // A class the store never saw (and no class-less entry): nothing, not a neighbour's answer.
    expect(tierForValue(byClass, life, 65, "Boots")).toBeUndefined();
    expect(tierForValue(byClass, life, 65)).toBeUndefined();
  });

  it("parses swapped bounds the right way round so a mid roll is not promoted past the ceiling", () => {
    const parsed = parseLearnedTiers({
      stats: { [life]: { tiers: { "2": { min: 149, max: 120, count: 2 }, "3": { min: 90, max: 119, count: 2 } } } },
    });
    expect(parsed.stats[life]!.tiers["2"]).toEqual({ min: 120, max: 149, count: 2 });
    expect(tierForValue(parsed, life, 130)).toBe(2);
    expect(tierForValue(parsed, life, 160)).toBe(1);
  });

  it("honours an ascending numbering when the levels say so", () => {
    const asc = store({
      [life]: {
        "8": { min: 150, max: 180, count: 2, level: 80 },
        "5": { min: 100, max: 120, count: 2, level: 50 },
      },
    });
    expect(tierDirection(asc)).toBe("asc");
    expect(tierForValue(asc, life, 160)).toBe(1);
    // Tier 5 of 8 is rank 4 → collapses to 3.
    expect(tierForValue(asc, life, 110)).toBe(3);
  });
});
