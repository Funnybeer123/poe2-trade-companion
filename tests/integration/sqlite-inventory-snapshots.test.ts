import { applyStaleSnapshots, createEmptyWorldState, FrozenClock, makeGridCells } from "@poe2tc/core";
import { applyMigrations, openSqliteDatabase, SqliteInventoryStore } from "@poe2tc/persistence-sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "../helpers/fixturePaths.js";

describe("SqliteInventoryStore", () => {
  it("persists inventory and stash snapshots and reloads them after a new connection", () => {
    const file = join(mkdtempSync(join(tmpdir(), "poe2tc-inv-")), "snapshots.db");
    const clock = new FrozenClock(12_000);
    const cells = makeGridCells({
      columns: 4,
      rows: 3,
      occupied: [
        { x: 0, y: 0, fingerprint: "orb-a" },
        [1, 0],
        [2, 0],
      ],
    });
    const stashCells = makeGridCells({
      columns: 4,
      rows: 3,
      tabId: "currency",
      occupied: [{ x: 0, y: 0, fingerprint: "orb-b" }],
    });

    const writer = openSqliteDatabase(file);
    applyMigrations(writer, MIGRATIONS_DIR, clock);
    const store = new SqliteInventoryStore(writer);
    store.writeInventory({
      id: "inv-1",
      capturedAtMs: 12_000,
      payload: { occupied: 3, capacity: 12, full: false, cells },
    });
    store.writeStash({
      id: "stash-1",
      capturedAtMs: 12_000,
      tabId: "currency",
      payload: { tabId: "currency", tabName: "Currency", cells: stashCells, tabFull: false },
    });
    writer.close();

    const reader = openSqliteDatabase(file);
    const reloaded = new SqliteInventoryStore(reader);
    const inventory = reloaded.loadLatestInventory();
    const stash = reloaded.loadLatestStash();
    expect(inventory?.payload.occupied).toBe(3);
    expect(inventory?.payload.cells).toHaveLength(12);
    expect(inventory?.payload.cells[0]?.itemFingerprint).toBe("orb-a");
    expect(stash?.payload.tabName).toBe("Currency");
    expect(stash?.payload.cells[0]?.itemFingerprint).toBe("orb-b");

    const world = applyStaleSnapshots(createEmptyWorldState({ clock: new FrozenClock(30_000) }), {
      inventory,
      stash,
    });
    expect(world.inventory.freshness).toBe("stale");
    expect(world.stash.freshness).toBe("stale");
    expect(world.inventory.value.cells[0]?.itemFingerprint).toBe("orb-a");
    reader.close();
  });
});
