/**
 * Bag triage: read every item sitting in the inventory (Ctrl+C per occupied
 * cell) and decide, per cell, whether it deposits to the Review tab, the Dump
 * tab, or its normal class destination.
 *
 * This module is pure planning plus an injectable sweep runner — no screen,
 * no input. The sorter calls it between "withdraw burst" and "deposit".
 *
 * Multi-cell items appear as several occupied cells. Every cell of an item
 * gets the item's verdict (grouped by fingerprint); depositing then
 * ctrl-clicks every cell in a verdict group — redundant clicks on a cell the
 * item already vacated are harmless no-ops on an empty cell.
 */

import { clampToArea, type ClickArea } from "./gearSort.js";
import { looksLikePoeItemText, parseItemText } from "./parseItem.js";
import type { TierVerdict, TriageTier } from "./valueTiers.js";

export interface TriageCell {
  row: number;
  col: number;
  /** Screen hover/click point for the cell centre. */
  x: number;
  y: number;
}

export type TriageCopyStatus = "copied" | "grouped" | "copy-failed";

export interface TriagedCell extends TriageCell {
  status: TriageCopyStatus;
  verdict: TierVerdict;
  fingerprint?: string;
  itemName?: string;
  itemClass?: string;
  rawText?: string;
}

export interface BagTriageSummary {
  cells: TriagedCell[];
  copies: number;
  failures: number;
  distinctItems: number;
  sweepMs: number;
  stopped: boolean;
}

export const TRIAGE_LIMITS = {
  /** Hard cap on copies per sweep; a bag is at most 60 cells. */
  maxCopies: 60,
  /** Consecutive copy failures before the sweep gives up. */
  maxConsecutiveFailures: 3,
} as const;

const UNKNOWN_VERDICT: TierVerdict = {
  tier: "unknown",
  source: "safety",
  reasons: ["The cell's item text could not be read; it routes normally and is never dumped."],
  matchedRules: [],
};

/** Row-major sweep order, clamped so a stray cell can never hover off-bag. */
export function planBagSweep<T extends TriageCell>(cells: readonly T[], bagArea: ClickArea): T[] {
  return clampToArea(cells, bagArea).sort((a, b) => a.row - b.row || a.col - b.col);
}

export interface RunBagTriageArgs {
  cells: readonly TriageCell[];
  bagArea: ClickArea;
  /** Hover + Ctrl+C at the cell point; empty string means the copy failed. */
  copyItem: (x: number, y: number) => Promise<string>;
  evaluate: (itemText: string) => TierVerdict;
  fingerprint?: (itemText: string) => string;
  shouldStop?: () => boolean;
  maxCopies?: number;
}

function defaultFingerprint(text: string): string {
  try {
    return parseItemText(text).fingerprint;
  } catch {
    return `raw:${text.slice(0, 120)}`;
  }
}

/**
 * Sweep the bag. Copies each planned cell once; when a copy returns an item
 * already seen this sweep (another cell of the same multi-cell item), the
 * cell joins that item's group without re-evaluating.
 */
export async function runBagTriage(args: RunBagTriageArgs): Promise<BagTriageSummary> {
  const started = Date.now();
  const planned = planBagSweep(args.cells, args.bagArea);
  const maxCopies = Math.min(args.maxCopies ?? TRIAGE_LIMITS.maxCopies, TRIAGE_LIMITS.maxCopies);
  const fingerprintOf = args.fingerprint ?? defaultFingerprint;
  const verdicts = new Map<string, { verdict: TierVerdict; name?: string; itemClass?: string }>();
  const out: TriagedCell[] = [];
  let copies = 0;
  let failures = 0;
  let consecutiveFailures = 0;
  let stopped = false;

  for (const cell of planned) {
    if (args.shouldStop?.()) {
      stopped = true;
      break;
    }
    if (copies >= maxCopies || consecutiveFailures >= TRIAGE_LIMITS.maxConsecutiveFailures) {
      out.push({ ...cell, status: "copy-failed", verdict: UNKNOWN_VERDICT });
      continue;
    }
    const text = await args.copyItem(cell.x, cell.y);
    copies += 1;
    if (!looksLikePoeItemText(text)) {
      failures += 1;
      consecutiveFailures += 1;
      out.push({ ...cell, status: "copy-failed", verdict: UNKNOWN_VERDICT });
      continue;
    }
    consecutiveFailures = 0;
    const fingerprint = fingerprintOf(text);
    const existing = verdicts.get(fingerprint);
    if (existing) {
      out.push({
        ...cell,
        status: "grouped",
        verdict: existing.verdict,
        fingerprint,
        ...(existing.name ? { itemName: existing.name } : {}),
        ...(existing.itemClass ? { itemClass: existing.itemClass } : {}),
      });
      continue;
    }
    const verdict = args.evaluate(text);
    let name: string | undefined;
    let itemClass: string | undefined;
    try {
      const parsed = parseItemText(text);
      name = parsed.name;
      itemClass = parsed.itemClass;
    } catch {
      // Verdict already accounts for unparseable text via the evaluator.
    }
    verdicts.set(fingerprint, { verdict, name, itemClass });
    out.push({
      ...cell,
      status: "copied",
      verdict,
      fingerprint,
      rawText: text,
      ...(name ? { itemName: name } : {}),
      ...(itemClass ? { itemClass } : {}),
    });
  }

  return {
    cells: out,
    copies,
    failures,
    distinctItems: verdicts.size,
    sweepMs: Date.now() - started,
    stopped,
  };
}

export type TriagePartition = Record<TriageTier, TriagedCell[]>;

/**
 * Split triaged cells by tier. "unknown" (including every failed copy)
 * always deposits normally — the invariant that keeps a bad OCR day from
 * vendoring someone's upgrade lives here and in evaluateValueTier.
 */
export function partitionTriage(cells: readonly TriagedCell[]): TriagePartition {
  const partition: TriagePartition = { keep: [], sell: [], dump: [], unknown: [] };
  for (const cell of cells) {
    partition[cell.verdict.tier].push(cell);
  }
  return partition;
}

export interface TriageRouting {
  /** Tab label receiving keep-tier items. */
  reviewTab: string;
  /** Tab label receiving dump-tier items. */
  dumpTab: string;
  /** Where sell-tier items go; defaults to the review tab. */
  sellTab?: string;
}

export const DEFAULT_TRIAGE_ROUTING: TriageRouting = {
  reviewTab: "Review",
  dumpTab: "Dump",
};

export interface TriageDeposit {
  tab: string;
  tier: TriageTier;
  cells: TriagedCell[];
}

/**
 * Deposit plan: one entry per destination tab that has cells. Unknown-tier
 * cells are NOT included — they belong to the caller's normal class deposit.
 */
export function planTriageDeposits(
  partition: TriagePartition,
  routing: TriageRouting = DEFAULT_TRIAGE_ROUTING,
): TriageDeposit[] {
  const deposits: TriageDeposit[] = [];
  if (partition.keep.length > 0) {
    deposits.push({ tab: routing.reviewTab, tier: "keep", cells: partition.keep });
  }
  if (partition.sell.length > 0) {
    deposits.push({ tab: routing.sellTab ?? routing.reviewTab, tier: "sell", cells: partition.sell });
  }
  if (partition.dump.length > 0) {
    deposits.push({ tab: routing.dumpTab, tier: "dump", cells: partition.dump });
  }
  return deposits;
}
