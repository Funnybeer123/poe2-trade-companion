import type { TradeSessionRecord } from "../world-state/types.js";
import type { TradeSessionStore } from "./types.js";

export class MemoryTradeSessionStore implements TradeSessionStore {
  readonly records = new Map<string, TradeSessionRecord>();

  upsert(record: TradeSessionRecord): void {
    this.records.set(record.id, record);
  }

  get(id: string): TradeSessionRecord | undefined {
    return this.records.get(id);
  }

  listByScenario(scenarioId: string): TradeSessionRecord[] {
    return [...this.records.values()]
      .filter((row) => row.scenarioId === scenarioId)
      .sort((left, right) => left.updatedAtMs - right.updatedAtMs || left.id.localeCompare(right.id));
  }
}

export function createMemoryTradeSessionStore(): MemoryTradeSessionStore {
  return new MemoryTradeSessionStore();
}
