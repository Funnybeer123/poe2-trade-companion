import { defaultStashValuationSettings, evaluateStashItem, unavailableStashQuote, type StashValuationReport } from "../../src/core/stashValuation.js";
import { assessBatch } from "../../src/core/batchTriage.js";
import { destForItemClass, type IdentifiedItem } from "../../src/core/gearSort.js";
import type { TabScanResult } from "../../src/adapters/gearSorter.js";
export const AT = "2026-09-14T12:00:00Z";
export const settings = () => ({ ...defaultStashValuationSettings(), league: "Forbidden Rites" });
export const affix = (kind: "Prefix" | "Suffix", tier: number, text: string, name = "Fixture") =>
  '{ ' + kind + ' Modifier "' + name + '" (Tier: ' + tier + ') }\n' + text;
export const text = (mods: string[], options: { itemClass?: string; base?: string; rarity?: string; name?: string; status?: string; itemLevel?: number } = {}) =>
  "Item Class: " + (options.itemClass ?? "Rings") + "\nRarity: " + (options.rarity ?? "Rare") + "\n" + (options.name ?? "Fixture Ring") +
  "\n" + (options.base ?? "Ruby Ring") + "\n--------\nItem Level: " + (options.itemLevel ?? 82) + "\n--------\n" + mods.join("\n") + (options.status ? "\n--------\n" + options.status : "");
export const strongText = () => text([
  affix("Prefix", 1, "+110(100-119) to maximum Life"),
  affix("Suffix", 2, "+38(36-40)% to Fire Resistance"),
  affix("Suffix", 2, "+38(36-40)% to Cold Resistance"),
]);
export const physical = (rawText = strongText(), col = 0): IdentifiedItem => {
  const itemClass = /Item Class: (.*)/.exec(rawText)![1]!;
  return { text: rawText, itemClass, dest: destForItemClass(itemClass), cells: [{ row: 0, col, x: col * 50, y: 300 }] };
};
export const scan = (items: IdentifiedItem[], unread = false): TabScanResult => ({ ok: true, occupiedCount: items.length,
  modelItems: items, reads: items.map(item => ({ cell: item.cells[0]!, text: item.text })),
  unread: unread ? [{ row: 3, col: 4, x: 200, y: 500 }] : [], region: { x: 0, y: 0, w: 1200, h: 1200 },
  cols: 24, rows: 24, coverage: { totalCells: 576, copiedCells: 576, excludedCells: [] } });
export function batch(texts = [strongText()]): StashValuationReport {
  const config = settings();
  const rows = texts.map((raw, index) => evaluateStashItem(raw, unavailableStashQuote(config.league, "Not requested", AT), config, { id: "physical-" + index, row: 0, col: index, at: AT }));
  return assessBatch({ schemaVersion: 1, id: "fixture-batch", startedAt: AT, finishedAt: AT, league: config.league, settings: config,
    sourceTab: "Dump", mode: "scan", status: "complete", scannedItems: rows.length, rows, unreadCells: [], errors: [], scoreVersion: "fixture" }, config, AT);
}
