import { FrozenClock, listingHistoryRecord } from "@poe2tc/core";
import { applyMigrations, openSqliteDatabase, SqliteListingHistory } from "@poe2tc/persistence-sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "../helpers/fixturePaths.js";

describe("SqliteListingHistory", () => {
  it("persists listing_history and reloads after a new connection", () => {
    const file = join(mkdtempSync(join(tmpdir(), "poe2tc-listing-")), "listing.db");
    const clock = new FrozenClock(12_000);
    const writer = openSqliteDatabase(file);
    applyMigrations(writer, MIGRATIONS_DIR, clock);
    const store = new SqliteListingHistory(writer);
    store.append(
      listingHistoryRecord({
        fingerprint: "astramentis-1",
        price: 14.55,
        currency: "divine",
        createdAtMs: 12_000,
        result: "applied",
      }),
    );
    writer.close();

    const reader = openSqliteDatabase(file);
    const reloaded = new SqliteListingHistory(reader);
    const latest = reloaded.latest("astramentis-1");
    expect(latest?.price).toBe(14.55);
    expect(latest?.currency).toBe("divine");
    expect(latest?.result).toBe("applied");
    expect(reloaded.listByFingerprint("astramentis-1")).toHaveLength(1);
    reader.close();
  });
});
