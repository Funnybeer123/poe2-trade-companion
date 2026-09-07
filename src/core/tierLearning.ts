/**
 * Learn mod tiers from trade2 fetch payloads.
 *
 * Every listing trade2 returns carries its mods' real tier data. The PoE2
 * shape, verified on a live fetch (Ruby Ring comps, 2026-09-07):
 *   item.explicitMods[] = {
 *     description: "Adds 2 to 5 [Physical|Physical] Damage to [Attack|Attacks]",
 *     domain: "explicit",
 *     hash: "stat.explicit.stat_3032590688",          // "stat." + catalogue id
 *     mods: [{ name: "Burnished", tier: "P8", level: 8,
 *              magnitudes: [{ min: "2", max: "3" }, { min: "4", max: "6" }] }],
 *   }
 *   item.extended.hashes.explicit = [["explicit.stat_3032590688", [2]], …]
 * Magnitudes carry no hash of their own (the description entry's hash
 * applies), `level` is absent on the lowest tiers, and the numbering runs
 * DOWN to the best roll: P8 at level 8 out-rolls P9. The PoE1-era shape
 * (item.extended.mods.explicit[] with hashed magnitudes) is still accepted
 * as a fallback in case trade2 moves the block.
 *
 * So every comps lookup teaches us, for free, what magnitude range each
 * tier of each stat rolls. That replaces the hand-guessed t1/t2/t3
 * thresholds in modKnowledge.ts with observed ones, per item class when the
 * class is known (life on a ring and on a body armour share a stat id but
 * not a range).
 *
 * Pure: parsing, merging, serialization, and the tier judgement. The
 * service persists the store (configDir/mod-tiers.json).
 */

export interface TierObservation {
  statId: string;
  itemClass?: string;
  /** trade2's label, e.g. "P3" (prefix tier 3) or "S1". */
  tierLabel: string;
  /** The digits of the label. */
  tierNumber: number;
  /** The mod's required item level, when trade2 sends it (best tier = highest). */
  level?: number;
  min: number;
  max: number;
}

export interface LearnedTierRange {
  /** Lowest magnitude seen for this tier (min of mins). */
  min: number;
  /** Highest magnitude seen (max of maxes). */
  max: number;
  /** Observations merged in. Under MIN_OBSERVATIONS the range is not trusted. */
  count: number;
  /** Highest mod level seen — orders tiers independently of the label. */
  level?: number;
}

export interface LearnedStat {
  /** tier number (as a string key) → observed range. */
  tiers: Record<string, LearnedTierRange>;
}

export interface LearnedTiers {
  version: 1;
  /** Class-less entries: every observation lands here. */
  stats: Record<string, LearnedStat>;
  /** item class → stat id → entry; consulted before the class-less one. */
  classes: Record<string, Record<string, LearnedStat>>;
}

/** A tier's range is trusted once this many listings agreed on it. */
export const MIN_OBSERVATIONS = 2;

export type LearnedTier = 1 | 2 | 3 | 0;

export function emptyLearnedTiers(): LearnedTiers {
  return { version: 1, stats: {}, classes: {} };
}

// ---------------------------------------------------------------------------
// Parsing fetch payloads
// ---------------------------------------------------------------------------

function toNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

interface RawMagnitude {
  hash?: unknown;
  min?: unknown;
  max?: unknown;
}

interface RawMod {
  name?: unknown;
  tier?: unknown;
  level?: unknown;
  magnitudes?: unknown;
}

function tierNumberOf(label: string): number | undefined {
  const digits = label.replace(/\D+/g, "");
  if (!digits) return undefined;
  const number = Number(digits);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

/** "stat.explicit.stat_123" (explicitMods hash) → "explicit.stat_123" (catalogue id). */
export function catalogueStatId(hash: string): string {
  return hash.replace(/^stat\./, "");
}

/**
 * One mod's magnitudes, grouped by stat id. A two-number mod ("Adds # to #
 * Physical Damage") carries two magnitude entries for the same stat; they
 * are averaged so the range compares with the `average2` judge in
 * modKnowledge.ts. `fallbackHash` keys magnitudes that carry no hash of
 * their own (the PoE2 shape: the parent description entry holds it).
 */
function magnitudeRanges(
  raw: unknown,
  fallbackHash?: string,
): Map<string, { min: number; max: number }> {
  const ranges = new Map<string, { mins: number[]; maxes: number[] }>();
  if (!Array.isArray(raw)) return new Map();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const magnitude = entry as RawMagnitude;
    const hash = typeof magnitude.hash === "string" ? magnitude.hash : fallbackHash;
    if (!hash) continue;
    const min = toNumber(magnitude.min);
    const max = toNumber(magnitude.max);
    if (min === undefined || max === undefined) continue;
    const id = catalogueStatId(hash);
    const bucket = ranges.get(id) ?? { mins: [], maxes: [] };
    bucket.mins.push(Math.min(min, max));
    bucket.maxes.push(Math.max(min, max));
    ranges.set(id, bucket);
  }
  const out = new Map<string, { min: number; max: number }>();
  for (const [id, bucket] of ranges) {
    const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    out.set(id, { min: average(bucket.mins), max: average(bucket.maxes) });
  }
  return out;
}

function observeMod(
  mod: RawMod,
  fallbackHash: string | undefined,
  itemClass: string | undefined,
  into: TierObservation[],
): void {
  if (typeof mod.tier !== "string") return;
  const tierNumber = tierNumberOf(mod.tier);
  if (tierNumber === undefined) return;
  const level = toNumber(mod.level);
  for (const [statId, range] of magnitudeRanges(mod.magnitudes, fallbackHash)) {
    into.push({
      statId,
      ...(itemClass ? { itemClass } : {}),
      tierLabel: mod.tier,
      tierNumber,
      ...(level !== undefined ? { level } : {}),
      min: range.min,
      max: range.max,
    });
  }
}

/**
 * Observations from a /api/trade2/fetch payload. Listings, mods, or
 * magnitudes of an unexpected shape are skipped, never thrown on: the
 * explicitMods shape was verified on one live fetch (2026-09-07), but the
 * comps path must keep pricing if trade2 ever changes it.
 */
export function learnTiersFromFetch(payload: unknown, itemClass?: string): TierObservation[] {
  const observations: TierObservation[] = [];
  if (typeof payload !== "object" || payload === null) return observations;
  const results = (payload as { result?: unknown }).result;
  if (!Array.isArray(results)) return observations;
  const cls = itemClass?.trim() || undefined;
  for (const raw of results) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = (raw as { item?: unknown }).item;
    if (typeof item !== "object" || item === null) continue;
    // PoE2: tier data hangs off each explicitMods description entry.
    const explicitMods = (item as { explicitMods?: unknown }).explicitMods;
    let seen = false;
    if (Array.isArray(explicitMods)) {
      for (const entry of explicitMods) {
        if (typeof entry !== "object" || entry === null) continue;
        const described = entry as { hash?: unknown; mods?: unknown };
        if (typeof described.hash !== "string" || !Array.isArray(described.mods)) continue;
        for (const mod of described.mods) {
          if (typeof mod !== "object" || mod === null) continue;
          seen = true;
          observeMod(mod as RawMod, described.hash, cls, observations);
        }
      }
    }
    if (seen) continue;
    // Fallback: the PoE1-era block, magnitudes hashed individually.
    const extended = (item as { extended?: unknown }).extended;
    if (typeof extended !== "object" || extended === null) continue;
    const mods = (extended as { mods?: unknown }).mods;
    if (typeof mods !== "object" || mods === null) continue;
    const explicit = (mods as { explicit?: unknown }).explicit;
    if (!Array.isArray(explicit)) continue;
    for (const entry of explicit) {
      if (typeof entry !== "object" || entry === null) continue;
      observeMod(entry as RawMod, undefined, cls, observations);
    }
  }
  return observations;
}

// ---------------------------------------------------------------------------
// Store maintenance
// ---------------------------------------------------------------------------

function mergeRange(into: LearnedTierRange | undefined, range: LearnedTierRange): LearnedTierRange {
  if (!into) return { ...range };
  const level =
    into.level !== undefined || range.level !== undefined
      ? Math.max(into.level ?? -Infinity, range.level ?? -Infinity)
      : undefined;
  return {
    min: Math.min(into.min, range.min),
    max: Math.max(into.max, range.max),
    count: into.count + range.count,
    ...(level !== undefined ? { level } : {}),
  };
}

function mergeStat(into: LearnedStat | undefined, stat: LearnedStat): LearnedStat {
  const tiers: Record<string, LearnedTierRange> = { ...(into?.tiers ?? {}) };
  for (const [tier, range] of Object.entries(stat.tiers)) {
    tiers[tier] = mergeRange(tiers[tier], range);
  }
  return { tiers };
}

function mergeStatMap(
  into: Record<string, LearnedStat>,
  from: Record<string, LearnedStat>,
): Record<string, LearnedStat> {
  const merged: Record<string, LearnedStat> = { ...into };
  for (const [statId, stat] of Object.entries(from)) merged[statId] = mergeStat(merged[statId], stat);
  return merged;
}

/** Union of two stores: ranges widen, counts add, levels keep the max. */
export function mergeLearnedTiers(a: LearnedTiers, b: LearnedTiers): LearnedTiers {
  const classes: Record<string, Record<string, LearnedStat>> = {};
  for (const source of [a.classes, b.classes]) {
    for (const [cls, stats] of Object.entries(source)) {
      classes[cls] = mergeStatMap(classes[cls] ?? {}, stats);
    }
  }
  return { version: 1, stats: mergeStatMap(a.stats, b.stats), classes };
}

/** A store holding just these observations (merge it into the live one). */
export function storeFromObservations(observations: readonly TierObservation[]): LearnedTiers {
  const store = emptyLearnedTiers();
  for (const observation of observations) {
    const range: LearnedTierRange = {
      min: observation.min,
      max: observation.max,
      count: 1,
      ...(observation.level !== undefined ? { level: observation.level } : {}),
    };
    const stat: LearnedStat = { tiers: { [String(observation.tierNumber)]: range } };
    store.stats[observation.statId] = mergeStat(store.stats[observation.statId], stat);
    if (observation.itemClass) {
      const byClass = store.classes[observation.itemClass] ?? {};
      byClass[observation.statId] = mergeStat(byClass[observation.statId], stat);
      store.classes[observation.itemClass] = byClass;
    }
  }
  return store;
}

/** Fold observations into a store (returns a new store). */
export function addObservations(
  store: LearnedTiers,
  observations: readonly TierObservation[],
): LearnedTiers {
  return mergeLearnedTiers(store, storeFromObservations(observations));
}

export function serializeLearnedTiers(store: LearnedTiers): string {
  return JSON.stringify(store);
}

function isRange(value: unknown): value is LearnedTierRange {
  if (typeof value !== "object" || value === null) return false;
  const range = value as Partial<LearnedTierRange>;
  return (
    typeof range.min === "number" &&
    typeof range.max === "number" &&
    typeof range.count === "number" &&
    Number.isFinite(range.min) &&
    Number.isFinite(range.max) &&
    range.count >= 0 &&
    (range.level === undefined || typeof range.level === "number")
  );
}

function parseStatMap(value: unknown): Record<string, LearnedStat> {
  const out: Record<string, LearnedStat> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [statId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const tiersRaw = (raw as { tiers?: unknown }).tiers;
    if (typeof tiersRaw !== "object" || tiersRaw === null) continue;
    const tiers: Record<string, LearnedTierRange> = {};
    for (const [tier, range] of Object.entries(tiersRaw as Record<string, unknown>)) {
      if (!/^\d+$/.test(tier) || !isRange(range)) continue;
      // A hand-edited or torn file may hold the bounds the wrong way round;
      // tierForValue's ceiling and floor tests assume min ≤ max.
      tiers[tier] = {
        min: Math.min(range.min, range.max),
        max: Math.max(range.min, range.max),
        count: range.count,
        ...(range.level !== undefined ? { level: range.level } : {}),
      };
    }
    if (Object.keys(tiers).length > 0) out[statId] = { tiers };
  }
  return out;
}

/** Parse a serialized store (or an already-parsed value). Garbage → empty. */
export function parseLearnedTiers(value: unknown): LearnedTiers {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return emptyLearnedTiers();
    }
  }
  if (typeof parsed !== "object" || parsed === null) return emptyLearnedTiers();
  const raw = parsed as { stats?: unknown; classes?: unknown };
  const classes: Record<string, Record<string, LearnedStat>> = {};
  if (typeof raw.classes === "object" && raw.classes !== null) {
    for (const [cls, stats] of Object.entries(raw.classes as Record<string, unknown>)) {
      const map = parseStatMap(stats);
      if (Object.keys(map).length > 0) classes[cls] = map;
    }
  }
  return { version: 1, stats: parseStatMap(raw.stats), classes };
}

/** Total observations in the store (for status lines). */
export function learnedObservationCount(store: LearnedTiers): number {
  let count = 0;
  for (const stat of Object.values(store.stats)) {
    for (const range of Object.values(stat.tiers)) count += range.count;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Judging a value
// ---------------------------------------------------------------------------

/**
 * Which way trade2 numbers its tiers. Derived from the data rather than
 * assumed: the best tier of a stat always has the highest required level,
 * so across every stat with two levelled tiers, "does the tier number rise
 * with the level?" settles it. "desc" = 1 is best — what the live fetch
 * showed (P8 at level 8 out-rolls the level-less P9) and the default;
 * "asc" = the highest number is best. Undefined until the store holds a
 * stat with two levelled tiers.
 */
export function tierDirection(store: LearnedTiers): "asc" | "desc" | undefined {
  let asc = 0;
  let desc = 0;
  for (const stat of Object.values(store.stats)) {
    const tiers = Object.entries(stat.tiers)
      .map(([tier, range]) => ({ tier: Number(tier), level: range.level }))
      .filter((entry): entry is { tier: number; level: number } => entry.level !== undefined);
    for (let i = 0; i < tiers.length; i += 1) {
      for (let j = i + 1; j < tiers.length; j += 1) {
        const a = tiers[i]!;
        const b = tiers[j]!;
        if (a.level === b.level || a.tier === b.tier) continue;
        if (a.tier > b.tier === a.level > b.level) asc += 1;
        else desc += 1;
      }
    }
  }
  if (asc === 0 && desc === 0) return undefined;
  return asc > desc ? "asc" : "desc";
}

function collapse(rank: number): LearnedTier {
  if (rank <= 1) return 1;
  if (rank === 2) return 2;
  if (rank <= 4) return 3;
  return 0;
}

/**
 * Judge a value against the learned ranges: 1 = best tier, 3 = notable
 * (real tiers 3-4), 0 = worse than every notable tier. Returns undefined
 * when the store cannot say — no entry, no tier trusted yet, or the value
 * sits under every trusted range without a trusted tier ≥ 3 to bound it —
 * so the caller falls back to its hand thresholds.
 *
 * A value above every observed range counts one tier better than the best
 * observed tier (tier 1 when tier 1 was observed): cheap listings rarely
 * show the top roll, and "above T2's max" is not proof of T1.
 */
export function tierForValue(
  store: LearnedTiers,
  statId: string,
  value: number,
  itemClass?: string,
): LearnedTier | undefined {
  if (!Number.isFinite(value)) return undefined;
  const cls = itemClass?.trim();
  const entry = (cls ? store.classes[cls]?.[statId] : undefined) ?? store.stats[statId];
  if (!entry) return undefined;
  const direction = tierDirection(store) ?? "desc";
  const allTiers = Object.keys(entry.tiers).map(Number);
  const highest = Math.max(...allTiers);
  const rankOf = (tier: number) => (direction === "desc" ? tier : highest - tier + 1);
  const trusted = Object.entries(entry.tiers)
    .filter(([, range]) => range.count >= MIN_OBSERVATIONS)
    .map(([tier, range]) => ({ rank: rankOf(Number(tier)), min: range.min, max: range.max }))
    .sort((a, b) => a.rank - b.rank);
  if (trusted.length === 0) return undefined;
  const best = trusted[0]!;
  const ceiling = Math.max(...trusted.map((tier) => tier.max));
  if (value > ceiling) return collapse(best.rank - 1);
  for (const tier of trusted) {
    if (value >= tier.min) return collapse(tier.rank);
  }
  const worst = trusted[trusted.length - 1]!;
  return worst.rank >= 3 ? 0 : undefined;
}
