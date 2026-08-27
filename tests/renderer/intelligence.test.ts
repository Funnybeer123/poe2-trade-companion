import { describe, expect, it } from "vitest";
import { createBuildProfile } from "../../src/core/buildProfiles.js";
import type { NormalizedItem } from "../../src/core/types.js";
import type { CatalogItemView } from "../../src/shared/ipc.js";
import {
  catalogBuildCoverage,
  explainRuleMatch,
  matchGearTarget,
} from "../../src/renderer/utils/intelligence.js";

const item: NormalizedItem = {
  itemClass: "Rings",
  rarity: "Rare",
  name: "Storm Loop",
  baseType: "Ruby Ring",
  itemLevel: 82,
  requirements: {},
  mods: [
    { text: "+35% to Fire Resistance", values: [35] },
    { text: "+92 to maximum Life", values: [92] },
  ],
  identified: true,
  fingerprint: "ring-fixture",
  rawText: [
    "Item Class: Rings",
    "Rarity: Rare",
    "Storm Loop",
    "Ruby Ring",
    "--------",
    "+35% to Fire Resistance",
    "+92 to maximum Life",
  ].join("\n"),
};

describe("renderer intelligence explanations", () => {
  it("explains exact and near OR-of-AND rule matches", () => {
    const exact = explainRuleMatch(
      {
        name: "Life or resistance",
        regex: '"cold resistance"|"fire resistance" "maximum life"',
      },
      item,
    );
    expect(exact.status).toBe("match");
    expect(exact.bestBranch?.index).toBe(1);
    expect(exact.bestBranch?.terms.every((term) => term.matched)).toBe(true);

    const near = explainRuleMatch(
      {
        name: "Life and movement",
        regex: '"maximum life" "movement speed"',
      },
      item,
    );
    expect(near.status).toBe("near-match");
    expect(near.bestBranch?.matchedTerms).toBe(1);
    expect(near.bestBranch?.terms.find((term) => !term.matched)?.reason).toContain(
      "does not contain",
    );
  });

  it("computes exact catalog coverage with practical stat rules", () => {
    const profile = createBuildProfile({
      name: "Resistance setup",
      gearTargets: [
        {
          name: "Fire ring",
          slot: "ring-1",
          itemClass: "Rings",
          statRules: [
            {
              stat: "fire-resistance",
              operator: "gte",
              value: 30,
              required: true,
              weight: 1,
            },
          ],
        },
      ],
    });
    const catalog: CatalogItemView[] = [
      {
        id: "catalog-ring",
        fingerprint: item.fingerprint,
        name: item.name,
        baseType: item.baseType,
        itemClass: item.itemClass,
        currentLocation: "fixture",
        item,
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
      },
    ];

    const direct = matchGearTarget(profile.gearTargets[0]!, item);
    expect(direct).toMatchObject({ matched: true, score: 1 });

    const coverage = catalogBuildCoverage(profile, catalog);
    expect(coverage).toMatchObject({
      covered: 1,
      nearMatches: 0,
      missing: 0,
      total: 1,
      ratio: 1,
    });
    expect(coverage.targets[0]).toMatchObject({
      status: "covered",
      candidateId: "catalog-ring",
    });
  });
});
