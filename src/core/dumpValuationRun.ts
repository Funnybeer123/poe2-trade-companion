import type { SourceTab, TabScanResult } from "../adapters/gearSorter.js";
import { type GridCell, type IdentifiedItem } from "./gearSort.js";
import { CLASS_SIZE_DEFAULTS } from "./itemSizeCatalog.js";
import {
  evaluateStashItem, STASH_SCORING_VERSION, unavailableStashQuote,
  validateStashValuationSettings,
  type StashMarketQuote, type StashValuationReport, type StashValuationSettings,
} from "./stashValuation.js";

/** Narrow existing sorter seam: tests replay the entire workflow without OS input. */
export interface DumpValuationSorter {
  scanTab(source: SourceTab, options?: { navigate?: boolean; exhaustive?: boolean }): Promise<TabScanResult>;
  gotoTab(label: string, occurrence?: number, topLevel?: boolean): Promise<boolean>;
  bagCellsNow(): Promise<GridCell[]>;
  identifyBagItems(): Promise<{ items: IdentifiedItem[]; unread: GridCell[] }>;
  copyAt(x: number, y: number): Promise<string>;
  withdrawItemsSerial(items: readonly IdentifiedItem[], label: string): Promise<IdentifiedItem[]>;
  depositBagCells(points: readonly GridCell[], destination: string, options: { shiftOnly: boolean }): Promise<number>;
}

export interface DumpValuationRunOptions {
  settings: StashValuationSettings;
  mode: "scan" | "move";
  sorter: DumpValuationSorter;
  quote: (text: string) => Promise<StashMarketQuote>;
  onReport: (report: StashValuationReport) => void;
  checkpoint?: (message: string) => Promise<void>;
  now?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

/** Split identical neighbours only when every cell fits a known class footprint. */
export function auditPhysicalItems(items: readonly IdentifiedItem[]): IdentifiedItem[] {
  return items.flatMap(item => {
    // Relics have varying footprints; the general catalogue's 1x1 default
    // is insufficient evidence to split an actual observed relic.
    const size = CLASS_SIZE_DEFAULTS.find(entry => entry.itemClass.toLowerCase() === item.itemClass?.toLowerCase());
    if (!size || /^Relics$/i.test(item.itemClass ?? "") || item.cells.length <= size.w * size.h) return [item];
    const remaining = new Map(item.cells.map(cell => [`${cell.row},${cell.col}`, cell]));
    const parts: IdentifiedItem[] = [];
    while (remaining.size) {
      const start = [...remaining.values()].sort((a, b) => a.row - b.row || a.col - b.col)[0]!;
      const cells: GridCell[] = [];
      for (let dr = 0; dr < size.h; dr += 1) for (let dc = 0; dc < size.w; dc += 1) {
        const cell = remaining.get(`${start.row + dr},${start.col + dc}`);
        if (!cell) return [item];
        cells.push(cell);
      }
      for (const cell of cells) remaining.delete(`${cell.row},${cell.col}`);
      parts.push({ ...item, cells });
    }
    return parts;
  });
}

function identity(text: string): string {
  // Keep all copied properties (quality, sockets, corruption, rolls); stack size
  // is quantity, so merging a stack still verifies against the same identity.
  return text.replace(/\r/g, "").replace(/^Stack Size:.*$/gim, "Stack Size:").trim();
}

function quantity(text: string): number {
  const value = /^Stack Size:\s*([\d,]+)\s*\//im.exec(text)?.[1];
  return value ? Number(value.replace(/,/g, "")) : 1;
}

function amountIn(scan: Extract<TabScanResult, { ok: true }>, text: string): number {
  return auditPhysicalItems(scan.modelItems).filter(item => identity(item.text) === identity(text))
    .reduce((sum, item) => sum + quantity(item.text), 0);
}

function unreadIn(scan: Extract<TabScanResult, { ok: true }>): Array<{ row: number; col: number; reason: string }> {
  return [
    ...scan.unread.map(cell => ({ row: cell.row, col: cell.col, reason: "Visible cell did not yield readable item text." })),
    ...(scan.coverage?.excludedCells ?? []).map(cell => ({ row: cell.row, col: cell.col, reason: "Cell was outside the calibrated safe input area." })),
  ];
}

function quoteExpired(quote: StashMarketQuote, settings: StashValuationSettings, at: string): boolean {
  const time = Date.parse(at);
  const age = time - Date.parse(quote.fetchedAt);
  const validUntil = quote.validUntil;
  return !Number.isFinite(age) || age < -60_000 || age > settings.maxAgeMinutes * 60_000 ||
    (validUntil !== undefined && (!Number.isFinite(Date.parse(validUntil)) || time >= Date.parse(validUntil)));
}

/** Scan first, price every item, then move only validated selections. */
export async function runDumpValuation(options: DumpValuationRunOptions): Promise<StashValuationReport> {
  const errors = validateStashValuationSettings(options.settings);
  if (errors.length) throw new Error(errors.join(" "));
  const now = options.now ?? (() => new Date().toISOString());
  const settings = structuredClone(options.settings);
  const startedAt = now();
  const report: StashValuationReport = {
    schemaVersion: 1, id: startedAt, startedAt, league: settings.league, settings,
    scoreVersion: STASH_SCORING_VERSION, mode: options.mode, status: "running",
    sourceTab: settings.sourceTab, scannedItems: 0, unreadCells: [], rows: [], errors: [],
  };
  const save = () => options.onReport(structuredClone(report));
  const checkpoint = (message: string) => options.checkpoint?.(message) ?? Promise.resolve();
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let rateLimitWaits = 0;
  const source: SourceTab = { label: settings.sourceTab, occurrence: 0, topLevel: true };
  save();
  try {
    await checkpoint(`scan every cell in ${source.label}`);
    const scan = await options.sorter.scanTab(source, { exhaustive: true });
    if (!scan.ok) throw new Error(`Source scan failed: ${scan.reason}`);
    const items = auditPhysicalItems(scan.modelItems);
    report.scannedItems = items.length;
    report.unreadCells = unreadIn(scan);
    // Persist the whole copied inventory immediately, before a slow/throttled
    // network lookup can interrupt the run. Every unpriced item remains visible.
    report.rows = items.map((item, index) => evaluateStashItem(item.text,
      unavailableStashQuote(settings.league, "Market lookup pending.", now()), settings,
      { id: `${startedAt}:${index}`, row: item.cells[0]?.row, col: item.cells[0]?.col, at: now() }));
    save();
    for (const [index, item] of items.entries()) {
      await checkpoint(`price item ${index + 1}/${items.length}`);
      let quote: StashMarketQuote;
      try {
        quote = await options.quote(item.text);
        if (quote.state === "unavailable" && quote.retryAfter) {
          const resumeAt = Date.parse(quote.retryAfter) + 250;
          const remaining = resumeAt - Date.parse(now());
          if (!Number.isFinite(remaining) || remaining < 0 || remaining > 15 * 60_000 || rateLimitWaits >= 2) {
            report.rows[index] = evaluateStashItem(item.text, quote, settings,
              { id: report.rows[index]!.id, row: item.cells[0]?.row, col: item.cells[0]?.col, at: now() });
            save();
            throw new Error("Pricing paused after repeated or unbounded market throttling. All item copies are saved for a later valuation.");
          }
          rateLimitWaits += 1;
          report.rows[index] = evaluateStashItem(item.text, quote, settings,
            { id: report.rows[index]!.id, row: item.cells[0]?.row, col: item.cells[0]?.col, at: now() });
          report.rows[index]!.reasons.push(`Pricing waits for the trade service until ${quote.retryAfter}.`);
          save();
          while (Date.parse(now()) < resumeAt) {
            await checkpoint(`market restriction until ${quote.retryAfter}`);
            await sleep(Math.min(250, resumeAt - Date.parse(now())));
          }
          await checkpoint(`resume pricing item ${index + 1}/${items.length}`);
          quote = await options.quote(item.text);
        }
      } catch (error) {
        if (error instanceof Error && (error.name === "SortStop" || error.message.startsWith("Pricing paused"))) throw error;
        quote = unavailableStashQuote(settings.league, "Market lookup failed; item retained for review.", now());
      }
      report.rows[index] = evaluateStashItem(item.text, quote, settings,
        { id: report.rows[index]!.id, row: item.cells[0]?.row, col: item.cells[0]?.col, at: now() });
      save();
    }

    if (options.mode === "move") {
      if (report.unreadCells.length) throw new Error("Source coverage is incomplete; resolve unread cells and rescan before transferring items.");
      if ((await options.sorter.bagCellsNow()).length) throw new Error("Empty the inventory before sorting valuable items.");
      const destinationScans = new Map<string, Extract<TabScanResult, { ok: true }>>();
      for (const [index, item] of items.entries()) {
        const row = report.rows[index]!;
        if (row.status !== "planned") continue;
        await checkpoint(`verify ${row.name} before transfer`);
        // At most one lookup at each of the two transfer gates. Never loop
        // against an outage or a provider repeatedly returning expired cache.
        const refreshIfExpired = async (stage: string): Promise<"unchanged" | "refreshed" | "retained"> => {
          if (row.decision !== "valuable" || !quoteExpired(row.quote, settings, now())) return "unchanged";
          await checkpoint(`refresh expired price ${stage}`);
          let refreshed: StashMarketQuote;
          try { refreshed = await options.quote(item.text); }
          catch (error) {
            if (error instanceof Error && error.name === "SortStop") throw error;
            refreshed = unavailableStashQuote(settings.league, "Expired price could not be refreshed.", now());
          }
          Object.assign(row, evaluateStashItem(item.text, refreshed, settings,
            { id: row.id, row: row.row, col: row.col, at: now() }));
          if (refreshed.state !== "priced" || quoteExpired(refreshed, settings, now())) {
            row.status = "stay"; row.decision = "review"; row.destination = settings.sourceTab;
            row.reasons.push(`Price refresh failed or remained expired ${stage}; source item was not withdrawn.`);
            save(); return "retained";
          }
          row.reasons.push(`Refreshed expired market evidence ${stage}.`);
          save();
          return row.status === "planned" ? "refreshed" : "retained";
        };
        if (await refreshIfExpired("before destination verification") === "retained") continue;
        // Long whole-tab appraisals can outlive a quote. Re-evaluate the gate
        // immediately before any withdrawal; stale evidence cannot authorize it.
        const freshDecision = evaluateStashItem(item.text, row.quote, settings, { id: row.id, at: now() });
        if (freshDecision.destination !== row.destination || freshDecision.status !== "planned") {
          row.status = "stay"; row.destination = settings.sourceTab;
          row.reasons.push("Eligibility changed while scanning; retained in the source for a fresh lookup."); save(); continue;
        }
        if ((await options.sorter.bagCellsNow()).length) throw new Error("Inventory is no longer empty; transfers stopped.");
        let before = destinationScans.get(row.destination);
        if (!before) {
          const result = await options.sorter.scanTab({ label: row.destination, occurrence: 0 }, { exhaustive: true });
          if (!result.ok || unreadIn(result).length) {
            row.status = "failed"; row.reasons.push("Destination could not be fully verified; item remains in source."); save(); continue;
          }
          before = result; destinationScans.set(row.destination, before);
        }
        if (!(await options.sorter.gotoTab(source.label, 0, true))) throw new Error("Cannot return to the source tab.");
        const cell = item.cells[0];
        const verifySourceIdentity = async () => {
          await checkpoint(`confirm source identity for ${row.name}`);
          return cell && (await options.sorter.copyAt(cell.x, cell.y)).replace(/\r/g, "").trim() === item.text.replace(/\r/g, "").trim();
        };
        if (!(await verifySourceIdentity())) {
          row.status = "failed"; row.reasons.push("Source item changed after scanning; no transfer attempted."); save();
          throw new Error("Source item identity changed; rescan the tab.");
        }
        const verifiedDestination = row.destination;
        const finalRefresh = await refreshIfExpired("after destination verification");
        if (finalRefresh === "retained") continue;
        if (row.destination !== verifiedDestination) {
          row.status = "stay"; row.destination = settings.sourceTab;
          row.reasons.push("Refreshed evidence changed the destination; retained for a new verified route."); save(); continue;
        }
        if (finalRefresh === "refreshed" && !(await verifySourceIdentity())) {
          row.status = "failed"; row.reasons.push("Source item changed during the price refresh; no transfer attempted."); save();
          throw new Error("Source item identity changed during price refresh; rescan the tab.");
        }
        const beforeWithdrawal = evaluateStashItem(item.text, row.quote, settings,
          { id: row.id, row: row.row, col: row.col, at: now() });
        if (beforeWithdrawal.destination !== row.destination || beforeWithdrawal.status !== "planned" ||
            (beforeWithdrawal.decision === "valuable" && quoteExpired(row.quote, settings, now()))) {
          Object.assign(row, beforeWithdrawal, { status: "stay", destination: settings.sourceTab });
          row.reasons.push("Quote expired during destination verification; source item was not withdrawn."); save(); continue;
        }
        Object.assign(row, beforeWithdrawal);
        const withdrawn = await options.sorter.withdrawItemsSerial([item], source.label);
        let bag: Awaited<ReturnType<DumpValuationSorter["identifyBagItems"]>>;
        const isExactBagReceipt = (receipt: typeof bag) => receipt.unread.length === 0 && receipt.items.length === 1 &&
          receipt.items[0]!.cells.length > 0 && identity(receipt.items[0]!.text) === identity(item.text) &&
          quantity(receipt.items[0]!.text) === quantity(item.text);
        if (withdrawn.length !== 1) {
          // Overlay pixels can conceal a bag-count increase. A failed growth
          // check is not evidence that the source item stayed in its cell.
          row.status = "failed"; row.actualDestination = "inventory (unconfirmed)";
          row.reasons.push("Withdrawal growth was not observed; the item may be in inventory. No withdrawal retry was attempted."); save();
          if (withdrawn.length !== 0) throw new Error("Withdrawal could not be verified; inspect the source and inventory before retrying.");
          await checkpoint(`verify text receipt after unobserved withdrawal for ${row.name}`);
          bag = await options.sorter.identifyBagItems();
          if (!isExactBagReceipt(bag) || !cell || (await options.sorter.copyAt(cell.x, cell.y)).trim() !== "") {
            throw new Error("Withdrawal could not be verified by exact inventory text and an empty source cell; inspect both before retrying.");
          }
          row.reasons.push("Verified withdrawal by exact inventory item text and quantity plus an empty original source cell after the bag-count increase was obscured.");
        } else {
          // Persist the observed withdrawal before another input or read can fail.
          row.status = "failed"; row.actualDestination = "inventory"; save();
          bag = await options.sorter.identifyBagItems();
        }
        // From here on failure means the user must inspect the bag. Never
        // silently fall back to a class tab, junk tab, or source coordinate.
        row.status = "failed"; row.actualDestination = "inventory"; save();
        if (!isExactBagReceipt(bag)) {
          throw new Error("Withdrawn inventory item does not match the source; transfers stopped.");
        }
        if (!(await options.sorter.gotoTab(row.destination))) throw new Error("Destination is unreachable; the withdrawn item remains in inventory.");
        const left = await options.sorter.depositBagCells([bag.items[0]!.cells[0]!], row.destination, { shiftOnly: true });
        if (left > 0 || (await options.sorter.bagCellsNow()).length) throw new Error("Deposit did not commit; item remains in inventory.");
        delete row.actualDestination;
        const after = await options.sorter.scanTab({ label: row.destination, occurrence: 0 }, { navigate: false, exhaustive: true });
        if (!after.ok || unreadIn(after).length || amountIn(after, item.text) !== amountIn(before, item.text) + quantity(item.text)) {
          row.reasons.push("Item left inventory, but its destination tooltip/quantity could not be confirmed."); save();
          throw new Error("Destination receipt could not be verified; check the destination before continuing.");
        }
        row.status = "moved"; row.actualDestination = row.destination;
        row.reasons.push("Verified source identity, inventory receipt, and destination item quantity after transfer.");
        destinationScans.set(row.destination, after); save();
      }
    }
    report.status = report.unreadCells.length || report.rows.some(row => row.quote.state !== "priced" || row.status === "failed")
      ? "incomplete" : "complete";
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stash valuation failed.";
    report.status = error instanceof Error && error.name === "SortStop" ? "stopped" : "failed";
    report.errors.push(message);
  }
  report.finishedAt = now(); save();
  return report;
}
