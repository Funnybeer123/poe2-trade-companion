import {
  isLostTargetExhausted,
  isStuckExhausted,
} from "../navigation/estimateNavigation.js";
import { DEFAULT_HIGH_VALUE_INTERRUPT_SCORE } from "../world-state/createEmptyWorldState.js";
import type {
  AutomationStateId,
  LootTarget,
  ModuleId,
  WorldState,
} from "../world-state/types.js";
import type { AutomationScenario } from "./types.js";

export const STATE_MODULE: Partial<Record<AutomationStateId, ModuleId>> = {
  TradeSession: "trade",
  InventoryFull: "stash",
  HighValueLoot: "loot",
  Listing: "listing",
  StashSort: "stash",
  LootPickup: "loot",
  Follow: "follow",
  RecoverTarget: "follow",
};

const ACTION_STATES: AutomationStateId[] = [
  "TradeSession",
  "InventoryFull",
  "HighValueLoot",
  "Listing",
  "StashSort",
  "LootPickup",
  "Follow",
  "RecoverTarget",
];

export function isModuleEnabledForState(
  state: AutomationStateId,
  scenario: AutomationScenario,
): boolean {
  const moduleId = STATE_MODULE[state];
  if (moduleId === undefined) {
    return true;
  }
  return scenario.enabledModules.includes(moduleId);
}

export function highValueInterruptScore(world: WorldState): number {
  const score = world.flags?.highValueInterruptScore;
  if (typeof score === "number" && Number.isFinite(score)) {
    return score;
  }
  return DEFAULT_HIGH_VALUE_INTERRUPT_SCORE;
}

export function lootTargets(world: WorldState): LootTarget[] {
  return world.loot?.value ?? [];
}

export function isTradeActive(world: WorldState): boolean {
  return world.flags?.tradeRequested === true || world.trade?.value?.open === true;
}

export function isInventoryFull(world: WorldState): boolean {
  return world.inventory?.value?.full === true;
}

export function hasHighValueLoot(world: WorldState): boolean {
  const threshold = highValueInterruptScore(world);
  return lootTargets(world).some(
    (item) => item.skipReason === undefined && (item.score ?? 0) >= threshold,
  );
}

export function hasPickupLoot(world: WorldState): boolean {
  return lootTargets(world).some((item) => item.skipReason === undefined);
}

export function isProcessAllowlisted(world: WorldState): boolean {
  return (
    world.process?.freshness !== "missing" && world.process?.value?.allowlisted === true
  );
}

export function isTargetAcquired(world: WorldState, scenario: AutomationScenario): boolean {
  const target = world.target;
  if (!target || target.freshness === "missing" || target.value === null) {
    return false;
  }
  return target.confidence >= scenario.confidenceThreshold;
}

export function isTargetMissingOrLowConfidence(
  world: WorldState,
  scenario: AutomationScenario,
): boolean {
  return !isTargetAcquired(world, scenario);
}

export function evaluateInterruptWhen(when: string, world: WorldState): boolean {
  switch (when) {
    case "always":
      return true;
    case "trade-active":
      return isTradeActive(world);
    case "inventory-full":
      return isInventoryFull(world);
    case "loot-above-interrupt-threshold":
      return hasHighValueLoot(world);
    case "stash-session-active":
      return world.flags?.stashSessionActive === true;
    case "listing-session-active":
      return world.flags?.listingSessionActive === true;
    default:
      return false;
  }
}

function hasLowConfidenceBlockedWork(world: WorldState, scenario: AutomationScenario): boolean {
  const threshold = scenario.confidenceThreshold;
  const targetLow =
    world.target?.freshness !== "missing" &&
    world.target?.value !== null &&
    (world.target?.confidence ?? 0) < threshold;
  const lootLow =
    lootTargets(world).length > 0 && (world.loot?.confidence ?? 0) < threshold;
  return targetLow || lootLow;
}

function hasEligibleActionAlternative(
  world: WorldState,
  scenario: AutomationScenario,
): boolean {
  return ACTION_STATES.some(
    (state) =>
      isModuleEnabledForState(state, scenario) && isPredicateTrue(state, world, scenario),
  );
}

export function isPredicateTrue(
  state: AutomationStateId,
  world: WorldState,
  scenario: AutomationScenario,
): boolean {
  switch (state) {
    case "EmergencyStop":
      return world.flags?.emergencyStopLatched === true;
    case "SafetyHold":
      if (world.flags?.stashSafetyHold === true) {
        return true;
      }
      if (isStuckExhausted(world.stuck?.value ?? { isStuck: false })) {
        return true;
      }
      if (!isProcessAllowlisted(world)) {
        return true;
      }
      return (
        scenario.lowConfidencePolicy === "skip" &&
        hasLowConfidenceBlockedWork(world, scenario) &&
        !hasEligibleActionAlternative(world, scenario)
      );
    case "TradeSession":
      return isTradeActive(world);
    case "InventoryFull":
      return isInventoryFull(world);
    case "HighValueLoot":
      return hasHighValueLoot(world);
    case "Listing":
      return world.flags?.listingSessionActive === true;
    case "StashSort":
      return world.flags?.stashSessionActive === true;
    case "LootPickup":
      return hasPickupLoot(world);
    case "Follow":
      return isTargetAcquired(world, scenario);
    case "RecoverTarget":
      return (
        isTargetMissingOrLowConfidence(world, scenario) &&
        !isLostTargetExhausted(world.stuck?.value ?? { isStuck: false })
      );
    case "Idle":
      return true;
    default:
      return false;
  }
}

export function isStateEligible(
  state: AutomationStateId,
  world: WorldState,
  scenario: AutomationScenario,
): boolean {
  if (state === "EmergencyStop") {
    return isPredicateTrue(state, world, scenario);
  }
  if (state === "SafetyHold") {
    return isPredicateTrue(state, world, scenario);
  }
  if (state === "Idle") {
    return true;
  }
  if (!scenario.enabled) {
    return false;
  }
  return isModuleEnabledForState(state, scenario) && isPredicateTrue(state, world, scenario);
}

export function eligibilityReason(state: AutomationStateId, world: WorldState): string {
  switch (state) {
    case "EmergencyStop":
      return "emergency-stop-latched";
    case "SafetyHold":
      if (world.flags?.stashSafetyHold === true) {
        return "FailedOrTimedOut";
      }
      if (isStuckExhausted(world.stuck?.value ?? { isStuck: false })) {
        return "stuck-exhausted";
      }
      return isProcessAllowlisted(world)
        ? "safety-hold-low-confidence-skip"
        : "safety-hold-process-not-allowlisted";
    case "TradeSession":
      return "trade-session-active";
    case "InventoryFull":
      return "inventory-full";
    case "HighValueLoot":
      return "high-value-loot";
    case "Listing":
      return "listing-session-active";
    case "StashSort":
      return "stash-session-active";
    case "LootPickup":
      return "loot-pickup-available";
    case "Follow":
      return "follow-target-acquired";
    case "RecoverTarget":
      return "recover-target";
    case "Idle":
      return "idle";
    default:
      return "idle";
  }
}
