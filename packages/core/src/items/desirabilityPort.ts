import type { AutomationScenario } from "../scheduler/types.js";
import type { LootTarget } from "../world-state/types.js";
import type { DesirabilityResult, MarketQuote, NormalizedItem } from "./types.js";

export interface DesirabilityContext {
  scenario: AutomationScenario;
  quote?: MarketQuote;
}

export interface DesirabilityPort {
  score(item: NormalizedItem | LootTarget, ctx: DesirabilityContext): DesirabilityResult;
}

export function isLootTarget(item: NormalizedItem | LootTarget): item is LootTarget {
  return "screenPoint" in item && "id" in item && typeof item.id === "string";
}

export function clampDesirabilityScore(score: number): number {
  if (!Number.isFinite(score)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(score)));
}
