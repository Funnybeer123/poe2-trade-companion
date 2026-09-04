/**
 * Phase 2 on PRICE-BUCKET tabs (docs/HANDOFF-shop-listings.md, "PRICE-BUCKET
 * TABS"): appraise every bag item, snap its value estimate DOWN to the
 * dearest bucket tab it clears (1Ex, 5Ex, 10Ex, 1D, 2D, 3D, 5D …), and list
 * it in that tab at the bucket's price.
 *
 *   npx tsx scripts/shop-buckets.ts [--live] [--step] [--no-comps] [--no-refresh]
 *                                   [--comps-limit=N] [--buckets=1Ex,5Ex,...]
 *                                   [--league=NAME]
 *
 * Prices are for the CONFIGURED league: "auto" (default) resolves to the
 * current softcore challenge league via poe2scout; --league=NAME pins it
 * (persisted in artifacts/tab-admin/price-feed.json). The poe2scout feed is
 * refreshed at the start of every run (divine rate, currency, uniques), and
 * trade2 comps are fetched per rare/magic item, so nothing is priced off a
 * stale table. The header line prints the league used.
 *
 * DEFAULT (no --live): read the bag (hover + Ctrl+C), read the bucket tabs
 * off the Merchant panel's strip (or take --buckets), and PRINT the plan —
 * item, estimate, basis, bucket. Nothing is listed.
 *
 * --live executes bucket by bucket: select the tab, ctrl-click each item in
 * (SET ITEM PRICE pops), set the bucket's currency + amount, LIST ITEM,
 * rescan and verify every listing's tooltip before the ledger records it.
 *
 * Value estimate = the price table (uniques/currency the app's feed prices)
 * first, else trade2 comps for the confident rares (2s-spaced, capped by
 * --comps-limit). keep-tier and dump-tier items never list; anything under
 * the cheapest bucket stays in the bag — every hold is reported with why.
 *
 * Anything priced UNDER the cheapest bucket (or dump-tier by the value
 * rules) is SOLD to ZELINA after the listing pass (user rule, 2026-09-03);
 * --no-vendor keeps those items in the bag instead.
 *
 * --step gates every click on Numpad 8 (9 = wrong, 5 = pause, 0 = stop).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { startWinHost } from "../src/adapters/winHost.js";
import { StashTabKit } from "../src/adapters/stashTabKit.js";
import { SortHarness, SortStop } from "../src/adapters/sortHarness.js";
import { GearSorter } from "../src/adapters/gearSorter.js";
import { ShopKeeper } from "../src/adapters/shopKeeper.js";
import { PriceFeedService } from "../src/main/priceFeedService.js";
import { evaluateWithAppraisal } from "../src/core/appraisal.js";
import { bucketTabs, parseShopConfig } from "../src/core/shopListings.js";
import { starterPriceTable, validatePriceTable, type PriceTable } from "../src/core/priceTable.js";
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
const stepMode = flag("--step");
const dryRun = !live;
const noComps = flag("--no-comps");
const compsLimit = Number(value("--comps-limit") ?? 15);
const bucketsArg = value("--buckets");
const leagueArg = value("--league");
const noRefresh = flag("--no-refresh");
const noVendor = flag("--no-vendor");

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

const triage = loadTriageExport();
// The feed refresh merges live prices into this table for the whole run.
let priceTable: PriceTable = triage.priceTable;
const evaluate = triage.evaluate;
const configFile = path.join(outDir, "shop.json");
const { config } = parseShopConfig(
  existsSync(configFile) ? (JSON.parse(readFileSync(configFile, "utf8")) as unknown) : undefined,
);

const host = startWinHost({ requestTimeoutMs: 45_000 });
const controlHost = startWinHost({ requestTimeoutMs: 10_000 });
const harness = new SortHarness(host, controlHost, { outDir, stepMode, dryRun });
const kit = new StashTabKit(host);
const sorter = new GearSorter(host, harness, kit, {
  root,
  templateDir,
  dryRun,
  debug: false,
  maxChestClicks: 0,
});
const feed = noComps
  ? undefined
  : new PriceFeedService({
      configDir: outDir,
      getPriceTable: () => priceTable,
      savePriceTable: (table) => {
        priceTable = table;
        return table;
      },
    });
if (feed && leagueArg) feed.configure({ league: leagueArg.trim() });
const keeper = new ShopKeeper(host, harness, kit, sorter, {
  root,
  config,
  dryRun,
  stepMode,
  priceTable,
  evaluate,
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
});

let exitCode = 0;
try {
  const rect = await host.send({ op: "rect" });
  if (!rect.ok) throw new Error("poe-window-not-found");
  await host.send({ op: "focus" });
  harness.startKeyListener();
  console.log(
    `shop-buckets ${dryRun ? "DRY-RUN" : "LIVE"}${stepMode ? " STEP" : ""}${noComps ? " no-comps" : ` comps≤${compsLimit}`} — numpad: 8 good · 9 wrong · 5 pause · 0 stop`,
  );

  // Live prices first: the divine rate and every feed-priced unique/currency
  // come from poe2scout for the configured league; comps are per item later.
  if (feed && !noRefresh) {
    const status = await feed.refresh();
    console.log(
      status.lastError
        ? `price feed: refresh FAILED (${status.lastError}) — pricing off the exported table`
        : `price feed: ${status.resolvedLeague ?? status.config.league} league, ${status.feedEntryCount} entries, refreshed ${status.lastRefreshAt ?? "now"}`,
    );
  } else if (feed) {
    console.log(`price feed: ${feed.status().resolvedLeague ?? feed.status().config.league} league (no refresh)`);
  }
  if (feed && !noComps) {
    const budget = feed.tradeBudget();
    console.log(
      budget.restrictedUntilIso
        ? `trade2 budget: restricted until ${new Date(budget.restrictedUntilIso).toLocaleTimeString()} — lookups wait for the window`
        : `trade2 budget: ${budget.lookups} lookup(s) available now; the rest pace themselves`,
    );
  }

  // Bucket tabs: the command line, shop.json, and the merchant strip — unioned.
  // Navigation only (Ange → Manage Shop) — fine in a dry-run too; the
  // inventory shows with the Merchant and the bag needs it on screen.
  if (!(await keeper.ensureMerchantOpen())) throw new Error("merchant-panel-not-open");
  const labels = [
    ...(bucketsArg ? bucketsArg.split(",").map((s) => s.trim()).filter(Boolean) : []),
    ...config.bucketTabs,
  ];
  const fromStrip = await keeper.readBucketTabs().catch(() => []);
  const seen = new Set<string>();
  const buckets = [...bucketTabs(labels, priceTable), ...fromStrip]
    .sort((a, b) => a.exalted - b.exalted)
    .filter((bucket) => {
      const key = `${bucket.amount}:${bucket.currency}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (buckets.length === 0) {
    throw new Error("no-bucket-tabs — open the Merchant panel on a bucket tab, or pass --buckets=1Ex,5Ex,...");
  }
  console.log(`buckets: ${buckets.map((b) => `${b.label}=${b.exalted}ex`).join(" · ")}`);

  const { plan, held, vendor } = await keeper.planBagBuckets(buckets, { compsLimit });
  console.log(`\nplan: ${plan.length} item(s) to list, ${vendor.length} to vendor, ${held.length} held`);
  for (const entry of plan) {
    console.log(
      `  ${entry.name} (${entry.itemClass}) ≈${entry.estimateExalted} ex via ${entry.basis} → ${entry.bucket.label} (${entry.bucket.amount} ${entry.bucket.currency})`,
    );
  }
  for (const entry of vendor) console.log(`  vendor: ${entry.name} (${entry.itemClass}) — ${entry.reason}`);
  for (const line of held) console.log(`  hold: ${line}`);

  if (!live) {
    console.log("\ndry-run: nothing listed or sold — rerun with --live (add --step to approve each click)");
  } else {
    if (plan.length > 0) {
      const result = await keeper.applyBagBuckets(plan);
      console.log(`\nlisted ${result.listed}, failed ${result.failed}`);
      for (const line of result.report) console.log(`  · ${line}`);
    }
    if (vendor.length > 0 && !noVendor) {
      const sale = await keeper.vendorBagItems(vendor);
      console.log(`\nvendored ${sale.sold}, failed ${sale.failed}`);
      for (const line of sale.report) console.log(`  · ${line}`);
    } else if (vendor.length > 0) {
      console.log(`\n--no-vendor: ${vendor.length} sub-bucket item(s) left in the bag`);
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
