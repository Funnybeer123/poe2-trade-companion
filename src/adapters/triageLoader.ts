/**
 * The one loader every CLI uses for the app's triage export
 * (artifacts/tab-admin/triage.json: value tiers, thresholds, routing,
 * detour confidence, price table). Out-of-process scripts cannot read the
 * app database, so the app mirrors these to JSON whenever they change.
 *
 * The price table it returns is the export's table with two fixes applied
 * that used to differ from loader to loader:
 *   - legacy starter placeholders (divine 40 / chaos 0.5) are stripped so
 *     the crafting engine's accurate defaults apply until the feed prices
 *     the orb (priceTable.ts stripStarterPlaceholders);
 *   - the newest feed snapshot any process fetched
 *     (artifacts/tab-admin/feed-snapshot.json) is merged in when it is
 *     fresher than the table's own feed data, so a script that never
 *     refreshes still prices off the latest numbers.
 */

import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { evaluateWithAppraisal } from "../core/appraisal.js";
import { DEFAULT_TRIAGE_ROUTING, type TriageRouting } from "../core/bagTriage.js";
import { applyFeedSnapshotIfNewer, parseFeedSnapshot } from "../core/priceFeed.js";
import {
  starterPriceTable,
  stripStarterPlaceholders,
  validatePriceTable,
  type PriceTable,
} from "../core/priceTable.js";
import { DEFAULT_MIN_DETOUR_CONFIDENCE } from "../core/sortTriage.js";
import { loadTierKnowledge } from "./learnedTiersStore.js";
import {
  DEFAULT_TIER_THRESHOLDS,
  starterValueTierRules,
  type TierVerdict,
  type ValueTierRules,
  type ValueTierThresholds,
} from "../core/valueTiers.js";

export const TRIAGE_EXPORT_FILE = "triage.json";
export const FEED_SNAPSHOT_FILE = "feed-snapshot.json";
export const PRICE_FEED_CONFIG_FILE = "price-feed.json";

export interface TriageExport {
  rules: ValueTierRules;
  thresholds: ValueTierThresholds;
  routing: TriageRouting;
  /** Appraisal confidence an item needs before it detours (0-100). */
  minDetourConfidence: number;
  priceTable: PriceTable;
  /** Where the tiers came from, for a run's header line. */
  source: string;
  /** Set when a persisted feed snapshot was merged into the price table. */
  feedSnapshot?: { league: string; fetchedAt: string };
  /**
   * Which learned-tier inputs were on disk (artifacts/tab-admin/mod-tiers.json
   * and trade-stats.json, written by the price feed service after every
   * comps fetch). Without them the appraisal uses the hand thresholds.
   */
  tierKnowledge: { learnedTiers: boolean; statIds: boolean };
  /** Tier decision for one copied item's text (rules + price table). */
  evaluate: (itemText: string) => TierVerdict;
}

export interface LoadTriageExportOptions {
  /** Where unreadable-file notices go (default: console.log). */
  log?: (line: string) => void;
  now?: Date;
}

interface RawTriageExport {
  rules?: ValueTierRules;
  thresholds?: Partial<ValueTierThresholds>;
  routing?: Partial<TriageRouting>;
  minDetourConfidence?: unknown;
  priceTable?: unknown;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/** The configured league from price-feed.json ("auto" when absent). */
function configuredLeague(dir: string): string {
  try {
    const file = path.join(dir, PRICE_FEED_CONFIG_FILE);
    if (!existsSync(file)) return "auto";
    const parsed = readJson(file) as { league?: unknown };
    return typeof parsed.league === "string" && parsed.league.trim() ? parsed.league.trim() : "auto";
  } catch {
    return "auto";
  }
}

/**
 * Load `root`/artifacts/tab-admin/triage.json; starter tiers and prices when
 * the export is missing or unreadable (the app has not exported yet).
 */
export function loadTriageExport(root: string, options: LoadTriageExportOptions = {}): TriageExport {
  const log = options.log ?? ((line: string) => console.log(line));
  const dir = path.join(root, "artifacts", "tab-admin");
  let rules: ValueTierRules = starterValueTierRules();
  let thresholds: ValueTierThresholds = { ...DEFAULT_TIER_THRESHOLDS };
  let routing: TriageRouting = { ...DEFAULT_TRIAGE_ROUTING };
  let minDetourConfidence = DEFAULT_MIN_DETOUR_CONFIDENCE;
  let priceTable: PriceTable = starterPriceTable();
  let source = "starter tiers (no artifacts/tab-admin/triage.json export)";
  const file = path.join(dir, TRIAGE_EXPORT_FILE);
  if (existsSync(file)) {
    try {
      const parsed = readJson(file) as RawTriageExport;
      if (parsed.rules?.keep && parsed.rules.sell && parsed.rules.dump) rules = parsed.rules;
      if (parsed.thresholds) thresholds = { ...thresholds, ...parsed.thresholds };
      if (parsed.routing?.reviewTab && parsed.routing.dumpTab) {
        routing = { ...parsed.routing, reviewTab: parsed.routing.reviewTab, dumpTab: parsed.routing.dumpTab };
      }
      if (
        typeof parsed.minDetourConfidence === "number" &&
        Number.isFinite(parsed.minDetourConfidence)
      ) {
        minDetourConfidence = Math.max(0, Math.min(100, parsed.minDetourConfidence));
      }
      const tableCheck = validatePriceTable(parsed.priceTable);
      if (tableCheck.valid && tableCheck.table) priceTable = tableCheck.table;
      source = "artifacts/tab-admin/triage.json";
    } catch (error) {
      log(`triage.json unreadable (${String(error)}) — using starter tiers`);
    }
  }
  priceTable = stripStarterPlaceholders(priceTable);

  let feedSnapshot: TriageExport["feedSnapshot"];
  const snapshotFile = path.join(dir, FEED_SNAPSHOT_FILE);
  if (existsSync(snapshotFile)) {
    try {
      const snapshot = parseFeedSnapshot(readJson(snapshotFile));
      if (snapshot) {
        const result = applyFeedSnapshotIfNewer(priceTable, snapshot, {
          ...(options.now ? { now: options.now } : {}),
          league: configuredLeague(dir),
        });
        if (result.applied) {
          priceTable = result.table;
          feedSnapshot = { league: snapshot.league, fetchedAt: snapshot.fetchedAt };
        }
      }
    } catch (error) {
      log(`feed-snapshot.json unreadable (${String(error)}) — pricing off the exported table`);
    }
  }

  const table = priceTable;
  // Learned mod tiers + stat ids from the comps fetches (learnedTiersStore.ts):
  // the evaluator falls back to the hand thresholds when either is missing.
  const knowledge = loadTierKnowledge(dir);
  return {
    rules,
    thresholds,
    routing,
    minDetourConfidence,
    priceTable: table,
    source,
    ...(feedSnapshot ? { feedSnapshot } : {}),
    tierKnowledge: {
      learnedTiers: knowledge.learnedTiers !== undefined,
      statIds: knowledge.statIds !== undefined,
    },
    evaluate: (itemText) =>
      evaluateWithAppraisal(itemText, { rules, priceTable: table, thresholds, ...knowledge }),
  };
}
