import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_RITES_GEAR_CATALOG_RELATIVE_PATH,
  loadBuildProfileCatalogFromJson,
} from "../src/core/buildProfileCatalog.js";
import { createBuildProfile, validateBuildProfile } from "../src/core/buildProfiles.js";
import {
  FORBIDDEN_RITES_CATALOG_SETTING_KEY,
  resolveBuildProfileCatalogPath,
  seedForbiddenRitesGearCatalog,
} from "../src/main/persistence/buildProfileCatalog.js";
import { ItemIntelligenceService } from "../src/main/itemIntelligenceService.js";
import { openLocalPersistence } from "../src/main/persistence/index.js";

const NOW = "2026-09-20T06:00:00.000Z";
const EXPECTED_PROFILE_COUNT = 7;

function catalogJson(): string {
  return readFileSync(
    path.join(process.cwd(), FORBIDDEN_RITES_GEAR_CATALOG_RELATIVE_PATH),
    "utf8",
  );
}

describe("Forbidden Rites gear catalog", () => {
  it("loads each profile and prefers high light-radius Eventide Petals rolls", () => {
    const loaded = loadBuildProfileCatalogFromJson(catalogJson(), { now: NOW });

    expect(loaded.catalog.kind).toBe("poe2-build-profile-catalog");
    expect(loaded.catalog.league).toBe("Forbidden Rites");
    expect(loaded.profiles).toHaveLength(EXPECTED_PROFILE_COUNT);
    expect(loaded.warnings).toEqual([]);

    for (const profile of loaded.profiles) {
      expect(validateBuildProfile(profile)).toEqual({ valid: true, issues: [] });
      expect(createBuildProfile(profile, { now: NOW }).id).toBe(profile.id);
    }

    const lightRadius = loaded.profiles.find(
      (profile) => profile.id === "fr-light-radius-150",
    );
    expect(lightRadius?.name).toBe("Max Light Radius (150% cap)");
    expect(lightRadius?.preferences.preferredTags).toContain("light-radius");

    const petals = lightRadius?.gearTargets.find(
      (target) => target.name === "Eventide Petals",
    );
    expect(petals).toMatchObject({
      slot: "amulet",
      itemClass: "Amulets",
      searchKey: "unique:eventide-petals",
    });
    expect(petals?.importedQuery).toMatchObject({
      query: { name: "Eventide Petals", type: "Veridical Chain" },
    });

    const highRoll = petals?.statRules.find((rule) => rule.operator === "between");
    const floor = petals?.statRules.find((rule) => rule.operator === "gte");
    expect(highRoll).toMatchObject({
      stat: "increased Light Radius",
      min: 45,
      max: 50,
      required: true,
      weight: 5,
    });
    expect(floor).toMatchObject({
      stat: "increased Light Radius",
      value: 30,
      required: false,
    });
    expect(highRoll?.weight ?? 0).toBeGreaterThan(floor?.weight ?? 0);
  });

  it("seeds the catalog into persistence on first run and stays idempotent", () => {
    const filePath = resolveBuildProfileCatalogPath();
    const persistence = openLocalPersistence(":memory:", { clock: () => NOW });
    const first = seedForbiddenRitesGearCatalog(persistence, filePath, { now: NOW });

    expect(first.addedProfileIds).toHaveLength(EXPECTED_PROFILE_COUNT);
    expect(first.skippedProfileIds).toEqual([]);
    expect(persistence.buildProfiles.list()).toHaveLength(EXPECTED_PROFILE_COUNT);
    expect(persistence.settings.get(FORBIDDEN_RITES_CATALOG_SETTING_KEY)?.value).toMatchObject({
      league: "Forbidden Rites",
      profileIds: expect.arrayContaining(["fr-light-radius-150"]),
    });

    const second = seedForbiddenRitesGearCatalog(persistence, filePath, { now: NOW });
    expect(second.addedProfileIds).toEqual([]);
    expect(second.skippedProfileIds).toHaveLength(EXPECTED_PROFILE_COUNT);
    expect(persistence.buildProfiles.list()).toHaveLength(EXPECTED_PROFILE_COUNT);

    const service = new ItemIntelligenceService({
      persistence,
      now: () => NOW,
    });
    const seeded = service.seedBundledBuildProfileCatalog(filePath);
    expect(seeded.profiles).toHaveLength(EXPECTED_PROFILE_COUNT);
    expect(service.listBuildProfiles()).toHaveLength(EXPECTED_PROFILE_COUNT);
    expect(service.listCatalogAvoidUniques().some((entry) => entry.name === "Veil of the Night")).toBe(
      true,
    );
    persistence.close();
  });
});
