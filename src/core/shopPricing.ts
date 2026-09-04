/**
 * Shop pricing policy (docs/HANDOFF-shop-listings.md): pure decisions about
 * WHAT to charge, WHEN to step a stale listing down, and WHETHER an item may
 * be auto-listed at all.
 *
 * Safety rails enforced here, not left to callers:
 *   - the anchor is a low PERCENTILE of comps, never the minimum (troll and
 *     anchor listings must not set the price), and the troll-floor caution
 *     from summarizeComps pulls the anchor back toward the median;
 *   - a listing decision needs BOTH appraisal confidence and a usable comps
 *     summary — everything below threshold routes to Review, never listed on
 *     a guess;
 *   - keep-tier items are never listed; estimates above the configured cap
 *     require per-item confirmation; listings whose note this flow did not
 *     write are read-only.
 */

import { orbCosts } from "./crafting.js";
import {
  ageDays,
  maxAutoListExalted,
  type ActiveListing,
  type CompsSnapshot,
  type ListingEvent,
  type ShopConfig,
} from "./shopListings.js";
import type { CompsSummary } from "./tradeComps.js";
import type { ItemAppraisal } from "./appraisal.js";
import type { PriceTable } from "./priceTable.js";
import type { TriageTier } from "./valueTiers.js";

// ---------------------------------------------------------------------------
// Price suggestion
// ---------------------------------------------------------------------------

/** Value at a low percentile of an ASCENDING price list. */
export function percentileLowPrice(
  prices: readonly number[],
  percentile: number,
): number | undefined {
  if (prices.length === 0) return undefined;
  const sorted = [...prices].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

export interface DenominatedPrice {
  amount: number;
  currency: string;
  /** What the display amount is actually worth in exalted (post-rounding). */
  exalted: number;
}

/**
 * Express an exalted value in the sensible listing currency: whole divines at
 * or above the divine rate, whole exalted below it. Integer amounts only —
 * the price dialog types this number and the Note re-read must match it
 * exactly.
 */
export function denominatePrice(
  exalted: number,
  priceTable?: PriceTable,
): DenominatedPrice {
  const divineRate = orbCosts(priceTable).divine;
  if (Number.isFinite(divineRate) && divineRate > 0 && exalted >= divineRate) {
    const amount = Math.max(1, Math.round(exalted / divineRate));
    return { amount, currency: "divine", exalted: Math.round(amount * divineRate * 100) / 100 };
  }
  const amount = Math.max(1, Math.round(exalted));
  return { amount, currency: "exalted", exalted: amount };
}

export interface PriceSuggestion {
  /** The policy's target value before denomination. */
  targetExalted: number;
  /** What actually gets typed into the price dialog. */
  display: DenominatedPrice;
  /** The comps evidence behind the number, for the ledger snapshot. */
  comps: CompsSnapshot;
  cautions: string[];
}

export type PriceRefusalReason = "no-comps" | "sample-too-small" | "below-floor";

export interface PriceRefusal {
  refusal: PriceRefusalReason;
  detail: string;
}

export function isPriceRefusal(
  value: PriceSuggestion | PriceRefusal,
): value is PriceRefusal {
  return "refusal" in value;
}

/**
 * Price at the Nth-lowest comparable minus the configured undercut. The
 * caution path (floor far under the median — bait or terrible rolls) pulls
 * the anchor up to half the median so one troll listing cannot set our price.
 */
export function suggestListingPrice(
  comps: CompsSummary,
  config: ShopConfig,
  options: { at: string; priceTable?: PriceTable },
): PriceSuggestion | PriceRefusal {
  const prices = comps.comps.map((entry) => entry.price);
  if (prices.length === 0) {
    return { refusal: "no-comps", detail: "no priced comparable listings" };
  }
  if (comps.sampleSize < config.minCompsCount) {
    return {
      refusal: "sample-too-small",
      detail: `${comps.sampleSize} comparable(s), need ${config.minCompsCount}`,
    };
  }
  const cautions: string[] = [];
  const median = comps.median;
  if (
    comps.lowest !== undefined &&
    median !== undefined &&
    comps.lowest > 0 &&
    median / comps.lowest > config.maxCompsSpread
  ) {
    cautions.push(
      `spread ${comps.lowest}–${median} ex exceeds ${config.maxCompsSpread}x — anchoring on the median side`,
    );
  }
  let anchor = percentileLowPrice(prices, config.compsPercentile)!;
  if ((comps.caution || cautions.length > 0) && median !== undefined) {
    // The floor is not trustworthy: never anchor below half the median.
    const guard = median / 2;
    if (anchor < guard) {
      cautions.push(`anchor ${anchor} ex raised to ${guard} ex (troll-floor guard)`);
      anchor = guard;
    }
    if (comps.caution) cautions.push(comps.caution);
  }
  let target = Math.round(anchor * (1 - config.undercutPercent / 100) * 100) / 100;
  // The undercut exists to beat competing listings; it cannot go under the
  // listing floor. Comps AT the floor (1 ex is the market's own minimum)
  // mean "worth the floor" — list there, never vendor (live lesson: seven
  // 1-ex items nearly went to ZELINA over a 0.95 ex target, 2026-09-03).
  if (target < config.minListExalted && anchor >= config.minListExalted) {
    cautions.push(`undercut would go under the ${config.minListExalted} ex floor — listing at the floor`);
    target = config.minListExalted;
  }
  if (target < config.minListExalted) {
    return {
      refusal: "below-floor",
      detail: `${target} ex is under the ${config.minListExalted} ex listing floor`,
    };
  }
  const display = denominatePrice(target, options.priceTable);
  return {
    targetExalted: target,
    display,
    comps: {
      at: options.at,
      basis: comps.basis,
      sampleSize: comps.sampleSize,
      candidateCount: comps.candidateCount,
      ...(comps.lowest !== undefined ? { lowest: comps.lowest } : {}),
      ...(median !== undefined ? { median } : {}),
      anchorExalted: anchor,
    },
    cautions,
  };
}

// ---------------------------------------------------------------------------
// Reprice ladder
// ---------------------------------------------------------------------------

export type ListingBadge = "STALE" | "UNDERPRICED" | "USER-PRICED" | "UNPRICED";

export interface RepriceDecision {
  action: "hold" | "reprice" | "delist";
  /** For reprice: the new display price to type. */
  to?: DenominatedPrice;
  badges: ListingBadge[];
  reasons: string[];
}

/**
 * One listing's next move. The ladder steps a stale listing down (relative
 * to its CURRENT price, never below the fresh suggestion), with a floor at
 * the delist boundary — below the floor the answer is the return tab, not a
 * race to zero. Listings the app did not price are read-only.
 */
export function repriceDecision(args: {
  listing: ActiveListing;
  suggestion?: PriceSuggestion | PriceRefusal;
  config: ShopConfig;
  nowMs: number;
  priceTable?: PriceTable;
}): RepriceDecision {
  const { listing, config, nowMs } = args;
  const badges: ListingBadge[] = [];
  const reasons: string[] = [];
  const age = ageDays(listing.pricedAt, nowMs);
  const stale = age >= config.staleDays;
  if (stale) badges.push("STALE");

  if (listing.by !== "app") {
    badges.push("USER-PRICED");
    reasons.push("priced by hand — read-only unless overridden per item in the app");
    return { action: "hold", badges, reasons };
  }
  const current = listing.price?.exalted;
  if (current === undefined) {
    badges.push("UNPRICED");
    reasons.push("no readable price on the ledger record — scan again before acting");
    return { action: "hold", badges, reasons };
  }
  const suggestion =
    args.suggestion && !isPriceRefusal(args.suggestion) ? args.suggestion : undefined;

  if (suggestion && suggestion.targetExalted >= current * (1 + config.underpricedPercent / 100)) {
    badges.push("UNDERPRICED");
    reasons.push(
      `comps target ${suggestion.targetExalted} ex sits ≥${config.underpricedPercent}% above the ${current} ex listing`,
    );
    return { action: "reprice", to: suggestion.display, badges, reasons };
  }

  if (!stale) {
    reasons.push(`listed ${age.toFixed(1)}d — not yet stale (${config.staleDays}d)`);
    return { action: "hold", badges, reasons };
  }
  if (!suggestion) {
    reasons.push(
      args.suggestion && isPriceRefusal(args.suggestion)
        ? `stale, but comps unusable (${args.suggestion.detail}) — holding rather than guessing`
        : "stale, but no comps were fetched — holding",
    );
    return { action: "hold", badges, reasons };
  }
  // Market moved vs. we overpriced: when comps still support the current
  // price, age alone is no reason to cut it.
  if (suggestion.targetExalted >= current) {
    reasons.push(
      `stale at ${age.toFixed(1)}d but comps (${suggestion.targetExalted} ex) still support ${current} ex — market did not move`,
    );
    return { action: "hold", badges, reasons };
  }
  const step = [...config.ladder].reverse().find((entry) => age >= entry.afterDays);
  if (!step) {
    reasons.push(`stale at ${age.toFixed(1)}d but before the first ladder step`);
    return { action: "hold", badges, reasons };
  }
  const target = Math.max(
    suggestion.targetExalted,
    Math.round(current * (1 - step.stepPercent / 100) * 100) / 100,
  );
  if (target < config.delistFloorExalted || target >= current) {
    if (target >= current) {
      reasons.push("the ladder step lands at or above the current price — nothing to cut");
      return { action: "hold", badges, reasons };
    }
    reasons.push(
      `ladder lands at ${target} ex, under the ${config.delistFloorExalted} ex floor — delist to ${config.returnTab} instead of racing to zero`,
    );
    return { action: "delist", badges, reasons };
  }
  const display = denominatePrice(target, args.priceTable);
  if (display.exalted >= current) {
    reasons.push("rounding to a listable amount cancels the cut — holding until the next step");
    return { action: "hold", badges, reasons };
  }
  reasons.push(
    `stale ${age.toFixed(1)}d (step -${step.stepPercent}% after ${step.afterDays}d): ${current} → ${display.exalted} ex`,
  );
  return { action: "reprice", to: display, badges, reasons };
}

// ---------------------------------------------------------------------------
// Auto-list gate (phase 2)
// ---------------------------------------------------------------------------

export interface ListingGateInput {
  appraisal: ItemAppraisal;
  tier: TriageTier;
  comps?: CompsSummary;
  config: ShopConfig;
  at: string;
  priceTable?: PriceTable;
}

export type ListingGateResult =
  | { ok: true; suggestion: PriceSuggestion; needsConfirmation?: string }
  | { ok: false; reason: string };

/**
 * May this item be auto-listed? BOTH gates must pass: appraisal confidence
 * at or above threshold AND a usable comps summary. Failures route to the
 * Review tab — never list a guess.
 */
export function listingGate(input: ListingGateInput): ListingGateResult {
  if (input.tier === "keep") {
    return { ok: false, reason: "keep-tier items are never auto-listed — they belong to the user" };
  }
  if (input.tier === "dump") {
    return { ok: false, reason: "dump-tier items are vendor trash, not listings" };
  }
  if (input.appraisal.evidence === "unparseable") {
    return { ok: false, reason: "unreadable item text" };
  }
  if (input.appraisal.confidence < input.config.minListConfidence) {
    return {
      ok: false,
      reason: `appraisal confidence ${input.appraisal.confidence} < ${input.config.minListConfidence} — route to Review`,
    };
  }
  if (!input.comps) {
    return { ok: false, reason: "no comps summary — route to Review" };
  }
  const suggestion = suggestListingPrice(input.comps, input.config, {
    at: input.at,
    ...(input.priceTable ? { priceTable: input.priceTable } : {}),
  });
  if (isPriceRefusal(suggestion)) {
    return { ok: false, reason: `comps unusable (${suggestion.detail}) — route to Review` };
  }
  const cap = maxAutoListExalted(input.config, input.priceTable);
  if (suggestion.display.exalted > cap) {
    return {
      ok: true,
      suggestion,
      needsConfirmation: `estimate ${suggestion.display.exalted} ex exceeds the ${cap} ex cap (${input.config.maxAutoList.amount} ${input.config.maxAutoList.currency}) — per-item confirmation required`,
    };
  }
  return { ok: true, suggestion };
}

// ---------------------------------------------------------------------------
// Slot economics
// ---------------------------------------------------------------------------

export interface SalesClassStats {
  itemClass: string;
  listed: number;
  sold: number;
  delisted: number;
  /** Median days from listing to (presumed) sale, when computable. */
  medianDaysToSale?: number;
  realizedExalted: number;
}

/** Fold the ledger's realized outcomes into per-class stats — the feedback
 * loop that should eventually raise/lower the value tiers of classes that
 * actually sell (reported, not auto-applied: the tiers are user-owned). */
export function salesStats(events: readonly ListingEvent[]): SalesClassStats[] {
  const byClass = new Map<string, SalesClassStats & { saleDays: number[] }>();
  const listedAt = new Map<string, string>();
  const stat = (itemClass: string) => {
    let entry = byClass.get(itemClass);
    if (!entry) {
      entry = { itemClass, listed: 0, sold: 0, delisted: 0, realizedExalted: 0, saleDays: [] };
      byClass.set(itemClass, entry);
    }
    return entry;
  };
  for (const event of events) {
    const entry = stat(event.itemClass);
    if (event.kind === "listed") {
      entry.listed += event.count;
      if (!listedAt.has(event.fingerprint)) listedAt.set(event.fingerprint, event.at);
    } else if (event.kind === "sold") {
      entry.sold += event.count;
      entry.realizedExalted += (event.realized?.exalted ?? 0) * event.count;
      const from = listedAt.get(event.fingerprint);
      if (from) {
        const days = ageDays(from, Date.parse(event.at));
        if (Number.isFinite(days)) entry.saleDays.push(days);
      }
    } else if (event.kind === "delisted") {
      entry.delisted += event.count;
    }
  }
  return [...byClass.values()].map(({ saleDays, ...entry }) => {
    const sorted = [...saleDays].sort((a, b) => a - b);
    const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : undefined;
    return {
      ...entry,
      realizedExalted: Math.round(entry.realizedExalted * 100) / 100,
      ...(median !== undefined ? { medianDaysToSale: Math.round(median * 10) / 10 } : {}),
    };
  });
}

/**
 * 0.05–0.95 chance this listing sells at the suggested price, from comps
 * depth (a deep market moves) shifted by the class's realized history. A
 * documented heuristic, not a model — its job is ordering candidates, and
 * the sold-feedback loop sharpens it as the ledger grows.
 */
export function estimateSaleProbability(
  compsSampleSize: number,
  classStats?: SalesClassStats,
): number {
  let probability = 0.35 + 0.06 * Math.min(compsSampleSize, 8);
  if (classStats) {
    const ended = classStats.sold + classStats.delisted;
    if (ended >= 3) {
      const soldRate = classStats.sold / ended;
      probability += (soldRate - 0.5) * 0.3;
    }
  }
  return Math.min(0.95, Math.max(0.05, Math.round(probability * 100) / 100));
}

export interface ListingCandidate {
  fingerprint: string;
  name: string;
  itemClass: string;
  /** Bag/source cells the item occupies (drives shop-space accounting). */
  cellCount: number;
  suggestion: PriceSuggestion;
  needsConfirmation?: string;
}

export interface RankedCandidate extends ListingCandidate {
  saleProbability: number;
  expectedValue: number;
}

/** Order candidates by expected value × sale probability, best first. */
export function rankListingCandidates(
  candidates: readonly ListingCandidate[],
  stats: readonly SalesClassStats[] = [],
): RankedCandidate[] {
  const byClass = new Map(stats.map((entry) => [entry.itemClass.toLowerCase(), entry]));
  return candidates
    .map((candidate) => {
      const saleProbability = estimateSaleProbability(
        candidate.suggestion.comps.sampleSize,
        byClass.get(candidate.itemClass.toLowerCase()),
      );
      return {
        ...candidate,
        saleProbability,
        expectedValue:
          Math.round(candidate.suggestion.display.exalted * saleProbability * 100) / 100,
      };
    })
    .sort((a, b) => b.expectedValue - a.expectedValue);
}

export interface EvictionPlan {
  evict: ActiveListing[];
  admitted: RankedCandidate[];
  /** One line per eviction — every eviction is reported. */
  report: string[];
}

/**
 * Shop space is finite. Fill free cells best-first; when full, the worst
 * STALE app-listed listing may make room for a candidate worth clearly more
 * (2x its expected value). User-priced listings are never evicted.
 */
export function planEvictions(args: {
  active: readonly ActiveListing[];
  candidates: readonly RankedCandidate[];
  freeCells: number;
  config: ShopConfig;
  nowMs: number;
  /** Cells each active listing occupies (fingerprint → cells); default 1. */
  cellsOf?: (listing: ActiveListing) => number;
}): EvictionPlan {
  const report: string[] = [];
  const admitted: RankedCandidate[] = [];
  const evict: ActiveListing[] = [];
  let free = Math.max(0, args.freeCells);
  const evictable = args.active
    .filter(
      (listing) =>
        listing.by === "app" && ageDays(listing.pricedAt, args.nowMs) >= args.config.staleDays,
    )
    .sort((a, b) => (a.price?.exalted ?? 0) - (b.price?.exalted ?? 0));
  for (const candidate of args.candidates) {
    if (candidate.cellCount <= free) {
      admitted.push(candidate);
      free -= candidate.cellCount;
      continue;
    }
    let gained = 0;
    const taking: ActiveListing[] = [];
    for (const victim of evictable) {
      if (evict.includes(victim) || taking.includes(victim)) continue;
      const victimValue = victim.price?.exalted ?? 0;
      if (candidate.expectedValue < victimValue * 2) continue;
      taking.push(victim);
      gained += args.cellsOf?.(victim) ?? 1;
      if (free + gained >= candidate.cellCount) break;
    }
    if (free + gained >= candidate.cellCount && taking.length > 0) {
      for (const victim of taking) {
        evict.push(victim);
        report.push(
          `evicting stale ${victim.name} (${victim.price?.exalted ?? "?"} ex, listed ${victim.listedAt.slice(0, 10)}) to make room for ${candidate.name} (EV ${candidate.expectedValue} ex)`,
        );
      }
      free += gained - candidate.cellCount;
      admitted.push(candidate);
    }
  }
  return { evict, admitted, report };
}
