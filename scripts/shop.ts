/**
 * Shop CLI — manage sale listings in the ONE designated public stash tab
 * (docs/HANDOFF-shop-listings.md).
 *
 *   npx tsx scripts/shop.ts [--record] [--live] [--list] [--step]
 *                           [--no-comps] [--comps-limit=N] [--max-actions=N]
 *                           [--shop-tab=NAME] [--report] [--from-scan=FILE]
 *
 * DEFAULT (no flags): DRY-RUN — scan the shop tab (Ctrl+C ground truth,
 * read-only), diff it against the listings ledger (sold/hand-listed/
 * hand-repriced are PRINTED, not recorded), fetch comps for app-priced
 * listings, and print the reprice/delist plan. Nothing is clicked beyond
 * navigation + hovering; no dialog opens, nothing moves, nothing is written
 * to the ledger. Artifacts: artifacts/tab-admin/shop-scan.json + shop-plan.json.
 *
 *   --record   append the reconcile events (sold detection!) to
 *              artifacts/tab-admin/listings.jsonl after the scan.
 *   --live     execute the plan: reprices via the item price dialog
 *              (Note-verified), delists via verified withdraw → return tab.
 *              Implies --record. FIRST LIVE RUN: pass --step too — the
 *              price dialog's controls are taught interactively once
 *              (validation workflow step 3).
 *   --list     phase 2: appraise the bag, gate by confidence + comps, and
 *              (with --live) deposit + price the winners in the shop tab.
 *   --report   offline: print the ledger's current state and realized-sales
 *              stats. No game needed.
 *   --from-scan=FILE  offline: reconcile a saved shop-scan.json against the
 *              ledger (testing without the game).
 *
 * Config: artifacts/tab-admin/shop.json (created with defaults on first run;
 * the app's Shop screen edits the same file). The feature refuses to run
 * until shopTab names the designated PUBLIC tab exactly.
 *
 * Controls during a run (numpad): 8 good · 9 wrong/teach · 5 pause · 0 stop.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { startWinHost } from "../src/adapters/winHost.js";
import { StashTabKit } from "../src/adapters/stashTabKit.js";
import { SortHarness, SortStop } from "../src/adapters/sortHarness.js";
import { GearSorter } from "../src/adapters/gearSorter.js";
import { ShopKeeper, type ShopAction } from "../src/adapters/shopKeeper.js";
import { PriceFeedService } from "../src/main/priceFeedService.js";
import { evaluateWithAppraisal } from "../src/core/appraisal.js";
import {
  defaultShopConfig,
  deriveShopState,
  parseShopConfig,
  parseListingEvents,
  reconcileShopScan,
  type ShopConfig,
  type ShopSnapshot,
} from "../src/core/shopListings.js";
import { salesStats } from "../src/core/shopPricing.js";
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(root, "fixtures", "perception", "templates");
const outDir = path.join(root, "artifacts", "tab-admin");

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);

const live = flag("--live");
const record = flag("--record") || live;
const list = flag("--list");
const stepMode = flag("--step");
const report = flag("--report");
const fromScan = value("--from-scan");
const noComps = flag("--no-comps");
const compsLimit = Number(value("--comps-limit") ?? 20);
const dryRun = !live;

/* ---------------- config + triage-exported prices ---------------- */

function loadShopConfig(): ShopConfig {
  const file = path.join(outDir, "shop.json");
  if (!existsSync(file)) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(file, JSON.stringify(defaultShopConfig(), null, 2));
    console.log(`created ${file} with defaults — set "shopTab" to your public tab's exact name`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`shop.json unreadable (${String(error)}) — fix or delete it`);
    process.exit(1);
  }
  const { config, issues } = parseShopConfig(parsed);
  for (const issue of issues) console.log(`shop.json: ${issue}`);
  const override = value("--shop-tab");
  if (override) config.shopTab = override.trim();
  const maxActions = Number(value("--max-actions"));
  if (Number.isFinite(maxActions) && maxActions > 0) {
    config.maxActionsPerRun = Math.floor(maxActions);
  }
  return config;
}

function loadTriageExport(): {
  priceTable: PriceTable;
  evaluate: (itemText: string) => ReturnType<typeof evaluateWithAppraisal>;
} {
  let rules: ValueTierRules = starterValueTierRules();
  let thresholds: ValueTierThresholds = { ...DEFAULT_TIER_THRESHOLDS };
  let priceTable: PriceTable = starterPriceTable();
  const file = path.join(outDir, "triage.json");
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        rules?: ValueTierRules;
        thresholds?: ValueTierThresholds;
        priceTable?: unknown;
      };
      if (parsed.rules?.keep && parsed.rules.sell && parsed.rules.dump) rules = parsed.rules;
      if (parsed.thresholds) thresholds = parsed.thresholds;
      const tableCheck = validatePriceTable(parsed.priceTable);
      if (tableCheck.valid && tableCheck.table) priceTable = tableCheck.table;
    } catch (error) {
      console.log(`triage.json unreadable (${String(error)}) — starter tiers/prices`);
    }
  }
  return {
    priceTable,
    evaluate: (itemText) => evaluateWithAppraisal(itemText, { rules, priceTable, thresholds }),
  };
}

const config = loadShopConfig();
const { priceTable, evaluate } = loadTriageExport();

/* ---------------- offline modes (no game) ---------------- */

function printPlanLine(action: ShopAction): void {
  const from = action.from ? `${action.from.amount} ${action.from.currency}` : "unpriced";
  const to = action.to ? `${action.to.amount} ${action.to.currency} (≈${action.to.exalted} ex)` : "";
  console.log(
    `  ${action.kind.toUpperCase().padEnd(14)} ${action.name} [${action.badges.join(",") || "-"}] ${from}${to ? ` → ${to}` : ""}`,
  );
  for (const reason of action.reasons) console.log(`      · ${reason}`);
}

if (report) {
  const file = path.join(outDir, "listings.jsonl");
  const events = existsSync(file) ? parseListingEvents(readFileSync(file, "utf8")) : [];
  const state = deriveShopState(events);
  console.log(`ledger: ${events.length} event(s), ${state.length} active listing(s)\n`);
  for (const listing of state) {
    console.log(
      `  ${listing.count}x ${listing.name} — ${listing.price ? `${listing.price.amount} ${listing.price.currency}` : "unpriced"} ` +
        `(listed ${listing.listedAt.slice(0, 10)}, by ${listing.by})`,
    );
  }
  const stats = salesStats(events);
  if (stats.length > 0) {
    console.log("\nrealized sales by class (feed this back into the value tiers):");
    for (const entry of stats) {
      console.log(
        `  ${entry.itemClass}: ${entry.sold} sold / ${entry.listed} listed (${entry.delisted} delisted)` +
          ` · ${entry.realizedExalted} ex realized` +
          (entry.medianDaysToSale !== undefined ? ` · median ${entry.medianDaysToSale}d to sale` : ""),
      );
    }
  }
  process.exit(0);
}

if (fromScan) {
  const snapshot = JSON.parse(readFileSync(fromScan, "utf8")) as { snapshot?: ShopSnapshot };
  const scan = snapshot.snapshot ?? (snapshot as unknown as ShopSnapshot);
  const ledgerFile = path.join(outDir, "listings.jsonl");
  const events = existsSync(ledgerFile) ? parseListingEvents(readFileSync(ledgerFile, "utf8")) : [];
  const result = reconcileShopScan({ state: deriveShopState(events), snapshot: scan, priceTable });
  console.log(`offline reconcile of ${fromScan}:`);
  for (const line of result.report) console.log(`  · ${line}`);
  for (const event of result.events) console.log(`  event: ${JSON.stringify(event)}`);
  console.log(record ? "(--record has no effect offline — appended nothing)" : "");
  process.exit(0);
}

/* ---------------- live wiring ---------------- */

if (!config.shopTab) {
  console.error(
    'shop.json has no "shopTab" — name the ONE public tab this feature may touch (exact label), then rerun',
  );
  process.exit(1);
}

// Orphaned input hosts accumulate; sweep true orphans only (same rule as sort-gear).
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

const host = startWinHost({ requestTimeoutMs: 45_000 });
const controlHost = startWinHost({ requestTimeoutMs: 10_000 });
const harness = new SortHarness(host, controlHost, { outDir, stepMode, dryRun });
const kit = new StashTabKit(host);
const sorter = new GearSorter(host, harness, kit, {
  root,
  templateDir,
  dryRun,
  debug: false,
  maxChestClicks: 2,
});

// Comps ride the SAME etiquette as the app: PriceFeedService serializes
// trade2 traffic at ≥2s spacing with a per-item cache. configDir is the
// artifacts dir, so a league/POESESSID set there applies to CLI runs too.
const feed = noComps
  ? undefined
  : new PriceFeedService({
      configDir: outDir,
      getPriceTable: () => priceTable,
      savePriceTable: (table) => table,
    });

const keeper = new ShopKeeper(host, harness, kit, sorter, {
  root,
  config,
  dryRun,
  stepMode,
  priceTable,
  ...(feed
    ? {
        comps: async (itemText: string) => {
          const result = await feed.fetchComps(itemText);
          if (!result.ok || !result.summary) {
            if (result.error) console.log(`  · comps: ${result.error}`);
            return /rate limit/i.test(result.error ?? "") ? "rate-limited" : undefined;
          }
          return result.summary;
        },
      }
    : {}),
  evaluate,
});

let exitCode = 0;
try {
  const rect = await host.send({ op: "rect" });
  if (!rect.ok) throw new Error("poe-window-not-found");
  await host.send({ op: "focus" });
  harness.startKeyListener();
  console.log(
    `shop ${dryRun ? "DRY-RUN" : "LIVE"}${stepMode ? " STEP" : ""}${record ? " RECORD" : ""}${list ? " +LIST(bag)" : ""} ` +
      `tab="${config.shopTab}" return="${config.returnTab}" max-actions=${config.maxActionsPerRun} — ` +
      "numpad: 8 good · 9 wrong · 5 pause · 0 stop",
  );

  const { snapshot, items, freeCells } = await keeper.scan();
  const { state, report: reconcileReport } = keeper.reconcile(snapshot, { record });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    path.join(outDir, "shop-scan.json"),
    JSON.stringify({ snapshot, freeCells }, null, 2),
  );

  const plan = await keeper.plan(snapshot, state, { compsLimit });
  writeFileSync(path.join(outDir, "shop-plan.json"), JSON.stringify(plan, null, 2));
  console.log(
    `\nplan: ${plan.actions.length} action(s), ${plan.holds.length} hold(s)` +
      (reconcileReport.length > 0 ? `, ${reconcileReport.length} reconcile note(s)` : ""),
  );
  for (const action of plan.actions) printPlanLine(action);
  for (const hold of plan.holds) {
    console.log(`  HOLD           ${hold.name} [${hold.badges.join(",") || "-"}]`);
    for (const reason of hold.reasons) console.log(`      · ${reason}`);
  }
  for (const line of plan.report) console.log(`  ! ${line}`);

  if (live && plan.actions.length > 0) {
    const { applied, failed } = await keeper.apply(plan, items);
    console.log(`\napply: ${applied} action(s) verified, ${failed} failed`);
  } else if (plan.actions.length > 0) {
    console.log("\ndry-run: nothing executed — rerun with --live to apply (add --step for the first dialog)");
  }

  if (list) {
    console.log("\nphase 2 — bag listings:");
    const bagPlan = await keeper.planBagListings(freeCells, state, { compsLimit });
    for (const line of bagPlan.report) console.log(`  · ${line}`);
    for (const candidate of bagPlan.candidates) {
      const admitted = bagPlan.admitted.some((entry) => entry.fingerprint === candidate.fingerprint);
      console.log(
        `  ${admitted ? "LIST" : "hold"} ${candidate.name} (${candidate.itemClass}) → ` +
          `${candidate.suggestion.display.amount} ${candidate.suggestion.display.currency} ` +
          `(EV ${candidate.expectedValue} ex @ P(sale) ${candidate.saleProbability})` +
          (candidate.needsConfirmation ? " — NEEDS CONFIRMATION" : ""),
      );
    }
    if (live && bagPlan.admitted.length > 0) {
      if (bagPlan.evictions.length > 0) {
        console.log(`  · ${bagPlan.evictions.length} eviction(s) planned — delist them via a phase-1 run first`);
      }
      const { listed, failed } = await keeper.applyBagListings(bagPlan.admitted, bagPlan.bagItems);
      console.log(`  listed ${listed}, failed ${failed}`);
    } else if (bagPlan.admitted.length > 0) {
      console.log("  dry-run: nothing deposited or priced — rerun with --live --list");
    }
  }

  await harness.dispose({ outcome: "complete" });
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
