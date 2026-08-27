import type { LootTarget } from "../world-state/types.js";
import { clampDesirabilityScore, isLootTarget, type DesirabilityPort } from "./desirabilityPort.js";
import type { DesirabilityContext } from "./desirabilityPort.js";
import type {
  DesirabilityCategory,
  DesirabilityFactor,
  DesirabilityResult,
  MarketQuote,
  NormalizedItem,
} from "./types.js";

const NAME_SCORES: Array<{ pattern: RegExp; score: number; category: DesirabilityCategory; id: string }> =
  [
    { id: "mirror", pattern: /\bmirror(\s+of\s+kalandra)?\b/i, score: 100, category: "HighValueSell" },
    { id: "divine", pattern: /\bdivine(\s+orb)?\b/i, score: 95, category: "HighValueSell" },
    { id: "perfect-jeweller", pattern: /\bperfect\s+jeweller/i, score: 88, category: "HighValueSell" },
    { id: "exalted", pattern: /\bexalted(\s+orb)?\b/i, score: 80, category: "HighValueSell" },
    { id: "greater-jeweller", pattern: /\bgreater\s+jeweller/i, score: 75, category: "Sell" },
    { id: "chaos", pattern: /\bchaos(\s+orb)?\b/i, score: 50, category: "BulkCommodity" },
    { id: "waystone", pattern: /\bwaystone\b/i, score: 42, category: "KeepUse" },
  ];

const RARITY_SCORES: Record<string, { score: number; category: DesirabilityCategory }> = {
  unique: { score: 70, category: "KeepUse" },
  currency: { score: 55, category: "BulkCommodity" },
  rare: { score: 50, category: "Sell" },
  magic: { score: 22, category: "VendorLowValue" },
  normal: { score: 8, category: "Dump" },
  gem: { score: 40, category: "KeepUse" },
};

function searchText(item: NormalizedItem): string {
  return [item.name, item.base, item.class, item.rarity].filter(Boolean).join(" ");
}

function marketScore(quote: MarketQuote | undefined): { score: number; detail: string } | undefined {
  if (quote === undefined || quote.fair === undefined) {
    return undefined;
  }
  if (quote.confidence === "none") {
    return undefined;
  }
  const fair = quote.fair;
  if (fair >= 10) {
    return { score: 96, detail: `fair=${String(fair)} ${quote.currency}` };
  }
  if (fair >= 2) {
    return { score: 88, detail: `fair=${String(fair)} ${quote.currency}` };
  }
  if (fair >= 0.5) {
    return { score: 70, detail: `fair=${String(fair)} ${quote.currency}` };
  }
  if (fair >= 0.15) {
    return { score: 45, detail: `fair=${String(fair)} ${quote.currency}` };
  }
  return { score: 18, detail: `fair=${String(fair)} ${quote.currency}` };
}

function categoryFromScore(
  score: number,
  hint?: DesirabilityCategory,
  quote?: MarketQuote,
): DesirabilityCategory {
  if (quote?.confidence === "none" || quote?.confidence === "low") {
    if (score < 40) {
      return "ManualReview";
    }
  }
  if (hint !== undefined && score >= 80) {
    return hint;
  }
  if (score >= 85) {
    return "HighValueSell";
  }
  if (score >= 60) {
    return "Sell";
  }
  if (score >= 40) {
    return "BulkCommodity";
  }
  if (score >= 20) {
    return "VendorLowValue";
  }
  if (score === 0) {
    return "ManualReview";
  }
  return "Dump";
}

export class DesirabilityEngine implements DesirabilityPort {
  score(item: NormalizedItem | LootTarget, ctx: DesirabilityContext): DesirabilityResult {
    if (isLootTarget(item)) {
      return {
        score: 0,
        category: "ManualReview",
        factors: [],
        reasons: ["engine-requires-normalized-item"],
      };
    }
    return this.scoreNormalized(item, ctx);
  }

  scoreNormalized(item: NormalizedItem, ctx: DesirabilityContext): DesirabilityResult {
    const factors: DesirabilityFactor[] = [];
    const reasons: string[] = [];
    const text = searchText(item);
    const nameRule = NAME_SCORES.find((rule) => rule.pattern.test(text));
    const rarity = item.rarity?.toLowerCase();
    const rarityRule = rarity !== undefined ? RARITY_SCORES[rarity] : undefined;
    const market = marketScore(ctx.quote);

    if (item.unidentified === true) {
      factors.push({
        id: "unidentified",
        weight: 1,
        contribution: 15,
        detail: "Unidentified item",
      });
      reasons.push("unidentified");
      return {
        score: 15,
        category: "ManualReview",
        factors,
        reasons,
      };
    }

    let raw = 0;
    let hint: DesirabilityCategory | undefined;

    if (nameRule !== undefined) {
      factors.push({
        id: `name:${nameRule.id}`,
        weight: 1,
        contribution: nameRule.score,
        detail: nameRule.id,
      });
      reasons.push(`name:${nameRule.id}`);
      raw = nameRule.score;
      hint = nameRule.category;
    } else if (rarityRule !== undefined) {
      factors.push({
        id: `rarity:${rarity}`,
        weight: 1,
        contribution: rarityRule.score,
        detail: `rarity ${rarity}`,
      });
      reasons.push(`rarity:${rarity}`);
      raw = rarityRule.score;
      hint = rarityRule.category;
    }

    if (rarityRule !== undefined && nameRule !== undefined) {
      factors.push({
        id: `rarity:${rarity}`,
        weight: 0.2,
        contribution: rarityRule.score,
        detail: `rarity ${rarity}`,
      });
      reasons.push(`rarity:${rarity}`);
    }

    if (market !== undefined) {
      const marketWeight = ctx.quote?.confidence === "high" ? 1 : 0.7;
      factors.push({
        id: "market-fair",
        weight: marketWeight,
        contribution: market.score,
        detail: market.detail,
      });
      reasons.push(`market:${ctx.quote?.providerId ?? "unknown"}:${ctx.quote?.confidence ?? "none"}`);
      raw = market.score;
      if (nameRule !== undefined && nameRule.score > raw) {
        raw = nameRule.score;
      }
    }

    if (item.corrupted === true) {
      factors.push({
        id: "corrupted",
        weight: 0.1,
        contribution: -4,
        detail: "Corrupted",
      });
      reasons.push("corrupted");
      raw -= 4;
    }

    if (ctx.quote?.confidence === "none" || ctx.quote?.confidence === "low") {
      reasons.push(`quote-${ctx.quote.confidence}`);
    }

    if (reasons.length === 0) {
      reasons.push("unscored-item");
    }

    const score = clampDesirabilityScore(raw);
    return {
      score,
      category: categoryFromScore(score, hint, ctx.quote),
      factors,
      reasons,
    };
  }
}

export function createDesirabilityEngine(): DesirabilityEngine {
  return new DesirabilityEngine();
}
