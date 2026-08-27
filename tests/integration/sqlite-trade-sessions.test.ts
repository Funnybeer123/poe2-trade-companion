import { FrozenClock, tradeSessionRecordFrom } from "@poe2tc/core";
import { applyMigrations, openSqliteDatabase, SqliteTradeSessions } from "@poe2tc/persistence-sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "../helpers/fixturePaths.js";

describe("SqliteTradeSessions", () => {
  it("updates trade_sessions on each transition and reloads after a new connection", () => {
    const file = join(mkdtempSync(join(tmpdir(), "poe2tc-trade-")), "trade.db");
    const clock = new FrozenClock(12_000);
    const writer = openSqliteDatabase(file);
    applyMigrations(writer, MIGRATIONS_DIR, clock);
    const store = new SqliteTradeSessions(writer);
    store.upsert(
      tradeSessionRecordFrom({
        id: "trade:trade-session:1",
        scenarioId: "trade-session",
        state: "OpenTrade",
        updatedAtMs: 12_000,
        payload: { event: "open-trade", reason: "trade-open" },
      }),
    );
    store.upsert(
      tradeSessionRecordFrom({
        id: "trade:trade-session:1",
        scenarioId: "trade-session",
        state: "PlaceItem",
        updatedAtMs: 12_200,
        payload: { event: "place-item", reason: "trade-place-item" },
      }),
    );
    writer.close();

    const reader = openSqliteDatabase(file);
    const reloaded = new SqliteTradeSessions(reader);
    const row = reloaded.get("trade:trade-session:1");
    expect(row?.state).toBe("PlaceItem");
    expect(JSON.parse(row?.payloadJson ?? "{}").reason).toBe("trade-place-item");
    expect(reloaded.listByScenario("trade-session")).toHaveLength(1);
    reader.close();
  });
});
