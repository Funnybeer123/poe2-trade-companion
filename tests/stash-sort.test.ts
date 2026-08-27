import { describe, expect, it } from "vitest";
import {
  buildSortMoveSchedule,
  cellsConnected,
  planStashSort,
  sortRectCells,
  type SortBagState,
  type SortCell,
  type SortableStashItem,
} from "../src/core/stashSort.js";
import {
  executeStashSort,
  sortTargetIsVerifiedEmpty,
  type SortExecutionSnapshot,
} from "../src/core/stashSortExecutor.js";

const tab = {
  signature: "normal:stash-grid:fixture",
  label: "Fixture tab",
  kind: "normal" as const,
  cols: 12,
  rows: 12,
  writable: true,
};

function item(
  id: string,
  itemClass: string,
  baseType: string,
  row: number,
  col: number,
  bagW = 1,
  bagH = 1,
): SortableStashItem {
  return {
    id,
    fingerprint: `fp-${id}`,
    itemClass,
    baseType,
    source: { row, col },
    w: bagW,
    h: bagH,
    bagW,
    bagH,
    footprintSource: "measured-base",
    confidence: 1,
  };
}

function occupied(items: SortableStashItem[]): SortCell[] {
  return items.flatMap((entry) => sortRectCells(entry.source, entry.w, entry.h));
}

describe("stash sort planner", () => {
  it("packs mixed footprints with exact duplicate bases in contiguous stable groups", () => {
    const items = [
      item("staff-1", "Staves", "Temple Staff", 0, 0, 2, 4),
      item("belt-2", "Belts", "Wide Belt", 6, 6, 2, 1),
      item("helm-1", "Helmets", "Great Helmet", 8, 0, 2, 2),
      item("belt-1", "Belts", "Wide Belt", 4, 8, 2, 1),
      item("ring-1", "Rings", "Ruby Ring", 11, 11, 1, 1),
    ];
    const plan = planStashSort({ tab, items, observedOccupied: occupied(items), generatedAt: "fixture" });

    expect(plan.executable).toBe(true);
    expect(plan.groups.map((group) => `${group.itemClass}:${group.baseType}`)).toEqual([
      "Belts:Wide Belt",
      "Helmets:Great Helmet",
      "Rings:Ruby Ring",
      "Staves:Temple Staff",
    ]);
    const targets = new Set<string>();
    for (const placement of plan.placements) {
      for (const cell of sortRectCells(placement.target, placement.w, placement.h)) {
        const key = `${cell.row},${cell.col}`;
        expect(targets.has(key)).toBe(false);
        targets.add(key);
        expect(cell.row).toBeLessThan(tab.rows);
        expect(cell.col).toBeLessThan(tab.cols);
      }
    }
    for (const group of plan.groups) {
      const cells = plan.placements
        .filter((entry) => entry.groupKey === group.key)
        .flatMap((entry) => sortRectCells(entry.target, entry.w, entry.h));
      expect(cellsConnected(cells)).toBe(true);
    }
    expect(plan.diagnostics.qualityScore).toBeGreaterThan(0);
  });

  it("is deterministic for a fragmented source layout", () => {
    const items = [
      item("a2", "Currency", "Exalted Orb", 10, 10),
      item("b1", "Currency", "Chaos Orb", 0, 11),
      item("a1", "Currency", "Exalted Orb", 6, 3),
      item("c1", "Jewels", "Ruby", 11, 0),
    ];
    const request = { tab, items, observedOccupied: occupied(items), generatedAt: "same" };
    const first = planStashSort(request);
    const second = planStashSort(request);
    expect(first.id).toBe(second.id);
    expect(first.snapshotHash).toBe(second.snapshotHash);
    expect(first.placements.map((entry) => [entry.id, entry.target])).toEqual(
      second.placements.map((entry) => [entry.id, entry.target]),
    );
  });

  it("blocks unknown items and uncovered occupied cells", () => {
    const known = [item("known", "Currency", "Chaos Orb", 0, 0)];
    const plan = planStashSort({
      tab,
      items: known,
      observedOccupied: [{ row: 0, col: 0 }, { row: 4, col: 4 }],
      scanIssues: [{
        code: "clipboard-copy-failed",
        message: "One hovered item could not be parsed.",
        blocking: true,
      }],
    });
    expect(plan.executable).toBe(false);
    expect(plan.blockers.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["unidentified-occupied-cells", "clipboard-copy-failed"]),
    );
    expect(plan.placements).toHaveLength(1);
    expect(
      sortRectCells(plan.placements[0]!.target, 1, 1).some(
        (cell) => cell.row === 4 && cell.col === 4,
      ),
    ).toBe(false);
  });

  it("rejects special, remove-only, and non-writable tabs", () => {
    const plan = planStashSort({
      tab: { ...tab, writable: false, special: true, removeOnly: true },
      items: [],
      observedOccupied: [],
    });
    expect(plan.executable).toBe(false);
    expect(plan.blockers.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["tab-not-writable", "special-tab", "remove-only-tab"]),
    );
  });
});

describe("stash sort dependency scheduling", () => {
  function cyclePlan() {
    const items = [
      item("a", "A class", "A base", 0, 1),
      item("b", "B class", "B base", 0, 0),
    ];
    const plan = planStashSort({ tab, items, observedOccupied: occupied(items), generatedAt: "cycle" });
    expect(plan.placements.find((entry) => entry.id === "a")?.target).toEqual({ row: 0, col: 0 });
    expect(plan.placements.find((entry) => entry.id === "b")?.target).toEqual({ row: 0, col: 1 });
    return plan;
  }

  it("breaks dependency cycles through a verified bag slot", () => {
    const schedule = buildSortMoveSchedule(cyclePlan(), { cols: 12, rows: 5, occupied: [] });
    expect(schedule.ok).toBe(true);
    expect(schedule.steps.map((step) => step.kind)).toContain("stash-to-bag");
    expect(schedule.steps.map((step) => step.kind)).toContain("bag-to-stash");
    expect(schedule.peakStagedItems).toBe(1);
  });

  it("fails closed when a cycle has no staging capacity", () => {
    const fullBag = Array.from({ length: 60 }, (_, index) => ({
      row: Math.floor(index / 12),
      col: index % 12,
    }));
    const schedule = buildSortMoveSchedule(cyclePlan(), {
      cols: 12,
      rows: 5,
      occupied: fullBag,
    });
    expect(schedule.ok).toBe(false);
    expect(schedule.reason).toBe("insufficient-bag-staging-capacity");
  });
});

describe("stash sort execution and reconciliation", () => {
  it("rejects a stale preview before emitting input", async () => {
    const items = [item("a", "Currency", "Chaos Orb", 2, 2)];
    const plan = planStashSort({ tab, items, observedOccupied: occupied(items) });
    const schedule = buildSortMoveSchedule(plan, { cols: 12, rows: 5, occupied: [] });
    let moved = false;
    const result = await executeStashSort(
      plan,
      schedule,
      { cols: 12, rows: 5, occupied: [] },
      {
        capture: async () => ({
          evidenceHash: "changed",
          tabSignature: tab.signature,
          stable: true,
          foreground: true,
          heldItem: "none",
          occupiedStash: occupied(items),
          occupiedBag: [],
          identifiedItems: [],
          planSnapshotHash: "not-the-preview",
        }),
        move: async () => {
          moved = true;
        },
      },
      { cancelled: () => false, killSwitchLatched: () => false },
    );
    expect(result).toMatchObject({ ok: false, reason: "stale-plan", completedSteps: 0 });
    expect(moved).toBe(false);
  });

  it("executes a cycle one audited move and reconciliation at a time", async () => {
    const items = [
      item("a", "A class", "A base", 0, 1),
      item("b", "B class", "B base", 0, 0),
    ];
    const plan = planStashSort({ tab, items, observedOccupied: occupied(items) });
    const bag: SortBagState = { cols: 12, rows: 5, occupied: [] };
    const schedule = buildSortMoveSchedule(plan, bag);
    const locations = new Map(
      plan.placements.map((entry) => [
        entry.id,
        { area: "stash" as "stash" | "bag", position: { ...entry.source }, placement: entry },
      ]),
    );
    let lastMoved: string | undefined;
    let captures = 0;
    const snapshot = (): SortExecutionSnapshot => {
      captures += 1;
      const occupiedStash: SortCell[] = [];
      const occupiedBag: SortCell[] = [];
      for (const located of locations.values()) {
        const w = located.area === "stash" ? located.placement.w : located.placement.bagW;
        const h = located.area === "stash" ? located.placement.h : located.placement.bagH;
        const target = located.area === "stash" ? occupiedStash : occupiedBag;
        target.push(...sortRectCells(located.position, w, h));
      }
      const identifiedItems = lastMoved
        ? [{
            itemId: lastMoved,
            area: locations.get(lastMoved)!.area,
            position: { ...locations.get(lastMoved)!.position },
          }]
        : [];
      return {
        evidenceHash: `capture-${captures}`,
        tabSignature: tab.signature,
        stable: true,
        foreground: true,
        heldItem: "none",
        occupiedStash,
        occupiedBag,
        identifiedItems,
        planSnapshotHash: plan.snapshotHash,
      };
    };
    const result = await executeStashSort(
      plan,
      schedule,
      bag,
      {
        capture: async () => snapshot(),
        move: async (step) => {
          const located = locations.get(step.itemId)!;
          located.area = step.toArea;
          located.position = { ...step.to };
          lastMoved = step.itemId;
        },
      },
      { cancelled: () => false, killSwitchLatched: () => false },
    );
    expect(result).toMatchObject({
      ok: true,
      reason: "sorted",
      completedSteps: schedule.steps.length,
    });
    expect(captures).toBe(schedule.steps.length + 1);
  });

  it("checks the entire target footprint for the 2x3-into-3x1 regression", () => {
    const snapshot: SortExecutionSnapshot = {
      evidenceHash: "regression",
      tabSignature: tab.signature,
      stable: true,
      foreground: true,
      heldItem: "none",
      occupiedStash: [
        ...sortRectCells({ row: 6, col: 6 }, 2, 3),
        ...sortRectCells({ row: 1, col: 1 }, 3, 1),
      ],
      occupiedBag: [],
      identifiedItems: [],
    };
    expect(
      sortTargetIsVerifiedEmpty(snapshot, {
        index: 0,
        itemId: "two-by-three",
        kind: "stash-to-stash",
        fromArea: "stash",
        toArea: "stash",
        from: { row: 6, col: 6 },
        to: { row: 0, col: 1 },
        fromW: 2,
        fromH: 3,
        toW: 2,
        toH: 3,
      }),
    ).toBe(false);
  });
});
