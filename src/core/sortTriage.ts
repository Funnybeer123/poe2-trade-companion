/**
 * Value-aware routing for the ground-truth sorter.
 *
 * The sorter identifies every item by Ctrl+C before moving it, so the full
 * text is already in hand — appraising it costs nothing. This module decides
 * whether an identified item detours to a triage tab (Review/Sell/Dump)
 * instead of its class tab, gated by appraisal confidence, and shapes the
 * find records the session log keeps.
 *
 * Safety invariants:
 *   - only explicit rule/price verdicts may send an item to the Dump tab;
 *   - a heuristic verdict may only detour UP (Review/Sell);
 *   - a low-confidence verdict routes normally (class tab) — the confidence
 *     gate is what keeps "somewhere special" meaning something.
 */

import type { IdentifiedItem } from "./gearSort.js";
import type { TriageRouting } from "./bagTriage.js";
import type { TierVerdict } from "./valueTiers.js";

export interface SortTriageConfig {
  evaluate: (itemText: string) => TierVerdict;
  routing: TriageRouting;
  /** Minimum appraisal confidence before an item detours. */
  minDetourConfidence: number;
}

export const DEFAULT_MIN_DETOUR_CONFIDENCE = 55;

export interface RoutedItem {
  item: IdentifiedItem;
  /** Where the item actually goes ("junk" = T tabs). */
  dest: string | "junk";
  /** The class-tab destination to fall back to if the triage tab is unreachable. */
  fallbackDest: string | "junk";
  verdict?: TierVerdict;
  detoured: boolean;
}

function verdictConfidence(verdict: TierVerdict): number {
  if (verdict.appraisal) return verdict.appraisal.confidence;
  // Without an appraisal, trust explicit sources and nothing else.
  return verdict.source === "price-table" ? 90 : verdict.source === "rule" ? 72 : 0;
}

/** The labels cleaning must never treat as sources — triage tabs hold detours. */
export function triageTabLabels(routing: TriageRouting): Set<string> {
  return new Set(
    [routing.reviewTab, routing.dumpTab, routing.sellTab]
      .filter((label): label is string => Boolean(label))
      .map((label) => label.trim().toLowerCase()),
  );
}

export function isTriageTabLabel(label: string, routing: TriageRouting): boolean {
  return triageTabLabels(routing).has(label.trim().toLowerCase());
}

/**
 * Route one identified item. Without config (triage off) the class
 * destination stands unchanged.
 */
export function routeIdentifiedItem(
  item: IdentifiedItem,
  config?: SortTriageConfig,
): RoutedItem {
  if (!config) {
    return { item, dest: item.dest, fallbackDest: item.dest, detoured: false };
  }
  const verdict = config.evaluate(item.text);
  const base: RoutedItem = {
    item,
    dest: item.dest,
    fallbackDest: item.dest,
    verdict,
    detoured: false,
  };
  const confidence = verdictConfidence(verdict);
  if (confidence < config.minDetourConfidence) return base;
  if (verdict.tier === "keep") {
    return { ...base, dest: config.routing.reviewTab, detoured: true };
  }
  if (verdict.tier === "sell") {
    return { ...base, dest: config.routing.sellTab ?? config.routing.reviewTab, detoured: true };
  }
  if (
    verdict.tier === "dump" &&
    (verdict.source === "rule" || verdict.source === "price-table")
  ) {
    return { ...base, dest: config.routing.dumpTab, detoured: true };
  }
  return base;
}

/* ---------------- find records ---------------- */

export interface FindRecord {
  at: string;
  /** Where the item was when found (tab label or "bag"). */
  location: string;
  name: string;
  itemClass: string;
  tier: string;
  source: string;
  valueScore?: number;
  confidence?: number;
  estimatedValue?: number;
  currency?: string;
  routedTo: string;
  reason?: string;
}

/** A find worth logging: anything that detoured as keep or sell. */
export function findRecordFor(
  routed: RoutedItem,
  location: string,
  at: string,
): FindRecord | undefined {
  const verdict = routed.verdict;
  if (!verdict || !routed.detoured) return undefined;
  if (verdict.tier !== "keep" && verdict.tier !== "sell") return undefined;
  const appraisal = verdict.appraisal;
  const name = routed.item.text.split(/\r?\n/).find(
    (line) =>
      line.trim() &&
      !/^(Item Class|Rarity):/i.test(line.trim()) &&
      line.trim() !== "--------",
  );
  return {
    at,
    location,
    name: name?.trim() ?? "Unknown item",
    itemClass: routed.item.itemClass ?? "Unknown",
    tier: verdict.tier,
    source: verdict.source,
    ...(appraisal ? { valueScore: appraisal.valueScore, confidence: appraisal.confidence } : {}),
    ...(appraisal?.estimatedValue
      ? {
          estimatedValue: appraisal.estimatedValue.amount,
          currency: appraisal.estimatedValue.currency,
        }
      : {}),
    routedTo: routed.dest === "junk" ? "T tabs" : routed.dest,
    ...(verdict.reasons[0] ? { reason: verdict.reasons[0] } : {}),
  };
}

export function parseFindRecords(jsonl: string): FindRecord[] {
  const records: FindRecord[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as FindRecord;
      if (parsed && parsed.at && parsed.name && parsed.tier) records.push(parsed);
    } catch {
      // A truncated trailing line from a killed run is expected; skip it.
    }
  }
  return records;
}
