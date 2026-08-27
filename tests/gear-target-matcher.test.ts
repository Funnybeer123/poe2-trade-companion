import { describe, expect, it } from "vitest";
import { createBuildProfile } from "../src/core/buildProfiles.js";
import {
  matchItemToGearTarget,
  scoreBuildAwareDesirability,
} from "../src/core/gearTargetMatcher.js";
import { parseItemText } from "../src/core/parseItem.js";

const item = parseItemText(
  [
    "Item Class: Rings",
    "Rarity: Rare",
    "Storm Loop",
    "Ruby Ring",
    "--------",
    "+31 to maximum Life",
    "+24% to Fire Resistance",
  ].join("\n"),
);

function target(
  statRules: Parameters<typeof createBuildProfile>[0]["gearTargets"] = [],
) {
  return createBuildProfile(
    {
      name: "Matcher",
      gearTargets:
        statRules.length > 0
          ? statRules
          : [
              {
                slot: "ring",
                itemClass: "Rings",
                importedQuery: { query: { type: "Ruby Ring" } },
              },
            ],
    },
    { now: "2026-08-27T15:00:00Z" },
  ).gearTargets[0]!;
}

describe("normalized item gear-target matcher", () => {
  it("matches imported item class and base-type identity without network data", () => {
    expect(matchItemToGearTarget(target(), item)).toMatchObject({
      matched: true,
      score: 1,
    });
  });

  it("evaluates required numeric stat targets and explains a near miss", () => {
    const passing = target([
      {
        slot: "ring",
        itemClass: "Rings",
        statRules: [
          {
            stat: "fire-resistance",
            operator: "gte",
            value: 20,
            required: true,
          },
        ],
      },
    ]);
    expect(matchItemToGearTarget(passing, item)).toMatchObject({
      matched: true,
      score: 1,
    });

    const failing = {
      ...passing,
      statRules: [{ ...passing.statRules[0]!, value: 30 }],
    };
    const result = matchItemToGearTarget(failing, item);
    expect(result.matched).toBe(false);
    expect(result.score).toBeGreaterThan(0);
    expect(result.nearMatchReasons).toContain(
      "Required stat not met: fire-resistance.",
    );
  });

  it("rejects the wrong class before scoring stats", () => {
    const boots = target([
      {
        slot: "boots",
        itemClass: "Boots",
        statRules: [{ stat: "maximum-life", required: true }],
      },
    ]);
    expect(matchItemToGearTarget(boots, item)).toMatchObject({
      matched: false,
      score: 0,
    });
  });

  it("promotes an exact active build target in unified desirability scoring", () => {
    const profile = createBuildProfile(
      {
        name: "Active rings",
        active: true,
        gearTargets: [
          {
            slot: "ring",
            itemClass: "Rings",
            importedQuery: { query: { type: "Ruby Ring" } },
          },
        ],
      },
      { now: "2026-08-27T15:00:00Z" },
    );
    const result = scoreBuildAwareDesirability(
      item,
      {
        itemIdentifier: item.fingerprint,
        itemType: item.baseType,
        normalizedKeyStats: {},
        providerName: "fixture",
        marketTimestamp: "1970-01-01T00:00:00.000Z",
        candidateCount: 0,
        comparablesUsed: 0,
        low: 0,
        fair: 0,
        high: 0,
        recommendedListing: 0,
        currency: "exalted",
        confidence: "none",
      },
      [profile],
    );
    expect(result.buildPreference.exactTargetIds).toEqual([
      profile.gearTargets[0]!.id,
    ]);
    expect(result.desirability.category).toBe("keep");
    expect(result.desirability.reasons).toContain("matches 1 active build target");
  });
});
