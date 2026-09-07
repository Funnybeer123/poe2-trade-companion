/**
 * Bucket reprice ladder (docs/HANDOFF-shop-listings.md, PRICE-BUCKET TABS):
 * the merchant tab's NAME is the price, so a stale app listing steps down by
 * MOVING to a cheaper bucket tab — delist to the bag, relist in the target.
 *
 *   npx tsx scripts/shop-ladder.ts [--live] [--step] [--comps] [--buckets=1Ex,5Ex,...]
 *                                  [--max=N] [--league=NAME] [--full-verify]
 *
 * DEFAULT (no --live): DRY-RUN, OFFLINE — fold the ledger
 * (artifacts/tab-admin/listings.jsonl) into the active listings, take the
 * bucket tabs from shop.json `bucketTabs` (∪ --buckets), and PRINT every
 * move and hold with its reason. No game, no host, nothing clicked.
 *
 * --live drives it: Ange → Manage Shop, bucket tabs ∪ the strip, then per
 * move: select the source bucket, find the listing by Ctrl+C fingerprint,
 * skip it under the game's price cooldown, DELIST it (ctrl-click — an
 * UNVERIFIED gesture, believed only when a bag Ctrl+C reads the same
 * fingerprint; anything else puts the item back, captures a screenshot and
 * STOPS), then list it into the target bucket through the ordinary bag
 * path (tooltip-verified). Ledger: "delisted" (app, verified) + "listed".
 *
 * --comps (live) fetches trade2 comps per move at apply time: a listing
 * whose comps still support its bucket holds ("market did not move");
 * without --comps age alone moves it when shop.json `ladderWithoutComps`
 * is true (default). --step gates every click on Numpad 8 (9 = wrong,
 * 5 = pause, 0 = stop). FIRST LIVE RUN: --live --step --max=1.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import {
  bucketTabs,
  deriveShopState,
  parseListingEvents,
  parseShopConfig,
  type BucketTab,
} from "../src/core/shopListings.js";
import { planBucketLadder, suggestListingPrice } from "../src/core/shopPricing.js";
import { loadTriageExport } from "../src/adapters/triageLoader.js";
import type { PriceTable } from "../src/core/priceTable.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(root, "fixtures", "perception", "templates");
const outDir = path.join(root, "artifacts", "tab-admin");

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);

const live = flag("--live");
const stepMode = flag("--step");
const useComps = flag("--comps");
const fullVerify = flag("--full-verify");
const bucketsArg = value("--buckets");
const leagueArg = value("--league");
const max = Number(value("--max") ?? Number.POSITIVE_INFINITY);
const dryRun = !live;
if (useComps && !live) {
  console.log("--comps only applies to --live (the dry-run plan has no item text to price) — ignored");
}

const configFile = path.join(outDir, "shop.json");
const { config } = parseShopConfig(
  existsSync(configFile) ? (JSON.parse(readFileSync(configFile, "utf8")) as unknown) : undefined,
);
if (Number.isFinite(max) && max > 0) config.maxActionsPerRun = Math.min(config.maxActionsPerRun, Math.floor(max));
// The app's price table export, placeholders stripped and the newest feed
// snapshot merged (src/adapters/triageLoader.ts): every bucket's exalted
// value — and so every ladder step — rides the divine rate in here.
let priceTable: PriceTable = loadTriageExport(root).priceTable;

const ledgerFile = path.join(outDir, "listings.jsonl");
const listings = deriveShopState(
  existsSync(ledgerFile) ? parseListingEvents(readFileSync(ledgerFile, "utf8")) : [],
);
const configuredLabels = [
  ...(bucketsArg ? bucketsArg.split(",").map((s) => s.trim()).filter(Boolean) : []),
  ...config.bucketTabs,
];

function dedupe(buckets: readonly BucketTab[]): BucketTab[] {
  const seen = new Set<string>();
  return [...buckets]
    .sort((a, b) => a.exalted - b.exalted)
    .filter((bucket) => {
      const key = `${bucket.amount}:${bucket.currency}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function printPlan(plan: ReturnType<typeof planBucketLadder>): void {
  console.log(`\nladder plan: ${plan.moves.length} move(s), ${plan.holds.length} hold(s)`);
  for (const line of plan.report) console.log(`  ${line}`);
}

/* ---------------- dry-run: offline plan ---------------- */

if (!live) {
  const buckets = dedupe(bucketTabs(configuredLabels, priceTable));
  console.log(
    `shop-ladder DRY-RUN (offline) — ${listings.length} active listing(s), ladder ${config.ladder
      .map((step) => `-${step.stepPercent}%@${step.afterDays}d`)
      .join(" ")}, ladderWithoutComps=${config.ladderWithoutComps}`,
  );
  if (buckets.length === 0) {
    console.error('no bucket tabs — set "bucketTabs" in artifacts/tab-admin/shop.json or pass --buckets=1Ex,5Ex,...');
    process.exit(1);
  }
  console.log(`buckets: ${buckets.map((b) => `${b.label}=${b.exalted}ex`).join(" · ")}`);
  const plan = planBucketLadder({ listings, buckets, config, nowMs: Date.now() });
  printPlan(plan);
  console.log("\ndry-run: nothing moved — rerun with --live --step (add --comps to hold listings the market still supports)");
  process.exit(0);
}

/* ---------------- live ---------------- */

const { startWinHost } = await import("../src/adapters/winHost.js");
const { StashTabKit } = await import("../src/adapters/stashTabKit.js");
const { SortHarness, SortStop } = await import("../src/adapters/sortHarness.js");
const { GearSorter } = await import("../src/adapters/gearSorter.js");
const { ShopKeeper } = await import("../src/adapters/shopKeeper.js");
const { PriceFeedService } = await import("../src/main/priceFeedService.js");

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
const feed = useComps
  ? new PriceFeedService({
      configDir: outDir,
      getPriceTable: () => priceTable,
      savePriceTable: (table) => {
        priceTable = table;
        return table;
      },
    })
  : undefined;
if (feed && leagueArg) feed.configure({ league: leagueArg.trim() });
const keeper = new ShopKeeper(host, harness, kit, sorter, {
  root,
  config,
  dryRun,
  stepMode,
  priceTable,
  // The feed refresh below replaces the table object: read it live so the
  // strip's bucket values use the refreshed divine rate, like the comps do.
  getPriceTable: () => priceTable,
  ...(fullVerify ? { fullVerify: true } : {}),
});

let exitCode = 0;
try {
  const rect = await host.send({ op: "rect" });
  if (!rect.ok) throw new Error("poe-window-not-found");
  await host.send({ op: "focus" });
  harness.startKeyListener();
  console.log(
    `shop-ladder LIVE${stepMode ? " STEP" : ""}${useComps ? " comps" : " age-only"} max=${config.maxActionsPerRun} — numpad: 8 good · 9 wrong · 5 pause · 0 stop`,
  );
  if (feed) {
    const status = await feed.refresh();
    console.log(
      status.lastError
        ? `price feed: refresh FAILED (${status.lastError}) — pricing off the exported table`
        : `price feed: ${status.resolvedLeague ?? status.config.league} league, ${status.feedEntryCount} entries`,
    );
  }
  if (!(await keeper.ensureMerchantOpen())) throw new Error("merchant-panel-not-open");
  const fromStrip = await keeper.readBucketTabs().catch(() => []);
  const buckets = dedupe([...bucketTabs(configuredLabels, priceTable), ...fromStrip]);
  if (buckets.length === 0) {
    throw new Error("no-bucket-tabs — open the Merchant panel on a bucket tab, or pass --buckets=1Ex,5Ex,...");
  }
  console.log(`buckets: ${buckets.map((b) => `${b.label}=${b.exalted}ex`).join(" · ")}`);
  const plan = planBucketLadder({ listings, buckets, config, nowMs: Date.now() });
  printPlan(plan);
  if (plan.moves.length === 0) {
    console.log("\nnothing to move");
  } else {
    const at = new Date().toISOString();
    const result = await keeper.applyBucketLadder(plan, {
      buckets,
      ...(feed
        ? {
            compsFor: async (itemText: string) => {
              const comps = await feed.fetchComps(itemText);
              if (!comps.ok || !comps.summary) {
                if (comps.error) console.log(`  · comps: ${comps.error}`);
                return undefined;
              }
              return suggestListingPrice(comps.summary, config, { at, priceTable });
            },
          }
        : {}),
    });
    console.log(`\nmoved ${result.moved}, skipped ${result.skipped}, failed ${result.failed}`);
    for (const line of result.report) console.log(`  · ${line}`);
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
