import { describe, expect, it, vi } from "vitest";
import { auditPhysicalItems, runDumpValuation, type DumpValuationSorter } from "../src/core/dumpValuationRun.js";
import { captureBatch, sortSavedBatch } from "../src/core/batchCapture.js";
import { assessBatch } from "../src/core/batchTriage.js";
import type { StashValuationReport } from "../src/core/stashValuation.js";
import type { IdentifiedItem, GridCell } from "../src/core/gearSort.js";
import { AT, settings, batch, strongText, physical, scan } from "./support/batchFixtures.js";

function fixture(options: { inventory?: boolean; unrelated?: boolean; receipt?: boolean; masked?: boolean; depositFails?: boolean } = {}) {
  const source = [physical()];
  let stash = options.inventory ? [] : [...source];
  let bag = options.inventory ? source.map(item => ({ ...item, cells: item.cells.map(cell => ({ ...cell, y: 1500 })) })) : [];
  if (options.unrelated) bag.push(physical(strongText().replace("+38(36-40)% to Fire Resistance", "Unknown special effect"), 4));
  let destination: typeof source = [];
  const saves: StashValuationReport[] = [];
  const sorter: DumpValuationSorter = {
    scanTab: vi.fn(async source => source.topLevel ? scan(stash) : scan(options.receipt === false ? [] : destination)),
    gotoTab: vi.fn(async () => true), bagCellsNow: vi.fn(async () => bag.flatMap(item => item.cells)),
    identifyBagItems: vi.fn(async () => ({ items: bag, unread: [] })),
    copyAt: vi.fn(async (x, y) => [...stash, ...bag].find(item => item.cells.some(cell => cell.x === x && cell.y === y))?.text ?? ""),
    withdrawItemsSerial: vi.fn(async (items: readonly IdentifiedItem[]) => {
      stash = []; bag = items.map(item => ({ ...item, cells: item.cells.map(cell => ({ ...cell, y: 1500 })) }));
      return options.masked ? [] : [...items];
    }),
    depositBagCells: vi.fn(async (points: readonly GridCell[]) => {
      if (options.depositFails) return 1;
      const moved = bag.filter(item => item.cells.some(cell => points.some(point => point.x === cell.x && point.y === cell.y)));
      bag = bag.filter(item => !moved.includes(item)); destination = [...destination, ...moved]; return 0;
    }),
  };
  return { sorter, saves, save: (report: StashValuationReport) => saves.push(structuredClone(report)),
    reposition: () => { stash = [physical(strongText(), 2)]; } };
}
describe("capture, local assessment and independently resumed verified sorting", () => {
  it("captures every item without invoking the market or transfers, even with a nonempty bag", async () => {
    const f = fixture();
    vi.mocked(f.sorter.bagCellsNow).mockResolvedValue([{ row: 0, col: 0, x: 10, y: 10 }]);
    vi.mocked(f.sorter.scanTab).mockResolvedValue(scan([physical(), physical(strongText(), 1)]));
    const quote = vi.fn(async () => { throw new Error("Network unavailable"); });
    const result = await runDumpValuation({ settings: settings(), mode: "scan", sorter: f.sorter, quote, now: () => AT, onReport: f.save });
    expect(result.rows).toHaveLength(2); expect(result.status).toBe("complete");
    expect(quote).not.toHaveBeenCalled(); expect(f.sorter.withdrawItemsSerial).not.toHaveBeenCalled();
    expect(f.saves.some(report => report.rows.length === 2 && report.rows.every(row => !row.assessment))).toBe(true);
    expect(result.rows.every(row => row.assessment)).toBe(true);
  });
  it("captures a nonempty inventory without empty-bag preconditions or stash navigation", async () => {
    const f = fixture({ inventory: true });
    const result = await captureBatch({ settings: { ...settings(), captureSource: "inventory" }, mode: "scan", sorter: f.sorter, now: () => AT, onReport: f.save });
    expect(result.capture!.complete).toBe(true);
    expect(result.rows[0]).toMatchObject({ sourceKind: "inventory", sourceTab: "Inventory", quantity: 1 });
    expect(f.sorter.scanTab).not.toHaveBeenCalled(); expect(f.sorter.depositBagCells).not.toHaveBeenCalled();
    expect(f.sorter.identifyBagItems).toHaveBeenCalledWith(expect.objectContaining({ exhaustive: true }));
  });
  it("saves partial progress on cancellation and resumes the incomplete source only", async () => {
    const f = fixture({ inventory: true });
    vi.mocked(f.sorter.scanTab).mockResolvedValue(scan([physical()]));
    vi.mocked(f.sorter.identifyBagItems).mockImplementationOnce(async options => {
      options?.onProgress?.({ items: [physical()], unread: [{ row: 1, col: 1, x: 1, y: 1 }] });
      throw Object.assign(new Error("Stopped"), { name: "SortStop" });
    });
    const config = { ...settings(), captureSource: "both" as const };
    const partial = await captureBatch({ settings: config, mode: "scan", sorter: f.sorter, now: () => AT, onReport: f.save });
    expect(partial).toMatchObject({ status: "stopped", scannedItems: 2, capture: { completedSources: ["Dump"], complete: false } });
    expect(partial.rows.every(row => !row.assessment)).toBe(true);
    vi.mocked(f.sorter.identifyBagItems).mockResolvedValue({ items: [physical()], unread: [] });
    const resumed = await captureBatch({ settings: config, saved: partial, mode: "scan", sorter: f.sorter, now: () => AT, onReport: f.save });
    expect(f.sorter.scanTab).toHaveBeenCalledTimes(1); expect(resumed.rows).toHaveLength(2); expect(resumed.capture!.complete).toBe(true);
  });
  it("retains unread and excluded grid cells and prevents moving an incomplete capture", async () => {
    const f = fixture();
    vi.mocked(f.sorter.scanTab).mockResolvedValue(scan([physical()], true));
    const captured = await captureBatch({ settings: settings(), mode: "scan", sorter: f.sorter, now: () => AT, onReport: f.save });
    expect(captured.status).toBe("incomplete"); expect(captured.unreadCells).toHaveLength(1);
    await expect(sortSavedBatch(captured, f.sorter, f.save)).rejects.toThrow("Complete capture");
    expect(f.sorter.withdrawItemsSerial).not.toHaveBeenCalled();
  });
  it("splits identical neighbours only with complete known footprints", () => {
    const first = physical();
    expect(auditPhysicalItems([{ ...first, cells: [first.cells[0]!, { ...first.cells[0]!, col: 1 }] }])).toHaveLength(2);
    const helmet = physical(strongText().replace("Rings", "Helmets"));
    helmet.cells = Array.from({ length: 8 }, (_, i) => ({ row: Math.floor(i / 4), col: i % 4, x: 0, y: 0 }));
    expect(auditPhysicalItems([helmet]).map(item => item.cells.length)).toEqual([4, 4]);
    helmet.cells.pop(); expect(auditPhysicalItems([helmet])).toHaveLength(1);
  });
  it.each([false, true])("verifies source, inventory, and destination receipts even when growth is masked=%s", async masked => {
    const f = fixture({ masked });
    const result = await sortSavedBatch(batch(), f.sorter, f.save, undefined, () => AT);
    expect(result.rows[0]).toMatchObject({ status: "moved", actualDestination: "Rings" });
    expect(f.sorter.withdrawItemsSerial).toHaveBeenCalledTimes(1);
    expect(f.sorter.depositBagCells).toHaveBeenCalledWith(expect.any(Array), "Rings", { shiftOnly: true });
    expect(f.saves.some(report => report.rows[0]?.actualDestination === "inventory (unconfirmed)")).toBe(true);
  });
  it("handles an inventory-source batch directly and preserves unrelated bag items", async () => {
    const f = fixture({ inventory: true, unrelated: true });
    const captured = await captureBatch({ settings: { ...settings(), captureSource: "inventory" }, mode: "scan", sorter: f.sorter, now: () => AT, onReport: f.save });
    const result = await sortSavedBatch(captured, f.sorter, f.save, undefined, () => AT);
    expect(result.rows[0]!.status).toBe("moved"); expect(f.sorter.withdrawItemsSerial).not.toHaveBeenCalled();
    expect(result.rows[1]!.status).toBe("stay");
    expect((await f.sorter.identifyBagItems()).items).toHaveLength(1);
  });
  it("stops on changed positions instead of relocating by a potentially duplicate fingerprint", async () => {
    const f = fixture(); f.reposition();
    const result = await sortSavedBatch(batch(), f.sorter, f.save, undefined, () => AT);
    expect(result.status).toBe("failed"); expect(result.rows[0]!.status).toBe("failed");
    expect(f.sorter.withdrawItemsSerial).not.toHaveBeenCalled();
  });
  it.each([{ receipt: false }, { depositFails: true }])("retains a failed transfer receipt without re-withdrawing: %j", async options => {
    const f = fixture(options);
    const result = await sortSavedBatch(batch(), f.sorter, f.save, undefined, () => AT);
    expect(result.rows[0]!.status).toBe("failed"); expect(result.rows[0]!.actualDestination).toBeTruthy();
    const next = assessBatch(result, result.settings, AT);
    const resumed = await sortSavedBatch(next, f.sorter, f.save, undefined, () => AT);
    expect(resumed.rows[0]!.status).toBe("failed"); expect(f.sorter.withdrawItemsSerial).toHaveBeenCalledTimes(1);
  });
  it("requires an exact inventory receipt and an empty source even when withdrawal reports success", async () => {
    const f = fixture();
    vi.mocked(f.sorter.copyAt).mockResolvedValue(strongText());
    const result = await sortSavedBatch(batch(), f.sorter, f.save, undefined, () => AT);
    expect(result.status).toBe("failed"); expect(f.sorter.depositBagCells).not.toHaveBeenCalled();
    expect(result.rows[0]!.actualDestination).toContain("inventory");
  });
  it("preserves moved history on rescore and never plans a second transfer", async () => {
    const f = fixture(), saved = batch();
    saved.rows[0]!.status = "moved"; saved.rows[0]!.actualDestination = "Amulets"; saved.rows[0]!.reasons.push("Historical receipt");
    const result = await sortSavedBatch(assessBatch(saved, saved.settings, AT), f.sorter, f.save, undefined, () => AT);
    expect(result.rows[0]!.reasons).toContain("Historical receipt"); expect(f.sorter.scanTab).not.toHaveBeenCalled();
  });
  it("fails closed before accessing game adapters for malformed saved input", async () => {
    const f = fixture();
    await expect(sortSavedBatch({ bad: true } as unknown as StashValuationReport, f.sorter, f.save)).rejects.toThrow();
    expect(f.sorter.scanTab).not.toHaveBeenCalled();
  });
});
