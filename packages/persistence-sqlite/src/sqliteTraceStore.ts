import type { QaActionTrace, TraceSink } from "@poe2tc/core";
import type { Database } from "better-sqlite3";

interface TraceRow {
  payload_json: string;
}

export class SqliteTraceStore implements TraceSink {
  constructor(private readonly db: Database) {}

  append(trace: QaActionTrace): void {
    this.db
      .prepare(
        `INSERT INTO qa_action_traces (
          id, timestamp, clock_ms, tick_id, scenario_id, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trace.id,
        trace.timestamp,
        trace.clockMs,
        trace.tickId,
        trace.scenarioId,
        JSON.stringify(trace),
      );
  }

  getById(id: string): QaActionTrace | undefined {
    const row = this.db
      .prepare("SELECT payload_json FROM qa_action_traces WHERE id = ?")
      .get(id) as TraceRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    return JSON.parse(row.payload_json) as QaActionTrace;
  }
}
