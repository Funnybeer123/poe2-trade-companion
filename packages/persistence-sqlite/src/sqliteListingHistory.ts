import type { ListingHistoryRecord, ListingHistoryStore } from "@poe2tc/core";
import type { Database } from "better-sqlite3";

interface ListingRow {
  id: string;
  fingerprint: string;
  price: number | null;
  currency: string | null;
  created_at_ms: number;
  result: string | null;
}

export class SqliteListingHistory implements ListingHistoryStore {
  constructor(private readonly db: Database) {}

  append(record: ListingHistoryRecord): void {
    this.db
      .prepare(
        `INSERT INTO listing_history (id, fingerprint, price, currency, created_at_ms, result)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           fingerprint = excluded.fingerprint,
           price = excluded.price,
           currency = excluded.currency,
           created_at_ms = excluded.created_at_ms,
           result = excluded.result`,
      )
      .run(
        record.id,
        record.fingerprint,
        record.price ?? null,
        record.currency ?? null,
        record.createdAtMs,
        record.result,
      );
  }

  listByFingerprint(fingerprint: string): ListingHistoryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, fingerprint, price, currency, created_at_ms, result
         FROM listing_history
         WHERE fingerprint = ?
         ORDER BY created_at_ms ASC, id ASC`,
      )
      .all(fingerprint) as ListingRow[];
    return rows.map(rowToRecord);
  }

  latest(fingerprint: string): ListingHistoryRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, fingerprint, price, currency, created_at_ms, result
         FROM listing_history
         WHERE fingerprint = ?
         ORDER BY created_at_ms DESC, id DESC
         LIMIT 1`,
      )
      .get(fingerprint) as ListingRow | undefined;
    return row === undefined ? undefined : rowToRecord(row);
  }
}

function rowToRecord(row: ListingRow): ListingHistoryRecord {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    price: row.price ?? undefined,
    currency: row.currency ?? undefined,
    createdAtMs: row.created_at_ms,
    result: row.result ?? "",
  };
}
