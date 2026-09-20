import {
  createBuildProfile,
  importGearTargets,
  updateBuildProfile,
  type BuildProfile,
  type BuildProfileMutationOptions,
  type CreateBuildProfileInput,
  type ImportedGearSearch,
} from "./buildProfiles.js";

export const BUILD_PROFILE_CATALOG_KIND = "poe2-build-profile-catalog";
export const BUILD_PROFILE_CATALOG_SCHEMA_VERSION = 1;
export const FORBIDDEN_RITES_GEAR_CATALOG_RELATIVE_PATH =
  "fixtures/builds/forbidden-rites-gear-targets.json";
export const FORBIDDEN_RITES_GEAR_CATALOG_SOURCE_KEY =
  "fixture:forbidden-rites-gear-targets";

export interface AvoidUnique {
  name: string;
  reason: string;
}

export interface BuildProfileCatalog {
  schemaVersion: number;
  kind: typeof BUILD_PROFILE_CATALOG_KIND;
  league: string;
  patch?: string;
  curatedAt?: string;
  tradeBaseUrl?: string;
  notes: string[];
  avoidUniques: AvoidUnique[];
  profiles: CreateBuildProfileInput[];
}

export interface LoadedBuildProfileCatalog {
  catalog: BuildProfileCatalog;
  profiles: BuildProfile[];
  warnings: string[];
}

export interface CatalogProfileSyncResult {
  profile: BuildProfile;
  created: boolean;
  addedTargetIds: string[];
  updatedTargetIds: string[];
  warnings: string[];
}

/**
 * Sync policy for catalog-owned profiles (IDs that appear in the bundled
 * fixture): the fixture is the source of truth for profile metadata and for
 * gear targets matched by `searchKey`. New catalog keys are added; existing
 * keys receive fixture searchKey / statRules / name / slot / itemClass
 * updates. Extra targets on the same profile whose searchKeys are not in the
 * fixture are treated as user customizations and kept. A user's `active`
 * flag is preserved. Profiles that are not in the fixture are never touched.
 * A changed catalog searchKey is a new target — identity is searchKey, not
 * display name.
 */
export const BUILD_PROFILE_CATALOG_SYNC_POLICY =
  "fixture-source-of-truth-for-catalog-owned-searchKeys";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string when provided`);
  }
  return value.trim();
}

function parseAvoidUniques(value: unknown): AvoidUnique[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("avoidUniques must be an array");
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`avoidUniques[${index}] must be an object`);
    }
    return {
      name: requiredText(entry.name, `avoidUniques[${index}].name`),
      reason: requiredText(entry.reason, `avoidUniques[${index}].reason`),
    };
  });
}

function parseNotes(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("notes must be an array");
  return value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`notes[${index}] must be a non-empty string`);
    }
    return entry.trim();
  });
}

function parseCatalogProfiles(value: unknown): CreateBuildProfileInput[] {
  if (!Array.isArray(value)) throw new Error("profiles must be an array");
  if (value.length === 0) throw new Error("Build profile catalog requires at least one profile");
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`profiles[${index}] must be an object`);
    }
    const name = requiredText(entry.name, `profiles[${index}].name`);
    return {
      ...(typeof entry.id === "string" && entry.id.trim() ? { id: entry.id.trim() } : {}),
      name,
      ...(typeof entry.league === "string" ? { league: entry.league } : {}),
      ...(typeof entry.sourceUrl === "string" ? { sourceUrl: entry.sourceUrl } : {}),
      ...(Array.isArray(entry.tags) ? { tags: entry.tags as string[] } : {}),
      ...(typeof entry.active === "boolean" ? { active: entry.active } : {}),
      ...(isRecord(entry.preferences)
        ? { preferences: entry.preferences as CreateBuildProfileInput["preferences"] }
        : {}),
      ...(Array.isArray(entry.gearTargets)
        ? { gearTargets: entry.gearTargets as CreateBuildProfileInput["gearTargets"] }
        : {}),
    };
  });
}

export function parseBuildProfileCatalog(value: unknown): BuildProfileCatalog {
  if (!isRecord(value)) throw new Error("Build profile catalog must be an object");
  if (value.schemaVersion !== BUILD_PROFILE_CATALOG_SCHEMA_VERSION) {
    throw new Error("Unsupported build-profile catalog schema version");
  }
  if (value.kind !== BUILD_PROFILE_CATALOG_KIND) {
    throw new Error(`Unsupported catalog kind: ${String(value.kind)}`);
  }
  return {
    schemaVersion: BUILD_PROFILE_CATALOG_SCHEMA_VERSION,
    kind: BUILD_PROFILE_CATALOG_KIND,
    league: requiredText(value.league, "league"),
    ...(optionalText(value.patch, "patch") ? { patch: optionalText(value.patch, "patch") } : {}),
    ...(optionalText(value.curatedAt, "curatedAt")
      ? { curatedAt: optionalText(value.curatedAt, "curatedAt") }
      : {}),
    ...(optionalText(value.tradeBaseUrl, "tradeBaseUrl")
      ? { tradeBaseUrl: optionalText(value.tradeBaseUrl, "tradeBaseUrl") }
      : {}),
    notes: parseNotes(value.notes),
    avoidUniques: parseAvoidUniques(value.avoidUniques),
    profiles: parseCatalogProfiles(value.profiles),
  };
}

export function materializeCatalogProfiles(
  catalog: BuildProfileCatalog,
  options: BuildProfileMutationOptions = {},
): { profiles: BuildProfile[]; warnings: string[] } {
  const warnings: string[] = [];
  const profiles = catalog.profiles.map((input) => {
    const skeleton = createBuildProfile({ ...input, gearTargets: [] }, options);
    const searches = (input.gearTargets ?? []) as ImportedGearSearch[];
    const imported = importGearTargets(skeleton, searches, options);
    warnings.push(...imported.warnings);
    return imported.profile;
  });
  return { profiles, warnings };
}

export function loadBuildProfileCatalog(
  value: unknown,
  options: BuildProfileMutationOptions = {},
): LoadedBuildProfileCatalog {
  const catalog = parseBuildProfileCatalog(value);
  const materialized = materializeCatalogProfiles(catalog, options);
  return { catalog, ...materialized };
}

export function syncCatalogOwnedProfile(
  existing: BuildProfile | undefined,
  incoming: BuildProfile,
  options: BuildProfileMutationOptions = {},
): CatalogProfileSyncResult {
  if (!existing) {
    return {
      profile: incoming,
      created: true,
      addedTargetIds: incoming.gearTargets.map((target) => target.id),
      updatedTargetIds: [],
      warnings: [],
    };
  }
  const imported = importGearTargets(existing, incoming.gearTargets, options);
  return {
    profile: updateBuildProfile(
      imported.profile,
      {
        name: incoming.name,
        ...(incoming.league !== undefined ? { league: incoming.league } : {}),
        ...(incoming.sourceUrl !== undefined ? { sourceUrl: incoming.sourceUrl } : {}),
        tags: incoming.tags,
        preferences: incoming.preferences,
        active: existing.active,
      },
      options,
    ),
    created: false,
    addedTargetIds: imported.addedTargetIds,
    updatedTargetIds: imported.updatedTargetIds,
    warnings: imported.warnings,
  };
}

export function loadBuildProfileCatalogFromJson(
  sourceText: string,
  options: BuildProfileMutationOptions = {},
): LoadedBuildProfileCatalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceText);
  } catch (error) {
    throw new Error(
      `Build profile catalog JSON is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  return loadBuildProfileCatalog(parsed, options);
}
