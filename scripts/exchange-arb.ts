/**
 * Currency Exchange arbitrage over a hand-captured quotes file. Pure maths,
 * no game input, no network.
 *
 *   npx tsx scripts/exchange-arb.ts --from=<quotes.json> [--min-gain=2] [--json]
 *                                   [--amount=N] [--gold-per-ex=N] [--max-length=3]
 *
 * The quotes file shape is documented in docs/EXCHANGE_ARBITRAGE.md (see
 * fixtures/exchange/sample-quotes.json). Market prices come from the file's
 * own `prices`, then the app's exported price table
 * (artifacts/tab-admin/triage.json), then the crafting orb defaults.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findCycles,
  findDirectEdges,
  parseExchangeQuotesFile,
  priceLookupFromTable,
  type ExchangeCycle,
} from "../src/core/exchangeArbitrage.js";
import { starterPriceTable, validatePriceTable, type PriceTable } from "../src/core/priceTable.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);

const fromArg = value("--from");
const minGain = Number(value("--min-gain") ?? 2);
const asJson = flag("--json");
const amountArg = value("--amount");
const goldArg = value("--gold-per-ex");
const maxLength = Number(value("--max-length") ?? 3);

if (!fromArg) {
  console.log("usage: npx tsx scripts/exchange-arb.ts --from=<quotes.json> [--min-gain=2] [--json]");
  console.log("       sample: --from=fixtures/exchange/sample-quotes.json");
  process.exit(2);
}
const quotesPath = path.resolve(root, fromArg);
if (!existsSync(quotesPath)) {
  console.error(`quotes file not found: ${quotesPath}`);
  process.exit(2);
}

function loadPriceTable(): { table: PriceTable; source: string } {
  const file = path.join(root, "artifacts", "tab-admin", "triage.json");
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { priceTable?: unknown };
      const check = validatePriceTable(parsed.priceTable);
      if (check.valid && check.table) return { table: check.table, source: "artifacts/tab-admin/triage.json" };
    } catch {
      // fall through to the starter table
    }
  }
  return { table: starterPriceTable(), source: "starter price table" };
}

const file = parseExchangeQuotesFile(JSON.parse(readFileSync(quotesPath, "utf8")) as unknown);
const { table, source } = loadPriceTable();
const prices = priceLookupFromTable(table, file.prices ?? {});
const goldPerExalted = goldArg !== undefined ? Number(goldArg) : file.goldPerExalted;
const startAmount = amountArg !== undefined ? Number(amountArg) : 1;

const edges = findDirectEdges(file.quotes, prices, minGain);
const cycles = findCycles(file.quotes, {
  maxLength,
  minGainPercent: minGain,
  prices,
  ...(goldPerExalted !== undefined && goldPerExalted > 0 ? { goldPerExalted } : {}),
  startAmount,
});
const unpriced = [
  ...new Set(
    file.quotes.flatMap((quote) => [quote.have, quote.want]).filter((name) => prices(name) === undefined),
  ),
];

if (asJson) {
  console.log(
    JSON.stringify(
      {
        source: quotesPath,
        league: file.league,
        capturedAt: file.capturedAt,
        priceSource: source,
        minGainPercent: minGain,
        startAmount,
        goldPerExalted,
        unpriced,
        edges,
        cycles,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const fmt = (n: number, digits = 2) => (Number.isInteger(n) ? String(n) : n.toFixed(digits));
console.log(`quotes: ${path.relative(root, quotesPath)} (${file.quotes.length} pairs)`);
console.log(`league: ${file.league ?? "?"} · captured ${file.capturedAt ?? "?"}`);
console.log(`prices: ${source}${file.prices ? ` + ${Object.keys(file.prices).length} file overrides` : ""}`);
console.log(
  `fees:   ${goldPerExalted ? `${goldPerExalted} gold per exalted` : "gold rate unknown — fees shown, not netted"} · trade size ${startAmount} of the start currency`,
);
if (unpriced.length) console.log(`unpriced (skipped for direct edges): ${unpriced.join(", ")}`);
console.log(`threshold: > ${minGain}% gain\n`);

console.log(`DIRECT EDGES (${edges.length})`);
if (edges.length === 0) console.log("  none beat the market by more than the threshold");
for (const edge of edges) {
  const stock = edge.quantity !== undefined ? ` · stock ${edge.quantity} ${edge.want}` : "";
  const fee = edge.feeGoldPerTrade !== undefined ? ` · fee ${edge.feeGoldPerTrade} gold/trade` : "";
  console.log(
    `  +${fmt(edge.gainPercent)}%  1 ${edge.have} → ${fmt(edge.ratio, 4)} ${edge.want}` +
      `  (market ${fmt(edge.marketRatio, 4)}; +${fmt(edge.gainExPerHave)} ex per ${edge.have})${stock}${fee}`,
  );
}

function describeCycle(cycle: ExchangeCycle): string {
  const legs = cycle.hops.map((hop) => `${hop.have} →(${fmt(hop.ratio, 4)})`).join(" ") + ` ${cycle.sequence[0]}`;
  const fee =
    cycle.feeGold > 0
      ? cycle.feeApplied
        ? ` · fees ${cycle.feeGold} gold netted`
        : ` · fees ${cycle.feeGold} gold NOT netted`
      : "";
  const ex = cycle.netGainEx !== undefined ? ` · ${cycle.netGainEx >= 0 ? "+" : ""}${fmt(cycle.netGainEx)} ex on ${cycle.startAmount}` : "";
  const limit = cycle.limit
    ? ` · stock caps the start at ${fmt(cycle.limit.maxStartAmount, 3)} ${cycle.sequence[0]} (${cycle.limit.limitedBy.have} → ${cycle.limit.limitedBy.want})`
    : "";
  return `  +${fmt(cycle.netGainPercent)}% net (gross ${fmt(cycle.grossGainPercent)}%, ×${fmt(cycle.multiplier, 5)})  ${legs}${ex}${fee}${limit}`;
}

console.log(`\nCYCLES (${cycles.length}, up to ${maxLength} trades)`);
if (cycles.length === 0) console.log("  none — the quotes are consistent with each other");
for (const cycle of cycles) console.log(describeCycle(cycle));
