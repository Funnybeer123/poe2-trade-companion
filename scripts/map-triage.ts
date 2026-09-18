/** Staged bag worker. Offline imports never initialize game or market adapters. */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { parseBagTriageArgs } from "../src/core/bagTriageArgs.js";
import { assessBatch } from "../src/core/batchTriage.js";
import { bagDecision, captureBagObservations } from "../src/core/bagAssessment.js";
import { createBagSession, runBagStage, validateBagSession, type BagSession, type BagSessionPorts } from "../src/core/bagSession.js";
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

const percentile = (values: number[], q: number) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))] : undefined;
const median = (values: number[]) => percentile(values, .5);

async function main() {
  const args = parseBagTriageArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Bag triage: --from-scan=FILE [--output=FILE] (offline reassessment)\n" +
      "Identify & drop: --run [--max-identifications=59] [--max-drops=59] (new capture, then verified identification and drops)\n" +
      "Replay: --replay=FILE --stage=workflow|capture|identify|drop|reconcile --journal=FILE\n" +
      "Capture includes every physical bag item. Compaction is disabled. Market requests are separate.\n" +
      "Diagnostics: --stage=capture|identify|drop|reconcile --journal=FILE [--run] [--max-identifications=1] [--max-drops=1]\n" +
      "Calibration: --calibration=FILE --perception=FILE --client-log=FILE. Num0 / Ctrl+Shift+Esc stops; Num5 pauses.\n" +
      "Workflow/identify/drop require --run. Unrecognized cursor art stops with recorded evidence; no blind recovery.");
    return;
  }
  const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const desktopRoot = process.platform === "win32" && process.env.APPDATA ? path.join(process.env.APPDATA, "poe2-trade-companion") : runtimeRoot;
  const root = path.resolve(process.env.POE2_BAG_DATA_ROOT ?? process.env.POE2_STASH_DATA_ROOT ?? desktopRoot);
  const out = path.join(root, "artifacts", "map-triage");
  const output = path.resolve(args.output ?? path.join(out, "assessment.json"));
  const journalFile = path.resolve(args.journal ?? path.join(out, args.stage === "workflow" ? `bag-${Date.now()}-${randomUUID()}.jsonl` : "session.jsonl"));
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
  const newCapture = args.stage === "capture" || args.stage === "workflow";
  if (!newCapture && !previous) throw new Error("No saved bag session. Capture first.");
  if (newCapture && previous) throw new Error("Choose a new journal for a new physical bag capture; an existing or pending session cannot restart as a workflow.");
  if (previous) validateBagSession(previous);
  const execute = async (ports: BagSessionPorts, origin: BagSession["origin"], settings?: StashValuationReport["settings"],
    knowledge?: ReturnType<typeof knowledgeForReport>) => {
    let session = previous;
    if (newCapture) {
      const scene = await ports.observe();
      const report = captureBagObservations(path.basename(journalFile, path.extname(journalFile)), scene.cells, settings, scene.at, knowledge);
      session = createBagSession(report, scene, origin); ports.save(session);
    }
    const limits = { maxDrops: args.maxDrops, maxIdentifications: args.maxIdentifications };
    if (args.stage === "workflow") {
      // Retain the adapter's image/text cache and durable session across phases.
      session = await runBagStage(session!, "identify", ports, limits);
      session = await runBagStage(session, "drop", ports, limits);
    } else if (args.stage === "identify" || args.stage === "drop" || args.stage === "reconcile") session = await runBagStage(session!, args.stage, ports, limits);
    return session!;
  };
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
    if (args.stage === "workflow") {
      // Normal one-action path: one read per physical item, one Shift-held Wisdom
      // chain, serially verified drops. The staged stages below stay as diagnostics.
      const { openLiveBagFast } = await import("../src/adapters/liveBagFast.js");
      const { runFastBag } = await import("../src/core/bagFastRun.js");
      const { openBagFastLog } = await import("../src/main/bagFastLog.js");
      const started = Date.now(), evidence = journalFile + ".evidence";
      let fast: ReturnType<typeof openLiveBagFast> | undefined, actions: ReturnType<typeof openBagFastLog> | undefined;
      try {
        actions = openBagFastLog(journalFile + ".actions.log");
        fast = openLiveBagFast({ directory: evidence, calibration, perceptionFile, clientLog, record: entry => actions!.record(entry),
          saveSession: session => journal.save(session), progress: message => console.error(message) });
        await fast.activate();
        const ready = Date.now();
        const result = await runFastBag({ id: path.basename(journalFile, path.extname(journalFile)), origin: "live", settings, knowledge,
          maxIdentifications: args.maxIdentifications, maxDrops: args.maxDrops }, fast.ports);
        const session = result.session;
        writeBatchReport(output, session.report); print(session.report, fast.inputCount);
        for (const note of result.notes) console.error(note);
        const timing = { startupMs: ready - started, ...result.timing, endToEndMs: Date.now() - started, readMs: undefined, dropItemMs: undefined,
          medianReadMs: median(result.timing.readMs), p95ReadMs: percentile(result.timing.readMs, .95), medianDropMs: median(result.timing.dropItemMs), p95DropMs: percentile(result.timing.dropItemMs, .95) };
        writeFileSync(journalFile + ".timing.json", JSON.stringify({ ...timing, tuning: fast.tuning, readMs: result.timing.readMs, dropItemMs: result.timing.dropItemMs,
          physicalItems: session.report.rows.length, scrollsUsed: result.scrollsUsed, leftUnidentified: result.leftUnidentified.length }, null, 2));
        console.log(JSON.stringify({ origin: "live", verifiedIdentifications: session.identifiedIds.length, verifiedDrops: session.droppedIds.length,
          scrollsUsed: result.scrollsUsed, leftUnidentified: result.leftUnidentified.length, timing, journal: journalFile }));
      } finally { try { await fast?.close(); } finally { actions?.close(); journal.close(); } }
      return;
    }
    let live: ReturnType<typeof openLiveBag> | undefined;
    try {
      live = openLiveBag({ directory: journalFile + ".evidence", calibration, perceptionFile, clientLog, previous,
        save: session => journal.save(session), progress: message => console.error(message) });
      await live.activate();
      const session = await execute(live.ports, "live", settings, knowledge);
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
    const session = await execute(replay.ports, "replay");
    replay.assertConsumed();
    writeBatchReport(output, session.report); print(session.report);
    console.log(JSON.stringify({ origin: "replay", verifiedIdentifications: session.identifiedIds.length,
      verifiedDrops: session.droppedIds.length, simulatedActions: replay.actions.length, journal: journalFile }));
  } finally { journal.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
