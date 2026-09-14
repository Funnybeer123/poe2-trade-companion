/**
 * Capture is local by default. --from-scan=FILE reassesses offline.
 * --price --from-scan=FILE resumes a selected budgeted queue.
 * --move --from-scan=FILE revalidates locations and performs verified transfers.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { startWinHost } from "../src/adapters/winHost.js";
import { StashTabKit } from "../src/adapters/stashTabKit.js";
import { GearSorter } from "../src/adapters/gearSorter.js";
import { SortHarness } from "../src/adapters/sortHarness.js";
import { loadProfile } from "../src/core/calibrationStore.js";
import { captureBatch, sortSavedBatch } from "../src/core/batchCapture.js";
import { assessBatch } from "../src/core/batchTriage.js";
import { runSavedStashPricing, validateSavedStashReport } from "../src/core/savedStashPricing.js";
import { defaultStashValuationSettings, validateStashValuationSettings, type StashValuationReport, type StashValuationSettings } from "../src/core/stashValuation.js";
import { PriceFeedService } from "../src/main/priceFeedService.js";
import { writeBatchReport } from "../src/main/batchReportStore.js";
import { StashValuationService } from "../src/main/stashValuationService.js";
import { validateLeagueKnowledge } from "../src/core/leagueKnowledge.js";

async function main(): Promise<void> {
const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = process.env.POE2_STASH_DATA_ROOT ? path.resolve(process.env.POE2_STASH_DATA_ROOT) : runtimeRoot;
const outDir = path.join(root, "artifacts", "tab-admin");
const argv = process.argv.slice(2);
const value = (name: string) => argv.find(arg => arg.startsWith(name + "="))?.slice(name.length + 1);
const booleans = ["--move", "--price", "--pending-only", "--craft-only", "--dry-run", "--step", "--resume-capture"];
const valued = ["--from-scan", "--report-file", "--league", "--source", "--budget", "--import-knowledge"];
for (const arg of argv) if (!booleans.includes(arg) && !valued.some(name => arg.startsWith(name + "=") && value(name))) throw new Error("Unknown or incomplete argument: " + arg + ". No game input started.");
if (value("--import-knowledge")) {
  if (argv.length !== 1) throw new Error("Knowledge import is an independent offline action.");
  const id = new StashValuationService(root).importKnowledge(JSON.parse(readFileSync(path.resolve(value("--import-knowledge")!), "utf8")));
  console.log("Imported immutable knowledge snapshot: " + id + ". Select this ID and reassess locally.");
  return;
}
const fromScan = value("--from-scan"), move = argv.includes("--move"), resumeCapture = argv.includes("--resume-capture");
const price = argv.includes("--price") || argv.includes("--pending-only");
if ((price || move || resumeCapture) && !fromScan) throw new Error("Pricing, movement and capture resume require --from-scan=FILE.");
if (Number(move) + Number(price) + Number(resumeCapture) > 1 || move && argv.includes("--dry-run")) throw new Error("Choose one independent action.");
if (price && argv.includes("--craft-only")) throw new Error("Craft-only cannot request market data.");
let saved: StashValuationReport | undefined;
if (fromScan) {
  const candidate: unknown = JSON.parse(readFileSync(path.resolve(fromScan), "utf8"));
  const problems = validateSavedStashReport(candidate);
  if (problems.length) throw new Error(problems.join(" "));
  saved = candidate as StashValuationReport;
}
const service = new StashValuationService(root);
const storedSettings = saved?.settings ?? service.overview().settings;
const settings: StashValuationSettings = { ...defaultStashValuationSettings(), ...(saved?.settings ?? storedSettings),
  ...(value("--league") ? { league: value("--league")! } : {}),
  ...(value("--source") ? { captureSource: value("--source") as StashValuationSettings["captureSource"] } : {}),
  ...(value("--budget") ? { searchBudget: Number(value("--budget")) } : {}) };
if ((move || price || resumeCapture) && saved?.league !== settings.league) throw new Error("This action must use the original league of the saved assessment.");
const issues = validateStashValuationSettings(settings);
if (issues.length) throw new Error(issues.join(" "));
const knowledge = saved?.knowledgeSnapshots?.[settings.knowledgeId ?? ""] ?? service.knowledge(settings);
validateLeagueKnowledge(knowledge);
const reportFile = value("--report-file") ? path.resolve(value("--report-file")!) : path.join(outDir, "stash-valuation-report.json");
if (fromScan && path.resolve(fromScan) === reportFile && path.basename(reportFile) !== "stash-valuation-report.json") throw new Error("Original capture files are immutable; choose a different report output.");
mkdirSync(outDir, { recursive: true });
const save = (report: StashValuationReport) => writeBatchReport(reportFile, report);
function printReport(report: StashValuationReport): void {
  const counts = report.rows.reduce<Record<string, number>>((result, row) => {
    const key = row.assessment?.outcome ?? "review"; result[key] = (result[key] ?? 0) + 1; return result;
  }, {});
  console.log("Batch " + report.status + ": " + report.scannedItems + " items, " + report.unreadCells.length + " unread cells, " + report.rows.filter(row => row.status === "moved").length + " verified transfers.");
  console.log(JSON.stringify({ league: report.league, counts, marketRequests: report.pricingQueue ? {
    searches: report.pricingQueue.searches, listingFetches: report.pricingQueue.listingFetches, metadata: report.pricingQueue.metadata, economy: report.pricingQueue.economy
  } : { searches: 0, listingFetches: 0, metadata: 0, economy: 0 }, output: reportFile }));
  if (report.status === "failed") process.exitCode = 1;
}
if (fromScan && !move && !resumeCapture) {
  const capture = saved!;
  if (!price) {
    const result = assessBatch(capture, settings, new Date().toISOString(), knowledge);
    save(result); printReport(result); return;
  }
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const feed = new PriceFeedService({ configDir: process.env.POE2_MARKET_CONFIG_DIR ?? outDir, disableAutoRefresh: true,
    getPriceTable: () => ({ schemaVersion: 1, currency: "chaos", entries: [] }), savePriceTable: table => table });
  try {
    const result = await runSavedStashPricing({ saved: { ...capture, settings }, pendingOnly: true,
      quote: text => feed.fetchStashQuote(text, settings.league, () => !cancelled, settings.league === knowledge.league ? knowledge.patch : undefined),
      checkpoint: async message => { if (cancelled) throw Object.assign(new Error("Pricing stopped."), { name: "AbortError" }); console.log(message); },
      onReport: save });
    printReport(result);
  } finally { feed.dispose(); process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
} else {

  const templateCandidates = [
    process.env.POE2_TEMPLATE_DIR,
    ...(process.env.POE2_MARKET_CONFIG_DIR ? [path.join(process.env.POE2_MARKET_CONFIG_DIR, "perception-templates")] : []),
    ...(process.env.APPDATA ? [path.join(process.env.APPDATA, "poe2-trade-companion", "perception-templates")] : []),
    path.join(runtimeRoot, "fixtures", "perception", "templates"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const templateDir = templateCandidates.find(candidate => existsSync(path.join(candidate, "calibration.json"))) ?? templateCandidates.at(-1)!;
  const profile = loadProfile(templateDir);
  const profileGrid = profile.quadStashGrid ?? profile.stashGrid;
  // The one-row strip is ~67px above the folder strip at this verified 4K
  // viewport; the saved app calibration names neither state. Its observed
  // top edge distinguishes the two supported layouts (typically 246/313).
  const profileStashLayout = profileGrid ? (profileGrid.y < 290 ? "top-level" as const : "folder" as const) : undefined;
  const host = startWinHost({ requestTimeoutMs: 45_000 });
  const controls = startWinHost({ requestTimeoutMs: 10_000 });
  const harness = new SortHarness(host, controls, { outDir, dryRun: !move, fast: true, stepMode: argv.includes("--step") });
  const sorter = new GearSorter(host, harness, new StashTabKit(host), {
    root, templateDir, dryRun: !move, debug: false, maxChestClicks: 2,
    gearFolderName: settings.destinationFolder,
    strictTabNavigation: true,
    gearTabNames: [...Object.values(settings.classTabs), settings.valuableTab, settings.craftTab, settings.reviewTab],
    ...(profileStashLayout ? { profileStashLayout } : {}),
  });
  try {
    const rect = await host.send({ op: "rect" });
    if (!rect.ok) throw new Error("Path of Exile window was not found.");
    if (Number(rect.width) !== 3840 || Number(rect.height) !== 2160 || Number(rect.left) !== 0 || Number(rect.top) !== 0) {
      throw new Error("This stash navigation calibration requires a 3840×2160 physical client at screen origin. No input was sent.");
    }
    console.log(`Calibration: ${profileGrid ? `${profileStashLayout} ${profileGrid.cols}×${profileGrid.rows}` : "automatic geometry"} from ${templateDir}`);
    await host.send({ op: "focus" });
    harness.startKeyListener();
    console.log(`Batch ${move ? "VERIFIED SORT FROM SAVED ASSESSMENT" : "CAPTURE THEN OFFLINE ASSESSMENT"} — league ${settings.league}. Zero market requests. Numpad 0 / Ctrl+Shift+Esc stops.`);
    let sessionReady = false;
    const runOptions = { settings, mode: move ? "move" as const : "scan" as const, sorter,
      checkpoint: async (message: string) => {
        await harness.checkpoint(message);
        if (!sessionReady) { await sorter.ensureSession({ openFolder: false }); sessionReady = true; }
      },
      quote: async () => { throw new Error("Capture cannot access the market."); }, onReport: save };
    const report = move ? await sortSavedBatch(saved!, sorter, save, runOptions.checkpoint) : await captureBatch({ ...runOptions, knowledge, ...(resumeCapture ? { saved } : {}) });
    printReport(report);
    await harness.dispose({ outcome: report.status, moved: report.rows.filter(row => row.status === "moved").length });
  } finally {

    await harness.dispose({ outcome: "closed" });
    await controls.close();
    await host.close();
  }
}
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
