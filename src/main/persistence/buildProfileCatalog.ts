import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  FORBIDDEN_RITES_GEAR_CATALOG_RELATIVE_PATH,
  FORBIDDEN_RITES_GEAR_CATALOG_SOURCE_KEY,
  loadBuildProfileCatalogFromJson,
  type AvoidUnique,
  type LoadedBuildProfileCatalog,
} from "../../core/buildProfileCatalog.js";

export {
  FORBIDDEN_RITES_GEAR_CATALOG_RELATIVE_PATH,
  FORBIDDEN_RITES_GEAR_CATALOG_SOURCE_KEY,
};
import type { BuildProfile, BuildProfileMutationOptions } from "../../core/buildProfiles.js";
import type { LocalPersistenceDatabase } from "./database.js";

export const FORBIDDEN_RITES_CATALOG_SETTING_KEY = "build-profile-catalog:forbidden-rites";

export interface SeedBuildProfileCatalogOptions extends BuildProfileMutationOptions {
  sourceKey?: string;
  sourceUri?: string;
  overwrite?: boolean;
}

export interface SeedBuildProfileCatalogResult {
  catalog: LoadedBuildProfileCatalog["catalog"];
  profiles: BuildProfile[];
  addedProfileIds: string[];
  skippedProfileIds: string[];
  warnings: string[];
  avoidUniques: AvoidUnique[];
  sourcePath?: string;
}

export function resolveBuildProfileCatalogPath(
  relativePath = FORBIDDEN_RITES_GEAR_CATALOG_RELATIVE_PATH,
  roots: readonly string[] = [],
): string {
  const candidates = [
    ...roots.map((root) => path.join(root, relativePath)),
    path.join(process.cwd(), relativePath),
  ];
  return candidates.find((file) => existsSync(file)) ?? candidates[0]!;
}

export function readBuildProfileCatalogFile(
  filePath: string,
  options: BuildProfileMutationOptions = {},
): LoadedBuildProfileCatalog {
  return loadBuildProfileCatalogFromJson(readFileSync(filePath, "utf8"), options);
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function persistCatalogSetting(
  persistence: LocalPersistenceDatabase,
  loaded: LoadedBuildProfileCatalog,
  sourceKey: string,
  sourceUri: string | undefined,
  digest: string,
  importedAt: string,
): void {
  persistence.settings.set({
    key: FORBIDDEN_RITES_CATALOG_SETTING_KEY,
    schemaVersion: loaded.catalog.schemaVersion,
    value: {
      sourceKey,
      ...(sourceUri ? { sourceUri } : {}),
      digest,
      league: loaded.catalog.league,
      ...(loaded.catalog.patch ? { patch: loaded.catalog.patch } : {}),
      profileIds: loaded.profiles.map((profile) => profile.id),
      avoidUniques: loaded.catalog.avoidUniques,
      importedAt,
    },
  });
}

export function persistBuildProfileCatalog(
  persistence: LocalPersistenceDatabase,
  loaded: LoadedBuildProfileCatalog,
  options: SeedBuildProfileCatalogOptions = {},
): SeedBuildProfileCatalogResult {
  const sourceKey = options.sourceKey ?? FORBIDDEN_RITES_GEAR_CATALOG_SOURCE_KEY;
  const addedProfileIds: string[] = [];
  const skippedProfileIds: string[] = [];
  const warnings = [...loaded.warnings];
  const persisted: BuildProfile[] = [];

  for (const profile of loaded.profiles) {
    const existing = persistence.buildProfiles.get(profile.id);
    if (existing && !options.overwrite) {
      skippedProfileIds.push(profile.id);
      persisted.push(existing);
      continue;
    }
    const saved = persistence.buildProfiles.upsert(profile);
    persistence.provenance.upsert({
      entityType: "build-profile",
      entityId: saved.id,
      sourceType: "build-profile-catalog",
      sourceKey: `${sourceKey}#${saved.id}`,
      ...(options.sourceUri ? { sourceUri: options.sourceUri } : {}),
      importedAt: saved.updatedAt,
      payload: {
        catalogKind: loaded.catalog.kind,
        league: loaded.catalog.league,
        profileName: saved.name,
      },
    });
    addedProfileIds.push(saved.id);
    persisted.push(saved);
  }

  return {
    catalog: loaded.catalog,
    profiles: persisted,
    addedProfileIds,
    skippedProfileIds,
    warnings,
    avoidUniques: loaded.catalog.avoidUniques,
    ...(options.sourceUri ? { sourcePath: options.sourceUri } : {}),
  };
}

export function seedBuildProfileCatalogFromJson(
  persistence: LocalPersistenceDatabase,
  sourceText: string,
  options: SeedBuildProfileCatalogOptions = {},
): SeedBuildProfileCatalogResult {
  const loaded = loadBuildProfileCatalogFromJson(sourceText, options);
  const result = persistBuildProfileCatalog(persistence, loaded, options);
  persistCatalogSetting(
    persistence,
    loaded,
    options.sourceKey ?? FORBIDDEN_RITES_GEAR_CATALOG_SOURCE_KEY,
    options.sourceUri,
    digestText(sourceText),
    loaded.profiles[0]?.updatedAt ?? new Date().toISOString(),
  );
  return result;
}

export function seedBuildProfileCatalogFromFile(
  persistence: LocalPersistenceDatabase,
  filePath: string,
  options: SeedBuildProfileCatalogOptions = {},
): SeedBuildProfileCatalogResult {
  const sourceText = readFileSync(filePath, "utf8");
  return seedBuildProfileCatalogFromJson(persistence, sourceText, {
    ...options,
    sourceUri: options.sourceUri ?? filePath,
  });
}

export function seedForbiddenRitesGearCatalog(
  persistence: LocalPersistenceDatabase,
  filePath = resolveBuildProfileCatalogPath(),
  options: SeedBuildProfileCatalogOptions = {},
): SeedBuildProfileCatalogResult {
  if (!existsSync(filePath)) {
    throw new Error(`Forbidden Rites gear catalog was not found at ${filePath}`);
  }
  const existing = persistence.settings.get(FORBIDDEN_RITES_CATALOG_SETTING_KEY);
  if (existing && !options.overwrite) {
    const profiles = persistence.buildProfiles.list();
    const catalogIds = new Set(
      isProfileIdList(existing.value) ? existing.value.profileIds : [],
    );
    const alreadyPresent =
      catalogIds.size > 0 &&
      [...catalogIds].every((id) => profiles.some((profile) => profile.id === id));
    if (alreadyPresent) {
      const loaded = readBuildProfileCatalogFile(filePath, options);
      return {
        catalog: loaded.catalog,
        profiles: profiles.filter((profile) => catalogIds.has(profile.id)),
        addedProfileIds: [],
        skippedProfileIds: [...catalogIds],
        warnings: loaded.warnings,
        avoidUniques: loaded.catalog.avoidUniques,
        sourcePath: filePath,
      };
    }
  }
  return seedBuildProfileCatalogFromFile(persistence, filePath, {
    ...options,
    sourceKey: options.sourceKey ?? FORBIDDEN_RITES_GEAR_CATALOG_SOURCE_KEY,
    sourceUri: options.sourceUri ?? filePath,
  });
}

function isProfileIdList(value: unknown): value is { profileIds: string[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { profileIds?: unknown }).profileIds) &&
    (value as { profileIds: unknown[] }).profileIds.every((id) => typeof id === "string")
  );
}
