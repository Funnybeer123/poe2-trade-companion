import { DEFAULT_RECOVERY } from "../recovery/defaultRecovery.js";
import type { LootTarget, Observation, WorldState, WorldStateFlags } from "../world-state/types.js";
import { LOOT_RECOVERY_KEY, SKIP_UNREACHABLE } from "./skipReasons.js";

export interface EstimateLootPickupInput {
  flags: WorldStateFlags;
  loot: Observation<LootTarget[]>;
  inventory: Observation<WorldState["inventory"]["value"]>;
  nowMs: number;
}

export interface EstimateLootPickupResult {
  flags: WorldStateFlags;
  loot: Observation<LootTarget[]>;
}

function copyCountMap(map: Record<string, number> | undefined): Record<string, number> {
  return { ...(map ?? {}) };
}

export function estimateLootPickup(input: EstimateLootPickupInput): EstimateLootPickupResult {
  const policy = DEFAULT_RECOVERY[LOOT_RECOVERY_KEY];
  const maxAttempts = policy?.maxAttempts ?? 2;
  const suppressMs = policy?.suppressMs ?? 15_000;

  const lootSuppressedUntilMs = copyCountMap(input.flags.lootSuppressedUntilMs);
  const lootAttemptCounts = copyCountMap(input.flags.lootAttemptCounts);
  const lootLastAttemptMs = copyCountMap(input.flags.lootLastAttemptMs);

  for (const [id, until] of Object.entries(lootSuppressedUntilMs)) {
    if (input.nowMs >= until) {
      delete lootSuppressedUntilMs[id];
      delete lootAttemptCounts[id];
      delete lootLastAttemptMs[id];
    }
  }

  let pendingLootPickup = input.flags.pendingLootPickup ?? null;
  const pending = pendingLootPickup;
  if (pending) {
    const stillVisible = input.loot.value.some((item) => item.id === pending.id);
    const occupancyIncreased = input.inventory.value.occupied > pending.occupancy;
    if (!stillVisible || occupancyIncreased) {
      pendingLootPickup = null;
      delete lootAttemptCounts[pending.id];
      delete lootLastAttemptMs[pending.id];
      delete lootSuppressedUntilMs[pending.id];
    } else {
      const attempts = (lootAttemptCounts[pending.id] ?? 0) + 1;
      lootAttemptCounts[pending.id] = attempts;
      lootLastAttemptMs[pending.id] = pending.clickedAtMs;
      pendingLootPickup = null;
      if (attempts >= maxAttempts) {
        lootSuppressedUntilMs[pending.id] = input.nowMs + suppressMs;
      }
    }
  }

  const lootValue = input.loot.value.map((item) => {
    const until = lootSuppressedUntilMs[item.id];
    if (until !== undefined && input.nowMs < until) {
      return { ...item, skipReason: item.skipReason ?? SKIP_UNREACHABLE };
    }
    return item;
  });

  return {
    flags: {
      ...input.flags,
      pendingLootPickup,
      lootSuppressedUntilMs,
      lootAttemptCounts,
      lootLastAttemptMs,
    },
    loot: {
      ...input.loot,
      value: lootValue,
    },
  };
}
