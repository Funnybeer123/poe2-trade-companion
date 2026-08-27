import type { BotDecision, InputAction } from "../input/types.js";
import { LOOT_RECOVERY_KEY } from "../loot/skipReasons.js";
import { DEFAULT_RECOVERY } from "../recovery/defaultRecovery.js";
import { listingEffectsFromDecision } from "../listing/session.js";
import { STATE_MODULE } from "../scheduler/predicates.js";
import { stashEffectsFromDecision } from "../stash/session.js";
import { tradeEffectsFromDecision } from "../trade/session.js";
import type {
  AutomationStateId,
  ListingCatalogItem,
  ModuleId,
  TradeEvent,
  WorldState,
  WorldStateFlags,
} from "../world-state/types.js";

export function beginStashSession(flags: WorldStateFlags): WorldStateFlags {
  return { ...flags, stashSessionActive: true };
}

export function endStashSession(flags: WorldStateFlags): WorldStateFlags {
  return { ...flags, stashSessionActive: false, pendingStashTransfer: null };
}

export function beginListingSession(
  flags: WorldStateFlags,
  catalog?: ListingCatalogItem[],
): WorldStateFlags {
  return {
    ...flags,
    listingSessionActive: true,
    listingCatalog: catalog ?? flags.listingCatalog,
  };
}

export function endListingSession(flags: WorldStateFlags): WorldStateFlags {
  return { ...flags, listingSessionActive: false, listingSession: null };
}

export function beginTradeSession(flags: WorldStateFlags, event?: TradeEvent | null): WorldStateFlags {
  return {
    ...flags,
    tradeRequested: true,
    tradeEvent: event ?? flags.tradeEvent,
  };
}

export function endTradeSession(flags: WorldStateFlags): WorldStateFlags {
  return { ...flags, tradeRequested: false, tradeSession: null };
}

export function moduleForState(state: AutomationStateId): ModuleId | undefined {
  return STATE_MODULE[state];
}

export function clearInFlightStep(flags: WorldStateFlags, module: ModuleId | undefined): WorldStateFlags {
  if (module === "loot") {
    return { ...flags, pendingLootPickup: null };
  }
  if (module === "stash") {
    return { ...flags, pendingStashTransfer: null };
  }
  if (module === "listing") {
    return { ...flags, pendingListingHistory: null };
  }
  if (module === "trade") {
    return { ...flags, pendingTradeSessionWrite: null };
  }
  return flags;
}

function lootIdFromDecision(decision: BotDecision, world: WorldState, click: InputAction): string | undefined {
  const fromEvidence = decision.evidenceIds.find((id) => id.startsWith("loot:"));
  if (fromEvidence !== undefined) {
    return fromEvidence.slice("loot:".length);
  }
  const pickMatch = /pick:([^;]+)/.exec(decision.reason);
  if (pickMatch?.[1] !== undefined) {
    return pickMatch[1];
  }
  if (click.type !== "mouse-click") {
    return undefined;
  }
  return world.loot.value.find(
    (item) => item.screenPoint.x === click.x && item.screenPoint.y === click.y,
  )?.id;
}

export function applyOrchestratorDecisionEffects(
  world: WorldState,
  decision: BotDecision,
  nowMs: number,
): WorldState {
  let flags = { ...world.flags };

  if (
    world.inventory.value.full &&
    (decision.module === "inventory" ||
      decision.state === "InventoryFull" ||
      world.selectedState === "InventoryFull")
  ) {
    flags = beginStashSession(flags);
  }

  const click = decision.intendedActions.find((action) => action.type === "mouse-click");
  if (decision.module === "loot" && click !== undefined) {
    const id = lootIdFromDecision(decision, world, click);
    if (id !== undefined) {
      flags = {
        ...flags,
        pendingLootPickup: {
          id,
          occupancy: world.inventory.value.occupied,
          clickedAtMs: nowMs,
        },
        lootLastAttemptMs: { ...(flags.lootLastAttemptMs ?? {}), [id]: nowMs },
      };
    }
  }

  if (decision.suppressTargetIds !== undefined && decision.suppressTargetIds.length > 0) {
    const until = nowMs + (DEFAULT_RECOVERY[LOOT_RECOVERY_KEY]?.suppressMs ?? 15_000);
    flags = { ...flags, lootSuppressedUntilMs: { ...(flags.lootSuppressedUntilMs ?? {}) } };
    for (const id of decision.suppressTargetIds) {
      flags.lootSuppressedUntilMs = { ...flags.lootSuppressedUntilMs, [id]: until };
    }
  }

  flags = {
    ...flags,
    ...stashEffectsFromDecision({ ...world, flags }, decision, nowMs),
    ...listingEffectsFromDecision({ ...world, flags }, decision, nowMs),
    ...tradeEffectsFromDecision({ ...world, flags }, decision, nowMs),
  };

  return { ...world, flags };
}
