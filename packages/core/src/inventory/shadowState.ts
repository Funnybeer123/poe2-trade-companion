import type { GridCell } from "../world-state/types.js";
import { DEFAULT_SHADOW_STALE_AFTER_MS, reconcile, type ReconcileInput } from "./reconcile.js";
import type { StoredInventorySnapshot, StoredStashSnapshot } from "./snapshots.js";
import { locationKey, type ReconcileResult, type ShadowItem } from "./types.js";

export class ShadowState {
  readonly #items = new Map<string, ShadowItem>();

  get items(): ShadowItem[] {
    return [...this.#items.values()].sort((a, b) => locationKey(a.location).localeCompare(locationKey(b.location)));
  }

  clear(): void {
    this.#items.clear();
  }

  get(location: ShadowItem["location"]): ShadowItem | undefined {
    return this.#items.get(locationKey(location));
  }

  seed(items: ShadowItem[]): void {
    this.#items.clear();
    for (const item of items) {
      if (item.fingerprint.length === 0) {
        continue;
      }
      this.#items.set(locationKey(item.location), { ...item });
    }
  }

  seedFromSnapshots(snapshots: {
    inventory?: StoredInventorySnapshot;
    stash?: StoredStashSnapshot;
  }): void {
    const items: ShadowItem[] = [];
    if (snapshots.inventory !== undefined) {
      items.push(
        ...shadowItemsFromCells(
          "inventory",
          snapshots.inventory.payload.cells,
          snapshots.inventory.capturedAtMs,
          true,
        ),
      );
    }
    if (snapshots.stash !== undefined) {
      items.push(
        ...shadowItemsFromCells("stash", snapshots.stash.payload.cells, snapshots.stash.capturedAtMs, true),
      );
    }
    this.seed(items);
  }

  apply(result: ReconcileResult): void {
    const next = new Map<string, ShadowItem>();
    for (const item of [...result.confirmed, ...result.unexpected, ...result.stale]) {
      if (item.fingerprint.length === 0) {
        continue;
      }
      next.set(locationKey(item.location), item);
    }
    this.#items.clear();
    for (const [key, item] of next) {
      this.#items.set(key, item);
    }
  }

  reconcile(
    input: Omit<ReconcileInput, "shadow" | "seedIfEmpty"> & { seedIfEmpty?: boolean },
  ): ReconcileResult {
    const result = reconcile({
      ...input,
      shadow: this.items,
      seedIfEmpty: input.seedIfEmpty ?? this.#items.size === 0,
      staleAfterMs: input.staleAfterMs ?? DEFAULT_SHADOW_STALE_AFTER_MS,
    });
    this.apply(result);
    return result;
  }
}

export function shadowItemsFromCells(
  kind: ShadowItem["location"]["kind"],
  cells: GridCell[],
  lastConfirmedMs: number,
  stale: boolean,
): ShadowItem[] {
  const items: ShadowItem[] = [];
  for (const cell of cells) {
    if (!cell.occupied || cell.itemFingerprint === undefined || cell.itemFingerprint.length === 0) {
      continue;
    }
    items.push({
      fingerprint: cell.itemFingerprint,
      location: { kind, tabId: cell.tabId, x: cell.x, y: cell.y },
      lastConfirmedMs,
      stale,
      mismatch: false,
    });
  }
  return items;
}

export function createShadowState(items: ShadowItem[] = []): ShadowState {
  const shadow = new ShadowState();
  shadow.seed(items);
  return shadow;
}
