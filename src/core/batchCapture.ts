import type { SourceTab, TabScanResult } from "../adapters/gearSorter.js";
import { auditPhysicalItems, type DumpValuationRunOptions, type DumpValuationSorter } from "./dumpValuationRun.js";
import { assessBatch, assessRow, BATCH_MODEL, BUNDLED_KNOWLEDGE, type LeagueKnowledge } from "./batchTriage.js";
import { unavailableStashQuote, validateStashValuationSettings, type StashValuationReport, type StashValuationRow } from "./stashValuation.js";
import { parseItemText } from "./parseItem.js";
import { validateSavedStashReport } from "./savedStashPricing.js";
import { knowledgeForReport } from "./leagueKnowledge.js";
import type { IdentifiedItem } from "./gearSort.js";

export async function captureBatch(options: Omit<DumpValuationRunOptions, "quote"> & { saved?: StashValuationReport; knowledge?: LeagueKnowledge }): Promise<StashValuationReport> {
  const issues = validateStashValuationSettings(options.settings);
  if (options.saved) issues.push(...validateSavedStashReport(options.saved));
  if (options.saved?.rows.some(row => row.status === "moved" || row.status === "failed")) issues.push("A capture with transfer history cannot be resumed as an unfinished scan; create a new capture.");
  if (issues.length) throw new Error(issues.join(" "));
  const now = options.now ?? (() => new Date().toISOString());
  const at = now(), settings = structuredClone(options.settings);
  const knowledge = options.knowledge ?? BUNDLED_KNOWLEDGE;
  const sourceChoice = settings.captureSource ?? "stash";
  const sourceNames = sourceChoice === "both" ? [settings.sourceTab, "Inventory"] : [sourceChoice === "inventory" ? "Inventory" : settings.sourceTab];
  const report: StashValuationReport = options.saved ? structuredClone(options.saved) : {
    schemaVersion: 1, id: at, startedAt: at, league: settings.league, settings, sourceTab: settings.sourceTab,
    scoreVersion: BATCH_MODEL, mode: "scan", status: "running", scannedItems: 0, unreadCells: [], rows: [], errors: [],
    capture: { id: at, league: settings.league, patch: settings.league === knowledge.league ? knowledge.patch : "unknown", completedSources: [], complete: false }
  };
  if (!report.capture || report.capture.league !== settings.league || report.settings.captureSource !== settings.captureSource ||
    report.sourceTab !== settings.sourceTab) throw new Error("Capture resume requires its original sources and league.");
  report.status = "running"; report.errors = [];
  const save = () => { report.scannedItems = report.rows.length; options.onReport(structuredClone(report)); };
  save();
  try {
    for (const source of sourceNames) {
      if (report.capture.completedSources.includes(source)) continue;
      await options.checkpoint?.("Capture every physical item in " + source + "; no transfers or market requests.");
      let items: IdentifiedItem[];
      let unread: StashValuationReport["unreadCells"];
      const record = (items: IdentifiedItem[], unresolved: StashValuationReport["unreadCells"]) => {
        const captured: StashValuationRow[] = items.map((item, index) => {
          const parsed = parseItemText(item.text);
          return { id: report.id + ":" + source + ":" + index, rawText: item.text, name: parsed.name, baseType: parsed.baseType,
            itemClass: parsed.itemClass, itemLevel: parsed.itemLevel, fingerprint: parsed.fingerprint, sourceTab: source,
            sourceKind: source === "Inventory" ? "inventory" : "stash", row: item.cells[0]?.row, col: item.cells[0]?.col,
            cells: item.cells.map(({ row, col }) => ({ row, col })), parsed, quantity: quantity(item.text),
            scoreVersion: "capture-only", gearScore: 0, craftScore: 0, mods: [],
            quote: unavailableStashQuote(settings.league, "Not requested; local capture.", now()),
            decision: "review", status: "stay", destination: source, reasons: ["Captured; local batch assessment pending."] };
        });
        report.rows = [...report.rows.filter(row => row.sourceTab !== source), ...captured];
        report.unreadCells = [...report.unreadCells.filter(cell => cell.source !== source), ...unresolved.map(cell => ({ ...cell, source }))];
        save();
      };
      const onProgress = (progress: { items: IdentifiedItem[]; unread: import("./gearSort.js").GridCell[] }) =>
        record(auditPhysicalItems(progress.items), progress.unread.map(cell => ({ row: cell.row, col: cell.col, reason: "Capture not yet complete." })));
      if (source === "Inventory") {
        const scan = await options.sorter.identifyBagItems({ exhaustive: true, onProgress });
        items = auditPhysicalItems(scan.items); unread = scan.unread.map(cell => ({ row: cell.row, col: cell.col, source }));
      } else {
        const scan = await options.sorter.scanTab({ label: source, occurrence: 0, topLevel: true }, { exhaustive: true, onProgress });
        if (!scan.ok) throw new Error("Source scan failed: " + scan.reason);
        items = auditPhysicalItems(scan.modelItems);
        unread = [...scan.unread, ...(scan.coverage?.excludedCells ?? [])].map(cell => ({ row: cell.row, col: cell.col, source }));
      }
      record(items, unread);
      if (!unread.length) report.capture.completedSources.push(source);
      save();
    }
    report.capture.complete = sourceNames.every(source => report.capture!.completedSources.includes(source)) && report.unreadCells.length === 0;
    const assessed = assessBatch(report, settings, now(), knowledge);
    options.onReport(assessed);
    return assessed;
  } catch (error) {
    report.status = error instanceof Error && ["SortStop", "AbortError"].includes(error.name) ? "stopped" : "failed";
    report.errors.push(error instanceof Error ? error.message : "Capture failed.");
    report.finishedAt = now(); save(); return report;
  }
}

const identity = (text: string) => text.replace(/\r/g, "").replace(/^Stack Size:.*$/gim, "Stack Size:").trim();
const quantity = (text: string) => Number(/^Stack Size:\s*([\d,]+)/im.exec(text)?.[1]?.replace(/,/g, "") ?? 1);
const unread = (scan: Extract<TabScanResult, { ok: true }>) => scan.unread.length + (scan.coverage?.excludedCells.length ?? 0);
const amount = (items: IdentifiedItem[], text: string) => auditPhysicalItems(items).filter(item => identity(item.text) === identity(text)).reduce((sum, item) => sum + quantity(item.text), 0);

/** Movement starts from an explicit assessment and checks current locations. Never invokes a market provider. */
export async function sortSavedBatch(saved: StashValuationReport, sorter: DumpValuationSorter,
  onReport: (report: StashValuationReport) => void, checkpoint?: (message: string) => Promise<void>, now = () => new Date().toISOString()): Promise<StashValuationReport> {
  const issues = validateSavedStashReport(saved);
  if (issues.length) throw new Error(issues.join(" "));
  if (!saved.capture?.complete || saved.unreadCells.length || !saved.rows.every(row => row.assessment)) throw new Error("Complete capture and local assessment are required before sorting.");
  const report = structuredClone(saved);
  const knowledge = knowledgeForReport(report);
  report.mode = "move"; report.status = "running";
  const save = () => onReport(structuredClone(report));
  const sourceScans = new Map<string, IdentifiedItem[]>();
  const destinations = new Map<string, Extract<TabScanResult, { ok: true }>>();
  save();
  try {
    // Inventory-source items are handled first, freeing space for stash withdrawals.
    const ordered = [...report.rows].sort((a, b) => Number(b.sourceKind === "inventory") - Number(a.sourceKind === "inventory"));
    for (const row of ordered) {
      if (row.status !== "planned") continue;
      await checkpoint?.("Revalidate current identity and eligibility: " + row.name);
      const assessed = assessRow(row, report.settings, now(), knowledge);
      if (assessed.status !== "planned" || assessed.destination !== row.destination) {
        Object.assign(row, assessed, { status: "stay" }); save(); continue;
      }
      const inventorySource = row.sourceKind === "inventory";
      let current = sourceScans.get(row.sourceTab);
      if (!current) {
        if (inventorySource) {
          const bag = await sorter.identifyBagItems({ exhaustive: true });
          if (bag.unread.length) throw new Error("Inventory coverage is incomplete.");
          current = auditPhysicalItems(bag.items);
        } else {
          if ((await sorter.bagCellsNow()).length) throw new Error("Stash withdrawals require free inventory; retained inventory items must be handled first.");
          const scan = await sorter.scanTab({ label: row.sourceTab, occurrence: 0, topLevel: true }, { exhaustive: true });
          if (!scan.ok || unread(scan)) throw new Error("Source could not be fully revalidated.");
          current = auditPhysicalItems(scan.modelItems);
        }
        sourceScans.set(row.sourceTab, current);
      }
      // A moved copy is indistinguishable from an identical neighbour. Do not relocate by fingerprint alone.
      const item = current.find(item => item.cells[0]?.row === row.row && item.cells[0]?.col === row.col && item.text.replace(/\r/g, "").trim() === row.rawText.replace(/\r/g, "").trim());
      if (!item) { row.status = "failed"; row.reasons.push("Current item/position differs from capture; no transfer attempted. Recapture before retry."); save(); throw new Error("Source identity or location changed."); }
      let before = destinations.get(row.destination);
      if (!before) {
        const scan = await sorter.scanTab({ label: row.destination, occurrence: 0 }, { exhaustive: true });
        if (!scan.ok || unread(scan)) throw new Error("Destination coverage is incomplete; no transfer attempted.");
        before = scan; destinations.set(row.destination, before);
      }
      if (!inventorySource && !await sorter.gotoTab(row.sourceTab, 0, true)) throw new Error("Source is unreachable.");
      const cell = item.cells[0]!;
      if ((await sorter.copyAt(cell.x, cell.y)).replace(/\r/g, "").trim() !== item.text.replace(/\r/g, "").trim()) {
        row.status = "failed"; row.reasons.push("Source identity changed immediately before input."); save(); throw new Error("Source item changed.");
      }
      const final = assessRow(row, report.settings, now(), knowledge);
      if (final.status !== "planned" || final.destination !== row.destination) { row.status = "stay"; save(); continue; }
      let bag = await sorter.identifyBagItems({ exhaustive: true });
      if (!inventorySource) {
        if (bag.items.length || bag.unread.length) throw new Error("Inventory is no longer empty.");
        // Persist uncertainty before emitting input: interruption cannot erase the possibility of a withdrawal.
        row.status = "failed"; row.actualDestination = "inventory (unconfirmed)"; save();
        const { withdrawn } = await sorter.withdrawItemsSerial([item], row.sourceTab);
        bag = await sorter.identifyBagItems({ exhaustive: true });
        if (withdrawn.length > 1 || bag.unread.length || bag.items.length !== 1 ||
          identity(bag.items[0]!.text) !== identity(item.text) || quantity(bag.items[0]!.text) !== quantity(item.text) ||
          (await sorter.copyAt(cell.x, cell.y)).trim() !== "") throw new Error("Withdrawal receipt could not be verified; inspect source and inventory.");
        row.actualDestination = "inventory"; row.reasons.push("Verified exact inventory text/quantity and empty original source cell."); save();
      }
      const bagItem = inventorySource ? bag.items.find(i => i.cells[0]?.row === row.row && i.cells[0]?.col === row.col && identity(i.text) === identity(row.rawText) && quantity(i.text) === quantity(row.rawText)) : bag.items[0];
      if (bag.unread.length || !bagItem) throw new Error("Exact inventory identity not confirmed.");
      const beforeBagAmount = amount(bag.items, item.text);
      if (!await sorter.gotoTab(row.destination)) throw new Error("Destination unreachable; item remains in inventory.");
      await checkpoint?.("Deposit verified item: " + row.name);
      row.status = "failed"; row.actualDestination = "inventory (deposit pending)"; save();
      await sorter.depositBagCells([bagItem.cells[0]!], row.destination, { shiftOnly: true });
      const afterBag = await sorter.identifyBagItems({ exhaustive: true });
      if (afterBag.unread.length || amount(afterBag.items, item.text) !== beforeBagAmount - quantity(item.text)) throw new Error("Inventory departure receipt failed.");
      row.actualDestination = row.destination + " (unconfirmed)"; save();
      const after = await sorter.scanTab({ label: row.destination, occurrence: 0 } satisfies SourceTab, { exhaustive: true, navigate: false });
      if (!after.ok || unread(after) || amount(after.modelItems, item.text) !== amount(before.modelItems, item.text) + quantity(item.text)) throw new Error("Destination receipt failed; inspect destination before retry.");
      row.status = "moved"; row.actualDestination = row.destination;
      row.reasons.push("Verified source identity, inventory departure, and exact destination quantity receipt.");
      destinations.set(row.destination, after); sourceScans.delete(row.sourceTab); save();
    }
    report.status = report.rows.some(row => row.status === "failed") ? "incomplete" : "complete";
  } catch (error) {
    report.status = error instanceof Error && ["SortStop", "AbortError"].includes(error.name) ? "stopped" : "failed";
    report.errors.push(error instanceof Error ? error.message : "Sorting failed.");
  }
  report.finishedAt = now(); save(); return report;
}
