/**
 * Shadow validation for the build-aware decision layer — OFFLINE ONLY.
 *
 * Replays the clipboard bag snapshots the map runner already saved
 * (artifacts/map-triage/bag-read-*.json) and the checked-in item fixtures
 * through the same evaluator the live runner uses (loadTriageExport →
 * evaluateItemDecision), then reports what the decision layer WOULD do:
 * outcome counts, the discard proposals with their audit trail, the review
 * queue before/after, coverage gaps (lines the knowledge base cannot judge)
 * and decision latency.
 *
 *   npx tsx scripts/demand-shadow.ts             # every snapshot + fixtures
 *   npx tsx scripts/demand-shadow.ts --latest=3  # the newest three snapshots
 *   npx tsx scripts/demand-shadow.ts --json      # machine-readable summary too
 *
 * No game input, no network: the loader reads local files only and the
 * evaluator is pure. The report lands in artifacts/demand/shadow-<time>.md.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTriageExport } from "../src/adapters/triageLoader.js";
import { needsPriceReview, reviewReasonFor } from "../src/adapters/priceTrainingStore.js";
import { classifyBagRead, decideDrop } from "../src/core/mapTriage.js";
import { describeDecision } from "../src/core/itemDecision.js";
import type { TierVerdict } from "../src/core/valueTiers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const value = (name: string): string | undefined =>
  argv.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
const latest = Number(value("--latest") ?? Number.POSITIVE_INFINITY);
const asJson = argv.includes("--json");

interface Snapshot {
  file: string;
  at?: string;
  texts: string[];
}

function loadSnapshots(): Snapshot[] {
  const dir = path.join(root, "artifacts", "map-triage");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((name) => /^bag-read-\d+\.json$/.test(name))
    .sort()
    .slice(-Math.max(1, Math.min(latest, 1_000)));
  return files.map((name) => {
    const parsed = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as {
      at?: string;
      cells?: Array<{ text?: string }>;
    };
    const seen = new Set<string>();
    const texts: string[] = [];
    for (const cell of parsed.cells ?? []) {
      const text = typeof cell.text === "string" ? cell.text : "";
      if (!text.trim() || seen.has(text)) continue;
      seen.add(text);
      texts.push(text);
    }
    return { file: name, ...(parsed.at ? { at: parsed.at } : {}), texts };
  });
}

function loadFixtures(): Snapshot {
  const dir = path.join(root, "fixtures", "items");
  const texts = readdirSync(dir)
    .filter((name) => name.endsWith(".txt"))
    .map((name) => readFileSync(path.join(dir, name), "utf8"));
  return { file: "fixtures/items", texts };
}

interface Row {
  source: string;
  name: string;
  itemClass: string;
  rarity: string;
  tier: TierVerdict["tier"];
  verdictSource: TierVerdict["source"];
  outcome: string;
  headline: string;
  retainedByDefault: boolean;
  wouldDropWithOptIn: boolean;
  queuedBefore: boolean;
  queuedAfter: boolean;
  reviewReason?: string;
  unsupported: string[];
  summary: string;
  ms: number;
}

/** The legacy queue rule: unknown tier (or a heuristic promotion without a price). */
function queuedLegacy(verdict: TierVerdict): boolean {
  if (verdict.source === "safety") return false;
  return verdict.tier === "unknown" ||
    verdict.training?.status === "stale" || verdict.training?.status === "conflict" ||
    (verdict.source === "heuristic" && !verdict.appraisal?.estimatedValue);
}

const triage = loadTriageExport(root, { log: (line) => console.log(`loader: ${line}`) });
const snapshots = [...loadSnapshots(), loadFixtures()];
const rows: Row[] = [];
// The same item sits in several consecutive snapshots; count it once.
const seenFingerprints = new Set<string>();
for (const snapshot of snapshots) {
  for (const text of snapshot.texts) {
    const classified = classifyBagRead(text);
    if (classified.kind !== "identified-gear" || !classified.parsed) continue;
    if (seenFingerprints.has(classified.parsed.fingerprint)) continue;
    seenFingerprints.add(classified.parsed.fingerprint);
    const started = process.hrtime.bigint();
    const verdict = triage.evaluate(text);
    const ms = Number(process.hrtime.bigint() - started) / 1_000_000;
    const decision = verdict.decision;
    rows.push({
      source: snapshot.file,
      name: classified.parsed.name || classified.parsed.baseType,
      itemClass: classified.parsed.itemClass,
      rarity: classified.parsed.rarity,
      tier: verdict.tier,
      verdictSource: verdict.source,
      outcome: decision?.outcome ?? "(none)",
      headline: decision?.headline ?? verdict.reasons[0] ?? "",
      retainedByDefault: !decideDrop(verdict, true).drop,
      wouldDropWithOptIn: decideDrop(verdict, false).drop,
      queuedBefore: queuedLegacy(verdict),
      queuedAfter: needsPriceReview(verdict),
      ...(needsPriceReview(verdict) ? { reviewReason: reviewReasonFor(verdict) } : {}),
      unsupported: decision?.coverage.unsupported ?? [],
      summary: describeDecision(decision),
      ms: Math.round(ms * 100) / 100,
    });
  }
}

const count = (predicate: (row: Row) => boolean): number => rows.filter(predicate).length;
const outcomes = ["keep", "list", "review", "discard-eligible"] as const;
const summary = {
  generatedAt: new Date().toISOString(),
  rules: triage.source,
  tierKnowledge: triage.tierKnowledge,
  snapshots: snapshots.map((snapshot) => ({ file: snapshot.file, items: snapshot.texts.length, ...(snapshot.at ? { at: snapshot.at } : {}) })),
  identifiedGearEvaluated: rows.length,
  outcomes: Object.fromEntries(outcomes.map((outcome) => [outcome, count((row) => row.outcome === outcome)])),
  retainedByDefault: count((row) => row.retainedByDefault),
  discardProposals: count((row) => row.wouldDropWithOptIn),
  reviewQueueBefore: count((row) => row.queuedBefore),
  reviewQueueAfter: count((row) => row.queuedAfter),
  resolvedLocallyAfter: count((row) => !row.queuedAfter),
  itemsWithUnjudgedLines: count((row) => row.unsupported.length > 0),
  latencyMs: {
    mean: rows.length ? Math.round((rows.reduce((total, row) => total + row.ms, 0) / rows.length) * 100) / 100 : 0,
    max: rows.reduce((max, row) => Math.max(max, row.ms), 0),
  },
  liveLookups: 0,
  networkRequests: 0,
};

const unjudged = new Map<string, number>();
for (const row of rows) for (const line of row.unsupported) unjudged.set(line, (unjudged.get(line) ?? 0) + 1);
const gaps = [...unjudged.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);

const lines: string[] = [];
lines.push(`# Decision-layer shadow replay — ${summary.generatedAt}`);
lines.push("");
lines.push("Offline replay of saved bag snapshots and checked-in fixtures through the live evaluator. No game input, no network request, no trade2 lookup.");
lines.push("");
lines.push(`- Rules: ${summary.rules}; learned tiers ${summary.tierKnowledge.learnedTiers ? "on" : "off"}, stat ids ${summary.tierKnowledge.statIds ? "on" : "off"}.`);
lines.push(`- Snapshots: ${summary.snapshots.map((snapshot) => `${snapshot.file} (${snapshot.items} items)`).join(", ")}.`);
lines.push(`- Identified gear evaluated: ${summary.identifiedGearEvaluated}.`);
lines.push(`- Outcomes: ${outcomes.map((outcome) => `${outcome} ${summary.outcomes[outcome]}`).join(" · ")}.`);
lines.push(`- Retained by the default policy: ${summary.retainedByDefault}/${rows.length}; discard proposals (would drop only with --drop-unknown): ${summary.discardProposals}.`);
lines.push(`- Review queue: ${summary.reviewQueueBefore} before → ${summary.reviewQueueAfter} after; resolved locally ${summary.resolvedLocallyAfter}/${rows.length}.`);
lines.push(`- Items with lines the knowledge base cannot judge: ${summary.itemsWithUnjudgedLines}.`);
lines.push(`- Decision latency: mean ${summary.latencyMs.mean} ms, max ${summary.latencyMs.max} ms per item.`);
lines.push("");
lines.push("## Discard proposals (shadow — nothing was dropped)");
lines.push("");
const proposals = rows.filter((row) => row.wouldDropWithOptIn);
if (proposals.length === 0) lines.push("_none_");
for (const row of proposals) lines.push(`- ${row.name} (${row.rarity} ${row.itemClass}, ${row.source}): ${row.headline}`);
lines.push("");
lines.push("## Review queue after (priority-tagged)");
lines.push("");
for (const row of rows.filter((entry) => entry.queuedAfter)) lines.push(`- ${row.name} (${row.rarity} ${row.itemClass}): ${row.reviewReason}`);
lines.push("");
lines.push("## Knowledge gaps (affix lines nothing recognised)");
lines.push("");
if (gaps.length === 0) lines.push("_none_");
for (const [line, n] of gaps) lines.push(`- ${n}× ${line}`);
lines.push("");
lines.push("## Every decision");
lines.push("");
lines.push("| item | class | tier/source | outcome | default | headline |");
lines.push("|---|---|---|---|---|---|");
for (const row of rows) {
  lines.push(`| ${row.name} | ${row.rarity} ${row.itemClass} | ${row.tier}/${row.verdictSource} | ${row.outcome} | ${row.retainedByDefault ? "retained" : "DROP"} | ${row.headline.replace(/\|/g, "/")} |`);
}
lines.push("");
lines.push("Distinct items (deduplicated by fingerprint across snapshots). Unique-tier items are kept by the 'Any unique' rule; the any-unique price row is a placeholder and no price is shown for them.");

const outDir = path.join(root, "artifacts", "demand");
mkdirSync(outDir, { recursive: true });
const stamp = summary.generatedAt.replace(/[:.]/g, "-");
const reportFile = path.join(outDir, `shadow-${stamp}.md`);
writeFileSync(reportFile, `${lines.join("\n")}\n`);
if (asJson) writeFileSync(path.join(outDir, `shadow-${stamp}.json`), JSON.stringify({ summary, rows }, null, 2));

console.log(lines.slice(0, 12).join("\n"));
console.log("");
for (const row of rows) {
  console.log(`  · ${row.name.padEnd(28)} ${(row.rarity + " " + row.itemClass).padEnd(24)} ${row.outcome.padEnd(17)} ${row.retainedByDefault ? "retained" : "DROP    "} ${row.summary}`);
}
console.log(`\nreport: ${path.relative(root, reportFile)}`);
