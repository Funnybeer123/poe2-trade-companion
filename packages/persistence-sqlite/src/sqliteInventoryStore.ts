import type {
  InventorySnapshotStore,
  StoredInventorySnapshot,
  StoredStashSnapshot,
} from "@poe2tc/core";
import type { Database } from "better-sqlite3";

interface InventoryRow {
  id: string;
  captured_at_ms: number;
  payload_json: string;
}

interface StashRow {
  id: string;
  captured_at_ms: number;
  tab_id: string | null;
  payload_json: string;
}

export class SqliteInventoryStore implements InventorySnapshotStore {
  constructor(private readonly db: Database) {}

  writeInventory(snapshot: StoredInventorySnapshot): void {
    this.db
      .prepare(
        `INSERT INTO inventory_snapshots (id, captured_at_ms, payload_json)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           captured_at_ms = excluded.captured_at_ms,
           payload_json = excluded.payload_json`,
      )
      .run(snapshot.id, snapshot.capturedAtMs, JSON.stringify(snapshot.payload));
  }

  writeStash(snapshot: StoredStashSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO stash_snapshots (id, captured_at_ms, tab_id, payload_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           captured_at_ms = excluded.captured_at_ms,
           tab_id = excluded.tab_id,
           payload_json = excluded.payload_json`,
      )
      .run(
        snapshot.id,
        snapshot.capturedAtMs,
        snapshot.tabId ?? snapshot.payload.tabId ?? null,
        JSON.stringify(snapshot.payload),
      );
  }

  loadLatestInventory(): StoredInventorySnapshot | undefined {
    const row = this.db
      .prepare(
        `SELECT id, captured_at_ms, payload_json
         FROM inventory_snapshots
         ORDER BY captured_at_ms DESC, id DESC
         LIMIT 1`,
      )
      .get() as InventoryRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id,
      capturedAtMs: row.captured_at_ms,
      payload: JSON.parse(row.payload_json) as StoredInventorySnapshot["payload"],
    };
  }

  loadLatestStash(): StoredStashSnapshot | undefined {
    const row = this.db
      .prepare(
        `SELECT id, captured_at_ms, tab_id, payload_json
         FROM stash_snapshots
         ORDER BY captured_at_ms DESC, id DESC
         LIMIT 1`,
      )
      .get() as StashRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id,
      capturedAtMs: row.captured_at_ms,
      tabId: row.tab_id ?? undefined,
      payload: JSON.parse(row.payload_json) as StoredStashSnapshot["payload"],
    };
  }
}
