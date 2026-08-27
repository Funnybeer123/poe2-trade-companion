import { locationKey, type ShadowItem } from "../inventory/types.js";
import type { GridCell, StashItemMeta } from "../world-state/types.js";
import { STASH_FALLBACK_TAB_FULL_REASON } from "./reasons.js";
import { DEFAULT_SORT_RULES, matchSortRule } from "./sortRules.js";
import {
  itemScore,
  type PlanStashTab,
  type SortRule,
  type TransferPlan,
  type TransferPlanStep,
} from "./types.js";

export interface TransferPlannerInput {
  inventory: ShadowItem[];
  tabs: PlanStashTab[];
  rules?: readonly SortRule[];
  catalog?: Record<string, StashItemMeta>;
}

function tabOccupancy(tab: PlanStashTab | undefined): { full: boolean; cells: GridCell[] } {
  if (tab === undefined) {
    return { full: false, cells: [] };
  }
  if (tab.cells.length === 0) {
    return { full: tab.tabFull === true, cells: [] };
  }
  return { full: tab.tabFull === true || tab.cells.every((cell) => cell.occupied), cells: tab.cells };
}

function firstEmptyCell(
  tabId: string,
  tab: PlanStashTab | undefined,
  reserved: Set<string>,
): ShadowItem["location"] | undefined {
  const occupancy = tabOccupancy(tab);
  if (occupancy.full && occupancy.cells.length > 0) {
    return undefined;
  }
  const cells =
    occupancy.cells.length > 0
      ? occupancy.cells
      : [{ tabId, x: 0, y: 0, w: 1, h: 1, occupied: false }];
  const sorted = [...cells].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const cell of sorted) {
    const location = { kind: "stash" as const, tabId, x: cell.x, y: cell.y };
    const key = locationKey(location);
    if (cell.occupied || reserved.has(key)) {
      continue;
    }
    return location;
  }
  return undefined;
}

function alreadyAtDestination(item: ShadowItem, destTabId: string): boolean {
  return item.location.kind === "stash" && item.location.tabId === destTabId;
}

export function planTransfers(input: TransferPlannerInput): TransferPlan {
  const rules = input.rules ?? DEFAULT_SORT_RULES;
  const catalog = input.catalog ?? {};
  const tabs = new Map(input.tabs.map((tab) => [tab.tabId, tab]));
  const reserved = new Set<string>();
  const candidates = input.inventory
    .filter((item) => item.fingerprint.length > 0 && item.location.kind === "inventory")
    .slice()
    .sort((a, b) => {
      const scoreDelta = itemScore(catalog[b.fingerprint]) - itemScore(catalog[a.fingerprint]);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return a.fingerprint.localeCompare(b.fingerprint);
    });

  const steps: TransferPlanStep[] = [];
  const blocked: TransferPlan["blocked"] = [];

  for (const item of candidates) {
    const meta = catalog[item.fingerprint] ?? {};
    const rule = matchSortRule(meta, rules);
    if (rule === undefined) {
      continue;
    }
    if (alreadyAtDestination(item, rule.tabId) || alreadyAtDestination(item, rule.fallbackTabId ?? "")) {
      continue;
    }

    const primary = firstEmptyCell(rule.tabId, tabs.get(rule.tabId), reserved);
    let dest = primary;
    let usedFallback = false;
    if (dest === undefined && rule.fallbackTabId !== undefined) {
      dest = firstEmptyCell(rule.fallbackTabId, tabs.get(rule.fallbackTabId), reserved);
      usedFallback = dest !== undefined;
    }
    if (dest === undefined) {
      blocked.push({
        fingerprint: item.fingerprint,
        reason: rule.fallbackTabId === undefined ? STASH_FALLBACK_TAB_FULL_REASON : STASH_FALLBACK_TAB_FULL_REASON,
      });
      continue;
    }

    reserved.add(locationKey(dest));
    const destTab = dest.tabId ?? rule.tabId;
    steps.push({
      fingerprint: item.fingerprint,
      from: item.location,
      to: dest,
      reason: usedFallback
        ? `${rule.bucket}:fallback:${destTab}`
        : `${rule.bucket}:${destTab}`,
    });
  }

  return { steps, blocked };
}
