/**
 * List every item in the bag in one merchant tab at one price — the first
 * live exercise of the Merchant-panel driving (docs/HANDOFF-shop-listings.md,
 * GROUND TRUTH).
 *
 *   npx tsx scripts/shop-list-bag.ts --tab=1Ex [--amount=1 --currency=exalted]
 *                                    [--reprice] [--current] [--live] [--step] [--max=N]
 *
 * A BUCKET tab ("1Ex", "5D", "10Ex") names its own price — everything in it
 * sells for that; --amount/--currency are only needed for other tabs.
 *
 * DEFAULT (no --live): identify the bag (hover + Ctrl+C, read-only) and
 * print what WOULD be listed. Nothing else is touched.
 *
 * --live executes: Ange → Manage Shop (if the panel is not already open),
 * select the merchant tab, then per item: ctrl-click it in the bag (the
 * game moves it into the tab and pops SET ITEM PRICE), set currency +
 * amount, LIST ITEM, confirm the bag cell emptied. Afterwards the tab is
 * rescanned and every new listing's tooltip ("Asking Price") is read before
 * it is recorded in listings.jsonl.
 *
 * --step shows every click as a bullseye + purpose label and waits for
 * Numpad 8 (9 = wrong / show the right spot, 5 = pause, 0 = stop).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { startWinHost } from "../src/adapters/winHost.js";
import { StashTabKit } from "../src/adapters/stashTabKit.js";
import { SortHarness, SortStop } from "../src/adapters/sortHarness.js";
import { GearSorter } from "../src/adapters/gearSorter.js";
import { ShopKeeper } from "../src/adapters/shopKeeper.js";
import { normalizeNoteCurrency, parseShopConfig, priceFromTabLabel } from "../src/core/shopListings.js";
import { starterPriceTable, validatePriceTable, type PriceTable } from "../src/core/priceTable.js";
import { orbCosts, type OrbId } from "../src/core/crafting.js";
import { tradeCurrencyToOrb } from "../src/core/tradeComps.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(root, "fixtures", "perception", "templates");
const outDir = path.join(root, "artifacts", "tab-admin");

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);

const live = flag("--live");
const stepMode = flag("--step");
/** --reprice: instead of listing the bag, bring every item already IN the
 * tab to the given price (right-click dialog), verified by tooltip. */
const reprice = flag("--reprice");
/** --current: the wanted tab is already on screen — never touch the strip
 * (the "1Ex" label does not OCR, so selection would prompt or hop). */
const current = flag("--current");
const dryRun = !live;
const tab = (value("--tab") ?? "").trim();
if (!tab) {
  console.error("--tab=<merchant tab label> is required (e.g. --tab=1Ex)");
  process.exit(1);
}
// A bucket tab ("1Ex", "5D") names its own price; --amount/--currency
// override it for tabs that are not buckets.
const bucket = priceFromTabLabel(tab);
const amountArg = value("--amount");
const currencyArg = value("--currency");
const amount = amountArg ? Math.max(1, Math.floor(Number(amountArg))) : bucket?.amount;
const currency = currencyArg ? normalizeNoteCurrency(currencyArg) : bucket?.currency;
if (amount === undefined || currency === undefined) {
  console.error(`tab "${tab}" is not a price bucket like 1Ex or 5D — pass --amount and --currency`);
  process.exit(1);
}
const max = Number(value("--max") ?? Number.POSITIVE_INFINITY);

function loadPriceTable(): PriceTable {
  const file = path.join(outDir, "triage.json");
  if (!existsSync(file)) return starterPriceTable();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { priceTable?: unknown };
    const check = validatePriceTable(parsed.priceTable);
    return check.valid && check.table ? check.table : starterPriceTable();
  } catch {
    return starterPriceTable();
  }
}

const priceTable = loadPriceTable();
const orb = tradeCurrencyToOrb(currency);
const rate = orb ? orbCosts(priceTable)[orb as OrbId] : undefined;
const price = { amount, currency, exalted: rate ? Math.round(amount * rate * 100) / 100 : amount };

const configFile = path.join(outDir, "shop.json");
const { config } = parseShopConfig(
  existsSync(configFile) ? (JSON.parse(readFileSync(configFile, "utf8")) as unknown) : undefined,
);
config.shopTab = tab;

const itemName = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !/^(Item Class|Rarity):/i.test(line) && line !== "--------") ??
  "item";

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
const keeper = new ShopKeeper(host, harness, kit, sorter, {
  root,
  config,
  dryRun,
  stepMode,
  priceTable,
  ...(current ? { assumeCurrentTab: true } : {}),
});

let exitCode = 0;
try {
  const rect = await host.send({ op: "rect" });
  if (!rect.ok) throw new Error("poe-window-not-found");
  await host.send({ op: "focus" });
  harness.startKeyListener();
  console.log(
    `shop-list-bag ${dryRun ? "DRY-RUN" : "LIVE"}${stepMode ? " STEP" : ""}${reprice ? " REPRICE" : ""} — tab "${tab}", ${amount} ${currency} each` +
      ` (≈${price.exalted} ex) — numpad: 8 good · 9 wrong · 5 pause · 0 stop`,
  );

  if (reprice) {
    const result = await keeper.repriceTabItems(tab, price);
    console.log(
      `\n${dryRun ? "would reprice" : "repriced"} ${dryRun ? result.report.filter((l) => /→ would set/.test(l)).length : result.repriced}, skipped ${result.skipped}, failed ${result.failed}`,
    );
    for (const line of result.report) console.log(`  · ${line}`);
    await harness.dispose({ outcome: "complete" });
    await controlHost.close();
    await host.close();
    process.exit(0);
  }

  // The Merchant panel opens the inventory alongside it — get it on screen
  // BEFORE reading the bag (a dry-run needs the inventory open by hand).
  if (live && !(await keeper.ensureMerchantOpen())) throw new Error("merchant-panel-not-open");
  const bag = await sorter.identifyBagItems();
  if (bag.unread.length > 0) console.log(`  · ${bag.unread.length} bag cell(s) unreadable — left alone`);
  const entries = bag.items.slice(0, Number.isFinite(max) ? max : undefined).map((item) => ({
    item,
    price,
    name: itemName(item.text),
    itemClass: item.itemClass ?? "Unknown",
  }));
  console.log(`\nbag: ${bag.items.length} item(s) identified, ${entries.length} to list:`);
  for (const entry of entries) {
    console.log(`  ${entry.name} (${entry.itemClass}) at bag ${entry.item.cells[0]!.row},${entry.item.cells[0]!.col} → ${amount} ${currency}`);
  }

  if (!live) {
    console.log("\ndry-run: nothing listed — rerun with --live (add --step to approve each click)");
  } else if (entries.length > 0) {
    const result = await keeper.listBagItems(entries, tab);
    console.log(`\nlisted ${result.listed}, failed ${result.failed}`);
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
