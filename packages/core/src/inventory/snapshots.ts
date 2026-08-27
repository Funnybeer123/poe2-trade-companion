import type { Freshness, GridCell, Observation, WorldState } from "../world-state/types.js";

export interface InventoryGridSnapshot {
  occupied: number;
  capacity: number;
  cells: GridCell[];
  full: boolean;
}

export interface StashGridSnapshot {
  tabId?: string;
  tabName?: string;
  cells: GridCell[];
  tabFull: boolean;
}

export interface StoredInventorySnapshot {
  id: string;
  capturedAtMs: number;
  payload: InventoryGridSnapshot;
}

export interface StoredStashSnapshot {
  id: string;
  capturedAtMs: number;
  tabId?: string;
  payload: StashGridSnapshot;
}

export interface InventorySnapshotStore {
  writeInventory(snapshot: StoredInventorySnapshot): void;
  writeStash(snapshot: StoredStashSnapshot): void;
  loadLatestInventory(): StoredInventorySnapshot | undefined;
  loadLatestStash(): StoredStashSnapshot | undefined;
}

export class MemoryInventorySnapshotStore implements InventorySnapshotStore {
  readonly inventory: StoredInventorySnapshot[] = [];
  readonly stash: StoredStashSnapshot[] = [];

  writeInventory(snapshot: StoredInventorySnapshot): void {
    this.inventory.push(snapshot);
  }

  writeStash(snapshot: StoredStashSnapshot): void {
    this.stash.push(snapshot);
  }

  loadLatestInventory(): StoredInventorySnapshot | undefined {
    return this.inventory.at(-1);
  }

  loadLatestStash(): StoredStashSnapshot | undefined {
    return this.stash.at(-1);
  }
}

export function createMemoryInventorySnapshotStore(): MemoryInventorySnapshotStore {
  return new MemoryInventorySnapshotStore();
}

function staleObservation<T>(value: T, capturedAtMs: number, evidenceId: string): Observation<T> {
  return {
    value,
    confidence: 1,
    observedAtMs: capturedAtMs,
    freshness: "stale" satisfies Freshness,
    evidenceId,
  };
}

export function applyStaleSnapshots(
  world: WorldState,
  snapshots: {
    inventory?: StoredInventorySnapshot;
    stash?: StoredStashSnapshot;
  },
): WorldState {
  let next = world;
  if (snapshots.inventory !== undefined) {
    next = {
      ...next,
      inventory: staleObservation(
        snapshots.inventory.payload,
        snapshots.inventory.capturedAtMs,
        `snapshot:${snapshots.inventory.id}`,
      ),
    };
  }
  if (snapshots.stash !== undefined) {
    next = {
      ...next,
      stash: staleObservation(
        snapshots.stash.payload,
        snapshots.stash.capturedAtMs,
        `snapshot:${snapshots.stash.id}`,
      ),
    };
  }
  return next;
}

export function inventorySnapshotFromWorld(
  world: WorldState,
  id: string,
): StoredInventorySnapshot {
  return {
    id,
    capturedAtMs: world.inventory.observedAtMs,
    payload: {
      occupied: world.inventory.value.occupied,
      capacity: world.inventory.value.capacity,
      cells: world.inventory.value.cells,
      full: world.inventory.value.full,
    },
  };
}

export function stashSnapshotFromWorld(world: WorldState, id: string): StoredStashSnapshot {
  return {
    id,
    capturedAtMs: world.stash.observedAtMs,
    tabId: world.stash.value.tabId,
    payload: {
      tabId: world.stash.value.tabId,
      tabName: world.stash.value.tabName,
      cells: world.stash.value.cells,
      tabFull: world.stash.value.tabFull,
    },
  };
}

export function shouldPersistInventory(world: WorldState): boolean {
  return world.inventory.freshness !== "missing" || world.inventory.value.cells.length > 0;
}

export function shouldPersistStash(world: WorldState): boolean {
  return world.stash.freshness !== "missing" || world.stash.value.cells.length > 0;
}
