import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bmpToGray } from "../src/adapters/bmp.js";
import type { StashItem } from "../src/core/bagPack.js";
import { loadProfile } from "../src/core/calibrationStore.js";
import {
  classifyDepositOutcome,
  classifyFillOutcome,
  reconcileTransfer,
} from "../src/core/transferReconciler.js";
import { perceiveUi, type OccupiedCell, type UiFacts } from "../src/core/uiPerception.js";

function cells(entries: Array<[number, number]>, bag?: string): OccupiedCell[] {
  return entries.map(([row, col]) => ({ row, col, x: col * 10 + 5, y: row * 10 + 5, bag }));
}

function item(row: number, col: number, w: number, h: number): StashItem {
  const footprint: Array<{ row: number; col: number }> = [];
  for (let r = 0; r < h; r += 1) {
    for (let c = 0; c < w; c += 1) footprint.push({ row: row + r, col: col + c });
  }
  return {
    id: `${row},${col}:${w}x${h}`,
    grab: { row, col, x: col * 10 + 5, y: row * 10 + 5, bag: "stash" },
    cells: footprint,
    w,
    h,
  };
}

function facts(
  bag: OccupiedCell[],
  stash: OccupiedCell[],
  stashItems: StashItem[] = [],
  panelsOpen = true,
): UiFacts {
  return {
    optionsOpen: false,
    loading: false,
    stashPanelOpen: panelsOpen,
    inventoryPanelOpen: panelsOpen,
    vendorPanelOpen: false,
    stashChestVisible: false,
    inventoryRegion: panelsOpen ? { x: 100, y: 100, w: 120, h: 50 } : undefined,
    stashRegion: panelsOpen ? { x: 0, y: 0, w: 120, h: 120 } : undefined,
    occupiedBag: bag,
    occupiedStash: stash,
    stashItems,
    stashGridSize: { cols: 12, rows: 12 },
    bagEmpty: panelsOpen && bag.length === 0,
    confidence: panelsOpen ? 0.95 : 0.2,
    reason: panelsOpen ? "stash-and-bag-open" : "world-or-unknown",
    scores: {
      sceneOpen: -1,
      sceneClosed: -1,
      stashPanel: -1,
      inventoryPanel: -1,
      chest: -1,
      options: -1,
      stashGrid: panelsOpen,
      inventoryGrid: panelsOpen,
    },
  };
}

describe("transfer reconciliation", () => {
  it("confirms a fill only when source disappearance has matching bag gain", () => {
    const attempted = item(0, 0, 2, 1);
    const before = facts([], cells([[0, 0], [0, 1]], "stash"), [attempted]);
    const after = facts(cells([[0, 0], [0, 1]], "bag"), [], []);
    const result = reconcileTransfer("stash-to-bag", [attempted], before, after);

    expect(result.moved.map((entry) => entry.item.id)).toEqual([attempted.id]);
    expect(result.rejected).toEqual([]);
    expect(result.ambiguous).toEqual([]);
    expect(result.destinationGain).toBe(2);
    expect(result.panelsStable).toBe(true);
  });

  it("rejects an attempted item that remains at its source", () => {
    const attempted = item(3, 4, 1, 1);
    const source = cells([[3, 4]], "stash");
    const result = reconcileTransfer(
      "stash-to-bag",
      [attempted],
      facts([], source, [attempted]),
      facts([], source, [attempted]),
    );

    expect(result.rejected.map((entry) => entry.item.id)).toEqual([attempted.id]);
    expect(result.moved).toEqual([]);
  });

  it("accepts the live search-noise signature when aggregate source loss and bag gain match", () => {
    const attempted = item(4, 4, 1, 3);
    const staleFootprint: Array<[number, number]> = [
      [4, 4],
      [5, 4],
      [6, 4],
    ];
    const unrelated: Array<[number, number]> = [
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
      [0, 4],
      [0, 5],
    ];
    const before = facts([], cells([...staleFootprint, ...unrelated], "stash"), [attempted]);
    const after = facts(
      cells([[0, 0], [1, 0], [2, 0]], "bag"),
      cells([...staleFootprint, ...unrelated.slice(3)], "stash"),
      [attempted],
    );

    const result = reconcileTransfer("stash-to-bag", [attempted], before, after);
    expect(result.sourceCellsBefore - result.sourceCellsAfter).toBe(3);
    expect(result.destinationGain).toBe(3);
    expect(result.moved.map((entry) => entry.item.id)).toEqual([attempted.id]);
    expect(result.rejected).toEqual([]);
  });

  it("keeps a perception-only source disappearance ambiguous", () => {
    const attempted = item(2, 2, 2, 2);
    const before = facts(
      [],
      cells([[2, 2], [2, 3], [3, 2], [3, 3]], "stash"),
      [attempted],
    );
    const result = reconcileTransfer("stash-to-bag", [attempted], before, facts([], [], []));

    expect(result.ambiguous.map((entry) => entry.item.id)).toEqual([attempted.id]);
    expect(result.moved).toEqual([]);
  });

  it("reconciles a multi-cell bag item deposited into stash", () => {
    const attempted = item(0, 11, 1, 3);
    const bag = cells([[0, 11], [1, 11], [2, 11]], "bag");
    const stashAfter = cells([[8, 0], [9, 0], [10, 0]], "stash");
    const result = reconcileTransfer(
      "bag-to-stash",
      [attempted],
      facts(bag, []),
      facts([], stashAfter),
    );

    expect(result.moved).toHaveLength(1);
    expect(result.sourceCellsAfter).toBe(0);
    expect(result.destinationGain).toBe(3);
  });

  it("requires stable open-panel observations for completion", () => {
    expect(classifyDepositOutcome(facts([], []), 1)).toBe("failed");
    expect(classifyDepositOutcome(facts([], []), 2)).toBe("bag-empty");
    expect(classifyDepositOutcome(facts(cells([[0, 0]]), []), 2)).toBe("partial");
    expect(classifyFillOutcome(facts(cells(Array.from({ length: 60 }, (_, i) => [Math.floor(i / 12), i % 12] as [number, number])), []), { eligibleRemaining: 4 })).toBe("bag-full");
    expect(classifyFillOutcome(facts(cells([[0, 0]]), []), { eligibleRemaining: 3, noMoreAutoFit: true })).toBe("no-more-auto-fit");
    expect(classifyFillOutcome(facts([], []), { eligibleRemaining: 0, filtered: true })).toBe("filter-exhausted");
  });

  it("does not classify the recorded top-right wand as an empty bag", () => {
    const bmp = path.resolve("fixtures/perception/live/deposit-1787705758242.bmp");
    if (!existsSync(bmp)) return;
    const observed = perceiveUi(
      bmpToGray(bmp),
      { left: 0, top: 0, width: 3840, height: 2160 },
      {},
      loadProfile(path.resolve("fixtures/perception/templates")),
    );

    expect(observed.occupiedBag.some((cell) => cell.col === 11 && cell.row <= 2)).toBe(true);
    expect(classifyDepositOutcome(observed, 2)).not.toBe("bag-empty");
  });
});
