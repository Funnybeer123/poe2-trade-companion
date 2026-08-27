import { FrozenClock, OPERATOR_SETTINGS_KEY, defaultOperatorSettings } from "@poe2tc/core";
import { applyMigrations, openSqliteDatabase, SqliteSettingsStore } from "@poe2tc/persistence-sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "../helpers/fixturePaths.js";

describe("SQLite settings persistence", () => {
  it("persists operator settings through a new database connection", () => {
    const clock = new FrozenClock(20_000);
    const file = join(mkdtempSync(join(tmpdir(), "poe2tc-settings-")), "settings.db");
    const first = openSqliteDatabase(file);
    applyMigrations(first, MIGRATIONS_DIR, clock);
    const store = new SqliteSettingsStore(first);
    store.set(
      OPERATOR_SETTINGS_KEY,
      JSON.stringify({ ...defaultOperatorSettings(), league: "Dawn of the Hunt" }),
      clock.nowMs(),
    );
    first.close();

    const second = openSqliteDatabase(file);
    const reloaded = new SqliteSettingsStore(second);
    expect(JSON.parse(reloaded.get(OPERATOR_SETTINGS_KEY) ?? "{}")).toMatchObject({
      league: "Dawn of the Hunt",
      redactIdentifiers: true,
    });
    const row = second.prepare("SELECT key FROM settings WHERE key = ?").get(OPERATOR_SETTINGS_KEY) as
      | { key: string }
      | undefined;
    expect(row?.key).toBe(OPERATOR_SETTINGS_KEY);
    second.close();
  });

  it("round-trips settings on the same connection after overwrite", () => {
    const clock = new FrozenClock(30_000);
    const db = openSqliteDatabase(":memory:");
    applyMigrations(db, MIGRATIONS_DIR, clock);
    const store = new SqliteSettingsStore(db);
    store.set(OPERATOR_SETTINGS_KEY, JSON.stringify({ ...defaultOperatorSettings(), league: "A" }), 30_000);
    store.set(OPERATOR_SETTINGS_KEY, JSON.stringify({ ...defaultOperatorSettings(), league: "B" }), 31_000);
    expect(JSON.parse(store.get(OPERATOR_SETTINGS_KEY) ?? "{}")).toMatchObject({ league: "B" });
    expect(store.getUpdatedAtMs(OPERATOR_SETTINGS_KEY)).toBe(31_000);
  });
});
