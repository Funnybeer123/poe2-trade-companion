import type { SettingsPort } from "@poe2tc/core";
import type { Database } from "better-sqlite3";

interface SettingsRow {
  key: string;
  value_json: string;
  updated_at_ms: number;
}

export class SqliteSettingsStore implements SettingsPort {
  constructor(private readonly db: Database) {}

  get(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value_json FROM settings WHERE key = ?")
      .get(key) as Pick<SettingsRow, "value_json"> | undefined;
    return row?.value_json;
  }

  set(key: string, valueJson: string, updatedAtMs: number): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(key, valueJson, updatedAtMs);
  }

  getUpdatedAtMs(key: string): number | undefined {
    const row = this.db
      .prepare("SELECT updated_at_ms FROM settings WHERE key = ?")
      .get(key) as Pick<SettingsRow, "updated_at_ms"> | undefined;
    return row?.updated_at_ms;
  }
}
