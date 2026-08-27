import { describe, expect, it } from "vitest";
import { createScanGrid } from "../src/core/scanContracts.js";
import {
  cancelScan,
  createScanPlanner,
  footprintGeometry,
  nextScanTarget,
  plannerClaimedCells,
  plannerVisitedCells,
  recordScanObservation,
  restoreScanPlannerSnapshot,
  resumeScan,
  serializeScanPlannerSnapshot,
  type ScanPlannerSnapshot,
} from "../src/core/scanPlanner.js";

function at(index: number): string {
  return new Date(index * 1_000).toISOString();
}

function recordEmpty(
  snapshot: ScanPlannerSnapshot,
  index: number,
): ScanPlannerSnapshot {
  return recordScanObservation(snapshot, {
    at: at(index),
    status: "empty",
  });
}

function advanceToOrdinal(
  source: ScanPlannerSnapshot,
  ordinal: number,
): ScanPlannerSnapshot {
  let snapshot = source;
  let index = 0;
  while ((nextScanTarget(snapshot)?.ordinal ?? ordinal) < ordinal) {
    snapshot = recordEmpty(snapshot, index);
    index += 1;
  }
  return snapshot;
}

describe("deterministic scan planner", () => {
  it.each([
    ["stash-normal", 12, 12],
    ["stash-quad", 24, 24],
    ["inventory", 12, 5],
  ] as const)("supports the %s grid", (kind, cols, rows) => {
    const planner = createScanPlanner({ grid: createScanGrid(kind) });
    expect(planner.grid).toEqual({ kind, cols, rows });
    expect(nextScanTarget(planner)).toEqual({
      cell: { row: 0, col: 0 },
      ordinal: 0,
      attempt: 1,
    });
  });

  it("traverses real observations in strict row-major order", () => {
    let planner = createScanPlanner({ grid: createScanGrid("stash-normal") });
    for (let index = 0; index < 13; index += 1) {
      planner = recordEmpty(planner, index);
    }

    expect(plannerVisitedCells(planner)).toEqual([
      ...Array.from({ length: 12 }, (_, col) => ({ row: 0, col })),
      { row: 1, col: 0 },
    ]);
    expect(nextScanTarget(planner)?.cell).toEqual({ row: 1, col: 1 });
  });

  it("claims a known footprint independent of rule matching and emits explicit skips", () => {
    let planner = createScanPlanner({ grid: createScanGrid("stash-normal") });
    planner = recordScanObservation(planner, {
      at: at(0),
      status: "copied",
      rawText: "item",
      itemFingerprint: "fingerprint",
      footprint: { width: 2, height: 2, source: "measured" },
      ruleMatched: false,
    });

    expect(planner.records.slice(0, 2).map((record) => ({
      cell: record.cell,
      status: record.status,
    }))).toEqual([
      { cell: { row: 0, col: 0 }, status: "copied" },
      { cell: { row: 0, col: 1 }, status: "skipped-footprint" },
    ]);
    expect(nextScanTarget(planner)?.cell).toEqual({ row: 0, col: 2 });

    for (let col = 2; col < 12; col += 1) {
      planner = recordEmpty(planner, col);
    }
    expect(planner.records.slice(-2).map((record) => ({
      cell: record.cell,
      status: record.status,
      claimedBy: record.claimedBy,
    }))).toEqual([
      {
        cell: { row: 1, col: 0 },
        status: "skipped-footprint",
        claimedBy: { row: 0, col: 0 },
      },
      {
        cell: { row: 1, col: 1 },
        status: "skipped-footprint",
        claimedBy: { row: 0, col: 0 },
      },
    ]);
    expect(nextScanTarget(planner)?.cell).toEqual({ row: 1, col: 2 });
    expect(plannerClaimedCells(planner)).toEqual([
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 1, col: 0 },
      { row: 1, col: 1 },
    ]);
    expect(planner.records[0]?.ruleMatched).toBe(false);
  });

  it("clips a trusted footprint at an edge without claiming outside the grid", () => {
    let planner = advanceToOrdinal(
      createScanPlanner({
        grid: createScanGrid("stash-normal"),
        edgePolicy: "clip",
      }),
      143,
    );
    planner = recordScanObservation(planner, {
      at: at(143),
      status: "copied",
      footprint: { width: 2, height: 2, source: "fixed-class" },
    });

    expect(planner.phase).toBe("finished");
    expect(planner.records.at(-1)?.footprint).toMatchObject({
      known: true,
      clipped: true,
      claimedCells: [{ row: 11, col: 11 }],
    });
    expect(plannerClaimedCells(planner).at(-1)).toEqual({ row: 11, col: 11 });
  });

  it("can reject an edge-crossing footprint safely", () => {
    let planner = advanceToOrdinal(
      createScanPlanner({
        grid: createScanGrid("inventory"),
        edgePolicy: "reject",
      }),
      59,
    );
    planner = recordScanObservation(planner, {
      at: at(59),
      status: "copied",
      footprint: { width: 2, height: 2, source: "measured" },
    });

    expect(planner.phase).toBe("finished");
    expect(planner.records.at(-1)).toMatchObject({
      status: "blocked",
      reason: "known footprint crosses grid edge",
      footprint: { clipped: true },
    });
    expect(planner.claims).toEqual([]);
  });

  it("validates footprint geometry", () => {
    const grid = createScanGrid("inventory");
    expect(footprintGeometry({ row: 4, col: 11 }, 2, 2, grid)).toMatchObject({
      valid: true,
      clipped: true,
      claimedCells: [{ row: 4, col: 11 }],
    });
    expect(footprintGeometry({ row: 0, col: 0 }, 0, 2, grid)).toMatchObject({
      valid: false,
      reason: "invalid-footprint-size",
      claimedCells: [],
    });
  });

  it("scans every cell for an unknown footprint by default", () => {
    const planner = recordScanObservation(
      createScanPlanner({ grid: createScanGrid("inventory") }),
      {
        at: at(0),
        status: "copied",
        rawText: "unknown item",
      },
    );

    expect(planner.records[0]).toMatchObject({
      status: "copied",
      footprint: { known: false, source: "unknown" },
    });
    expect(nextScanTarget(planner)?.cell).toEqual({ row: 0, col: 1 });
    expect(planner.claims).toEqual([]);
  });

  it("can block copied items whose size is unknown", () => {
    const planner = recordScanObservation(
      createScanPlanner({
        grid: createScanGrid("inventory"),
        unknownSizePolicy: "block",
      }),
      {
        at: at(0),
        status: "copied",
      },
    );
    expect(planner.records[0]).toMatchObject({
      status: "blocked",
      footprint: { known: false },
    });
  });

  it("serializes cancellation and resumes at the same coordinate with a new attempt", () => {
    let planner = recordEmpty(
      createScanPlanner({ grid: createScanGrid("inventory") }),
      0,
    );
    planner = cancelScan(planner, at(1), "operator-stop");
    expect(planner.phase).toBe("cancelled");
    expect(planner.records.at(-1)).toMatchObject({
      cell: { row: 0, col: 1 },
      status: "cancelled",
      attempt: 1,
    });

    planner = resumeScan(
      restoreScanPlannerSnapshot(serializeScanPlannerSnapshot(planner)),
    );
    expect(nextScanTarget(planner)).toMatchObject({
      cell: { row: 0, col: 1 },
      attempt: 2,
    });
    planner = recordScanObservation(planner, {
      at: at(2),
      status: "copied",
      footprint: { width: 1, height: 1, source: "parsed" },
    });
    expect(planner.records.at(-1)).toMatchObject({
      cell: { row: 0, col: 1 },
      status: "copied",
      attempt: 2,
    });
    expect(nextScanTarget(planner)?.cell).toEqual({ row: 0, col: 2 });
  });
});
