import type { TradeSessionRecord, TradeSessionStore, TradeState } from "@poe2tc/core";
import type { Database } from "better-sqlite3";

interface TradeSessionRow {
  id: string;
  scenario_id: string;
  state: string;
  payload_json: string;
  updated_at_ms: number;
}

export class SqliteTradeSessions implements TradeSessionStore {
  constructor(private readonly db: Database) {}

  upsert(record: TradeSessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO trade_sessions (id, scenario_id, state, payload_json, updated_at_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           scenario_id = excluded.scenario_id,
           state = excluded.state,
           payload_json = excluded.payload_json,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(record.id, record.scenarioId, record.state, record.payloadJson, record.updatedAtMs);
  }

  get(id: string): TradeSessionRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, scenario_id, state, payload_json, updated_at_ms
         FROM trade_sessions
         WHERE id = ?`,
      )
      .get(id) as TradeSessionRow | undefined;
    return row === undefined ? undefined : rowToRecord(row);
  }

  listByScenario(scenarioId: string): TradeSessionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, scenario_id, state, payload_json, updated_at_ms
         FROM trade_sessions
         WHERE scenario_id = ?
         ORDER BY updated_at_ms ASC, id ASC`,
      )
      .all(scenarioId) as TradeSessionRow[];
    return rows.map(rowToRecord);
  }
}

function rowToRecord(row: TradeSessionRow): TradeSessionRecord {
  return {
    id: row.id,
    scenarioId: row.scenario_id,
    state: row.state as TradeState,
    payloadJson: row.payload_json,
    updatedAtMs: row.updated_at_ms,
  };
}
