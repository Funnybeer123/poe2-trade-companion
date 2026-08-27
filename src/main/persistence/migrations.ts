import type BetterSqlite3 from "better-sqlite3";
import { utcTimestamp } from "./json.js";

export interface Migration {
  version: number;
  name: string;
  up(database: BetterSqlite3.Database): void;
}

export const PERSISTENCE_SCHEMA_VERSION = 2;

export const PERSISTENCE_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial-local-persistence",
    up(database) {
      database.exec(`
        CREATE TABLE catalog_items (
          id TEXT PRIMARY KEY NOT NULL,
          fingerprint TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          base_type TEXT NOT NULL,
          item_class TEXT NOT NULL,
          current_location TEXT NOT NULL,
          recommendation TEXT,
          fair_value REAL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE item_observations (
          id TEXT PRIMARY KEY NOT NULL,
          catalog_item_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
          observed_at TEXT NOT NULL,
          source TEXT NOT NULL,
          location TEXT NOT NULL,
          confidence REAL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (catalog_item_id, observed_at, source, location)
        );

        CREATE TABLE valuations (
          id TEXT PRIMARY KEY NOT NULL,
          catalog_item_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
          provider_name TEXT NOT NULL,
          market_timestamp TEXT NOT NULL,
          currency TEXT NOT NULL,
          low_value REAL NOT NULL,
          fair_value REAL NOT NULL,
          high_value REAL NOT NULL,
          confidence TEXT NOT NULL,
          sample_size INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (catalog_item_id, provider_name, market_timestamp)
        );

        CREATE TABLE rule_sets (
          id TEXT PRIMARY KEY NOT NULL,
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          rules_json TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (kind, name)
        );

        CREATE TABLE presets (
          id TEXT PRIMARY KEY NOT NULL,
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (kind, name)
        );

        CREATE TABLE build_profiles (
          id TEXT PRIMARY KEY NOT NULL,
          schema_version INTEGER NOT NULL,
          name TEXT NOT NULL,
          league TEXT,
          source_url TEXT,
          tags_json TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
          preferences_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE gear_targets (
          id TEXT PRIMARY KEY NOT NULL,
          profile_id TEXT NOT NULL REFERENCES build_profiles(id) ON DELETE CASCADE,
          search_key TEXT NOT NULL,
          name TEXT NOT NULL,
          slot TEXT NOT NULL,
          item_class TEXT,
          stat_rules_json TEXT NOT NULL,
          source_url TEXT,
          league TEXT,
          tags_json TEXT NOT NULL,
          imported_query_json TEXT,
          provenance_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (profile_id, search_key)
        );

        CREATE TABLE scan_sessions (
          id TEXT PRIMARY KEY NOT NULL,
          profile_id TEXT REFERENCES build_profiles(id) ON DELETE SET NULL,
          source TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          summary_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE scan_slots (
          id TEXT PRIMARY KEY NOT NULL,
          session_id TEXT NOT NULL REFERENCES scan_sessions(id) ON DELETE CASCADE,
          slot_key TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          status TEXT NOT NULL,
          item_fingerprint TEXT,
          scanned_at TEXT,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (session_id, slot_key)
        );

        CREATE TABLE settings (
          key TEXT PRIMARY KEY NOT NULL,
          schema_version INTEGER NOT NULL,
          value_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE provenance (
          id TEXT PRIMARY KEY NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          source_type TEXT NOT NULL,
          source_key TEXT NOT NULL,
          source_uri TEXT,
          source_digest TEXT,
          imported_at TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (entity_type, source_type, source_key)
        );
      `);
    },
  },
  {
    version: 2,
    name: "persistence-query-indexes",
    up(database) {
      database.exec(`
        CREATE INDEX item_observations_catalog_time_idx
          ON item_observations (catalog_item_id, observed_at DESC);
        CREATE INDEX valuations_catalog_time_idx
          ON valuations (catalog_item_id, market_timestamp DESC);
        CREATE INDEX rule_sets_kind_active_idx
          ON rule_sets (kind, active, name);
        CREATE INDEX presets_kind_name_idx
          ON presets (kind, name);
        CREATE INDEX gear_targets_profile_slot_idx
          ON gear_targets (profile_id, slot, name);
        CREATE INDEX scan_slots_session_ordinal_idx
          ON scan_slots (session_id, ordinal);
        CREATE INDEX provenance_entity_idx
          ON provenance (entity_type, entity_id);
      `);
    },
  },
] as const;

interface AppliedMigrationRow {
  version: number;
  name: string;
}

function validateMigrations(migrations: readonly Migration[]): void {
  let previous = 0;
  const names = new Set<string>();
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version !== previous + 1) {
      throw new Error("Persistence migrations must have contiguous versions starting at 1");
    }
    if (!migration.name.trim() || names.has(migration.name)) {
      throw new Error(`Invalid or duplicate migration name '${migration.name}'`);
    }
    names.add(migration.name);
    previous = migration.version;
  }
}

export function runMigrations(
  database: BetterSqlite3.Database,
  options: {
    migrations?: readonly Migration[];
    now?: Date | string | number;
  } = {},
): number {
  const migrations = options.migrations ?? PERSISTENCE_MIGRATIONS;
  validateMigrations(migrations);
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    );
  `);
  const appliedRows = database
    .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
    .all() as AppliedMigrationRow[];
  const applied = new Map(appliedRows.map((row) => [row.version, row.name]));
  const latestKnown = migrations.at(-1)?.version ?? 0;
  const latestApplied = appliedRows.at(-1)?.version ?? 0;
  if (latestApplied > latestKnown) {
    throw new Error(
      `Database schema version ${latestApplied} is newer than supported version ${latestKnown}`,
    );
  }
  for (const [version, name] of applied) {
    const expected = migrations.find((migration) => migration.version === version);
    if (!expected || expected.name !== name) {
      throw new Error(`Database migration ${version} does not match '${name}'`);
    }
  }

  const appliedAt = utcTimestamp(options.now ?? new Date(), "migration timestamp");
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    const apply = database.transaction(() => {
      migration.up(database);
      database
        .prepare(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        )
        .run(migration.version, migration.name, appliedAt);
      database.pragma(`user_version = ${migration.version}`);
    });
    apply();
  }
  return migrations.at(-1)?.version ?? 0;
}

export function readSchemaVersion(database: BetterSqlite3.Database): number {
  const row = database
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
    .get() as { version: number };
  return row.version;
}
