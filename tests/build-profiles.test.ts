import { describe, expect, it } from "vitest";
import {
  activateBuildProfile,
  associateGearTarget,
  computeBuildCoverage,
  createBuildProfile,
  getActiveProfileDesirabilityPreferences,
  importGearTargets,
  scoreCandidateForActiveProfiles,
  updateBuildProfile,
  validateBuildProfile,
  type GearTargetMatcher,
} from "../src/core/buildProfiles.js";

const NOW = "2026-08-26T06:00:00.000Z";

describe("build profiles", () => {
  it("creates, validates, updates, and associates typed gear targets", () => {
    const created = createBuildProfile(
      {
        name: "Lightning ranger",
        league: "Standard",
        sourceUrl: "https://example.com/build/lightning",
        tags: ["mapping", "lightning", "mapping"],
        preferences: {
          exactMatchBoost: 25,
          nearMatchBoost: 9,
        },
        gearTargets: [
          {
            searchKey: "search:helmet",
            name: "Resistant helmet",
            slot: "helmet",
            itemClass: "Helmets",
            statRules: [
              {
                stat: "fire-resistance",
                operator: "gte",
                value: 30,
                required: true,
                weight: 3,
              },
            ],
          },
        ],
      },
      { now: NOW },
    );

    expect(validateBuildProfile(created)).toEqual({ valid: true, issues: [] });
    expect(created.tags).toEqual(["lightning", "mapping"]);
    expect(created.gearTargets).toHaveLength(1);
    expect(created.gearTargets[0]?.statRules[0]).toMatchObject({
      stat: "fire-resistance",
      operator: "gte",
      required: true,
    });

    const associated = associateGearTarget(
      created,
      created.gearTargets[0]!.id,
      {
        slot: "head",
        itemClass: "Helmets",
        tags: ["defence", "resistance"],
      },
      { now: "2026-08-26T06:01:00Z" },
    );
    const updated = updateBuildProfile(
      associated,
      { name: "Lightning ranger v2", active: true },
      { now: "2026-08-26T06:02:00Z" },
    );

    expect(updated.name).toBe("Lightning ranger v2");
    expect(updated.active).toBe(true);
    expect(updated.gearTargets[0]).toMatchObject({
      slot: "head",
      itemClass: "Helmets",
      tags: ["defence", "resistance"],
    });
    expect(updated.gearTargets[0]?.id).toBe(created.gearTargets[0]?.id);
    expect(updated.gearTargets[0]?.searchKey).toBe("search:helmet");
  });

  it("creates exactly one target per distinct imported search", () => {
    const profile = createBuildProfile({ name: "Importer" }, { now: NOW });
    const first = importGearTargets(
      profile,
      [
        {
          searchKey: "query:a",
          name: "First helmet",
          slot: "helmet",
          importedQuery: { query: { type: "Helmet" } },
        },
        {
          searchKey: "query:a",
          name: "Duplicate helmet",
          slot: "helmet",
        },
        {
          searchKey: "query:b",
          name: "Boots",
          slot: "boots",
        },
      ],
      { now: NOW },
    );

    expect(first.profile.gearTargets).toHaveLength(2);
    expect(first.addedTargetIds).toHaveLength(2);
    expect(first.warnings).toContain("Duplicate imported search 'query:a' was ignored.");

    const second = importGearTargets(
      first.profile,
      [{ searchKey: "query:a", name: "Updated helmet", slot: "head" }],
      { now: "2026-08-26T06:03:00Z" },
    );
    expect(second.profile.gearTargets).toHaveLength(2);
    expect(second.addedTargetIds).toEqual([]);
    expect(second.updatedTargetIds).toHaveLength(1);
    expect(
      second.profile.gearTargets.find((target) => target.searchKey === "query:a"),
    ).toMatchObject({ name: "Updated helmet", slot: "head" });
  });

  it("reports exact coverage, alternatives, near matches, and missing reasons", () => {
    const profile = createBuildProfile(
      {
        name: "Coverage",
        gearTargets: [
          {
            searchKey: "helmet",
            name: "Helmet",
            slot: "helmet",
            itemClass: "Helmets",
          },
          {
            searchKey: "boots",
            name: "Boots",
            slot: "boots",
            itemClass: "Boots",
          },
          {
            searchKey: "amulet",
            name: "Amulet",
            slot: "amulet",
            itemClass: "Amulets",
          },
        ],
      },
      { now: NOW },
    );
    type Candidate = { itemClass: string; quality: number };
    const matcher: GearTargetMatcher<Candidate> = (target, candidate) => {
      if (target.itemClass !== candidate.value.itemClass) {
        return {
          matched: false,
          score: 0,
          reasons: ["wrong item class"],
        };
      }
      const score = candidate.value.quality / 100;
      return {
        matched: score >= 0.8,
        score,
        reasons: score >= 0.8 ? ["quality target met"] : [],
        nearMatchReasons: score < 0.8 ? [`quality ${candidate.value.quality} is low`] : [],
      };
    };

    const coverage = computeBuildCoverage(
      profile,
      [
        { id: "helmet-good", value: { itemClass: "Helmets", quality: 90 } },
        { id: "helmet-alt", value: { itemClass: "Helmets", quality: 82 } },
        { id: "boots-near", value: { itemClass: "Boots", quality: 65 } },
      ],
      matcher,
    );

    expect(coverage).toMatchObject({
      covered: 1,
      nearMatches: 1,
      missing: 1,
      total: 3,
      ratio: 1 / 3,
    });
    expect(coverage.targets[0]).toMatchObject({
      status: "covered",
      candidateId: "helmet-good",
      reasons: ["quality target met"],
    });
    expect(coverage.targets[0]?.alternatives[0]).toMatchObject({
      candidateId: "helmet-alt",
      matched: true,
    });
    expect(coverage.targets[1]).toMatchObject({
      status: "near-match",
      candidateId: "boots-near",
      reasons: ["quality 65 is low"],
    });
    expect(coverage.targets[2]?.status).toBe("missing");
    expect(coverage.targets[2]?.reasons).toContain("wrong item class");
  });

  it("derives desirability preferences only from active profiles", () => {
    const active = createBuildProfile(
      {
        name: "Active",
        active: true,
        tags: ["bossing"],
        preferences: {
          exactMatchBoost: 30,
          nearMatchBoost: 10,
          preferredTags: ["upgrade"],
        },
        gearTargets: [
          {
            searchKey: "ring",
            name: "Ring",
            slot: "ring",
            itemClass: "Rings",
            tags: ["resistance"],
          },
        ],
      },
      { now: NOW },
    );
    const inactive = createBuildProfile(
      {
        name: "Inactive",
        gearTargets: [
          {
            searchKey: "bow",
            name: "Bow",
            slot: "weapon",
            itemClass: "Bows",
          },
        ],
      },
      { now: NOW },
    );

    const preferences = getActiveProfileDesirabilityPreferences([active, inactive]);
    expect(preferences.profileIds).toEqual([active.id]);
    expect(preferences.preferredItemClasses).toEqual(["Rings"]);
    expect(preferences.preferredTags).toEqual(["bossing", "resistance", "upgrade"]);

    const candidate = { id: "ring-1", value: { itemClass: "Rings" } };
    const score = scoreCandidateForActiveProfiles(
      [active, inactive],
      candidate,
      (target, item) => ({
        matched: target.itemClass === item.value.itemClass,
        score: target.itemClass === item.value.itemClass ? 1 : 0,
        reasons: ["class matched"],
      }),
    );
    expect(score).toMatchObject({
      bonus: 30,
      exactTargetIds: [active.gearTargets[0]!.id],
      nearTargetIds: [],
    });

    const deactivated = activateBuildProfile(
      [active, inactive],
      inactive.id,
      { now: "2026-08-26T07:00:00Z" },
    );
    expect(deactivated.map((profile) => profile.active)).toEqual([false, true]);
  });

  it("rejects automation controls and duplicate search targets", () => {
    expect(() =>
      createBuildProfile(
        {
          name: "Unsafe",
          automationEnabled: true,
        } as unknown as Parameters<typeof createBuildProfile>[0],
        { now: NOW },
      ),
    ).toThrow("cannot arm automation");

    const profile = createBuildProfile(
      {
        name: "Duplicates",
        gearTargets: [
          { searchKey: "same", slot: "helmet" },
          { searchKey: "other", slot: "boots" },
        ],
      },
      { now: NOW },
    );
    const invalid = {
      ...profile,
      gearTargets: [
        profile.gearTargets[0],
        { ...profile.gearTargets[1]!, searchKey: "same" },
      ],
    };
    expect(validateBuildProfile(invalid).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "duplicate-search" }),
      ]),
    );
  });
});
