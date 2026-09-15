/**
 * The dated, labelled evaluation set for the build-aware decision layer
 * (fixtures/demand/eval-set.json). Every entry's expected outcome is checked
 * under the starter rules and starter price table; "retained" entries only
 * assert the default runner keeps them. The suite also prints the before /
 * after review burden so docs/features/build-demand.md can quote it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateWithAppraisal } from "../src/core/appraisal.js";
import { evaluateItemDecision, type DecisionOutcome } from "../src/core/itemDecision.js";
import { decideDrop } from "../src/core/mapTriage.js";
import { starterPriceTable } from "../src/core/priceTable.js";
import type { PriceLesson } from "../src/core/priceTraining.js";
import { starterValueTierRules, type TierVerdict } from "../src/core/valueTiers.js";
import { needsPriceReview } from "../src/adapters/priceTrainingStore.js";

interface EvalEntry {
  id: string;
  file?: string;
  text?: string;
  group: string;
  split: "tune" | "holdout";
  label: "keep" | "list" | "review" | "discard" | "retained";
  labelSource: string;
  training?: boolean;
  notes?: string;
}

interface EvalSet {
  version: string;
  league: string;
  entries: EvalEntry[];
}

const NOW = new Date("2026-09-14T22:00:00Z");
const ROOT = process.cwd();
const SET: EvalSet = JSON.parse(readFileSync(path.join(ROOT, "fixtures", "demand", "eval-set.json"), "utf8"));

function textOf(entry: EvalEntry): string {
  if (entry.text) return entry.text;
  return readFileSync(path.join(ROOT, "fixtures", entry.file!), "utf8");
}

const SAPPHIRE = readFileSync(path.join(ROOT, "fixtures", "items", "chilling-sapphire-training.txt"), "utf8");
const LESSON: PriceLesson = {
  id: "sapphire-lesson", itemText: SAPPHIRE, league: SET.league, amount: 1, currency: "divine", evidence: "estimate",
  scope: "exact", createdAt: "2026-09-14T12:00:00Z", updatedAt: "2026-09-14T12:00:00Z",
};

function evaluate(entry: EvalEntry): TierVerdict {
  return evaluateItemDecision(textOf(entry), {
    rules: starterValueTierRules(),
    priceTable: starterPriceTable(),
    now: NOW,
    ...(entry.training ? { training: { league: SET.league, lessons: [LESSON], now: NOW } } : {}),
  });
}

/** What the runner did before the decision layer: keep/sell retained, dump dropped, unknown → review queue. */
function legacyOutcome(entry: EvalEntry): DecisionOutcome {
  const verdict = evaluateWithAppraisal(textOf(entry), {
    rules: starterValueTierRules(),
    priceTable: starterPriceTable(),
    ...(entry.training ? { training: { league: SET.league, lessons: [LESSON], now: NOW } } : {}),
  });
  if (verdict.tier === "keep") return "keep";
  if (verdict.tier === "sell") return "list";
  if (verdict.tier === "dump") return "discard-eligible";
  return "review";
}

const expectedOutcome: Record<Exclude<EvalEntry["label"], "retained">, DecisionOutcome> = {
  keep: "keep",
  list: "list",
  review: "review",
  discard: "discard-eligible",
};

describe(`demand evaluation set ${SET.version}`, () => {
  it("has unique ids, valid splits and a readable text for every entry", () => {
    const ids = new Set<string>();
    for (const entry of SET.entries) {
      expect(ids.has(entry.id), entry.id).toBe(false);
      ids.add(entry.id);
      expect(["tune", "holdout"]).toContain(entry.split);
      expect(textOf(entry)).toMatch(/^Item Class:/);
      expect(entry.labelSource.length).toBeGreaterThan(10);
    }
    expect(SET.entries.filter((entry) => entry.split === "holdout").length).toBeGreaterThanOrEqual(8);
  });

  it.each(SET.entries.map((entry) => [entry.id, entry] as const))("%s", (_id, entry) => {
    const verdict = evaluate(entry);
    const outcome = verdict.decision?.outcome ?? "review";
    if (entry.label === "retained") {
      // Unlabelled live items: the default policy must keep them, and no
      // label is manufactured — only a discard would be a false discard.
      expect(decideDrop(verdict, true).drop).toBe(false);
      return;
    }
    expect(outcome, `${entry.id} (${entry.labelSource})`).toBe(expectedOutcome[entry.label]);
    if (entry.label === "discard") {
      expect(verdict.decision?.discard?.eligible).toBe(true);
    } else {
      expect(decideDrop(verdict, false).drop).toBe(false);
    }
    if (entry.id === "synthetic-normal-high-body") {
      expect(verdict.decision?.reasons.join(" ")).toMatch(/Conflict: your dump rule wins over crafting potential/);
    }
    if (entry.id === "synthetic-body-spirit-life") {
      expect(verdict.decision?.reasons.join(" ")).toMatch(/Conflict: your sell rule wins over a chase demand match/);
    }
    if (entry.id === "synthetic-unique-widowhail") {
      expect(verdict.price).toBeUndefined();
      expect(verdict.appraisal?.estimatedValue).toBeUndefined();
    }
  });

  it("makes zero false discards and resolves most items locally (report)", () => {
    const rows = SET.entries.map((entry) => {
      const verdict = evaluate(entry);
      const outcome = verdict.decision?.outcome ?? "review";
      return {
        entry,
        outcome,
        legacy: legacyOutcome(entry),
        queuedNow: needsPriceReview(verdict),
        // A false discard needs a positive label; unlabelled "retained" items
        // are reported separately as proposals awaiting the user's verdict.
        falseDiscard: outcome === "discard-eligible" && entry.label !== "discard" && entry.label !== "retained",
        proposedOnRetained: outcome === "discard-eligible" && entry.label === "retained",
        unsupported: verdict.decision?.coverage.unsupported ?? [],
      };
    });
    const falseDiscards = rows.filter((row) => row.falseDiscard);
    expect(falseDiscards.map((row) => row.entry.id)).toEqual([]);
    // Every retained live item is still retained by the default policy.
    for (const row of rows.filter((entry) => entry.entry.label === "retained")) {
      expect(decideDrop(evaluate(row.entry), true).drop, row.entry.id).toBe(false);
    }

    const count = (predicate: (row: (typeof rows)[number]) => boolean): number => rows.filter(predicate).length;
    const report = {
      entries: rows.length,
      holdout: count((row) => row.entry.split === "holdout"),
      outcomes: {
        keep: count((row) => row.outcome === "keep"),
        list: count((row) => row.outcome === "list"),
        review: count((row) => row.outcome === "review"),
        discardEligible: count((row) => row.outcome === "discard-eligible"),
      },
      falseDiscards: falseDiscards.length,
      discardProposalsOnUnlabelledLiveItems: count((row) => row.proposedOnRetained),
      reviewQueueBefore: count((row) => row.legacy === "review"),
      reviewQueueAfter: count((row) => row.queuedNow),
      resolvedLocallyBefore: count((row) => row.legacy !== "review"),
      resolvedLocallyAfter: count((row) => !row.queuedNow),
      itemsWithUnjudgedLines: count((row) => row.unsupported.length > 0),
    };
    // The review burden must not grow, and at least half the set resolves without a human.
    expect(report.reviewQueueAfter).toBeLessThanOrEqual(report.reviewQueueBefore);
    expect(report.resolvedLocallyAfter / report.entries).toBeGreaterThanOrEqual(0.5);
    console.log(`demand eval set ${SET.version}: ${JSON.stringify(report)}`);
    for (const row of rows) {
      console.log(`  ${row.entry.split.padEnd(7)} ${row.entry.id.padEnd(36)} ${row.legacy.padEnd(16)} → ${row.outcome}${row.entry.label === "retained" ? " (retained, unlabelled)" : ""}`);
    }
  });
});
