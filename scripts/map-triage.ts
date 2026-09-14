/** Staged bag worker. Offline imports never initialize game or market adapters. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { parseBagTriageArgs } from "../src/core/bagTriageArgs.js";
import { assessBatch } from "../src/core/batchTriage.js";
import { bagDecision, captureBagObservations } from "../src/core/bagAssessment.js";
import { createBagSession, runBagStage, validateBagSession } from "../src/core/bagSession.js";
import { knowledgeForReport } from "../src/core/leagueKnowledge.js";
import { validateSavedStashReport } from "../src/core/savedStashPricing.js";
import type { StashValuationReport } from "../src/core/stashValuation.js";
import { bagReplay, validateBagReplay } from "../src/adapters/bagReplay.js";
import { openBagJournal, readBagJournal } from "../src/main/bagSessionStore.js";
import { writeBatchReport } from "../src/main/batchReportStore.js";

async function main() {
  const args = parseBagTriageArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Bag triage: --from-scan=FILE [--output=FILE] (offline reassessment)\n" +
      "Replay: --replay=FILE --stage=capture|identify|drop|reconcile --journal=FILE [--max-drops=1]\n" +
      "Capture includes every physical bag item. Compaction is disabled. Market requests are separate.\n" +
      "Live adapter is not ready: map-context, ground and cursor evidence must be validated first.");
    return;
  }
  const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const root = path.resolve(process.env.POE2_BAG_DATA_ROOT ?? process.env.POE2_STASH_DATA_ROOT ?? runtimeRoot);
  const out = path.join(root, "artifacts", "map-triage");
  const output = path.resolve(args.output ?? path.join(out, "assessment.json"));
  const print = (report: StashValuationReport) => {
    const decisions = report.rows.map(row => bagDecision(row, report));
    console.log(JSON.stringify({ batch: report.id, league: report.league, model: report.scoreVersion,
      knowledge: knowledgeForReport(report).id, physicalItems: report.rows.length, unreadCells: report.unreadCells.length,
      decisions, marketRequests: 0, nativeInputs: 0, output }));
  };
  if (args.stage === "assess") {
    const input = path.resolve(args.fromScan!);
    if (input.toLowerCase() === output.toLowerCase()) throw new Error("Choose a separate output; original captures are immutable.");
    const candidate: unknown = JSON.parse(readFileSync(input, "utf8"));
    const errors = validateSavedStashReport(candidate);
    if (errors.length) throw new Error(errors.join(" "));
    const saved = candidate as StashValuationReport;
    const report = assessBatch(saved, saved.settings, new Date().toISOString(), knowledgeForReport(saved));
    writeBatchReport(output, report); print(report); return;
  }
  const journalFile = path.resolve(args.journal ?? path.join(out, "session.jsonl"));
  const previous = readBagJournal(journalFile).at(-1)?.session;
  if (args.stage !== "capture" && !previous) throw new Error("No saved bag session. Capture first.");
  if (args.stage === "capture" && previous) throw new Error("Choose a new journal for a new physical bag capture.");
  if (previous) validateBagSession(previous);
  if (!args.replay) {
    // This is deliberately checked before importing/starting any input host.
    // Position-only cursor APIs and absence of stash are insufficient evidence.
    throw new Error("Live bag testing is NOT ready: verified map-instance, modal/death, ground and cursor-held perception is missing. " +
      "No native host or game input started. Complete perception/cancellation validation before enabling live stages; see docs/BAG_TRIAGE_VALIDATION.md.");
  }
  if (previous?.origin === "live") throw new Error("Replay cannot mutate a live session journal.");
  const replayFile = path.resolve(args.replay);
  if ([output, journalFile, journalFile + ".lock"].some(p => p.toLowerCase() === replayFile.toLowerCase())) throw new Error("Replay input must be separate from outputs.");
  const steps: unknown = JSON.parse(readFileSync(replayFile, "utf8"));
  validateBagReplay(steps);
  const journal = openBagJournal(journalFile);
  try {
    const replay = bagReplay(steps, session => journal.save(session));
    const session = args.stage === "capture" ? await (async () => {
      const scene = await replay.ports.observe();
      const report = captureBagObservations(path.basename(journalFile, path.extname(journalFile)), scene.cells, undefined, scene.at);
      const session = createBagSession(report, scene, "replay"); journal.save(session); return session;
    })() : await runBagStage(previous!, args.stage, replay.ports, args.maxDrops);
    replay.assertConsumed();
    writeBatchReport(output, session.report); print(session.report);
    console.log(JSON.stringify({ origin: "replay", verifiedIdentifications: session.identifiedIds.length,
      verifiedDrops: session.droppedIds.length, simulatedActions: replay.actions.length, journal: journalFile }));
  } finally { journal.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
