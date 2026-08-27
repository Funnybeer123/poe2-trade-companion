import type { Observation, WorldState, WorldStateFlags } from "../world-state/types.js";
import { occupancyFromCells, stashTabFull } from "./occupancy.js";
import { DEFAULT_SHADOW_STALE_AFTER_MS } from "./reconcile.js";
import type { ShadowState } from "./shadowState.js";
import { hasShadowMismatch, type ReconcileResult } from "./types.js";

export interface EstimateInventoryInput {
  flags: WorldStateFlags;
  inventory: Observation<WorldState["inventory"]["value"]>;
  stash: Observation<WorldState["stash"]["value"]>;
  shadow: ShadowState;
  nowMs: number;
  staleAfterMs?: number;
}

export interface EstimateInventoryResult {
  flags: WorldStateFlags;
  inventory: Observation<WorldState["inventory"]["value"]>;
  stash: Observation<WorldState["stash"]["value"]>;
  reconcile: ReconcileResult;
}

export function estimateInventory(input: EstimateInventoryInput): EstimateInventoryResult {
  const inventoryValue = occupancyFromCells(input.inventory.value.cells, input.inventory.value);
  const stashOccupancy = occupancyFromCells(input.stash.value.cells, {
    occupied: input.stash.value.cells.filter((cell) => cell.occupied).length,
    capacity: input.stash.value.cells.length,
    full: input.stash.value.tabFull,
  });
  const stashValue: WorldState["stash"]["value"] = {
    ...input.stash.value,
    cells: stashOccupancy.cells,
    tabFull: stashTabFull(stashOccupancy.cells, input.stash.value.tabFull),
  };

  const result = input.shadow.reconcile({
    inventoryCells: inventoryValue.cells,
    stashCells: stashValue.cells,
    nowMs: input.nowMs,
    staleAfterMs: input.staleAfterMs ?? DEFAULT_SHADOW_STALE_AFTER_MS,
    inventoryFreshness: input.inventory.freshness,
    stashFreshness: input.stash.freshness,
  });

  return {
    inventory: { ...input.inventory, value: inventoryValue },
    stash: { ...input.stash, value: stashValue },
    flags: {
      ...input.flags,
      shadowMismatch: hasShadowMismatch(result),
    },
    reconcile: result,
  };
}
