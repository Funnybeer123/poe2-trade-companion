import type { LootTarget } from "../world-state/types.js";
import { clampDesirabilityScore, isLootTarget, type DesirabilityPort } from "./desirabilityPort.js";
import type { DesirabilityContext } from "./desirabilityPort.js";
import type { DesirabilityCategory, DesirabilityFactor, DesirabilityResult, NormalizedItem } from "./types.js";

interface KeywordRule {
  id: string;
  pattern: RegExp;
  score: number;
  category: DesirabilityCategory;
  detail: string;
}

const KEYWORD_RULES: KeywordRule[] = [
  {
    id: "mirror",
    pattern: /\bmirror(\s+of\s+kalandra)?\b/i,
    score: 100,
    category: "HighValueSell",
    detail: "Mirror-tier currency",
  },
  {
    id: "divine",
    pattern: /\bdivine(\s+orb)?\b/i,
    score: 95,
    category: "HighValueSell",
    detail: "Divine Orb",
  },
  {
    id: "perfect-jeweller",
    pattern: /\bperfect\s+jeweller/i,
    score: 88,
    category: "HighValueSell",
    detail: "Perfect Jeweller",
  },
  {
    id: "exalted",
    pattern: /\bexalted(\s+orb)?\b/i,
    score: 80,
    category: "HighValueSell",
    detail: "Exalted Orb",
  },
  {
    id: "greater-jeweller",
    pattern: /\bgreater\s+jeweller/i,
    score: 75,
    category: "Sell",
    detail: "Greater Jeweller",
  },
  {
    id: "chaos",
    pattern: /\bchaos(\s+orb)?\b/i,
    score: 50,
    category: "BulkCommodity",
    detail: "Chaos Orb",
  },
  {
    id: "waystone",
    pattern: /\bwaystone\b/i,
    score: 42,
    category: "KeepUse",
    detail: "Waystone",
  },
  {
    id: "wisdom-portal",
    pattern: /\b(scroll of wisdom|wisdom scroll|portal scroll|scroll of portal)\b/i,
    score: 10,
    category: "Dump",
    detail: "Vendor scroll",
  },
  {
    id: "transmute-augment",
    pattern: /\b(transmut|augment|alchemy|chance|whetstone|armourer)/i,
    score: 15,
    category: "VendorLowValue",
    detail: "Low-tier currency",
  },
];

const RARITY_RULES: Array<{ id: string; rarity: string; score: number; category: DesirabilityCategory }> =
  [
    { id: "rarity-unique", rarity: "unique", score: 70, category: "KeepUse" },
    { id: "rarity-currency", rarity: "currency", score: 60, category: "BulkCommodity" },
    { id: "rarity-rare", rarity: "rare", score: 55, category: "Sell" },
    { id: "rarity-magic", rarity: "magic", score: 25, category: "VendorLowValue" },
    { id: "rarity-normal", rarity: "normal", score: 5, category: "Dump" },
    { id: "rarity-white", rarity: "white", score: 5, category: "Dump" },
  ];

function searchText(item: NormalizedItem | LootTarget): string {
  if (isLootTarget(item)) {
    return [item.labelText, item.rarityCue, item.id].filter(Boolean).join(" ");
  }
  return [item.name, item.base, item.class, item.rarity, item.fingerprint].filter(Boolean).join(" ");
}

function rarityOf(item: NormalizedItem | LootTarget): string | undefined {
  if (isLootTarget(item)) {
    return item.rarityCue?.toLowerCase();
  }
  return item.rarity?.toLowerCase();
}

function matchKeyword(text: string): KeywordRule | undefined {
  return KEYWORD_RULES.find((rule) => rule.pattern.test(text));
}

function matchRarity(rarity: string | undefined): (typeof RARITY_RULES)[number] | undefined {
  if (rarity === undefined) {
    return undefined;
  }
  return RARITY_RULES.find((rule) => rarity === rule.rarity || rarity.includes(rule.rarity));
}

export class FixtureDesirabilityScorer implements DesirabilityPort {
  score(item: NormalizedItem | LootTarget, _ctx: DesirabilityContext): DesirabilityResult {
    const text = searchText(item);
    const keyword = matchKeyword(text);
    const rarity = matchRarity(rarityOf(item));
    const explicitScore = isLootTarget(item) && typeof item.score === "number" ? item.score : undefined;
    const factors: DesirabilityFactor[] = [];

    if (explicitScore !== undefined) {
      factors.push({
        id: "fixture-score",
        weight: 1,
        contribution: explicitScore,
        detail: "Caller-supplied fixture score",
      });
    }
    if (keyword !== undefined) {
      factors.push({
        id: keyword.id,
        weight: explicitScore === undefined ? 1 : 0.25,
        contribution: keyword.score,
        detail: keyword.detail,
      });
    }
    if (rarity !== undefined) {
      factors.push({
        id: rarity.id,
        weight: keyword === undefined && explicitScore === undefined ? 1 : 0.15,
        contribution: rarity.score,
        detail: `Rarity cue ${rarity.rarity}`,
      });
    }

    const raw = explicitScore ?? keyword?.score ?? rarity?.score ?? 0;
    const score = clampDesirabilityScore(raw);
    const category = keyword?.category ?? rarity?.category ?? (score === 0 ? "ManualReview" : "Dump");
    const reasons: string[] = [];
    if (explicitScore !== undefined) {
      reasons.push(`fixture-score:${String(explicitScore)}`);
    }
    if (keyword !== undefined) {
      reasons.push(`keyword:${keyword.id}`);
    }
    if (rarity !== undefined) {
      reasons.push(`rarity:${rarity.rarity}`);
    }
    if (reasons.length === 0) {
      reasons.push("unscored-label");
    }

    return { score, category, factors, reasons };
  }
}

export function createFixtureDesirabilityScorer(): FixtureDesirabilityScorer {
  return new FixtureDesirabilityScorer();
}
