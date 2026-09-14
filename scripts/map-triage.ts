/** Staged bag worker. Offline imports never initialize game or market adapters. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
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
import { StashValuationService } from "../src/main/stashValuationService.js";
import type { CalibrationProfile } from "../src/core/calibrationProfile.js";

/** Resolve existing links, including a linked parent of a not-yet-created output. */
function bagPathIdentity(file: string): { canonical: string; inode?: string } {
  const absolute = path.resolve(file);
  let ancestor = absolute;
  const missing: string[] = [];
  let canonical: string;
  while (true) {
    try { canonical = path.resolve(realpathSync.native(ancestor), ...missing); break; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw new Error("Bag paths could not be validated before output.", { cause: error });
      const parent = path.dirname(ancestor);
      if (parent === ancestor) { canonical = absolute; break; }
      missing.unshift(path.basename(ancestor)); ancestor = parent;
    }
  }
  let inode: string | undefined;
  try { const stat = statSync(absolute, { bigint: true }); if (stat.ino !== 0n) inode = `${stat.dev}:${stat.ino}`; } catch { /* A new output has no inode yet. */ }
  return { canonical: canonical.toLowerCase(), inode };
}

function assertBagPaths(writes: Record<string, string>, inputs: Record<string, string | undefined>): void {
  const destinations = Object.entries(writes).map(([label, file]) => ({ label, ...bagPathIdentity(file) }));
  const sources = Object.entries(inputs).filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([label, file]) => ({ label, ...bagPathIdentity(file) }));
  for (let i = 0; i < destinations.length; i++) {
    const destination = destinations[i]!;
    for (const other of [...destinations.slice(i + 1), ...sources]) {
      if (destination.canonical === other.canonical || destination.inode && destination.inode === other.inode)
        throw new Error(`Bag path collision: ${destination.label} must be separate from ${other.label}. No host or output started.`);
    }
  }
}

async function main() {
  const args = parseBagTriageArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Bag triage: --from-scan=FILE [--output=FILE] (offline reassessment)\n" +
      "Replay: --replay=FILE --stage=capture|identify|drop|reconcile --journal=FILE [--max-drops=1]\n" +
      "Capture includes every physical bag item. Compaction is disabled. Market requests are separate.\n" +
      "Live: --stage=capture|identify|drop|reconcile --journal=FILE [--run] [--max-identifications=1] [--max-drops=1]\n" +
      "Calibration: --calibration=FILE --perception=FILE --client-log=FILE. Num0 / Ctrl+Shift+Esc stops; Num5 pauses.\n" +
      "Identify/drop require --run. Unrecognized cursor art stops with recorded evidence; no blind recovery.");
    return;
  }
  const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const root = path.resolve(process.env.POE2_BAG_DATA_ROOT ?? process.env.POE2_STASH_DATA_ROOT ?? runtimeRoot);
  const out = path.join(root, "artifacts", "map-triage");
  const output = path.resolve(args.output ?? path.join(out, "assessment.json"));
  const journalFile = path.resolve(args.journal ?? path.join(out, "session.jsonl"));
  const templates = path.join(process.env.APPDATA ?? root, "poe2-trade-companion", "perception-templates");
  const calibrationFile = path.resolve(args.calibration ?? path.join(templates, "calibration.json"));
  const perceptionFile = path.resolve(args.perception ?? path.join(out, "live-perception.json"));
  const clientLog = path.resolve(args.clientLog ?? "C:/Program Files (x86)/Steam/steamapps/common/Path of Exile 2/logs/Client.txt");
  assertBagPaths({ output, "temporary output": output + ".tmp", journal: journalFile, "journal lock": journalFile + ".lock" },
    { calibration: calibrationFile, perception: perceptionFile, "client log": clientLog, replay: args.replay, "original capture": args.fromScan });
  const print = (report: StashValuationReport, nativeInputs = 0) => {
    const decisions = report.rows.map(row => bagDecision(row, report));
    console.log(JSON.stringify({ batch: report.id, league: report.league, model: report.scoreVersion,
      knowledge: knowledgeForReport(report).id, physicalItems: report.rows.length, unreadCells: report.unreadCells.length,
      decisions, marketRequests: 0, nativeInputs, output }));
  };
  if (args.stage === "assess") {
    const input = path.resolve(args.fromScan!);
    const candidate: unknown = JSON.parse(readFileSync(input, "utf8"));
    const errors = validateSavedStashReport(candidate);
    if (errors.length) throw new Error(errors.join(" "));
    const saved = candidate as StashValuationReport;
    const report = assessBatch(saved, saved.settings, new Date().toISOString(), knowledgeForReport(saved));
    writeBatchReport(output, report); print(report); return;
  }
  const previous = readBagJournal(journalFile).at(-1)?.session;
  if (args.stage !== "capture" && !previous) throw new Error("No saved bag session. Capture first.");
  if (args.stage === "capture" && previous) throw new Error("Choose a new journal for a new physical bag capture.");
  if (previous) validateBagSession(previous);
  if (!args.replay) {
    if (previous?.origin === "replay") throw new Error("Live input cannot use a replay session journal.");
    for (const file of [calibrationFile, perceptionFile, clientLog]) if (!existsSync(file)) throw new Error("Live bag calibration/evidence file missing: " + file + ". No native host started.");
    const calibration = JSON.parse(readFileSync(calibrationFile, "utf8")) as CalibrationProfile;
    const { openLiveBag, readBagLivePerception } = await import("../src/adapters/liveBag.js");
    readBagLivePerception(perceptionFile, calibration);
    const service = new StashValuationService(root), overview = service.overview();
    if (overview.issues.length) throw new Error(overview.issues.join(" "));
    const settings = { ...overview.settings, captureSource: "inventory" as const };
    const knowledge = service.knowledge(settings);
    const journal = openBagJournal(journalFile);
    let live: ReturnType<typeof openLiveBag> | undefined;
    try {
      live = openLiveBag({ directory: journalFile + ".evidence", calibration, perceptionFile, clientLog, previous,
        save: session => journal.save(session), progress: message => console.error(message) });
      await live.activate();
      const adapter = live;
      const session = args.stage === "capture" ? await (async () => {
        const scene = await adapter.ports.observe();
        const report = captureBagObservations(path.basename(journalFile, path.extname(journalFile)), scene.cells, settings, scene.at, knowledge);
        const session = createBagSession(report, scene, "live"); journal.save(session); return session;
      })() : await runBagStage(previous!, args.stage, live.ports, { maxDrops: args.maxDrops, maxIdentifications: args.maxIdentifications });
      writeBatchReport(output, session.report); print(session.report, live.inputCount);
      console.log(JSON.stringify({ origin: "live", verifiedIdentifications: session.identifiedIds.length, verifiedDrops: session.droppedIds.length, journal: journalFile }));
    } finally { try { await live?.close(); } finally { journal.close(); } }
    return;
  }
  if (previous?.origin === "live") throw new Error("Replay cannot mutate a live session journal.");
  const replayFile = path.resolve(args.replay);
  const steps: unknown = JSON.parse(readFileSync(replayFile, "utf8"));
  validateBagReplay(steps);
  const journal = openBagJournal(journalFile);
  try {
    const replay = bagReplay(steps, session => journal.save(session));
    const session = args.stage === "capture" ? await (async () => {
      const scene = await replay.ports.observe();
      const report = captureBagObservations(path.basename(journalFile, path.extname(journalFile)), scene.cells, undefined, scene.at);
      const session = createBagSession(report, scene, "replay"); journal.save(session); return session;
    })() : await runBagStage(previous!, args.stage, replay.ports, { maxDrops: args.maxDrops, maxIdentifications: args.maxIdentifications });
    replay.assertConsumed();
    writeBatchReport(output, session.report); print(session.report);
    console.log(JSON.stringify({ origin: "replay", verifiedIdentifications: session.identifiedIds.length,
      verifiedDrops: session.droppedIds.length, simulatedActions: replay.actions.length, journal: journalFile }));
  } finally { journal.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
