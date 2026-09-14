/** Private saved-batch regression. This script has no game or market adapter. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { assessBatch } from "../src/core/batchTriage.js";
import { bagDecision } from "../src/core/bagAssessment.js";
import { knowledgeForReport } from "../src/core/leagueKnowledge.js";
import { validateSavedStashReport } from "../src/core/savedStashPricing.js";
import type { StashValuationReport } from "../src/core/stashValuation.js";

const args = process.argv.slice(2);
if (args.length !== 2 || !args[0]?.startsWith("--from-scan=") || !args[1]?.startsWith("--output-dir=")) throw new Error("Use --from-scan=FILE --output-dir=IGNORED_DIRECTORY.");
const input = path.resolve(args[0].slice(12)), dir = path.resolve(args[1].slice(13));
const source = readFileSync(input, "utf8"), saved = JSON.parse(source) as StashValuationReport;
const errors = validateSavedStashReport(saved); if (errors.length) throw new Error(errors.join(" "));
const at = new Date().toISOString(), report = assessBatch(saved, saved.settings, at, knowledgeForReport(saved));
const projections = report.rows.map(row => {
  // Policy projection only. These are not live positions or an executable bag session.
  const projected = { ...row, sourceKind: "inventory" as const, sourceTab: "Inventory", row: 0, col: 1, cells: [{ row: 0, col: 1 }] };
  const scope: StashValuationReport = { ...report, settings: { ...report.settings, captureSource: "inventory" },
    rows: [projected], scannedItems: 1, unreadCells: [], capture: { ...report.capture!, complete: true } };
  const decision = bagDecision(projected, scope, at);
  if (["keep", "craft", "review"].includes(row.assessment!.outcome)) assert.notEqual(decision.action, "drop", "False discard for " + row.id);
  const original = saved.rows.find(r => r.id === row.id)!;
  assert.equal(row.rawText, original.rawText); assert.deepEqual(row.quote, original.quote);
  if (["moved", "failed"].includes(original.status)) {
    assert.equal(row.status, original.status); assert.equal(row.actualDestination, original.actualDestination);
    for (const reason of original.reasons) assert(row.reasons.includes(reason));
    assert.notEqual(decision.action, "drop");
  }
  return { id: row.id, outcome: row.assessment!.outcome, policyProjection: decision.action };
});
assert.equal(readFileSync(input, "utf8"), source);
const counts = (values: string[]) => values.reduce<Record<string, number>>((out, key) => { out[key] = (out[key] ?? 0) + 1; return out; }, {});
const summary = { at, sourceHash: createHash("sha256").update(source).digest("hex"), originalsUnchanged: true,
  physicalItems: report.rows.length, outcomes: counts(projections.map(p => p.outcome)), policyProjections: counts(projections.map(p => p.policyProjection)),
  historicalMovedReceipts: report.rows.filter(r => r.status === "moved").length, falseDiscards: 0, nativeInputs: 0, marketRequests: 0,
  note: "Projected positions test policy only; they are not live locations. Original reports and historical receipts remain intact." };
mkdirSync(dir, { recursive: true });
for (const [name, value] of Object.entries({ "assessment.json": report, "policy-projections.json": projections, "summary.json": summary })) {
  const output = path.join(dir, name);
  if (output.toLowerCase() === input.toLowerCase()) throw new Error("Cannot overwrite original capture.");
  writeFileSync(output, JSON.stringify(value, null, 2));
}
console.log(JSON.stringify(summary, null, 2));
