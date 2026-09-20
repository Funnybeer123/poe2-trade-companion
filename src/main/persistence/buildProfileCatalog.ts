import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  FORBIDDEN_RITES_GEAR_CATALOG_RELATIVE_PATH,
  FORBIDDEN_RITES_GEAR_CATALOG_SOURCE_KEY,
  loadBuildProfileCatalogFromJson,
  syncCatalogOwnedProfile,
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
  mtimeMs?: number;
}

export interface BuildProfileCatalogRevision {
  sourceKey: string;
  sourceUri?: string;
  digest: string;
  revision: string;
  mtimeMs?: number;
  league: string;
  patch?: string;
  curatedAt?: string;
  profileIds: string[];
  targetCount: number;
  avoidUniques: AvoidUnique[];
  importedAt: string;
}

export interface SeedBuildProfileCatalogResult {
  catalog: LoadedBuildProfileCatalog["catalog"];
  profiles: BuildProfile[];
  addedProfileIds: string[];
  updatedProfileIds: string[];
  skippedProfileIds: string[];
  addedTargetIds: string[];
  updatedTargetIds: string[];
  warnings: string[];
  avoidUniques: AvoidUnique[];
  sourcePath?: string;
  catalogRevision: string;
  unchanged: boolean;
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

export function digestBuildProfileCatalogSource(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAvoidUnique(value: unknown): value is AvoidUnique {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.reason === "string"
  );
}

export function readForbiddenRitesCatalogRevision(
  persistence: LocalPersistenceDatabase,
): BuildProfileCatalogRevision | undefined {
  const stored = persistence.settings.get(FORBIDDEN_RITES_CATALOG_SETTING_KEY);
  if (!stored || !isRecord(stored.value)) return undefined;
  const value = stored.value;
  const digest = typeof value.digest === "string" ? value.digest : undefined;
  const profileIds = Array.isArray(value.profileIds)
    ? value.profileIds.filter((id): id is string => typeof id === "string")
    : [];
  if (!digest) return undefined;
  return {
    sourceKey:
      typeof value.sourceKey === "string"
        ? value.sourceKey
        : FORBIDDEN_RITES_GEAR_CATALOG_SOURCE_KEY,
    ...(typeof value.sourceUri === "string" ? { sourceUri: value.sourceUri } : {}),
    digest,
    revision: typeof value.revision === "string" ? value.revision : digest,
    ...(typeof value.mtimeMs === "number" && Number.isFinite(value.mtimeMs)
      ? { mtimeMs: value.mtimeMs }
      : {}),
    league: typeof value.league === "string" ? value.league : "",
    ...(typeof value.patch === "string" ? { patch: value.patch } : {}),
    ...(typeof value.curatedAt === "string" ? { curatedAt: value.curatedAt } : {}),
    profileIds,
    targetCount: typeof value.targetCount === "number" ? value.targetCount : 0,
    avoidUniques: Array.isArray(value.avoidUniques)
      ? value.avoidUniques.filter(isAvoidUnique)
      : [],
    importedAt: typeof value.importedAt === "string" ? value.importedAt : "",
  };
}

function catalogProfilesPresent(
  persistence: LocalPersistenceDatabase,
  profileIds: readonly string[],
): boolean {
  if (profileIds.length === 0) return false;
  const present = new Set(persistence.buildProfiles.list().map((profile) => profile.id));
  return profileIds.every((id) => present.has(id));
}

function persistCatalogSetting(
  persistence: LocalPersistenceDatabase,
  loaded: LoadedBuildProfileCatalog,
  sourceKey: string,
  sourceUri: string | undefined,
  digest: string,
  importedAt: string,
  mtimeMs: number | undefined,
): void {
  persistence.settings.set({
    key: FORBIDDEN_RITES_CATALOG_SETTING_KEY,
    schemaVersion: loaded.catalog.schemaVersion,
    value: {
      sourceKey,
      ...(sourceUri ? { sourceUri } : {}),
      digest,
      revision: digest,
      ...(mtimeMs !== undefined ? { mtimeMs } : {}),
      league: loaded.catalog.league,
      ...(loaded.catalog.patch ? { patch: loaded.catalog.patch } : {}),
      ...(loaded.catalog.curatedAt ? { curatedAt: loaded.catalog.curatedAt } : {}),
      profileIds: loaded.profiles.map((profile) => profile.id),
      targetCount: loaded.profiles.reduce(
        (count, profile) => count + profile.gearTargets.length,
        0,
      ),
      avoidUniques: loaded.catalog.avoidUniques,
      importedAt,
    } satisfies Omit<BuildProfileCatalogRevision, never>,
  });
}

function emptySyncIds(): Pick<
  SeedBuildProfileCatalogResult,
  | "addedProfileIds"
  | "updatedProfileIds"
  | "skippedProfileIds"
  | "addedTargetIds"
  | "updatedTargetIds"
> {
  return {
    addedProfileIds: [],
    updatedProfileIds: [],
    skippedProfileIds: [],
    addedTargetIds: [],
    updatedTargetIds: [],
  };
}

export function persistBuildProfileCatalog(
  persistence: LocalPersistenceDatabase,
  loaded: LoadedBuildProfileCatalog,
  options: SeedBuildProfileCatalogOptions = {},
): SeedBuildProfileCatalogResult {
  const sourceKey = options.sourceKey ?? FORBIDDEN_RITES_GEAR_CATALOG_SOURCE_KEY;
  const addedProfileIds: string[] = [];
  const updatedProfileIds: string[] = [];
  const skippedProfileIds: string[] = [];
  const addedTargetIds: string[] = [];
  const updatedTargetIds: string[] = [];
  const warnings = [...loaded.warnings];
  const persisted: BuildProfile[] = [];

  for (const incoming of loaded.profiles) {
    const existing = persistence.buildProfiles.get(incoming.id);
    if (existing && options.overwrite) {
      const saved = persistence.buildProfiles.upsert(incoming);
      persistProfileProvenance(persistence, loaded, saved, sourceKey, options.sourceUri);
      updatedProfileIds.push(saved.id);
      addedTargetIds.push(
        ...incoming.gearTargets
          .filter((target) => !existing.gearTargets.some((entry) => entry.id === target.id))
          .map((target) => target.id),
      );
      updatedTargetIds.push(
        ...incoming.gearTargets
          .filter((target) => existing.gearTargets.some((entry) => entry.id === target.id))
          .map((target) => target.id),
      );
      persisted.push(saved);
      continue;
    }

    const synced = syncCatalogOwnedProfile(existing, incoming, options);
    warnings.push(...synced.warnings);
    if (synced.created) {
      const saved = persistence.buildProfiles.upsert(synced.profile);
      persistProfileProvenance(persistence, loaded, saved, sourceKey, options.sourceUri);
      addedProfileIds.push(saved.id);
      addedTargetIds.push(...synced.addedTargetIds);
      persisted.push(saved);
      continue;
    }

    const changed =
      synced.addedTargetIds.length > 0 || synced.updatedTargetIds.length > 0;
    if (!changed) {
      skippedProfileIds.push(incoming.id);
      persisted.push(existing!);
      continue;
    }

    const saved = persistence.buildProfiles.upsert(synced.profile);
    persistProfileProvenance(persistence, loaded, saved, sourceKey, options.sourceUri);
    updatedProfileIds.push(saved.id);
    addedTargetIds.push(...synced.addedTargetIds);
    updatedTargetIds.push(...synced.updatedTargetIds);
    persisted.push(saved);
  }

  return {
    catalog: loaded.catalog,
    profiles: persisted,
    addedProfileIds,
    updatedProfileIds,
    skippedProfileIds,
    addedTargetIds,
    updatedTargetIds,
    warnings,
    avoidUniques: loaded.catalog.avoidUniques,
    catalogRevision: "",
    unchanged: false,
    ...(options.sourceUri ? { sourcePath: options.sourceUri } : {}),
  };
}

function persistProfileProvenance(
  persistence: LocalPersistenceDatabase,
  loaded: LoadedBuildProfileCatalog,
  saved: BuildProfile,
  sourceKey: string,
  sourceUri: string | undefined,
): void {
  persistence.provenance.upsert({
    entityType: "build-profile",
    entityId: saved.id,
    sourceType: "build-profile-catalog",
    sourceKey: `${sourceKey}#${saved.id}`,
    ...(sourceUri ? { sourceUri } : {}),
    importedAt: saved.updatedAt,
    payload: {
      catalogKind: loaded.catalog.kind,
      league: loaded.catalog.league,
      profileName: saved.name,
    },
  });
}

function unchangedResult(
  persistence: LocalPersistenceDatabase,
  loaded: LoadedBuildProfileCatalog,
  revision: BuildProfileCatalogRevision,
  options: SeedBuildProfileCatalogOptions,
): SeedBuildProfileCatalogResult {
  const catalogIds = new Set(revision.profileIds);
  return {
    catalog: loaded.catalog,
    profiles: persistence.buildProfiles
      .list()
      .filter((profile) => catalogIds.has(profile.id)),
    ...emptySyncIds(),
    skippedProfileIds: [...catalogIds],
    warnings: loaded.warnings,
    avoidUniques: loaded.catalog.avoidUniques,
    catalogRevision: revision.digest,
    unchanged: true,
    ...(options.sourceUri ? { sourcePath: options.sourceUri } : {}),
  };
}

export function seedBuildProfileCatalogFromJson(
  persistence: LocalPersistenceDatabase,
  sourceText: string,
  options: SeedBuildProfileCatalogOptions = {},
): SeedBuildProfileCatalogResult {
  const digest = digestBuildProfileCatalogSource(sourceText);
  const stored = readForbiddenRitesCatalogRevision(persistence);
  const loaded = loadBuildProfileCatalogFromJson(sourceText, options);
  if (
    !options.overwrite &&
    stored?.digest === digest &&
    catalogProfilesPresent(persistence, stored.profileIds)
  ) {
    return unchangedResult(persistence, loaded, stored, options);
  }

  const result = persistBuildProfileCatalog(persistence, loaded, options);
  const importedAt = loaded.profiles[0]?.updatedAt ?? new Date().toISOString();
  persistCatalogSetting(
    persistence,
    loaded,
    options.sourceKey ?? FORBIDDEN_RITES_GEAR_CATALOG_SOURCE_KEY,
    options.sourceUri,
    digest,
    importedAt,
    options.mtimeMs,
  );
  return {
    ...result,
    catalogRevision: digest,
    unchanged: false,
  };
}

export function seedBuildProfileCatalogFromFile(
  persistence: LocalPersistenceDatabase,
  filePath: string,
  options: SeedBuildProfileCatalogOptions = {},
): SeedBuildProfileCatalogResult {
  const sourceText = readFileSync(filePath, "utf8");
  const mtimeMs = options.mtimeMs ?? statSync(filePath).mtimeMs;
  return seedBuildProfileCatalogFromJson(persistence, sourceText, {
    ...options,
    sourceUri: options.sourceUri ?? filePath,
    mtimeMs,
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
  return seedBuildProfileCatalogFromFile(persistence, filePath, {
    ...options,
    sourceKey: options.sourceKey ?? FORBIDDEN_RITES_GEAR_CATALOG_SOURCE_KEY,
    sourceUri: options.sourceUri ?? filePath,
  });
}
