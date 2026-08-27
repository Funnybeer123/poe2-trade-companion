import type { CatalogItem, DesirabilityResult, NormalizedItem, ObservedInventoryState, ObservedStashState, SortRecommendation, ValuationResult } from "./types.js";

export function toCatalogItem(
  item: NormalizedItem,
  location: string,
  desirability?: DesirabilityResult,
  valuation?: ValuationResult,
): CatalogItem {
  return {
    fingerprint: item.fingerprint,
    name: item.name,
    baseType: item.baseType,
    itemClass: item.itemClass,
    location,
    recommendation: desirability?.category,
    fairValue: valuation?.fair,
  };
}

export function searchCatalog(
  items: CatalogItem[],
  query: {
    text?: string;
    recommendation?: string;
    tab?: string;
    minValue?: number;
    maxValue?: number;
  },
): CatalogItem[] {
  const needle = query.text?.toLowerCase();
  return items.filter((item) => {
    if (needle && !`${item.name} ${item.baseType} ${item.itemClass}`.toLowerCase().includes(needle)) return false;
    if (query.recommendation && item.recommendation !== query.recommendation) return false;
    if (query.tab && !item.location.includes(query.tab)) return false;
    if (query.minValue !== undefined && (item.fairValue ?? 0) < query.minValue) return false;
    if (query.maxValue !== undefined && (item.fairValue ?? Number.POSITIVE_INFINITY) > query.maxValue) return false;
    return true;
  });
}

export function planSort(
  items: CatalogItem[],
  tabByCategory: Record<string, string>,
): SortRecommendation[] {
  return items.map((item) => {
    const category = item.recommendation ?? "dump";
    return {
      fingerprint: item.fingerprint,
      destinationTab: tabByCategory[category] ?? "dump",
      category,
      reason: `route ${category} to ${tabByCategory[category] ?? "dump"}`,
    };
  });
}

export function reconcileInventory(
  previous: ObservedInventoryState | undefined,
  next: ObservedInventoryState,
): ObservedInventoryState {
  if (!previous) return next;
  const stale = next.capturedAt < previous.capturedAt;
  return { ...next, stale };
}

export function reconcileStash(
  previous: ObservedStashState | undefined,
  next: ObservedStashState,
): ObservedStashState {
  if (!previous) return next;
  return { ...next, stale: next.capturedAt < previous.capturedAt };
}
