import type { ItemDecision } from "./itemDecision.js";
import type { DesirabilityResult, NormalizedItem, RecommendationCategory, ValuationResult } from "./types.js";
import type { TierVerdict } from "./valueTiers.js";

export interface DesirabilityPrefs {
  minScoreToKeep: number;
  preferItemClasses: string[];
}

const DEFAULT_PREFS: DesirabilityPrefs = {
  minScoreToKeep: 55,
  preferItemClasses: [],
};

/** The recommendation category a decision outcome maps to (routing tabs share the names). */
export function categoryForDecision(decision: ItemDecision): RecommendationCategory {
  switch (decision.outcome) {
    case "keep":
      return decision.craft ? "craft" : "keep";
    case "list":
      return "sell";
    case "discard-eligible":
      return "dump";
    default:
      return "review";
  }
}

export function scoreDesirability(
  item: NormalizedItem,
  valuation: ValuationResult,
  prefs: DesirabilityPrefs = DEFAULT_PREFS,
  /** The tier verdict; when it carries a decision, the category follows it. */
  verdict?: TierVerdict,
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
  // Craft outranks vendor: a 4-mod rare that misses the sell bar is crafting
  // stock, not vendor trash. (Checked before the score-40 vendor floor —
  // rarity bonuses used to push every multi-mod rare past it, making the
  // craft category unreachable.)
  else if (item.mods.length >= 4) category = "craft";
  else if (score >= 40) category = "vendor";
  else if (item.rarity === "Currency") category = "bulk";

  // The decision (rules, saved prices, build demand, craft case, audit)
  // outranks the generic score: the recommendation shown must agree with
  // what triage actually does.
  const decision = verdict?.decision;
  if (decision) {
    category = categoryForDecision(decision);
    reasons.unshift(decision.headline);
    if (decision.demand) {
      reasons.push(`General demand (not a price): ${decision.demand.label} — ${decision.demand.builds.join(", ") || "curated"}.`);
    }
  }

  // Saved observations protect an item independently of the generic score.
  // This also applies when an old/conflicting lesson has no current quote.
  if (Number(valuation.normalizedKeyStats.trainedExampleCount) > 0) {
    category = "keep";
    reasons.unshift("Saved price evidence: keep for review; the score does not override your correction.");
  }

  return { score, category, reasons };
}
