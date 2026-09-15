/**
 * Value tiers: the decision layer that says what an item is worth doing
 * something about, without trusting ValuationResult numbers — only the
 * user-owned price table (fed by poe2scout) and explicit rules.
 *
 * Three rule buckets drive triage:
 *   keep  — pull aside for review/selling (high value);
 *   sell  — worth listing but not exciting;
 *   dump  — vendor trash.
 * Anything that matches nothing is "unknown" and is routed normally.
 *
 * Safety invariants enforced here, not left to callers:
 *   - unparseable text never dumps;
 *   - unidentified items never dump (they are exactly the items worth
 *     reviewing);
 *   - a price-table hit outranks rules, and keep outranks sell outranks dump.
 */

import { looksLikePoeItemText, parseItemText } from "./parseItem.js";
import {
  isFloorEntry,
  lookupPrice,
  type PriceTable,
} from "./priceTable.js";
import {
  matchItemsAgainstText,
  validateRuleRegex,
  type ScanHistoryItem,
} from "./scanRules.js";
import type { ItemAppraisal } from "./appraisal.js";
import type { ItemDecision } from "./itemDecision.js";
import type { ParsedItem } from "./types.js";
import type { TrainingPriceEstimate } from "./priceTraining.js";

export const VALUE_TIER_SCHEMA_VERSION = 1 as const;

/** rule_sets.kind used to persist tier buckets. */
export const VALUE_TIER_RULE_SET_KIND = "value-tier";

export type ValueTierId = "keep" | "sell" | "dump";
export type TriageTier = ValueTierId | "unknown";

export const VALUE_TIER_IDS: readonly ValueTierId[] = ["keep", "sell", "dump"];

export interface ValueTierRules {
  keep: ScanHistoryItem[];
  sell: ScanHistoryItem[];
  dump: ScanHistoryItem[];
}

export interface ValueTierThresholds {
  /** Price-table value at or above which an item is a keep. */
  keepAtOrAbove: number;
  /** Price-table value at or above which an item is at least a sell. */
  sellAtOrAbove: number;
}

export const DEFAULT_TIER_THRESHOLDS: ValueTierThresholds = {
  keepAtOrAbove: 5,
  sellAtOrAbove: 0.5,
};

export type TierVerdictSource =
  | "safety"
  | "price-table"
  | "rule"
  | "heuristic"
  | "training"
  /** Promoted by a curated build-demand pattern (itemDecision.ts). */
  | "demand"
  | "default";

export interface TierVerdict {
  tier: TriageTier;
  source: TierVerdictSource;
  reasons: string[];
  /** Names of the rules that matched, when source is "rule". */
  matchedRules: string[];
  /** Price-table value, when source is "price-table". */
  price?: number;
  currency?: string;
  /** Scored appraisal evidence, when evaluateWithAppraisal produced this. */
  appraisal?: ItemAppraisal;
  training?: TrainingPriceEstimate;
  /**
   * Set when a rarity- or class-wide price-table row decided the tier: a
   * floor for unreviewed items, never presented as this item's price.
   */
  priceFloor?: { id: string; value: number; currency: string };
  /** The keep / list / review / discard-eligible decision (evaluateItemDecision). */
  decision?: ItemDecision;
}

export interface EvaluateTierOptions {
  rules: ValueTierRules;
  priceTable?: PriceTable;
  thresholds?: ValueTierThresholds;
  /** Pre-parsed item, if the caller already has one, to skip re-parsing. */
  parsed?: ParsedItem;
}

export function emptyValueTierRules(): ValueTierRules {
  return { keep: [], sell: [], dump: [] };
}

function verdict(
  tier: TriageTier,
  source: TierVerdictSource,
  reasons: string[],
  extra: Partial<Pick<TierVerdict, "matchedRules" | "price" | "currency">> = {},
): TierVerdict {
  return {
    tier,
    source,
    reasons,
    matchedRules: extra.matchedRules ?? [],
    ...(extra.price !== undefined ? { price: extra.price } : {}),
    ...(extra.currency ? { currency: extra.currency } : {}),
  };
}

function matchBucket(
  itemText: string,
  rules: ScanHistoryItem[],
): string[] {
  if (rules.length === 0) return [];
  return matchItemsAgainstText(itemText, rules).map((rule) => rule.name);
}

/**
 * Decide an item's tier from raw copied text. Order of authority:
 * safety gates, then an exact price-table price (name or base), then
 * keep/sell/dump rules, then a rarity/class-wide price floor.
 */
export function evaluateValueTier(
  itemText: string,
  options: EvaluateTierOptions,
): TierVerdict {
  const text = itemText ?? "";
  if (!looksLikePoeItemText(text)) {
    return verdict("unknown", "safety", [
      "The text is not recognizable item text; it is never auto-dumped.",
    ]);
  }
  const parsed = options.parsed ?? parseItemText(text);
  if (!parsed.identified) {
    return verdict("keep", "safety", [
      "Unidentified items are always pulled aside for review, never dumped.",
    ]);
  }

  const thresholds = options.thresholds ?? DEFAULT_TIER_THRESHOLDS;
  const hit = options.priceTable
    ? lookupPrice(options.priceTable, {
        name: parsed.name,
        baseType: parsed.baseType,
        itemClass: parsed.itemClass,
        itemLevel: parsed.itemLevel,
        rarity: parsed.rarity,
      })
    : undefined;
  const floor = hit !== undefined && isFloorEntry(hit.entry.match);
  if (hit && !floor) {
    {
      const label = hit.entry.match.name ?? hit.entry.match.baseType ?? hit.entry.id;
      if (hit.value >= thresholds.keepAtOrAbove) {
        return verdict(
          "keep",
          "price-table",
          [`Price table values "${label}" at ${hit.value} ${hit.currency}.`],
          { price: hit.value, currency: hit.currency },
        );
      }
      if (hit.value >= thresholds.sellAtOrAbove) {
        return verdict(
          "sell",
          "price-table",
          [`Price table values "${label}" at ${hit.value} ${hit.currency}.`],
          { price: hit.value, currency: hit.currency },
        );
      }
      // A priced-but-cheap entry falls through to the rules: cheap currency
      // may still be a deliberate dump target.
    }
  }

  for (const tier of VALUE_TIER_IDS) {
    const matched = matchBucket(text, options.rules[tier]);
    if (matched.length > 0) {
      return verdict(tier, "rule", [
        `Matched ${tier} rule${matched.length > 1 ? "s" : ""}: ${matched.join(", ")}.`,
      ], { matchedRules: matched });
    }
  }

  // A floor row (rarity/class-wide) comes after the user's rules: it is a
  // placeholder for unreviewed items and never this item's price.
  if (hit && floor) {
    const tier: TriageTier | undefined =
      hit.value >= thresholds.keepAtOrAbove ? "keep" : hit.value >= thresholds.sellAtOrAbove ? "sell" : undefined;
    if (tier) {
      return {
        ...verdict(tier, "price-table", [
          `Price-table floor "${hit.entry.id}" (${hit.value} ${hit.currency}) applies to every ${parsed.rarity.toLowerCase()} item; it is a placeholder, not this item's price.`,
        ]),
        priceFloor: { id: hit.entry.id, value: hit.value, currency: hit.currency },
      };
    }
  }

  return verdict("unknown", "default", ["No tier rule matched; the item routes normally."]);
}

export interface ValueTierValidationIssue {
  tier: ValueTierId;
  index: number;
  message: string;
}

/** Validates every rule in every bucket without persisting anything. */
export function validateValueTierRules(rules: ValueTierRules): ValueTierValidationIssue[] {
  const issues: ValueTierValidationIssue[] = [];
  for (const tier of VALUE_TIER_IDS) {
    rules[tier].forEach((rule, index) => {
      const result = validateRuleRegex(rule.regex);
      if (!result.valid) {
        issues.push({
          tier,
          index,
          message: result.issues[0]?.message ?? "Invalid rule.",
        });
      }
    });
  }
  return issues;
}

/**
 * Starter buckets. These deliberately match broad, safe things; the point is
 * a working example the user edits, not a curated economy filter.
 */
export function starterValueTierRules(): ValueTierRules {
  return {
    keep: [
      { name: "Normal belt crafting bases", regex: '"^Item Class: Belts$" "^Rarity: Normal$" "^(Heavy|Utility) Belt$"' },
      { name: "Any unique", regex: '"Rarity: Unique"' },
      { name: "High elemental resist total", regex: '"TOTAL_ELE_RES >= 70"' },
      { name: "Triple resist", regex: '"ANY_RESIST >= 3"' },
    ],
    sell: [
      { name: "Double resist rare", regex: '"Rarity: Rare" "ANY_RESIST >= 2"' },
    ],
    dump: [
      { name: "Low-level normals", regex: '"Rarity: Normal"' },
    ],
  };
}
