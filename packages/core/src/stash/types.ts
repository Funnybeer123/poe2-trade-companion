import type { DesirabilityCategory } from "../items/types.js";
import type { ShadowItem } from "../inventory/types.js";
import type { GridCell, StashItemMeta } from "../world-state/types.js";

export type SortBucket =
  | "Currency"
  | "Waystones"
  | "Uniques"
  | "HighValueSell"
  | "NormalSell"
  | "Crafting"
  | "Bulk"
  | "Dump"
  | "Vendor";

export interface SortRule {
  id: string;
  bucket: SortBucket;
  tabId: string;
  fallbackTabId?: string;
  match: { category?: DesirabilityCategory[]; class?: string[]; rarity?: string[] };
}

export interface TransferPlanStep {
  fingerprint: string;
  from: ShadowItem["location"];
  to: ShadowItem["location"];
  reason: string;
}

export interface PlanStashTab {
  tabId: string;
  cells: GridCell[];
  tabFull?: boolean;
}

export interface TransferPlan {
  steps: TransferPlanStep[];
  blocked: Array<{ fingerprint: string; reason: string }>;
}

export type { StashItemMeta };

export function itemScore(meta: StashItemMeta | undefined): number {
  return meta?.score ?? 0;
}
