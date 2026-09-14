/**
 * Exhaustive Dump audit with league-specific live prices and explainable scores.
 *   npx tsx scripts/value-dump.ts                 # navigate/copy, never move
 *   npx tsx scripts/value-dump.ts --move          # re-scan, price, verify transfers
 *   npx tsx scripts/value-dump.ts --from-scan=FILE # re-price a saved report, no game
 *   npx tsx scripts/value-dump.ts --from-scan=FILE --pending-only # resume unavailable rows only
 * Settings: artifacts/tab-admin/stash-valuation.json (exact league required).
 * Source: top-level Dump. Destinations: configured class tabs inside G.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { startWinHost } from "../src/adapters/winHost.js";
import { StashTabKit } from "../src/adapters/stashTabKit.js";
import { GearSorter } from "../src/adapters/gearSorter.js";
import { SortHarness } from "../src/adapters/sortHarness.js";
import { loadProfile } from "../src/core/calibrationStore.js";
import { runDumpValuation } from "../src/core/dumpValuationRun.js";
import { runSavedStashPricing, validateSavedStashReport } from "../src/core/savedStashPricing.js";
import { defaultStashValuationSettings, unavailableStashQuote, validateStashValuationSettings, type StashValuationReport, type StashValuationSettings } from "../src/core/stashValuation.js";
import { PriceFeedService } from "../src/main/priceFeedService.js";

async function main(): Promise<void> {
const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = process.env.POE2_STASH_DATA_ROOT ? path.resolve(process.env.POE2_STASH_DATA_ROOT) : runtimeRoot;
const outDir = path.join(root, "artifacts", "tab-admin");
const argv = process.argv.slice(2);
const value = (name: string) => argv.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const move = argv.includes("--move");
const craftOnly = argv.includes("--craft-only");
const fromScan = value("--from-scan");
const fromScanSpecified = argv.some(arg => arg === "--from-scan" || arg.startsWith("--from-scan="));
const pendingOnly = argv.includes("--pending-only");
if (fromScanSpecified && !fromScan) throw new Error("--from-scan requires a nonempty saved report path; no live scan was started.");
if (pendingOnly && !fromScan) throw new Error("--pending-only requires --from-scan=FILE; it never starts a live scan.");
if (pendingOnly && craftOnly) throw new Error("--pending-only cannot be combined with --craft-only.");
if (move && (fromScan || argv.includes("--dry-run"))) throw new Error("--move cannot use --from-scan or --dry-run; transfer runs require a fresh live scan.");
let saved: StashValuationReport | undefined;
if (fromScanSpecified) {
  const candidate: unknown = JSON.parse(readFileSync(path.resolve(fromScan!), "utf8"));
  const savedIssues = validateSavedStashReport(candidate);
  if (savedIssues.length) throw new Error(savedIssues.join(" "));
  saved = candidate as StashValuationReport;
  if (value("--league") && value("--league") !== saved.league) throw new Error("Saved pricing must use the report's original league; --league does not match.");
}
const settingsFile = path.join(outDir, "stash-valuation.json");
const rawSettings: unknown = saved?.settings ?? (existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : defaultStashValuationSettings());
const settings = { ...(rawSettings as StashValuationSettings), ...(value("--league") ? { league: value("--league")! } : {}) };
const issues = validateStashValuationSettings(settings);
if (issues.length) throw new Error(issues.join(" "));
mkdirSync(outDir, { recursive: true });
const reportFile = value("--report-file") ? path.resolve(value("--report-file")!) : path.join(outDir, "stash-valuation-report.json");
mkdirSync(path.dirname(reportFile), { recursive: true });
const save = (report: StashValuationReport) => {
  const temp = `${reportFile}.tmp`;
  writeFileSync(temp, JSON.stringify(report, null, 2));
  renameSync(temp, reportFile);
};
// The valuation endpoint never reads starter/manual prices. Its only use of
// this table interface is satisfying the shared provider's legacy constructor.
const feed = new PriceFeedService({ configDir: process.env.POE2_MARKET_CONFIG_DIR ?? outDir, disableAutoRefresh: true,
  getPriceTable: () => ({ schemaVersion: 1, currency: "chaos", entries: [] }), savePriceTable: table => table });
const lookupQuote = (text: string, canRun?: () => boolean) => craftOnly
  ? Promise.resolve(unavailableStashQuote(settings.league, "Crafting-only pass: market valuation remains pending."))
  : feed.fetchStashQuote(text, settings.league, canRun);

function printReport(report: StashValuationReport): void {
  console.log(`Dump valuation ${report.status}: ${report.scannedItems} items, ${report.unreadCells.length} unread cells, ${report.rows.filter(row => row.status === "moved").length} verified transfers.`);
  console.log(`League: ${report.league}. Report: ${reportFile}`);
  for (const error of report.errors) console.log(`  ${error}`);
  if (report.status === "failed" || report.status === "incomplete") process.exitCode = 1;
}

if (fromScanSpecified) {
  const capture = saved!;
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    console.log("SAVED PRICING ONLY — league " + capture.league + "; " + (pendingOnly ? "unavailable rows only; prior quotes retained" : "refresh every saved quote") + ". No game input or transfers.");
    const result = await runSavedStashPricing({ saved: capture, pendingOnly, quote: text => lookupQuote(text, () => !cancelled), onReport: save,
      checkpoint: async message => {
        if (cancelled) throw Object.assign(new Error("Saved pricing stopped."), { name: "AbortError" });
        console.log(message);
      } });
    console.log("Saved pricing: " + result.pricingResume!.completed + "/" + result.pricingResume!.total + " attempted; " + result.pricingResume!.retained + " previous quotes retained.");
    printReport(result);
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    feed.dispose();
  }
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
    console.log(`Dump valuation ${move ? "SCAN + VERIFIED TRANSFERS" : "SCAN ONLY (navigation and clipboard reads)"}${craftOnly ? " · CRAFTING ONLY; MARKET VALUES PENDING" : ""} — league ${settings.league}. Numpad 0 / Ctrl+Shift+Esc stops.`);
    let sessionReady = false;
    const report = await runDumpValuation({ settings, mode: move ? "move" : "scan", sorter,
      checkpoint: async message => {
        await harness.checkpoint(message);
        if (!sessionReady) { await sorter.ensureSession({ openFolder: false }); sessionReady = true; }
      },
      quote: text => lookupQuote(text, () => !harness.stopRequested), onReport: save });
    printReport(report);
    await harness.dispose({ outcome: report.status, moved: report.rows.filter(row => row.status === "moved").length });
  } finally {
    feed.dispose();
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
