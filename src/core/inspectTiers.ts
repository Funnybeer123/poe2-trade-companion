/**
 * Tier ladders for Inspect: turning the learned trade2 ranges
 * (`artifacts/tab-admin/mod-tiers.json`) into something a panel can show
 * per modifier — which tier a roll sits in, how far into that tier it
 * rolled, what item level the tier needs, and the best tier this item's
 * level could ever hold.
 *
 * Why a second module next to `tierLearning.ts`: that module answers one
 * question ("is this roll notable?") and collapses real tiers into 1/2/3/0.
 * Inspect needs the ladder itself — every observed tier, its rank, range,
 * level and how many listings backed it — so the badge can say "T3 of 8 ·
 * learned from 12 listings" instead of a collapsed verdict.
 *
 * Direction caveat (design §7.C): trade2 numbers tiers DOWN to the best roll
 * in the data seen so far, while the game's own `(Tier: N)` may number up.
 * Nothing here assumes: `tierDirection(store)` decides the rank mapping and
 * the caller is told which direction was used.
 *
 * Every number produced here is an estimate from observed listings, never a
 * guarantee. Pure: no HTTP, no fs, no clock.
 */

import { statIdsForMatch, statIdsForModText, type StatCatalogue } from "./statIds.js";
import { MIN_OBSERVATIONS, tierDirection, type LearnedTiers } from "./tierLearning.js";

export interface TierLadderEntry {
  /** The tier number as the store keys it (trade2's "P3" → 3). */
  tierNumber: number;
  /** 1 = best, whichever way the store numbers its tiers. */
  rank: number;
  min: number;
  max: number;
  /** Listings merged into this range. */
  count: number;
  /** The mod's required item level, when trade2 sent one. */
  level?: number;
  /** `count >= MIN_OBSERVATIONS`: only trusted entries judge a roll. */
  trusted: boolean;
}

export interface TierLadder {
  statId: string;
  /** Where the entry came from: this item class's table, or the class-less one. */
  scope: "class" | "global";
  direction: "asc" | "desc";
  /** Sorted by rank ascending (index 0 = best tier). */
  entries: TierLadderEntry[];
}

/**
 * The first of `statIds` the store knows about, as a ladder. The item
 * class's own table wins over the class-less one (a ring's life tiers are
 * not a body armour's) — and it wins across the WHOLE id list, not just per
 * id: a class-scoped ladder for the third stat id is still a better answer
 * than the class-less ladder for the first, because the class table was
 * learned from listings of this very base.
 */
export function tierLadderFor(
  store: LearnedTiers | undefined,
  statIds: readonly string[],
  itemClass?: string,
): TierLadder | undefined {
  if (!store) return undefined;
  const cls = itemClass?.trim();
  const direction = tierDirection(store) ?? "desc";

  const ladderFor = (statId: string, scope: "class" | "global"): TierLadder | undefined => {
    const entry = scope === "class" ? (cls ? store.classes[cls]?.[statId] : undefined) : store.stats[statId];
    if (!entry) return undefined;
    const tiers = Object.entries(entry.tiers)
      .map(([tier, range]) => ({ tierNumber: Number(tier), range }))
      .filter((row) => Number.isFinite(row.tierNumber));
    if (tiers.length === 0) return undefined;
    const highest = Math.max(...tiers.map((row) => row.tierNumber));
    const entries: TierLadderEntry[] = tiers
      .map((row) => ({
        tierNumber: row.tierNumber,
        rank: direction === "desc" ? row.tierNumber : highest - row.tierNumber + 1,
        min: row.range.min,
        max: row.range.max,
        count: row.range.count,
        ...(row.range.level !== undefined ? { level: row.range.level } : {}),
        trusted: row.range.count >= MIN_OBSERVATIONS,
      }))
      .sort((a, b) => a.rank - b.rank);
    return { statId, scope, direction, entries };
  };

  for (const scope of ["class", "global"] as const) {
    for (const statId of statIds) {
      const ladder = ladderFor(statId, scope);
      if (ladder) return ladder;
    }
  }
  return undefined;
}

/**
 * Which trusted tier a roll falls in. Containment decides first, and when
 * several learned ranges contain the value the WORST-ranked one wins: the
 * ranges come from observed listings, so one low-rolled T1 listing widens
 * T1 downwards over the whole of T3 — answering T1 there would promote a
 * filler roll to "the best tier the ladder knows". Claiming the least is
 * the honest read.
 *
 * A value above every observed maximum answers the best trusted tier (cheap
 * listings rarely show the top roll, so "above T2's max" is not proof of a
 * better tier that was never seen); a value that sits between ranges falls
 * back to the first range whose floor it clears, and a value under every
 * trusted range answers undefined so the caller can use hand thresholds.
 */
export function rankForValue(ladder: TierLadder, value: number): TierLadderEntry | undefined {
  if (!Number.isFinite(value)) return undefined;
  const trusted = ladder.entries.filter((entry) => entry.trusted);
  if (trusted.length === 0) return undefined;
  const ceiling = Math.max(...trusted.map((entry) => entry.max));
  if (value > ceiling) return trusted[0];
  // `trusted` keeps the ladder's rank-ascending order, so the last entry
  // containing the value is the worst-ranked one that does.
  const inside = trusted.filter((entry) => value >= entry.min && value <= entry.max);
  if (inside.length > 0) return inside[inside.length - 1];
  for (const entry of trusted) {
    if (value >= entry.min) return entry;
  }
  return undefined;
}

/** The ladder entry carrying the game's printed `(Tier: N)` number. */
export function entryForTierNumber(ladder: TierLadder, tierNumber: number): TierLadderEntry | undefined {
  return ladder.entries.find((entry) => entry.tierNumber === tierNumber);
}

/**
 * The best tier an item of this level can hold: the highest-ranked entry
 * whose required level is at or below the item level. Entries without a
 * level are ignored — trade2 only sends the level for some mods, and
 * guessing would invent a cap the game does not have.
 */
export function maxTierAtLevel(ladder: TierLadder, itemLevel: number): TierLadderEntry | undefined {
  if (!Number.isFinite(itemLevel)) return undefined;
  const levelled = ladder.entries.filter(
    (entry) => entry.level !== undefined && entry.level <= itemLevel,
  );
  if (levelled.length === 0) return undefined;
  return levelled.reduce((best, entry) => (entry.rank < best.rank ? entry : best));
}

/**
 * The next better tier this item level cannot hold yet — the cheapest step
 * up ("T2 from item level 76"), which is the whole point of showing a max
 * tier at all: a base one level short of a better tier is worth knowing
 * about. The entry with the LOWEST required level above the item level
 * wins, and only when it actually out-ranks what the level already allows.
 */
export function nextTierAboveLevel(ladder: TierLadder, itemLevel: number): TierLadderEntry | undefined {
  if (!Number.isFinite(itemLevel)) return undefined;
  const reachable = maxTierAtLevel(ladder, itemLevel);
  const above = ladder.entries.filter(
    (entry) =>
      entry.level !== undefined &&
      entry.level > itemLevel &&
      (reachable === undefined || entry.rank < reachable.rank),
  );
  if (above.length === 0) return undefined;
  return above.reduce((best, entry) => ((entry.level ?? 0) < (best.level ?? 0) ? entry : best));
}

/**
 * How far into its range a roll landed, 0–100. Undefined when the range is
 * a single value (nothing to be "far into") or the numbers are unusable.
 * For a penalty modifier the scale is flipped, so 100 % is always "the good
 * end of the range".
 */
export function rollPercent(
  value: number,
  min: number,
  max: number,
  lowerIsBetter = false,
): number | undefined {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) return undefined;
  if (min === max) return undefined;
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  const raw = ((value - low) / (high - low)) * 100;
  const oriented = lowerIsBetter ? 100 - raw : raw;
  return Math.round(Math.min(100, Math.max(0, oriented)));
}

export { isLowerIsBetter, LOWER_IS_BETTER } from "./itemStats.js";

/**
 * The stat ids to key one modifier line by: its exact catalogue ids first,
 * then (for a small family) the family's siblings, which is what the
 * learned store was written under.
 */
export function statIdsForInspect(
  catalogue: StatCatalogue | undefined,
  modText: string,
  familyId?: string,
): string[] {
  if (!catalogue) return [];
  if (familyId) return statIdsForMatch(catalogue, familyId, modText);
  return statIdsForModText(catalogue, modText);
}
