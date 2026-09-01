/**
 * Gear sorter CLI — thin wiring around the reworked state machine.
 *
 *   npx tsx scripts/sort-gear.ts [--sources=A,B,...]
 *                                [--fast] [--step] [--dry-run] [--no-chest]
 *                                [--no-triage] [--review-corrections]
 *                                [--drain-remove-only] [--guild]
 *
 * --drain-remove-only: the Standard-league drain flow (gear-first increment,
 * docs/HANDOFF-standard-drain-guild-stash.md). Sources become the Remove-only
 * tabs — withdraw-only; gear files into the Gear folder by Ctrl+C ground
 * truth, non-gear items stay put for the later affinity increment. Without
 * the flag, Remove-only tabs stay refused exactly as always.
 *
 * --guild: run against the GUILD Stash chest instead of the personal one
 * (requires --drain-remove-only; triage off). Gear routes onto the guild's
 * own taxonomy (Armor 1/2, Weapons 1/2, Jewels/Amulets/Charms, Rings,
 * HEAVY BELTS, Uniques); non-gear stays put. Every guild action is
 * verified-serial and floor-paced (≥1s/item, ≥2.5s/tab switch, commit
 * verified before the next) — guild writes are synchronous realm round
 * trips and every one shows in the guild log. Live runs demand an EMPTY
 * bag first.
 *
 * Triage: unless --no-triage is passed, every withdrawn bag-load is read
 * item-by-item (Ctrl+C per cell) and valuable/trash items detour to the
 * Review/Dump tabs configured in artifacts/tab-admin/triage.json (exported
 * by the app's Sort screen; starter rules apply when the file is absent).
 *
 * The moving parts live in:
 *   src/core/gearSort.ts      — clamps, identification model (pure, tested)
 *   src/adapters/sortHarness.ts — overlays, step mode, corrections, pacing, bench
 *   src/adapters/gearSorter.ts  — ensureSession / goto / cleanTab state machine
 *
 * Controls (numpad, any time): 8 = good (execute), 9 = wrong (then click or
 * drag a box where it SHOULD have been — recorded to corrections.jsonl),
 * 5 = pause/resume, 0 = instant stop.
 *
 * --review-corrections prints the per-step summary of corrections.jsonl so
 * the constants they contradict can be fixed — a correction is a bug report
 * with pixel-exact repro.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { startWinHost } from "../src/adapters/winHost.js";
import { StashTabKit } from "../src/adapters/stashTabKit.js";
import { SortHarness, SortStop } from "../src/adapters/sortHarness.js";
import { GearSorter } from "../src/adapters/gearSorter.js";
import {
  correctedPoint,
  parseCorrections,
  summarizeCorrections,
} from "../src/core/gearSort.js";
import { DEFAULT_TRIAGE_ROUTING, type TriageRouting } from "../src/core/bagTriage.js";
import {
  starterPriceTable,
  validatePriceTable,
  type PriceTable,
} from "../src/core/priceTable.js";
import {
  DEFAULT_TIER_THRESHOLDS,
  starterValueTierRules,
  type ValueTierRules,
  type ValueTierThresholds,
} from "../src/core/valueTiers.js";
import { evaluateWithAppraisal } from "../src/core/appraisal.js";
import { DEFAULT_MIN_DETOUR_CONFIDENCE } from "../src/core/sortTriage.js";
import type { GearSorterTriageOptions } from "../src/adapters/gearSorter.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(root, "fixtures", "perception", "templates");
const outDir = path.join(root, "artifacts", "tab-admin");

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const fast = argv.includes("--fast");
const stepMode = argv.includes("--step");
const turbo = argv.includes("--turbo");
const drainRemoveOnly = argv.includes("--drain-remove-only");
const guild = argv.includes("--guild");
if (guild && !drainRemoveOnly) {
  console.error("--guild requires --drain-remove-only (the only guild flow built so far)");
  process.exit(1);
}
if (guild && (fast || turbo)) {
  console.error("--guild never runs fast: guild actions are verified-serial and floor-paced");
  process.exit(1);
}
const teach = argv.includes("--teach");
const teachGrid = argv.includes("--teach-grid");
const sourcesArg = argv.find((a) => a.startsWith("--sources="))?.slice(10);
const scopeArg = argv.find((a) => a.startsWith("--scope="))?.slice(8);
const scope = scopeArg === "gear" || scopeArg === "tabs" ? scopeArg : "all";
/** With no --sources flag, every tab discovered in the folder gets sorted. */
const sourceFilter = sourcesArg
  ? sourcesArg.split(",").map((s) => s.trim()).filter(Boolean)
  : undefined;

if (argv.includes("--review-corrections")) {
  const file = path.join(outDir, "corrections.jsonl");
  if (!existsSync(file)) {
    console.log(`no corrections recorded yet (${file})`);
    process.exit(0);
  }
  const summaries = summarizeCorrections(parseCorrections(readFileSync(file, "utf8")));
  if (summaries.length === 0) {
    console.log("corrections.jsonl holds no parseable records");
    process.exit(0);
  }
  console.log(`corrections by step (${file}):\n`);
  for (const summary of summaries) {
    console.log(`${summary.why}: ${summary.count} correction(s), mean offset (${summary.meanDx >= 0 ? "+" : ""}${summary.meanDx}, ${summary.meanDy >= 0 ? "+" : ""}${summary.meanDy})`);
    for (const record of summary.records) {
      const point = correctedPoint(record);
      console.log(
        `    ${record.at}  planned (${record.planned.x},${record.planned.y})` +
          (point ? ` -> (${point.x},${point.y})` : "") +
          (record.box ? `  box ${record.box.w}x${record.box.h} at (${record.box.x},${record.box.y})` : ""),
      );
    }
  }
  console.log("\nEach group above contradicts a constant or matcher — update the code, then archive the file.");
  process.exit(0);
}

// Orphaned input hosts accumulate (killing the node parent does not always
// stop the PowerShell child) and eventually break new host spawns. Sweep
// them BEFORE starting our own — but ONLY true orphans (dead parent), so a
// concurrently running action daemon or app-panel host is never killed.
function sweepOrphanHosts(): void {
  try {
    spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*win-input-host.ps1*' } | Where-Object { -not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
      ],
      { timeout: 15_000 },
    );
  } catch {
    // best-effort hygiene
  }
}

sweepOrphanHosts();

/**
 * Triage config: the app exports the user's value tiers + price table to
 * artifacts/tab-admin/triage.json whenever they change. Without an export
 * the starter rules apply. --no-triage turns the sweep off entirely.
 */
function loadTriage(): GearSorterTriageOptions | undefined {
  if (argv.includes("--no-triage")) return undefined;
  let rules: ValueTierRules = starterValueTierRules();
  let thresholds: ValueTierThresholds = { ...DEFAULT_TIER_THRESHOLDS };
  let routing: TriageRouting = { ...DEFAULT_TRIAGE_ROUTING };
  let priceTable: PriceTable = starterPriceTable();
  let minDetourConfidence = DEFAULT_MIN_DETOUR_CONFIDENCE;
  const file = path.join(outDir, "triage.json");
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        rules?: ValueTierRules;
        thresholds?: ValueTierThresholds;
        routing?: TriageRouting;
        priceTable?: unknown;
        minDetourConfidence?: number;
      };
      if (parsed.rules?.keep && parsed.rules.sell && parsed.rules.dump) rules = parsed.rules;
      if (parsed.thresholds) thresholds = parsed.thresholds;
      if (parsed.routing?.reviewTab && parsed.routing.dumpTab) routing = parsed.routing;
      const tableCheck = validatePriceTable(parsed.priceTable);
      if (tableCheck.valid && tableCheck.table) priceTable = tableCheck.table;
      if (
        typeof parsed.minDetourConfidence === "number" &&
        Number.isFinite(parsed.minDetourConfidence)
      ) {
        minDetourConfidence = Math.max(0, Math.min(100, parsed.minDetourConfidence));
      }
    } catch (error) {
      console.log(`triage.json unreadable (${String(error)}) — using starter tiers`);
    }
  }
  const findsFile = path.join(outDir, "finds.jsonl");
  return {
    // The appraisal engine scores every item (0-100 value, 0-100 confidence)
    // and may promote a high-scoring unknown to keep/sell; explicit rules
    // and the price table still outrank it, and nothing heuristic ever dumps.
    evaluate: (itemText) => evaluateWithAppraisal(itemText, { rules, priceTable, thresholds }),
    routing,
    minDetourConfidence,
    onFind: (record) => {
      try {
        appendFileSync(findsFile, `${JSON.stringify(record)}\n`);
      } catch {
        // The finds journal is a convenience log; never fail a sort over it.
      }
    },
  };
}

const triage = loadTriage();

const host = startWinHost({ requestTimeoutMs: 45_000 });
const controlHost = startWinHost({ requestTimeoutMs: 10_000 });
const harness = new SortHarness(host, controlHost, {
  outDir,
  stepMode,
  fast: fast || turbo,
  dryRun,
  ...(turbo ? { paceFloor: 0.5, initialPace: 0.7 } : {}),
});
const sorter = new GearSorter(host, harness, new StashTabKit(host), {
  root,
  templateDir,
  dryRun,
  debug: !fast && !turbo,
  turbo,
  teach,
  teachGrid,
  drainRemoveOnly,
  chest: guild ? ("guild" as const) : ("personal" as const),
  maxChestClicks: argv.includes("--no-chest") ? 0 : 2,
  ...(triage && !guild ? { triage } : {}),
});

let exitCode = 0;
try {
  const rect = await host.send({ op: "rect" });
  if (!rect.ok) throw new Error("poe-window-not-found");
  await host.send({ op: "focus" });
  harness.startKeyListener();
  console.log(
    `sort-gear ${fast ? "fast" : "DEBUG"}${stepMode ? " STEP" : ""}${dryRun ? " DRY-RUN" : ""}${drainRemoveOnly ? " DRAIN-REMOVE-ONLY" : ""}${guild ? " GUILD-CHEST" : ""}${triage && !guild ? ` triage→${triage.routing.reviewTab}/${triage.routing.dumpTab}` : " no-triage"} pace=${harness.pace.toFixed(2)} — numpad: 8 good · 9 wrong · 5 pause · 0 stop`,
  );
  const moved = await sorter.run(sourceFilter, scope);
  console.log(`sort complete — ~${moved} cells moved`);
  await harness.dispose({ moved, outcome: "complete" });
} catch (error) {
  const stopped = error instanceof SortStop;
  console.log(String(error instanceof Error ? error.message : error));
  console.log(`last step: ${sorter.lastStep}`);
  if (!stopped) exitCode = 1;
  await harness.dispose({ outcome: stopped ? "stopped" : "failed", lastStep: sorter.lastStep });
} finally {
  await controlHost.close();
  await host.close();
}
process.exit(exitCode);
