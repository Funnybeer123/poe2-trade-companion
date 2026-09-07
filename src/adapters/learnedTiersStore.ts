/**
 * Read-side of the learned-tier knowledge the price feed service writes:
 *   configDir/mod-tiers.json   — tierLearning.ts store, merged after every
 *                                trade2 comps fetch;
 *   configDir/trade-stats.json — the trade2 stats catalogue ({ at, payload }),
 *                                which keys mod lines to stat ids.
 * Both are optional: a missing or corrupt file simply means the evaluator
 * falls back to the hand thresholds in modKnowledge.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { MOD_FAMILIES } from "../core/modKnowledge.js";
import { buildStatCatalogue, type StatCatalogue } from "../core/statIds.js";
import { parseLearnedTiers, type LearnedTiers } from "../core/tierLearning.js";

export const LEARNED_TIERS_FILE = "mod-tiers.json";
export const TRADE_STATS_FILE = "trade-stats.json";

export function loadLearnedTiers(dir: string): LearnedTiers | undefined {
  try {
    const file = path.join(dir, LEARNED_TIERS_FILE);
    if (!existsSync(file)) return undefined;
    const store = parseLearnedTiers(readFileSync(file, "utf8"));
    return Object.keys(store.stats).length > 0 ? store : undefined;
  } catch {
    return undefined;
  }
}

/** The cached stats catalogue, whatever its age — ids do not move. */
export function loadStatCatalogue(dir: string): StatCatalogue | undefined {
  try {
    const file = path.join(dir, TRADE_STATS_FILE);
    if (!existsSync(file)) return undefined;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { payload?: unknown };
    const catalogue = buildStatCatalogue(parsed.payload, MOD_FAMILIES);
    return catalogue.entryCount > 0 ? catalogue : undefined;
  } catch {
    return undefined;
  }
}

/** Both halves, shaped for `evaluateWithAppraisal` / `appraiseItem` options. */
export function loadTierKnowledge(dir: string): {
  learnedTiers?: LearnedTiers;
  statIds?: StatCatalogue;
} {
  const learnedTiers = loadLearnedTiers(dir);
  const statIds = loadStatCatalogue(dir);
  return {
    ...(learnedTiers ? { learnedTiers } : {}),
    ...(statIds ? { statIds } : {}),
  };
}
