import { FrozenClock, isoTimestampFromMs, type QaActionTrace } from "@poe2tc/core";
import { applyMigrations, openSqliteDatabase, SqliteTraceStore } from "@poe2tc/persistence-sqlite";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "../helpers/fixturePaths.js";

describe("SqliteTraceStore", () => {
  it("round-trips one QaActionTrace after applying migrations", () => {
    const clock = new FrozenClock(10_000);
    const db = openSqliteDatabase(":memory:");
    const applied = applyMigrations(db, MIGRATIONS_DIR, clock);
    expect(applied).toContain(1);
    expect(applyMigrations(db, MIGRATIONS_DIR, clock)).toEqual([]);

    const store = new SqliteTraceStore(db);
    const trace: QaActionTrace = {
      id: "follow-only:1",
      timestamp: isoTimestampFromMs(clock.nowMs()),
      clockMs: clock.nowMs(),
      tickId: 1,
      scenarioId: "follow-only",
      runtimeMode: "authorized-qa",
      module: "follow",
      selectedState: "Follow",
      previousState: "Idle",
      process: { name: "PathOfExile.exe", title: "Path of Exile 2" },
      observedSummary: "target=qa-target process=PathOfExile.exe ui=gameplay",
      confidence: 0.92,
      decisionReason: "follow-target",
      intendedActions: [{ type: "mouse-click", x: 640, y: 360, button: "left" }],
      interlockCode: "dry-run",
      executed: false,
      dryRun: true,
      result: "dry-run",
    };

    store.append(trace);
    expect(store.getById(trace.id)).toEqual(trace);
    expect(store.getById("missing")).toBeUndefined();
  });
});

