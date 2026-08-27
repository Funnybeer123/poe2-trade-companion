import type { DesirabilityResult, NormalizedItem, RecommendationCategory, ValuationResult } from "./types.js";

export interface DesirabilityPrefs {
  minScoreToKeep: number;
  preferItemClasses: string[];
}

const DEFAULT_PREFS: DesirabilityPrefs = {
  minScoreToKeep: 55,
  preferItemClasses: [],
};

export function scoreDesirability(
  item: NormalizedItem,
  valuation: ValuationResult,
  prefs: DesirabilityPrefs = DEFAULT_PREFS,
): DesirabilityResult {
  const reasons: string[] = [];
  let score = 20;
  if (item.rarity === "Unique") {
    score += 25;
    reasons.push("unique rarity");
  } else if (item.rarity === "Rare") {
    score += 15;
    reasons.push("rare rarity");
  }
  if ((item.itemLevel ?? 0) >= 80) {
    score += 10;
    reasons.push("high item level");
  }
  score += Math.min(20, item.mods.length * 3);
  if (item.mods.length > 0) reasons.push(`${item.mods.length} explicit mods`);
  if (valuation.fair >= 10) {
    score += 15;
    reasons.push("strong fair market value");
  } else if (valuation.fair >= 1) {
    score += 8;
    reasons.push("positive market value");
  }
  if (valuation.confidence === "high") score += 8;
  if (prefs.preferItemClasses.includes(item.itemClass)) {
    score += 10;
    reasons.push("preferred item class");
  }
  score = Math.max(0, Math.min(100, score));

  let category: RecommendationCategory = "dump";
  if (score >= 80) category = "keep";
  else if (score >= prefs.minScoreToKeep) category = "sell";
  else if (score >= 40) category = "vendor";
  else if (item.mods.length >= 4) category = "craft";
  else if (item.rarity === "Currency") category = "bulk";

  return { score, category, reasons };
}
