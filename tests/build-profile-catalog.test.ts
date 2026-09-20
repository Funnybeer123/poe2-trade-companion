import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILD_PROFILE_CATALOG_KIND,
  BUILD_PROFILE_CATALOG_SCHEMA_VERSION,
  FORBIDDEN_RITES_GEAR_CATALOG_RELATIVE_PATH,
  loadBuildProfileCatalogFromJson,
  syncCatalogOwnedProfile,
} from "../src/core/buildProfileCatalog.js";
import {
  createBuildProfile,
  updateBuildProfile,
  validateBuildProfile,
  type CreateGearTargetInput,
} from "../src/core/buildProfiles.js";
import {
  FORBIDDEN_RITES_CATALOG_SETTING_KEY,
  digestBuildProfileCatalogSource,
  readForbiddenRitesCatalogRevision,
  resolveBuildProfileCatalogPath,
  seedBuildProfileCatalogFromJson,
  seedForbiddenRitesGearCatalog,
} from "../src/main/persistence/buildProfileCatalog.js";
import { ItemIntelligenceService } from "../src/main/itemIntelligenceService.js";
import { openLocalPersistence } from "../src/main/persistence/index.js";

const NOW = "2026-09-20T06:00:00.000Z";
const LATER = "2026-09-21T08:00:00.000Z";
const EXPECTED_PROFILE_COUNT = 9;
const EXPECTED_TARGET_COUNT = 204;

function catalogJson(): string {
  return readFileSync(
    path.join(process.cwd(), FORBIDDEN_RITES_GEAR_CATALOG_RELATIVE_PATH),
    "utf8",
  );
}

function miniCatalog(targets: CreateGearTargetInput[], extraProfiles: object[] = []) {
  return JSON.stringify({
    schemaVersion: BUILD_PROFILE_CATALOG_SCHEMA_VERSION,
    kind: BUILD_PROFILE_CATALOG_KIND,
    league: "Forbidden Rites",
    patch: "0.5.5b",
    curatedAt: "2026-09-20",
    notes: ["test catalog"],
    avoidUniques: [{ name: "Veil of the Night", reason: "-40% light radius" }],
    profiles: [
      {
        id: "fr-sync-test",
        name: "Sync Test",
        league: "Forbidden Rites",
        tags: ["forbidden-rites", "catalog"],
        active: true,
        preferences: {
          exactMatchBoost: 20,
          nearMatchBoost: 8,
          preferredTags: ["catalog"],
        },
        gearTargets: targets,
      },
      ...extraProfiles,
    ],
  });
}

const BOOTS_TARGET: CreateGearTargetInput = {
  searchKey: "rare:boots:ms35",
  name: "Chase boots",
  slot: "boots",
  itemClass: "Boots",
  tags: ["rare"],
  statRules: [
    {
      stat: "Movement Speed",
      operator: "gte",
      required: true,
      weight: 6,
      value: 35,
    },
  ],
};

const HELMET_TARGET: CreateGearTargetInput = {
  searchKey: "rare:helmet:life-res",
  name: "Life res helmet",
  slot: "helmet",
  itemClass: "Helmets",
  tags: ["rare"],
  statRules: [
    {
      stat: "maximum Life",
      operator: "gte",
      required: true,
      weight: 4,
      value: 80,
    },
  ],
};

describe("Forbidden Rites gear catalog", () => {
  it("loads each profile and prefers high light-radius Eventide Petals rolls", () => {
    const loaded = loadBuildProfileCatalogFromJson(catalogJson(), { now: NOW });

    expect(loaded.catalog.kind).toBe("poe2-build-profile-catalog");
    expect(loaded.catalog.league).toBe("Forbidden Rites");
    expect(loaded.profiles).toHaveLength(EXPECTED_PROFILE_COUNT);
    expect(
      loaded.profiles.reduce((count, profile) => count + profile.gearTargets.length, 0),
    ).toBe(EXPECTED_TARGET_COUNT);
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

  it("seeds the catalog into persistence on first run and stays a no-op when unchanged", () => {
    const filePath = resolveBuildProfileCatalogPath();
    const persistence = openLocalPersistence(":memory:", { clock: () => NOW });
    const first = seedForbiddenRitesGearCatalog(persistence, filePath, { now: NOW });

    expect(first.unchanged).toBe(false);
    expect(first.addedProfileIds).toHaveLength(EXPECTED_PROFILE_COUNT);
    expect(first.skippedProfileIds).toEqual([]);
    expect(first.addedTargetIds).toHaveLength(EXPECTED_TARGET_COUNT);
    expect(persistence.buildProfiles.list()).toHaveLength(EXPECTED_PROFILE_COUNT);
    const revision = readForbiddenRitesCatalogRevision(persistence);
    expect(revision).toMatchObject({
      league: "Forbidden Rites",
      digest: digestBuildProfileCatalogSource(catalogJson()),
      revision: digestBuildProfileCatalogSource(catalogJson()),
      targetCount: EXPECTED_TARGET_COUNT,
      profileIds: expect.arrayContaining(["fr-light-radius-150"]),
    });
    expect(persistence.settings.get(FORBIDDEN_RITES_CATALOG_SETTING_KEY)?.value).toMatchObject({
      league: "Forbidden Rites",
      digest: revision?.digest,
    });

    const second = seedForbiddenRitesGearCatalog(persistence, filePath, { now: LATER });
    expect(second.unchanged).toBe(true);
    expect(second.addedProfileIds).toEqual([]);
    expect(second.updatedProfileIds).toEqual([]);
    expect(second.addedTargetIds).toEqual([]);
    expect(second.updatedTargetIds).toEqual([]);
    expect(second.skippedProfileIds).toHaveLength(EXPECTED_PROFILE_COUNT);
    expect(persistence.buildProfiles.list()).toHaveLength(EXPECTED_PROFILE_COUNT);
    expect(readForbiddenRitesCatalogRevision(persistence)?.importedAt).toBe(NOW);

    const service = new ItemIntelligenceService({
      persistence,
      now: () => NOW,
    });
    const seeded = service.seedBundledBuildProfileCatalog(filePath);
    expect(seeded.unchanged).toBe(true);
    expect(seeded.profiles).toHaveLength(EXPECTED_PROFILE_COUNT);
    expect(service.listBuildProfiles()).toHaveLength(EXPECTED_PROFILE_COUNT);
    expect(service.listCatalogAvoidUniques().some((entry) => entry.name === "Veil of the Night")).toBe(
      true,
    );
    persistence.close();
  });

  it("upserts new and changed catalog targets on a later start when the fixture grows", () => {
    const persistence = openLocalPersistence(":memory:", { clock: () => NOW });
    const first = seedBuildProfileCatalogFromJson(persistence, miniCatalog([BOOTS_TARGET]), {
      now: NOW,
    });

    expect(first.unchanged).toBe(false);
    expect(first.addedProfileIds).toEqual(["fr-sync-test"]);
    expect(first.addedTargetIds).toHaveLength(1);
    const originalBoots = persistence.buildProfiles
      .get("fr-sync-test")
      ?.gearTargets.find((target) => target.searchKey === BOOTS_TARGET.searchKey);
    expect(originalBoots?.statRules[0]).toMatchObject({ stat: "Movement Speed", value: 35 });

    const customized = persistUserTarget(persistence, NOW);

    const expanded = miniCatalog(
      [
        {
          ...BOOTS_TARGET,
          statRules: [
            {
              stat: "Movement Speed",
              operator: "gte",
              required: true,
              weight: 8,
              value: 30,
            },
          ],
        },
        HELMET_TARGET,
      ],
      [
        {
          id: "fr-sync-extra",
          name: "Extra Catalog Profile",
          league: "Forbidden Rites",
          tags: ["catalog"],
          active: true,
          gearTargets: [HELMET_TARGET],
        },
      ],
    );

    const second = seedBuildProfileCatalogFromJson(persistence, expanded, { now: LATER });
    expect(second.unchanged).toBe(false);
    expect(second.addedProfileIds).toEqual(["fr-sync-extra"]);
    expect(second.updatedProfileIds).toEqual(["fr-sync-test"]);
    expect(second.addedTargetIds).toHaveLength(2);
    expect(second.updatedTargetIds).toHaveLength(1);

    const synced = persistence.buildProfiles.get("fr-sync-test");
    expect(synced?.gearTargets.map((target) => target.searchKey).sort()).toEqual([
      "manual:user-ring",
      BOOTS_TARGET.searchKey,
      HELMET_TARGET.searchKey,
    ].sort());
    expect(
      synced?.gearTargets.find((target) => target.searchKey === BOOTS_TARGET.searchKey)?.statRules[0],
    ).toMatchObject({ stat: "Movement Speed", value: 30, weight: 8 });
    expect(
      synced?.gearTargets.find((target) => target.searchKey === "manual:user-ring")?.name,
    ).toBe("User ring");
    expect(synced?.gearTargets.find((target) => target.searchKey === "manual:user-ring")?.id).toBe(
      customized,
    );

    const extra = persistence.buildProfiles.get("fr-sync-extra");
    expect(extra?.gearTargets).toHaveLength(1);
    expect(extra?.gearTargets[0]?.searchKey).toBe(HELMET_TARGET.searchKey);

    const revision = readForbiddenRitesCatalogRevision(persistence);
    expect(revision?.digest).toBe(digestBuildProfileCatalogSource(expanded));
    expect(revision?.targetCount).toBe(3);
    expect(revision?.importedAt).toBe(LATER);

    const third = seedBuildProfileCatalogFromJson(persistence, expanded, { now: "2026-09-22T00:00:00.000Z" });
    expect(third.unchanged).toBe(true);
    expect(third.addedTargetIds).toEqual([]);
    expect(third.updatedTargetIds).toEqual([]);
    expect(readForbiddenRitesCatalogRevision(persistence)?.importedAt).toBe(LATER);
    persistence.close();
  });

  it("keeps user customizations and updates catalog searchKeys in memory", () => {
    const existing = createBuildProfile(
      {
        id: "fr-sync-test",
        name: "Old name",
        tags: ["user"],
        active: false,
        gearTargets: [
          {
            searchKey: "rare:boots:ms35",
            name: "Old boots",
            slot: "boots",
            statRules: [{ stat: "Movement Speed", operator: "gte", value: 20, required: true, weight: 1 }],
          },
          {
            searchKey: "manual:user-ring",
            name: "User ring",
            slot: "ring",
          },
        ],
      },
      { now: NOW },
    );
    const incoming = createBuildProfile(
      {
        id: "fr-sync-test",
        name: "Sync Test",
        tags: ["catalog"],
        active: true,
        gearTargets: [BOOTS_TARGET, HELMET_TARGET],
      },
      { now: LATER },
    );

    const synced = syncCatalogOwnedProfile(existing, incoming, { now: LATER });
    expect(synced.created).toBe(false);
    expect(synced.addedTargetIds).toHaveLength(1);
    expect(synced.updatedTargetIds).toHaveLength(1);
    expect(synced.profile.active).toBe(false);
    expect(synced.profile.name).toBe("Sync Test");
    expect(synced.profile.tags).toEqual(["catalog"]);
    expect(synced.profile.gearTargets.map((target) => target.searchKey).sort()).toEqual([
      "manual:user-ring",
      "rare:boots:ms35",
      "rare:helmet:life-res",
    ]);
    expect(
      synced.profile.gearTargets.find((target) => target.searchKey === "rare:boots:ms35")?.statRules[0],
    ).toMatchObject({ value: 35, weight: 6 });
  });
});

function persistUserTarget(
  persistence: ReturnType<typeof openLocalPersistence>,
  now: string,
): string {
  const profile = persistence.buildProfiles.get("fr-sync-test");
  if (!profile) throw new Error("expected seeded profile");
  const withUserTarget = updateBuildProfile(
    profile,
    {
      gearTargets: [
        ...profile.gearTargets,
        {
          searchKey: "manual:user-ring",
          name: "User ring",
          slot: "ring",
        },
      ],
    },
    { now },
  );
  persistence.buildProfiles.upsert(withUserTarget);
  const userTarget = withUserTarget.gearTargets.find(
    (target) => target.searchKey === "manual:user-ring",
  );
  if (!userTarget) throw new Error("expected user target");
  return userTarget.id;
}
