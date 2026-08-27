import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "@poe2tc/core";
import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";

export function openSqliteDatabase(filename = ":memory:"): SqliteDatabase {
  return new Database(filename);
}

const MIGRATION_FILE = /^(\d+)_.*\.sql$/;

export function listMigrationFiles(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter((name) => MIGRATION_FILE.test(name))
    .sort((a, b) => {
      const aId = Number(/^(\d+)/.exec(a)?.[1] ?? Number.POSITIVE_INFINITY);
      const bId = Number(/^(\d+)/.exec(b)?.[1] ?? Number.POSITIVE_INFINITY);
      return aId - bId;
    });
}

function appliedIds(db: SqliteDatabase): Set<number> {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { name: string } | undefined;
  if (table === undefined) {
    return new Set();
  }
  const rows = db.prepare("SELECT id FROM schema_migrations").all() as Array<{ id: number }>;
  return new Set(rows.map((row) => row.id));
}

export function applyMigrations(
  db: SqliteDatabase,
  migrationsDir: string,
  clock?: Clock,
): number[] {
  const applied = appliedIds(db);
  const inserted: number[] = [];
  const nowMs = (): number => clock?.nowMs() ?? Date.now();

  const applyOne = db.transaction((file: string, id: number) => {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    db.exec(sql);
    db.prepare("INSERT INTO schema_migrations (id, applied_at_ms) VALUES (?, ?)").run(id, nowMs());
  });

  for (const file of listMigrationFiles(migrationsDir)) {
    const id = Number(/^(\d+)/.exec(file)?.[1]);
    if (!Number.isFinite(id)) {
      continue;
    }
    if (applied.has(id)) {
      continue;
    }
    applyOne(file, id);
    applied.add(id);
    inserted.push(id);
  }

  return inserted;
}
