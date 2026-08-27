import type { ListingHistoryRecord } from "../world-state/types.js";
import type { ListingHistoryStore } from "./types.js";

export class MemoryListingHistoryStore implements ListingHistoryStore {
  readonly records: ListingHistoryRecord[] = [];

  append(record: ListingHistoryRecord): void {
    this.records.push(record);
  }

  listByFingerprint(fingerprint: string): ListingHistoryRecord[] {
    return this.records.filter((row) => row.fingerprint === fingerprint);
  }

  latest(fingerprint: string): ListingHistoryRecord | undefined {
    return this.listByFingerprint(fingerprint).at(-1);
  }
}

export function createMemoryListingHistoryStore(): MemoryListingHistoryStore {
  return new MemoryListingHistoryStore();
}

export function listingHistoryId(fingerprint: string, createdAtMs: number, result: string): string {
  return `listing:${fingerprint}:${String(createdAtMs)}:${result}`;
}

export function listingHistoryRecord(input: {
  fingerprint: string;
  price?: number;
  currency?: string;
  createdAtMs: number;
  result: string;
}): ListingHistoryRecord {
  return {
    id: listingHistoryId(input.fingerprint, input.createdAtMs, input.result),
    fingerprint: input.fingerprint,
    price: input.price,
    currency: input.currency,
    createdAtMs: input.createdAtMs,
    result: input.result,
  };
}
