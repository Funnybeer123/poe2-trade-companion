import { createFixtureDesirabilityScorer } from "../items/fixtureDesirabilityScorer.js";
import type { DesirabilityPort } from "../items/desirabilityPort.js";
import type { AutomationScenario } from "../scheduler/types.js";
import type { LootTarget, WorldState } from "../world-state/types.js";
import { DEFAULT_LOOT_MIN_SCORE, SKIP_BELOW_MIN_SCORE, SKIP_INVENTORY_FULL } from "./skipReasons.js";

export function resolveLootMinScore(scenario: AutomationScenario): number {
  return typeof scenario.lootMinScore === "number" && Number.isFinite(scenario.lootMinScore)
    ? scenario.lootMinScore
    : DEFAULT_LOOT_MIN_SCORE;
}

export function isAdversarialScenario(scenario: AutomationScenario): boolean {
  return scenario.lowConfidencePolicy === "adversarial-execute";
}

export function annotateLootTargets(
  items: LootTarget[],
  scenario: AutomationScenario,
  options: {
    inventoryFull?: boolean;
    port?: DesirabilityPort;
  } = {},
): LootTarget[] {
  const port = options.port ?? createFixtureDesirabilityScorer();
  const minScore = resolveLootMinScore(scenario);
  const adversarial = isAdversarialScenario(scenario);
  const inventoryFull = options.inventoryFull === true;

  return items.map((item) => {
    const scored = port.score(item, { scenario });
    const next: LootTarget = { ...item, score: scored.score };
    if (next.skipReason !== undefined) {
      return next;
    }
    if (inventoryFull) {
      return { ...next, skipReason: SKIP_INVENTORY_FULL };
    }
    if (!adversarial && scored.score < minScore) {
      return { ...next, skipReason: SKIP_BELOW_MIN_SCORE };
    }
    return next;
  });
}

export function annotateLoot(
  world: WorldState,
  scenario: AutomationScenario,
  port?: DesirabilityPort,
): WorldState {
  if (world.loot.value.length === 0) {
    return world;
  }
  return {
    ...world,
    loot: {
      ...world.loot,
      value: annotateLootTargets(world.loot.value, scenario, {
        inventoryFull: world.inventory.value.full,
        port,
      }),
    },
  };
}
