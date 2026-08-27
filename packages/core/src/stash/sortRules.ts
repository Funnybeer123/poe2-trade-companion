import type { DesirabilityCategory } from "../items/types.js";
import type { StashItemMeta } from "../world-state/types.js";
import type { SortRule } from "./types.js";

/** Product-spec default destinations: Currency, Waystones, Uniques, High-Value Sell, Normal Sell, Crafting, Bulk, Dump, Vendor. */
export const DEFAULT_SORT_RULES: SortRule[] = [
  {
    id: "currency-class",
    bucket: "Currency",
    tabId: "currency",
    fallbackTabId: "dump",
    match: { class: ["Currency", "Stackable Currency"] },
  },
  {
    id: "waystone-class",
    bucket: "Waystones",
    tabId: "waystones",
    fallbackTabId: "dump",
    match: { class: ["Waystone", "Waystones", "Tablet"] },
  },
  {
    id: "unique-rarity",
    bucket: "Uniques",
    tabId: "uniques",
    fallbackTabId: "high-value-sell",
    match: { rarity: ["unique"] },
  },
  {
    id: "high-value-sell",
    bucket: "HighValueSell",
    tabId: "high-value-sell",
    fallbackTabId: "normal-sell",
    match: { category: ["HighValueSell"] },
  },
  {
    id: "normal-sell",
    bucket: "NormalSell",
    tabId: "normal-sell",
    fallbackTabId: "dump",
    match: { category: ["Sell"] },
  },
  {
    id: "crafting",
    bucket: "Crafting",
    tabId: "crafting",
    fallbackTabId: "dump",
    match: { category: ["CraftCandidate"] },
  },
  {
    id: "bulk",
    bucket: "Bulk",
    tabId: "bulk",
    fallbackTabId: "dump",
    match: { category: ["BulkCommodity"] },
  },
  {
    id: "vendor",
    bucket: "Vendor",
    tabId: "vendor",
    fallbackTabId: "dump",
    match: { category: ["VendorLowValue"] },
  },
  {
    id: "dump",
    bucket: "Dump",
    tabId: "dump",
    match: { category: ["Dump"] },
  },
];

function normalize(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase();
}

function matchesList(value: string | undefined, list: string[] | undefined): boolean {
  if (list === undefined || list.length === 0) {
    return true;
  }
  const needle = normalize(value);
  if (needle === undefined) {
    return false;
  }
  return list.some((entry) => normalize(entry) === needle);
}

export function ruleMatches(rule: SortRule, item: StashItemMeta): boolean {
  const categoryOk = matchesList(item.category, rule.match.category as string[] | undefined);
  const classOk = matchesList(item.class, rule.match.class);
  const rarityOk = matchesList(item.rarity, rule.match.rarity);
  const hasConstraint =
    (rule.match.category?.length ?? 0) > 0 ||
    (rule.match.class?.length ?? 0) > 0 ||
    (rule.match.rarity?.length ?? 0) > 0;
  if (!hasConstraint) {
    return false;
  }
  if (rule.match.category !== undefined && rule.match.category.length > 0 && !categoryOk) {
    return false;
  }
  if (rule.match.class !== undefined && rule.match.class.length > 0 && !classOk) {
    return false;
  }
  if (rule.match.rarity !== undefined && rule.match.rarity.length > 0 && !rarityOk) {
    return false;
  }
  return true;
}

export function matchSortRule(
  item: StashItemMeta,
  rules: readonly SortRule[] = DEFAULT_SORT_RULES,
): SortRule | undefined {
  return rules.find((rule) => ruleMatches(rule, item));
}

export function categoryForBucket(bucket: SortRule["bucket"]): DesirabilityCategory | undefined {
  switch (bucket) {
    case "HighValueSell":
      return "HighValueSell";
    case "NormalSell":
      return "Sell";
    case "Crafting":
      return "CraftCandidate";
    case "Bulk":
      return "BulkCommodity";
    case "Vendor":
      return "VendorLowValue";
    case "Dump":
      return "Dump";
    default:
      return undefined;
  }
}
