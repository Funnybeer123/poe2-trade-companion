import type BetterSqlite3 from "better-sqlite3";
import {
  validateBuildProfile,
  type BuildProfile,
  type BuildProfileDesirabilityPreferences,
  type GearTarget,
  type GearTargetProvenance,
  type GearTargetStatRule,
} from "../../core/buildProfiles.js";
import {
  boundedText,
  deterministicJson,
  finiteNumber,
  optionalBoundedText,
  parseDeterministicJson,
  positiveSchemaVersion,
  stableId,
  utcTimestamp,
  validatedId,
} from "./json.js";
import type {
  CatalogItemInput,
  CatalogItemRecord,
  GearTargetRecord,
  ItemObservationInput,
  ItemObservationRecord,
  PresetInput,
  PresetRecord,
  ProvenanceInput,
  ProvenanceRecord,
  RuleSetInput,
  RuleSetRecord,
  ScanSessionInput,
  ScanSessionRecord,
  ScanSlotInput,
  ScanSlotRecord,
  SettingInput,
  SettingRecord,
  ValuationInput,
  ValuationRecord,
} from "./records.js";

export interface RepositoryContext {
  database: BetterSqlite3.Database;
  now(): Date | string | number;
}

function currentTimestamp(context: RepositoryContext): string {
  return utcTimestamp(context.now(), "repository clock");
}

function listLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 10_000) {
    throw new Error("Repository list limit must be an integer between 1 and 10000");
  }
  return value;
}

interface CatalogRow {
  id: string;
  fingerprint: string;
  name: string;
  base_type: string;
  item_class: string;
  current_location: string;
  recommendation: string | null;
  fair_value: number | null;
  payload_json: string;
  created_at: string;
  updated_at: string;
}

function mapCatalog(row: CatalogRow): CatalogItemRecord {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    name: row.name,
    baseType: row.base_type,
    itemClass: row.item_class,
    currentLocation: row.current_location,
    ...(row.recommendation !== null ? { recommendation: row.recommendation } : {}),
    ...(row.fair_value !== null ? { fairValue: row.fair_value } : {}),
    payload: parseDeterministicJson(row.payload_json, "catalog payload"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CatalogItemsRepository {
  constructor(private readonly context: RepositoryContext) {}

  upsert(input: CatalogItemInput): CatalogItemRecord {
    const fingerprint = boundedText(input.fingerprint, "fingerprint", 256);
    const id = input.id
      ? validatedId(input.id, "catalog item ID")
      : stableId("item", fingerprint);
    const name = boundedText(input.name, "catalog item name", 512);
    const baseType = boundedText(input.baseType, "catalog base type", 512);
    const itemClass = boundedText(input.itemClass, "catalog item class", 256);
    const location = boundedText(input.currentLocation, "catalog location", 1024);
    const recommendation = optionalBoundedText(
      input.recommendation,
      "catalog recommendation",
      64,
    );
    const fairValue =
      input.fairValue === undefined
        ? undefined
        : finiteNumber(input.fairValue, "catalog fair value", { min: 0 });
    const payload = deterministicJson(input.payload ?? {}, "catalog payload");
    const now = currentTimestamp(this.context);
    this.context.database
      .prepare(
        `INSERT INTO catalog_items (
          id, fingerprint, name, base_type, item_class, current_location,
          recommendation, fair_value, payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(fingerprint) DO UPDATE SET
          name = excluded.name,
          base_type = excluded.base_type,
          item_class = excluded.item_class,
          current_location = excluded.current_location,
          recommendation = excluded.recommendation,
          fair_value = excluded.fair_value,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        id,
        fingerprint,
        name,
        baseType,
        itemClass,
        location,
        recommendation ?? null,
        fairValue ?? null,
        payload,
        now,
        now,
      );
    return this.getByFingerprint(fingerprint)!;
  }

  get(id: string): CatalogItemRecord | undefined {
    const row = this.context.database
      .prepare("SELECT * FROM catalog_items WHERE id = ?")
      .get(validatedId(id)) as CatalogRow | undefined;
    return row ? mapCatalog(row) : undefined;
  }

  getByFingerprint(fingerprint: string): CatalogItemRecord | undefined {
    const row = this.context.database
      .prepare("SELECT * FROM catalog_items WHERE fingerprint = ?")
      .get(boundedText(fingerprint, "fingerprint", 256)) as CatalogRow | undefined;
    return row ? mapCatalog(row) : undefined;
  }

  list(limit = 1_000): CatalogItemRecord[] {
    return (
      this.context.database
        .prepare("SELECT * FROM catalog_items ORDER BY updated_at DESC, id LIMIT ?")
        .all(listLimit(limit)) as CatalogRow[]
    ).map(mapCatalog);
  }

  delete(id: string): boolean {
    return (
      this.context.database
        .prepare("DELETE FROM catalog_items WHERE id = ?")
        .run(validatedId(id)).changes > 0
    );
  }
}

interface ObservationRow {
  id: string;
  catalog_item_id: string;
  observed_at: string;
  source: string;
  location: string;
  confidence: number | null;
  payload_json: string;
  created_at: string;
  updated_at: string;
}

function mapObservation(row: ObservationRow): ItemObservationRecord {
  return {
    id: row.id,
    catalogItemId: row.catalog_item_id,
    observedAt: row.observed_at,
    source: row.source,
    location: row.location,
    ...(row.confidence !== null ? { confidence: row.confidence } : {}),
    payload: parseDeterministicJson(row.payload_json, "observation payload"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ItemObservationsRepository {
  constructor(private readonly context: RepositoryContext) {}

  upsert(input: ItemObservationInput): ItemObservationRecord {
    const catalogItemId = validatedId(input.catalogItemId, "catalog item ID");
    const observedAt = utcTimestamp(input.observedAt, "observation timestamp");
    const source = boundedText(input.source, "observation source", 128);
    const location = boundedText(input.location, "observation location", 1024);
    const confidence =
      input.confidence === undefined
        ? undefined
        : finiteNumber(input.confidence, "observation confidence", { min: 0, max: 1 });
    const id = input.id
      ? validatedId(input.id, "observation ID")
      : stableId("obs", catalogItemId, observedAt, source, location);
    const payload = deterministicJson(input.payload ?? {}, "observation payload");
    const now = currentTimestamp(this.context);
    this.context.database
      .prepare(
        `INSERT INTO item_observations (
          id, catalog_item_id, observed_at, source, location, confidence,
          payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(catalog_item_id, observed_at, source, location) DO UPDATE SET
          confidence = excluded.confidence,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        id,
        catalogItemId,
        observedAt,
        source,
        location,
        confidence ?? null,
        payload,
        now,
        now,
      );
    return this.getByNaturalKey(catalogItemId, observedAt, source, location)!;
  }

  get(id: string): ItemObservationRecord | undefined {
    const row = this.context.database
      .prepare("SELECT * FROM item_observations WHERE id = ?")
      .get(validatedId(id)) as ObservationRow | undefined;
    return row ? mapObservation(row) : undefined;
  }

  getByNaturalKey(
    catalogItemId: string,
    observedAt: string,
    source: string,
    location: string,
  ): ItemObservationRecord | undefined {
    const row = this.context.database
      .prepare(
        `SELECT * FROM item_observations
         WHERE catalog_item_id = ? AND observed_at = ? AND source = ? AND location = ?`,
      )
      .get(
        validatedId(catalogItemId),
        utcTimestamp(observedAt, "observation timestamp"),
        boundedText(source, "observation source", 128),
        boundedText(location, "observation location", 1024),
      ) as ObservationRow | undefined;
    return row ? mapObservation(row) : undefined;
  }

  listForCatalogItem(catalogItemId: string, limit = 1_000): ItemObservationRecord[] {
    return (
      this.context.database
        .prepare(
          `SELECT * FROM item_observations
           WHERE catalog_item_id = ?
           ORDER BY observed_at DESC, id
           LIMIT ?`,
        )
        .all(validatedId(catalogItemId), listLimit(limit)) as ObservationRow[]
    ).map(mapObservation);
  }
}

interface ValuationRow {
  id: string;
  catalog_item_id: string;
  provider_name: string;
  market_timestamp: string;
  currency: string;
  low_value: number;
  fair_value: number;
  high_value: number;
  confidence: string;
  sample_size: number;
  payload_json: string;
  created_at: string;
  updated_at: string;
}

function mapValuation(row: ValuationRow): ValuationRecord {
  return {
    id: row.id,
    catalogItemId: row.catalog_item_id,
    providerName: row.provider_name,
    marketTimestamp: row.market_timestamp,
    currency: row.currency,
    low: row.low_value,
    fair: row.fair_value,
    high: row.high_value,
    confidence: row.confidence,
    sampleSize: row.sample_size,
    payload: parseDeterministicJson(row.payload_json, "valuation payload"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ValuationsRepository {
  constructor(private readonly context: RepositoryContext) {}

  upsert(input: ValuationInput): ValuationRecord {
    const catalogItemId = validatedId(input.catalogItemId, "catalog item ID");
    const providerName = boundedText(input.providerName, "valuation provider", 128);
    const marketTimestamp = utcTimestamp(
      input.marketTimestamp,
      "valuation market timestamp",
    );
    const currency = boundedText(input.currency, "valuation currency", 64);
    const low = finiteNumber(input.low, "valuation low", { min: 0 });
    const fair = finiteNumber(input.fair, "valuation fair", { min: 0 });
    const high = finiteNumber(input.high, "valuation high", { min: 0 });
    if (low > fair || fair > high) {
      throw new Error("Valuation values must satisfy low <= fair <= high");
    }
    const confidence = boundedText(input.confidence, "valuation confidence", 32);
    const sampleSize = finiteNumber(input.sampleSize, "valuation sample size", {
      min: 0,
      max: 10_000_000,
    });
    if (!Number.isInteger(sampleSize)) throw new Error("valuation sample size must be an integer");
    const id = input.id
      ? validatedId(input.id, "valuation ID")
      : stableId("valuation", catalogItemId, providerName, marketTimestamp);
    const payload = deterministicJson(input.payload ?? {}, "valuation payload");
    const now = currentTimestamp(this.context);
    this.context.database
      .prepare(
        `INSERT INTO valuations (
          id, catalog_item_id, provider_name, market_timestamp, currency,
          low_value, fair_value, high_value, confidence, sample_size,
          payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(catalog_item_id, provider_name, market_timestamp) DO UPDATE SET
          currency = excluded.currency,
          low_value = excluded.low_value,
          fair_value = excluded.fair_value,
          high_value = excluded.high_value,
          confidence = excluded.confidence,
          sample_size = excluded.sample_size,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        id,
        catalogItemId,
        providerName,
        marketTimestamp,
        currency,
        low,
        fair,
        high,
        confidence,
        sampleSize,
        payload,
        now,
        now,
      );
    return this.getByNaturalKey(catalogItemId, providerName, marketTimestamp)!;
  }

  get(id: string): ValuationRecord | undefined {
    const row = this.context.database
      .prepare("SELECT * FROM valuations WHERE id = ?")
      .get(validatedId(id)) as ValuationRow | undefined;
    return row ? mapValuation(row) : undefined;
  }

  getByNaturalKey(
    catalogItemId: string,
    providerName: string,
    marketTimestamp: string,
  ): ValuationRecord | undefined {
    const row = this.context.database
      .prepare(
        `SELECT * FROM valuations
         WHERE catalog_item_id = ? AND provider_name = ? AND market_timestamp = ?`,
      )
      .get(
        validatedId(catalogItemId),
        boundedText(providerName, "valuation provider", 128),
        utcTimestamp(marketTimestamp, "valuation market timestamp"),
      ) as ValuationRow | undefined;
    return row ? mapValuation(row) : undefined;
  }

  listForCatalogItem(catalogItemId: string, limit = 1_000): ValuationRecord[] {
    return (
      this.context.database
        .prepare(
          `SELECT * FROM valuations
           WHERE catalog_item_id = ?
           ORDER BY market_timestamp DESC, id
           LIMIT ?`,
        )
        .all(validatedId(catalogItemId), listLimit(limit)) as ValuationRow[]
    ).map(mapValuation);
  }
}

interface RuleSetRow {
  id: string;
  kind: string;
  name: string;
  schema_version: number;
  rules_json: string;
  active: number;
  created_at: string;
  updated_at: string;
}

function mapRuleSet(row: RuleSetRow): RuleSetRecord {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    schemaVersion: row.schema_version,
    rules: parseDeterministicJson(row.rules_json, "rule-set rules"),
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class RuleSetsRepository {
  constructor(private readonly context: RepositoryContext) {}

  upsert(input: RuleSetInput): RuleSetRecord {
    const kind = boundedText(input.kind, "rule-set kind", 64);
    const name = boundedText(input.name, "rule-set name", 256);
    const id = input.id
      ? validatedId(input.id, "rule-set ID")
      : stableId("rules", kind, name);
    const schemaVersion = positiveSchemaVersion(input.schemaVersion ?? 1);
    const rules = deterministicJson(input.rules, "rule-set rules");
    const now = currentTimestamp(this.context);
    this.context.database
      .prepare(
        `INSERT INTO rule_sets (
          id, kind, name, schema_version, rules_json, active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind,
          name = excluded.name,
          schema_version = excluded.schema_version,
          rules_json = excluded.rules_json,
          active = excluded.active,
          updated_at = excluded.updated_at`,
      )
      .run(id, kind, name, schemaVersion, rules, input.active ? 1 : 0, now, now);
    return this.getByNaturalKey(kind, name)!;
  }

  get(id: string): RuleSetRecord | undefined {
    const row = this.context.database
      .prepare("SELECT * FROM rule_sets WHERE id = ?")
      .get(validatedId(id)) as RuleSetRow | undefined;
    return row ? mapRuleSet(row) : undefined;
  }

  getByNaturalKey(kind: string, name: string): RuleSetRecord | undefined {
    const row = this.context.database
      .prepare("SELECT * FROM rule_sets WHERE kind = ? AND name = ?")
      .get(
        boundedText(kind, "rule-set kind", 64),
        boundedText(name, "rule-set name", 256),
      ) as RuleSetRow | undefined;
    return row ? mapRuleSet(row) : undefined;
  }

  list(kind?: string, limit = 1_000): RuleSetRecord[] {
    const rows = kind
      ? (this.context.database
          .prepare(
            "SELECT * FROM rule_sets WHERE kind = ? ORDER BY active DESC, name LIMIT ?",
          )
          .all(boundedText(kind, "rule-set kind", 64), listLimit(limit)) as RuleSetRow[])
      : (this.context.database
          .prepare("SELECT * FROM rule_sets ORDER BY kind, active DESC, name LIMIT ?")
          .all(listLimit(limit)) as RuleSetRow[]);
    return rows.map(mapRuleSet);
  }

  delete(id: string): boolean {
    return (
      this.context.database
        .prepare("DELETE FROM rule_sets WHERE id = ?")
        .run(validatedId(id)).changes > 0
    );
  }
}

interface PresetRow {
  id: string;
  kind: string;
  name: string;
  schema_version: number;
  payload_json: string;
  created_at: string;
  updated_at: string;
}

function mapPreset(row: PresetRow): PresetRecord {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    schemaVersion: row.schema_version,
    payload: parseDeterministicJson(row.payload_json, "preset payload"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PresetsRepository {
  constructor(private readonly context: RepositoryContext) {}

  upsert(input: PresetInput): PresetRecord {
    const kind = boundedText(input.kind, "preset kind", 64);
    const name = boundedText(input.name, "preset name", 256);
    const id = input.id ? validatedId(input.id, "preset ID") : stableId("preset", kind, name);
    const schemaVersion = positiveSchemaVersion(input.schemaVersion ?? 1);
    const payload = deterministicJson(input.payload, "preset payload");
    const now = currentTimestamp(this.context);
    this.context.database
      .prepare(
        `INSERT INTO presets (
          id, kind, name, schema_version, payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind,
          name = excluded.name,
          schema_version = excluded.schema_version,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at`,
      )
      .run(id, kind, name, schemaVersion, payload, now, now);
    return this.getByNaturalKey(kind, name)!;
  }

  get(id: string): PresetRecord | undefined {
    const row = this.context.database
      .prepare("SELECT * FROM presets WHERE id = ?")
      .get(validatedId(id)) as PresetRow | undefined;
    return row ? mapPreset(row) : undefined;
  }

  getByNaturalKey(kind: string, name: string): PresetRecord | undefined {
    const row = this.context.database
      .prepare("SELECT * FROM presets WHERE kind = ? AND name = ?")
      .get(
        boundedText(kind, "preset kind", 64),
        boundedText(name, "preset name", 256),
      ) as PresetRow | undefined;
    return row ? mapPreset(row) : undefined;
  }

  list(kind?: string, limit = 1_000): PresetRecord[] {
    const rows = kind
      ? (this.context.database
          .prepare("SELECT * FROM presets WHERE kind = ? ORDER BY name LIMIT ?")
          .all(boundedText(kind, "preset kind", 64), listLimit(limit)) as PresetRow[])
      : (this.context.database
          .prepare("SELECT * FROM presets ORDER BY kind, name LIMIT ?")
          .all(listLimit(limit)) as PresetRow[]);
    return rows.map(mapPreset);
  }

  delete(id: string): boolean {
    return (
      this.context.database
        .prepare("DELETE FROM presets WHERE id = ?")
        .run(validatedId(id)).changes > 0
    );
  }
}

interface GearTargetRow {
  id: string;
  profile_id: string;
  search_key: string;
  name: string;
  slot: string;
  item_class: string | null;
  stat_rules_json: string;
  source_url: string | null;
  league: string | null;
  tags_json: string;
  imported_query_json: string | null;
  provenance_json: string | null;
  created_at: string;
  updated_at: string;
}

function mapGearTarget(row: GearTargetRow): GearTargetRecord {
  return {
    id: row.id,
    profileId: row.profile_id,
    searchKey: row.search_key,
    name: row.name,
    slot: row.slot,
    ...(row.item_class !== null ? { itemClass: row.item_class } : {}),
    statRules: parseDeterministicJson<GearTargetStatRule[]>(
      row.stat_rules_json,
      "gear-target stat rules",
    ),
    ...(row.source_url !== null ? { sourceUrl: row.source_url } : {}),
    ...(row.league !== null ? { league: row.league } : {}),
    tags: parseDeterministicJson<string[]>(row.tags_json, "gear-target tags"),
    ...(row.imported_query_json !== null
      ? {
          importedQuery: parseDeterministicJson(
            row.imported_query_json,
            "gear-target imported query",
          ),
        }
      : {}),
    ...(row.provenance_json !== null
      ? {
          provenance: parseDeterministicJson<GearTargetProvenance>(
            row.provenance_json,
            "gear-target provenance",
          ),
        }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class GearTargetsRepository {
  constructor(private readonly context: RepositoryContext) {}

  upsert(profileIdValue: string, target: GearTarget): GearTargetRecord {
    const profileId = validatedId(profileIdValue, "build profile ID");
    const id = validatedId(target.id, "gear target ID");
    const searchKey = boundedText(target.searchKey, "gear target search key", 512);
    const name = boundedText(target.name, "gear target name", 256);
    const slot = boundedText(target.slot, "gear target slot", 128);
    const itemClass = optionalBoundedText(target.itemClass, "gear target item class", 256);
    const sourceUrl = optionalBoundedText(target.sourceUrl, "gear target source URL", 4096);
    const league = optionalBoundedText(target.league, "gear target league", 128);
    const createdAt = utcTimestamp(target.createdAt, "gear target createdAt");
    const updatedAt = utcTimestamp(target.updatedAt, "gear target updatedAt");
    const statRules = deterministicJson(target.statRules, "gear-target stat rules");
    const tags = deterministicJson(target.tags, "gear-target tags");
    const importedQuery =
      target.importedQuery === undefined
        ? null
        : deterministicJson(target.importedQuery, "gear-target imported query");
    const provenance =
      target.provenance === undefined
        ? null
        : deterministicJson(target.provenance, "gear-target provenance");
    this.context.database
      .prepare(
        `INSERT INTO gear_targets (
          id, profile_id, search_key, name, slot, item_class, stat_rules_json,
          source_url, league, tags_json, imported_query_json, provenance_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_id, search_key) DO UPDATE SET
          name = excluded.name,
          slot = excluded.slot,
          item_class = excluded.item_class,
          stat_rules_json = excluded.stat_rules_json,
          source_url = excluded.source_url,
          league = excluded.league,
          tags_json = excluded.tags_json,
          imported_query_json = excluded.imported_query_json,
          provenance_json = excluded.provenance_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        id,
        profileId,
        searchKey,
        name,
        slot,
        itemClass ?? null,
        statRules,
        sourceUrl ?? null,
        league ?? null,
        tags,
        importedQuery,
        provenance,
        createdAt,
        updatedAt,
      );
    return this.getBySearchKey(profileId, searchKey)!;
  }

  get(id: string): GearTargetRecord | undefined {
    const row = this.context.database
      .prepare("SELECT * FROM gear_targets WHERE id = ?")
      .get(validatedId(id)) as GearTargetRow | undefined;
    return row ? mapGearTarget(row) : undefined;
  }

  getBySearchKey(profileId: string, searchKey: string): GearTargetRecord | undefined {
    const row = this.context.database
      .prepare("SELECT * FROM gear_targets WHERE profile_id = ? AND search_key = ?")
      .get(
        validatedId(profileId, "build profile ID"),
        boundedText(searchKey, "gear target search key", 512),
      ) as GearTargetRow | undefined;
    return row ? mapGearTarget(row) : undefined;
  }

  listForProfile(profileId: string): GearTargetRecord[] {
    return (
      this.context.database
        .prepare("SELECT * FROM gear_targets WHERE profile_id = ? ORDER BY slot, name, id")
        .all(validatedId(profileId, "build profile ID")) as GearTargetRow[]
    ).map(mapGearTarget);
  }

  removeAbsent(profileId: string, targetIds: readonly string[]): void {
    const normalizedProfileId = validatedId(profileId, "build profile ID");
    if (targetIds.length === 0) {
      this.context.database
        .prepare("DELETE FROM gear_targets WHERE profile_id = ?")
        .run(normalizedProfileId);
      return;
    }
    const ids = targetIds.map((id) => validatedId(id, "gear target ID"));
    const placeholders = ids.map(() => "?").join(", ");
    this.context.database
      .prepare(
        `DELETE FROM gear_targets
         WHERE profile_id = ? AND id NOT IN (${placeholders})`,
      )
      .run(normalizedProfileId, ...ids);
  }
}

interface BuildProfileRow {
  id: string;
  schema_version: number;
  name: string;
  league: string | null;
  source_url: string | null;
  tags_json: string;
  active: number;
  preferences_json: string;
  created_at: string;
  updated_at: string;
}

export class BuildProfilesRepository {
  constructor(
    private readonly context: RepositoryContext,
    private readonly gearTargets: GearTargetsRepository,
  ) {}

  upsert(profile: BuildProfile): BuildProfile {
    const validation = validateBuildProfile(profile);
    if (!validation.valid) {
      throw new Error(
        `Invalid build profile: ${validation.issues
          .map((issue) => `${issue.path} ${issue.message}`)
          .join("; ")}`,
      );
    }
    const id = validatedId(profile.id, "build profile ID");
    const schemaVersion = positiveSchemaVersion(profile.schemaVersion);
    const name = boundedText(profile.name, "build profile name", 256);
    const league = optionalBoundedText(profile.league, "build profile league", 128);
    const sourceUrl = optionalBoundedText(
      profile.sourceUrl,
      "build profile source URL",
      4096,
    );
    const tags = deterministicJson(profile.tags, "build profile tags");
    const preferences = deterministicJson(
      profile.preferences,
      "build profile preferences",
    );
    const createdAt = utcTimestamp(profile.createdAt, "build profile createdAt");
    const updatedAt = utcTimestamp(profile.updatedAt, "build profile updatedAt");

    const persist = this.context.database.transaction(() => {
      this.context.database
        .prepare(
          `INSERT INTO build_profiles (
            id, schema_version, name, league, source_url, tags_json, active,
            preferences_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            schema_version = excluded.schema_version,
            name = excluded.name,
            league = excluded.league,
            source_url = excluded.source_url,
            tags_json = excluded.tags_json,
            active = excluded.active,
            preferences_json = excluded.preferences_json,
            updated_at = excluded.updated_at`,
        )
        .run(
          id,
          schemaVersion,
          name,
          league ?? null,
          sourceUrl ?? null,
          tags,
          profile.active ? 1 : 0,
          preferences,
          createdAt,
          updatedAt,
        );
      for (const target of profile.gearTargets) this.gearTargets.upsert(id, target);
      this.gearTargets.removeAbsent(
        id,
        profile.gearTargets.map((target) => target.id),
      );
    });
    persist();
    return this.get(id)!;
  }

  get(id: string): BuildProfile | undefined {
    const row = this.context.database
      .prepare("SELECT * FROM build_profiles WHERE id = ?")
      .get(validatedId(id, "build profile ID")) as BuildProfileRow | undefined;
    if (!row) return undefined;
    const gearTargets = this.gearTargets.listForProfile(row.id).map((target) => {
      const { profileId: _profileId, ...rest } = target;
      return rest;
    });
    const profile: BuildProfile = {
      schemaVersion: row.schema_version,
      id: row.id,
      name: row.name,
      ...(row.league !== null ? { league: row.league } : {}),
      ...(row.source_url !== null ? { sourceUrl: row.source_url } : {}),
      tags: parseDeterministicJson<string[]>(row.tags_json, "build profile tags"),
      active: row.active === 1,
      preferences: parseDeterministicJson<BuildProfileDesirabilityPreferences>(
        row.preferences_json,
        "build profile preferences",
      ),
      gearTargets,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    const validation = validateBuildProfile(profile);
    if (!validation.valid) {
      throw new Error(`Stored build profile '${row.id}' is invalid`);
    }
    return profile;
  }

  list(limit = 1_000): BuildProfile[] {
    const ids = this.context.database
      .prepare("SELECT id FROM build_profiles ORDER BY active DESC, name, id LIMIT ?")
      .all(listLimit(limit)) as Array<{ id: string }>;
    return ids.map(({ id }) => this.get(id)!);
  }

  delete(id: string): boolean {
    return (
      this.context.database
        .prepare("DELETE FROM build_profiles WHERE id = ?")
        .run(validatedId(id, "build profile ID")).changes > 0
    );
  }
}

interface ScanSessionRow {
  id: string;
  profile_id: string | null;
  source: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  summary_json: string;
  created_at: string;
  updated_at: string;
}

function mapScanSession(row: ScanSessionRow): ScanSessionRecord {
  return {
    id: row.id,
    ...(row.profile_id !== null ? { profileId: row.profile_id } : {}),
    source: row.source,
    status: row.status,
    startedAt: row.started_at,
    ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
    summary: parseDeterministicJson(row.summary_json, "scan-session summary"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ScanSessionsRepository {
  constructor(private readonly context: RepositoryContext) {}

  upsert(input: ScanSessionInput): ScanSessionRecord {
    const profileId = input.profileId
      ? validatedId(input.profileId, "build profile ID")
      : undefined;
    const source = boundedText(input.source, "scan-session source", 128);
    const status = boundedText(input.status, "scan-session status", 64);
    const startedAt = utcTimestamp(input.startedAt, "scan-session startedAt");
    const endedAt = input.endedAt
      ? utcTimestamp(input.endedAt, "scan-session endedAt")
      : undefined;
    if (endedAt && endedAt < startedAt) {
      throw new Error("scan-session endedAt cannot precede startedAt");
    }
    const id = input.id
      ? validatedId(input.id, "scan-session ID")
      : stableId("scan", source, startedAt);
    const summary = deterministicJson(input.summary ?? {}, "scan-session summary");
    const now = currentTimestamp(this.context);
    this.context.database
      .prepare(
        `INSERT INTO scan_sessions (
          id, profile_id, source, status, started_at, ended_at, summary_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          profile_id = excluded.profile_id,
          source = excluded.source,
          status = excluded.status,
          started_at = excluded.started_at,
          ended_at = excluded.ended_at,
          summary_json = excluded.summary_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        id,
        profileId ?? null,
        source,
        status,
        startedAt,
        endedAt ?? null,
        summary,
        now,
        now,
      );
    return this.get(id)!;
  }

  get(id: string): ScanSessionRecord | undefined {
    const row = this.context.database
      .prepare("SELECT * FROM scan_sessions WHERE id = ?")
      .get(validatedId(id, "scan-session ID")) as ScanSessionRow | undefined;
    return row ? mapScanSession(row) : undefined;
  }

  list(limit = 1_000): ScanSessionRecord[] {
    return (
      this.context.database
        .prepare("SELECT * FROM scan_sessions ORDER BY started_at DESC, id LIMIT ?")
        .all(listLimit(limit)) as ScanSessionRow[]
    ).map(mapScanSession);
  }
}

interface ScanSlotRow {
  id: string;
  session_id: string;
  slot_key: string;
  ordinal: number;
  status: string;
  item_fingerprint: string | null;
  scanned_at: string | null;
  payload_json: string;
  created_at: string;
  updated_at: string;
}

function mapScanSlot(row: ScanSlotRow): ScanSlotRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    slotKey: row.slot_key,
    ordinal: row.ordinal,
    status: row.status,
    ...(row.item_fingerprint !== null ? { itemFingerprint: row.item_fingerprint } : {}),
    ...(row.scanned_at !== null ? { scannedAt: row.scanned_at } : {}),
    payload: parseDeterministicJson(row.payload_json, "scan-slot payload"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ScanSlotsRepository {
  constructor(private readonly context: RepositoryContext) {}

  upsert(input: ScanSlotInput): ScanSlotRecord {
    const sessionId = validatedId(input.sessionId, "scan-session ID");
    const slotKey = boundedText(input.slotKey, "scan-slot key", 256);
    const ordinal = finiteNumber(input.ordinal, "scan-slot ordinal", {
      min: 0,
      max: 1_000_000,
    });
    if (!Number.isInteger(ordinal)) throw new Error("scan-slot ordinal must be an integer");
    const status = boundedText(input.status, "scan-slot status", 64);
    const itemFingerprint = optionalBoundedText(
      input.itemFingerprint,
      "scan-slot item fingerprint",
      256,
    );
    const scannedAt = input.scannedAt
      ? utcTimestamp(input.scannedAt, "scan-slot scannedAt")
      : undefined;
    const id = input.id
      ? validatedId(input.id, "scan-slot ID")
      : stableId("slot", sessionId, slotKey);
    const payload = deterministicJson(input.payload ?? {}, "scan-slot payload");
    const now = currentTimestamp(this.context);
    this.context.database
      .prepare(
        `INSERT INTO scan_slots (
          id, session_id, slot_key, ordinal, status, item_fingerprint,
          scanned_at, payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, slot_key) DO UPDATE SET
          ordinal = excluded.ordinal,
          status = excluded.status,
          item_fingerprint = excluded.item_fingerprint,
          scanned_at = excluded.scanned_at,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        id,
        sessionId,
        slotKey,
        ordinal,
        status,
        itemFingerprint ?? null,
        scannedAt ?? null,
        payload,
        now,
        now,
      );
    return this.getByNaturalKey(sessionId, slotKey)!;
  }

  get(id: string): ScanSlotRecord | undefined {
    const row = this.context.database
      .prepare("SELECT * FROM scan_slots WHERE id = ?")
      .get(validatedId(id, "scan-slot ID")) as ScanSlotRow | undefined;
    return row ? mapScanSlot(row) : undefined;
  }

  getByNaturalKey(sessionId: string, slotKey: string): ScanSlotRecord | undefined {
    const row = this.context.database
      .prepare("SELECT * FROM scan_slots WHERE session_id = ? AND slot_key = ?")
      .get(
        validatedId(sessionId, "scan-session ID"),
        boundedText(slotKey, "scan-slot key", 256),
      ) as ScanSlotRow | undefined;
    return row ? mapScanSlot(row) : undefined;
  }

  listForSession(sessionId: string, limit = 10_000): ScanSlotRecord[] {
    return (
      this.context.database
        .prepare(
          `SELECT * FROM scan_slots
           WHERE session_id = ?
           ORDER BY ordinal, slot_key
           LIMIT ?`,
        )
        .all(validatedId(sessionId, "scan-session ID"), listLimit(limit)) as ScanSlotRow[]
    ).map(mapScanSlot);
  }
}

interface SettingRow {
  key: string;
  schema_version: number;
  value_json: string;
  created_at: string;
  updated_at: string;
}

function mapSetting(row: SettingRow): SettingRecord {
  return {
    key: row.key,
    schemaVersion: row.schema_version,
    value: parseDeterministicJson(row.value_json, "setting value"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SettingsRepository {
  constructor(private readonly context: RepositoryContext) {}

  set(input: SettingInput): SettingRecord {
    const key = boundedText(input.key, "setting key", 256);
    const schemaVersion = positiveSchemaVersion(input.schemaVersion ?? 1);
    const value = deterministicJson(input.value, "setting value");
    const now = currentTimestamp(this.context);
    this.context.database
      .prepare(
        `INSERT INTO settings (
          key, schema_version, value_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          schema_version = excluded.schema_version,
          value_json = excluded.value_json,
          updated_at = excluded.updated_at`,
      )
      .run(key, schemaVersion, value, now, now);
    return this.get(key)!;
  }

  get(key: string): SettingRecord | undefined {
    const row = this.context.database
      .prepare("SELECT * FROM settings WHERE key = ?")
      .get(boundedText(key, "setting key", 256)) as SettingRow | undefined;
    return row ? mapSetting(row) : undefined;
  }

  list(limit = 1_000): SettingRecord[] {
    return (
      this.context.database
        .prepare("SELECT * FROM settings ORDER BY key LIMIT ?")
        .all(listLimit(limit)) as SettingRow[]
    ).map(mapSetting);
  }

  delete(key: string): boolean {
    return (
      this.context.database
        .prepare("DELETE FROM settings WHERE key = ?")
        .run(boundedText(key, "setting key", 256)).changes > 0
    );
  }
}

interface ProvenanceRow {
  id: string;
  entity_type: string;
  entity_id: string;
  source_type: string;
  source_key: string;
  source_uri: string | null;
  source_digest: string | null;
  imported_at: string;
  payload_json: string;
  created_at: string;
  updated_at: string;
}

function mapProvenance(row: ProvenanceRow): ProvenanceRecord {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    sourceType: row.source_type,
    sourceKey: row.source_key,
    ...(row.source_uri !== null ? { sourceUri: row.source_uri } : {}),
    ...(row.source_digest !== null ? { sourceDigest: row.source_digest } : {}),
    importedAt: row.imported_at,
    payload: parseDeterministicJson(row.payload_json, "provenance payload"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProvenanceRepository {
  constructor(private readonly context: RepositoryContext) {}

  upsert(input: ProvenanceInput): ProvenanceRecord {
    const entityType = boundedText(input.entityType, "provenance entity type", 64);
    const entityId = validatedId(input.entityId, "provenance entity ID");
    const sourceType = boundedText(input.sourceType, "provenance source type", 64);
    const sourceKey = boundedText(input.sourceKey, "provenance source key", 1024);
    const sourceUri = optionalBoundedText(
      input.sourceUri,
      "provenance source URI",
      4096,
    );
    const sourceDigest = optionalBoundedText(
      input.sourceDigest,
      "provenance source digest",
      256,
    );
    const id = input.id
      ? validatedId(input.id, "provenance ID")
      : stableId("source", entityType, sourceType, sourceKey);
    const importedAt = utcTimestamp(
      input.importedAt ?? this.context.now(),
      "provenance importedAt",
    );
    const payload = deterministicJson(input.payload ?? {}, "provenance payload");
    const now = currentTimestamp(this.context);
    this.context.database
      .prepare(
        `INSERT INTO provenance (
          id, entity_type, entity_id, source_type, source_key, source_uri,
          source_digest, imported_at, payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_type, source_type, source_key) DO UPDATE SET
          entity_id = excluded.entity_id,
          source_uri = excluded.source_uri,
          source_digest = excluded.source_digest,
          imported_at = excluded.imported_at,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        id,
        entityType,
        entityId,
        sourceType,
        sourceKey,
        sourceUri ?? null,
        sourceDigest ?? null,
        importedAt,
        payload,
        now,
        now,
      );
    return this.getBySource(entityType, sourceType, sourceKey)!;
  }

  get(id: string): ProvenanceRecord | undefined {
    const row = this.context.database
      .prepare("SELECT * FROM provenance WHERE id = ?")
      .get(validatedId(id, "provenance ID")) as ProvenanceRow | undefined;
    return row ? mapProvenance(row) : undefined;
  }

  getBySource(
    entityType: string,
    sourceType: string,
    sourceKey: string,
  ): ProvenanceRecord | undefined {
    const row = this.context.database
      .prepare(
        `SELECT * FROM provenance
         WHERE entity_type = ? AND source_type = ? AND source_key = ?`,
      )
      .get(
        boundedText(entityType, "provenance entity type", 64),
        boundedText(sourceType, "provenance source type", 64),
        boundedText(sourceKey, "provenance source key", 1024),
      ) as ProvenanceRow | undefined;
    return row ? mapProvenance(row) : undefined;
  }

  listForEntity(
    entityType: string,
    entityId: string,
    limit = 1_000,
  ): ProvenanceRecord[] {
    return (
      this.context.database
        .prepare(
          `SELECT * FROM provenance
           WHERE entity_type = ? AND entity_id = ?
           ORDER BY imported_at DESC, id
           LIMIT ?`,
        )
        .all(
          boundedText(entityType, "provenance entity type", 64),
          validatedId(entityId, "provenance entity ID"),
          listLimit(limit),
        ) as ProvenanceRow[]
    ).map(mapProvenance);
  }
}

export interface PersistenceRepositories {
  catalogItems: CatalogItemsRepository;
  itemObservations: ItemObservationsRepository;
  valuations: ValuationsRepository;
  ruleSets: RuleSetsRepository;
  presets: PresetsRepository;
  buildProfiles: BuildProfilesRepository;
  gearTargets: GearTargetsRepository;
  scanSessions: ScanSessionsRepository;
  scanSlots: ScanSlotsRepository;
  settings: SettingsRepository;
  provenance: ProvenanceRepository;
}

export function createRepositories(context: RepositoryContext): PersistenceRepositories {
  const gearTargets = new GearTargetsRepository(context);
  return {
    catalogItems: new CatalogItemsRepository(context),
    itemObservations: new ItemObservationsRepository(context),
    valuations: new ValuationsRepository(context),
    ruleSets: new RuleSetsRepository(context),
    presets: new PresetsRepository(context),
    buildProfiles: new BuildProfilesRepository(context, gearTargets),
    gearTargets,
    scanSessions: new ScanSessionsRepository(context),
    scanSlots: new ScanSlotsRepository(context),
    settings: new SettingsRepository(context),
    provenance: new ProvenanceRepository(context),
  };
}
