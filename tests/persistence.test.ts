import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildProfile } from "../src/core/buildProfiles.js";
import {
  importLegacyData,
  openLocalPersistence,
  PERSISTENCE_MIGRATIONS,
  PERSISTENCE_SCHEMA_VERSION,
  readSchemaVersion,
  runMigrations,
  type Migration,
} from "../src/main/persistence/index.js";

const roots: string[] = [];
const NOW = "2026-08-26T06:30:00.000Z";

function tempDatabase(): { root: string; file: string } {
  const root = mkdtempSync(path.join(tmpdir(), "poe2-persistence-"));
  roots.push(root);
  return { root, file: path.join(root, "state", "companion.sqlite") };
}

function fixture(name: string): string {
  return readFileSync(path.join(process.cwd(), "fixtures", "imports", name), "utf8");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SQLite local persistence", () => {
  it("migrates, persists repository CRUD, closes, and reopens after restart", () => {
    const { file } = tempDatabase();
    let clock = NOW;
    const persistence = openLocalPersistence(file, { clock: () => clock });

    expect(persistence.schemaVersion).toBe(PERSISTENCE_SCHEMA_VERSION);
    const catalog = persistence.catalogItems.upsert({
      fingerprint: "fp-ring",
      name: "Storm Loop",
      baseType: "Ruby Ring",
      itemClass: "Rings",
      currentLocation: "stash:1:0,0",
      recommendation: "keep",
      fairValue: 25,
      payload: { z: 2, a: { d: 4, b: 3 } },
    });
    const observation = persistence.itemObservations.upsert({
      catalogItemId: catalog.id,
      observedAt: "2026-08-26T06:00:00-00:00",
      source: "clipboard",
      location: "stash:1:0,0",
      confidence: 0.95,
      payload: { rawText: "Item Class: Rings" },
    });
    const valuation = persistence.valuations.upsert({
      catalogItemId: catalog.id,
      providerName: "fixture",
      marketTimestamp: "2026-08-26T06:05:00Z",
      currency: "exalted",
      low: 20,
      fair: 25,
      high: 30,
      confidence: "high",
      sampleSize: 12,
      payload: { comparablesUsed: 10 },
    });
    const ruleSet = persistence.ruleSets.upsert({
      kind: "stash-scan",
      name: "Rings",
      schemaVersion: 1,
      rules: [{ regex: "\"Resistance\"" }],
      active: true,
    });
    const preset = persistence.presets.upsert({
      kind: "trade-query",
      name: "Ruby rings",
      payload: { query: { type: "Ruby Ring" } },
    });
    const profile = createBuildProfile(
      {
        name: "Ring build",
        league: "Standard",
        active: true,
        gearTargets: [
          {
            searchKey: "trade-query:ring",
            name: "Main ring",
            slot: "ring-1",
            itemClass: "Rings",
            importedQuery: { query: { type: "Ruby Ring" } },
          },
        ],
      },
      { now: NOW },
    );
    persistence.buildProfiles.upsert(profile);
    const session = persistence.scanSessions.upsert({
      profileId: profile.id,
      source: "fixture",
      status: "complete",
      startedAt: "2026-08-26T06:10:00Z",
      endedAt: "2026-08-26T06:11:00Z",
      summary: { slots: 1 },
    });
    const slot = persistence.scanSlots.upsert({
      sessionId: session.id,
      slotKey: "0,0",
      ordinal: 0,
      status: "matched",
      itemFingerprint: catalog.fingerprint,
      scannedAt: "2026-08-26T06:10:30Z",
      payload: { targetId: profile.gearTargets[0]!.id },
    });
    persistence.settings.set({
      key: "market.cache",
      schemaVersion: 2,
      value: { ttl: 60, providers: ["fixture"] },
    });
    const provenance = persistence.provenance.upsert({
      entityType: "preset",
      entityId: preset.id,
      sourceType: "manual-import",
      sourceKey: "fixture:preset:1",
      importedAt: NOW,
      payload: { source: "test" },
    });

    expect(catalog.id).toMatch(/^item_/);
    expect(observation.observedAt).toBe("2026-08-26T06:00:00.000Z");
    expect(valuation.marketTimestamp).toBe("2026-08-26T06:05:00.000Z");
    expect(ruleSet.active).toBe(true);
    expect(slot.sessionId).toBe(session.id);
    expect(provenance.entityId).toBe(preset.id);

    clock = "2026-08-26T06:35:00Z";
    const updated = persistence.catalogItems.upsert({
      fingerprint: "fp-ring",
      name: "Storm Loop",
      baseType: "Ruby Ring",
      itemClass: "Rings",
      currentLocation: "inventory:0,0",
      payload: { moved: true },
    });
    expect(updated.id).toBe(catalog.id);
    expect(updated.createdAt).toBe(NOW);
    expect(updated.updatedAt).toBe("2026-08-26T06:35:00.000Z");
    persistence.close();

    const reopened = openLocalPersistence(file, { clock: () => clock });
    expect(reopened.schemaVersion).toBe(PERSISTENCE_SCHEMA_VERSION);
    expect(reopened.catalogItems.get(catalog.id)).toMatchObject({
      id: catalog.id,
      currentLocation: "inventory:0,0",
      payload: { moved: true },
    });
    expect(reopened.itemObservations.get(observation.id)?.confidence).toBe(0.95);
    expect(reopened.valuations.get(valuation.id)?.fair).toBe(25);
    expect(reopened.ruleSets.get(ruleSet.id)?.rules).toEqual([
      { regex: "\"Resistance\"" },
    ]);
    expect(reopened.presets.get(preset.id)?.payload).toEqual({
      query: { type: "Ruby Ring" },
    });
    expect(reopened.buildProfiles.get(profile.id)).toEqual(profile);
    expect(reopened.gearTargets.listForProfile(profile.id)).toHaveLength(1);
    expect(reopened.scanSlots.listForSession(session.id)).toHaveLength(1);
    expect(reopened.settings.get("market.cache")).toMatchObject({
      schemaVersion: 2,
      value: { providers: ["fixture"], ttl: 60 },
    });
    expect(reopened.provenance.listForEntity("preset", preset.id)).toHaveLength(1);

    expect(reopened.buildProfiles.delete(profile.id)).toBe(true);
    expect(reopened.gearTargets.listForProfile(profile.id)).toEqual([]);
    expect(reopened.catalogItems.delete(catalog.id)).toBe(true);
    expect(reopened.itemObservations.get(observation.id)).toBeUndefined();
    expect(reopened.valuations.get(valuation.id)).toBeUndefined();
    reopened.close();
  });

  it("commits synchronous transactions and rolls back all writes on failure", () => {
    const { file } = tempDatabase();
    const persistence = openLocalPersistence(file, { clock: () => NOW });

    persistence.transaction((repositories) => {
      repositories.settings.set({ key: "committed", value: { ok: true } });
      repositories.presets.upsert({
        kind: "test",
        name: "committed",
        payload: { ok: true },
      });
    });
    expect(persistence.settings.get("committed")?.value).toEqual({ ok: true });

    expect(() =>
      persistence.transaction((repositories) => {
        repositories.settings.set({ key: "rolled-back", value: { ok: false } });
        repositories.presets.upsert({
          kind: "test",
          name: "rolled-back",
          payload: { ok: false },
        });
        throw new Error("force rollback");
      }),
    ).toThrow("force rollback");
    expect(persistence.settings.get("rolled-back")).toBeUndefined();
    expect(persistence.presets.getByNaturalKey("test", "rolled-back")).toBeUndefined();
    persistence.close();
  });

  it("rolls back a failed migration and leaves its schema version unapplied", () => {
    const { root } = tempDatabase();
    const file = path.join(root, "migration.sqlite");
    const raw = new Database(file);
    try {
      runMigrations(raw, { now: NOW });
      const failing: Migration = {
        version: 3,
        name: "intentionally-failing-test-migration",
        up(database) {
          database.exec("CREATE TABLE should_rollback (id TEXT PRIMARY KEY);");
          database.exec("INSERT INTO table_that_does_not_exist VALUES (1);");
        },
      };
      expect(() =>
        runMigrations(raw, {
          migrations: [...PERSISTENCE_MIGRATIONS, failing],
          now: NOW,
        }),
      ).toThrow();
      expect(readSchemaVersion(raw)).toBe(PERSISTENCE_SCHEMA_VERSION);
      const table = raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'",
        )
        .get();
      expect(table).toBeUndefined();
    } finally {
      raw.close();
    }
  });

  it("stores JSON canonically and enforces payload, timestamp, schema, and numeric caps", () => {
    const { file } = tempDatabase();
    const persistence = openLocalPersistence(file, { clock: () => NOW });
    persistence.settings.set({
      key: "canonical",
      value: { z: 1, a: { y: 2, b: 3 } },
    });
    persistence.close();

    const raw = new Database(file, { readonly: true });
    const row = raw
      .prepare("SELECT value_json FROM settings WHERE key = ?")
      .get("canonical") as { value_json: string };
    expect(row.value_json).toBe('{"a":{"b":3,"y":2},"z":1}');
    raw.close();

    const reopened = openLocalPersistence(file, { clock: () => NOW });
    expect(() =>
      reopened.settings.set({
        key: "oversized",
        value: { blob: "x".repeat(300_000) },
      }),
    ).toThrow("byte cap");
    expect(() =>
      reopened.settings.set({
        key: "hostile",
        value: JSON.parse('{"__proto__":{"polluted":true}}') as unknown,
      }),
    ).toThrow("forbidden key");
    expect(() =>
      reopened.settings.set({ key: "bad-schema", schemaVersion: 0, value: {} }),
    ).toThrow("at least 1");
    expect(() =>
      reopened.catalogItems.upsert({
        fingerprint: "bad",
        name: "Bad",
        baseType: "Bad",
        itemClass: "Bad",
        currentLocation: "stash",
        fairValue: Number.POSITIVE_INFINITY,
      }),
    ).toThrow("finite number");
    expect(() =>
      reopened.scanSessions.upsert({
        source: "fixture",
        status: "bad",
        startedAt: "not-a-date",
      }),
    ).toThrow("valid timestamp");
    expect(reopened.settings.get("oversized")).toBeUndefined();
    reopened.close();
  });

  it("imports all legacy formats idempotently with provenance", () => {
    const { file } = tempDatabase();
    const persistence = openLocalPersistence(file, { clock: () => NOW });
    const options = {
      sourceKey: "legacy-fixtures",
      sourceUri: "file:///legacy/export",
      importedAt: NOW,
    };

    const scanHistoryFirst = importLegacyData(
      persistence,
      "scan-history",
      fixture("scan_history.json"),
      options,
    );
    const scanHistorySecond = importLegacyData(
      persistence,
      "scan-history",
      fixture("scan_history.json"),
      options,
    );
    expect(scanHistoryFirst.entityIds).toEqual(scanHistorySecond.entityIds);
    expect(scanHistoryFirst.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "missing-regex" })]),
    );
    expect(persistence.presets.list("scan-history")).toHaveLength(2);

    importLegacyData(
      persistence,
      "regex-history",
      fixture("regex-history.json"),
      { ...options, sourceKey: "regex-fixture" },
    );
    importLegacyData(
      persistence,
      "trade-presets",
      fixture("trade-presets.json"),
      { ...options, sourceKey: "trade-fixture" },
    );
    const scanFirst = importLegacyData(
      persistence,
      "scan-jsonl",
      fixture("legacy-scan.jsonl"),
      { ...options, sourceKey: "jsonl-fixture" },
    );
    const scanSecond = importLegacyData(
      persistence,
      "scan-jsonl",
      fixture("legacy-scan.jsonl"),
      { ...options, sourceKey: "jsonl-fixture" },
    );

    expect(scanFirst.entityIds).toEqual(scanSecond.entityIds);
    expect(persistence.presets.list("regex-history")).toHaveLength(2);
    expect(persistence.presets.list("trade-query")).toHaveLength(2);
    const sessions = persistence.scanSessions.list();
    expect(sessions).toHaveLength(2);
    expect(
      sessions.reduce(
        (count, session) =>
          count + persistence.scanSlots.listForSession(session.id).length,
        0,
      ),
    ).toBe(3);
    expect(persistence.catalogItems.list()).toHaveLength(2);
    for (const entityId of scanHistoryFirst.entityIds) {
      expect(persistence.provenance.listForEntity("preset", entityId)).toHaveLength(1);
    }
    persistence.close();
  });
});
