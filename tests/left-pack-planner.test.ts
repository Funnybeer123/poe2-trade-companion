import { describe, expect, it } from "vitest";
import { createScanGrid } from "../src/core/scanContracts.js";
import {
  markRectangle,
  planLeftPack,
  rectangleFits,
  type LeftPackItem,
  type LeftPackRequest,
} from "../src/core/leftPackPlanner.js";

const generatedAt = "2026-08-26T06:00:00.000Z";

function item(
  id: string,
  row: number,
  col: number,
  width = 1,
  height = 1,
): LeftPackItem {
  return {
    id,
    fingerprint: `fingerprint-${id}`,
    source: { row, col },
    width,
    height,
  };
}

function request(items: LeftPackItem[]): LeftPackRequest {
  return {
    grid: createScanGrid("inventory"),
    items,
    sourceEvidenceHash: "evidence-hash",
    generatedAt,
  };
}

const cycleItems = [
  item("vertical", 0, 1, 1, 2),
  item("single", 1, 0, 1, 1),
];

describe("left-pack rectangle geometry", () => {
  it("fits and marks rectangles without mutating the input occupancy", () => {
    const source = {
      cols: 4,
      rows: 3,
      occupied: [{ row: 0, col: 0 }],
    };
    expect(rectangleFits(source, { row: 0, col: 1 }, 2, 2)).toBe(true);
    expect(rectangleFits(source, { row: 0, col: 0 }, 2, 2)).toBe(false);

    const marked = markRectangle(source, { row: 0, col: 1 }, 2, 2);
    expect(source.occupied).toEqual([{ row: 0, col: 0 }]);
    expect(marked.occupied).toEqual([
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 0, col: 2 },
      { row: 1, col: 1 },
      { row: 1, col: 2 },
    ]);
    expect(rectangleFits(marked, { row: 0, col: 1 }, 1, 1)).toBe(false);
  });
});

describe("deterministic left-pack planning", () => {
  it("returns an executable no-op when items are already packed", () => {
    const plan = planLeftPack(request([
      item("c", 0, 0, 2, 1),
      item("a", 0, 2),
      item("b", 0, 3),
    ]));

    expect(plan).toMatchObject({
      executable: true,
      reason: "already-packed",
      blockers: [],
      steps: [],
    });
    expect(plan.reconciliation.before).toEqual(
      plan.reconciliation.expectedAfter,
    );
  });

  it("left-packs into deterministic first-fit targets", () => {
    const input = request([
      item("a", 0, 3),
      item("b", 1, 4, 2, 1),
    ]);
    const first = planLeftPack(input);
    const second = planLeftPack(input);

    expect(first).toEqual(second);
    expect(first.placements.map((placement) => ({
      id: placement.itemId,
      target: placement.target,
    }))).toEqual([
      { id: "b", target: { row: 0, col: 0 } },
      { id: "a", target: { row: 0, col: 2 } },
    ]);
    expect(first.executable).toBe(true);
    expect(first.steps.every((step) => step.kind === "direct")).toBe(true);
  });

  it("fails safely when a collision cycle needs a buffer", () => {
    const plan = planLeftPack(request(cycleItems));

    expect(plan).toMatchObject({
      executable: false,
      reason: "buffer-required",
      steps: [],
    });
    expect(plan.blockers[0]?.code).toBe("buffer-required");
    expect(plan.diagnostics.plannedStepsBeforeFailure).toBe(0);
  });

  it("uses a verified buffer to break a collision cycle", () => {
    const plan = planLeftPack({
      ...request(cycleItems),
      buffer: { id: "inventory-buffer", cols: 1, rows: 2, occupied: [] },
    });

    expect(plan.executable).toBe(true);
    expect(plan.steps.map((step) => `${step.kind}:${step.itemId}`)).toEqual([
      "stage-to-buffer:vertical",
      "direct:single",
      "restore-from-buffer:vertical",
    ]);
    expect(plan.diagnostics).toMatchObject({
      peakBufferItems: 1,
      peakBufferCells: 2,
    });
    for (let index = 1; index < plan.steps.length; index += 1) {
      expect(plan.steps[index]?.before).toEqual(
        plan.steps[index - 1]?.expectedAfter,
      );
    }
    expect(plan.steps.at(-1)?.expectedAfter).toEqual(
      plan.reconciliation.expectedAfter,
    );
    expect(
      plan.reconciliation.expectedItems.every(
        (entry) => entry.location.area === "grid",
      ),
    ).toBe(true);
  });

  it("fails safely when the configured buffer has no room", () => {
    const plan = planLeftPack({
      ...request(cycleItems),
      buffer: {
        id: "full-buffer",
        cols: 1,
        rows: 1,
        occupied: [{ row: 0, col: 0 }],
      },
    });

    expect(plan).toMatchObject({
      executable: false,
      reason: "insufficient-buffer-space",
      steps: [],
    });
  });

  it("rejects overlapping source rectangles", () => {
    const plan = planLeftPack(request([
      item("wide", 0, 0, 2, 1),
      item("overlap", 0, 1),
    ]));

    expect(plan.executable).toBe(false);
    expect(plan.blockers.some((blocker) => blocker.code === "source-overlap")).toBe(
      true,
    );
    expect(plan.steps).toEqual([]);
  });

  it("rejects ambiguous non-rectangular perception shapes", () => {
    const ambiguous = item("ambiguous", 0, 0, 2, 2);
    ambiguous.cells = [
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 1, col: 0 },
    ];
    const plan = planLeftPack(request([ambiguous]));

    expect(plan).toMatchObject({
      executable: false,
      reason: "ambiguous-shape",
      steps: [],
    });
  });

  it("returns no partial schedule when planning is cancelled", () => {
    const plan = planLeftPack({
      ...request(cycleItems),
      buffer: { id: "inventory-buffer", cols: 1, rows: 2, occupied: [] },
      cancellation: { requested: true, reason: "kill-switch" },
    });

    expect(plan).toMatchObject({
      executable: false,
      reason: "cancelled",
      steps: [],
      blockers: [{ code: "cancelled", message: "kill-switch" }],
    });
  });
});
