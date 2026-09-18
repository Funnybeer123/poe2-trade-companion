import type { SourceTab, TabScanResult } from "../adapters/gearSorter.js";
import type { GridCell, IdentifiedItem } from "./gearSort.js";
import { knownPhysicalItemSize } from "./itemSizeCatalog.js";
import { parseItemText } from "./parseItem.js";
import type { StashMarketQuote, StashValuationReport, StashValuationSettings } from "./stashValuation.js";
import { captureBatch, sortSavedBatch } from "./batchCapture.js";
/** Narrow existing sorter seam: tests replay the entire workflow without OS input. */
export interface DumpValuationSorter {
  scanTab(source: SourceTab, options?: { navigate?: boolean; exhaustive?: boolean; onProgress?: CaptureProgress }): Promise<TabScanResult>;
  gotoTab(label: string, occurrence?: number, topLevel?: boolean): Promise<boolean>;
  bagCellsNow(): Promise<GridCell[]>;
  identifyBagItems(options?: { exhaustive?: boolean; onProgress?: CaptureProgress }): Promise<{ items: IdentifiedItem[]; unread: GridCell[] }>;
  copyAt(x: number, y: number): Promise<string>;
  withdrawItemsSerial(items: readonly IdentifiedItem[], label: string): Promise<{ withdrawn: IdentifiedItem[]; bagFull: boolean }>;
  depositBagCells(points: readonly GridCell[], destination: string, options: { shiftOnly: boolean }): Promise<number>;
}
export type CaptureProgress = (progress: { items: IdentifiedItem[]; unread: GridCell[] }) => void;

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
    const size = knownPhysicalItemSize(item.itemClass, parseItemText(item.text).baseType);
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

/** Capture and local assessment never call quote. Movement is a separately resumable action. */
export async function runDumpValuation(options: DumpValuationRunOptions): Promise<StashValuationReport> {
  const captured = await captureBatch(options);
  if (options.mode !== "move" || !captured.capture?.complete) return captured;
  return sortSavedBatch(captured, options.sorter, options.onReport, options.checkpoint, options.now);
}
