import { describe, expect, it } from "vitest";
import type { StashItem } from "../src/core/bagPack.js";
import { emptyProfile } from "../src/core/calibrationProfile.js";
import {
  applyOverlayDetectionLabels,
  overlayCellAtPoint,
  overlayCellRect,
  overlayItemCellsAt,
  overlayPlanToClientSpace,
  overlaySelectionSummary,
  planDryRunOverlay,
  updateOverlaySelection,
} from "../src/core/dryRunOverlay.js";
import type { QaActionTrace } from "../src/core/types.js";

const CLIENT = { left: 100, top: 50, width: 1600, height: 900 };

function profile() {
  return {
    ...emptyProfile(CLIENT.width, CLIENT.height),
    stashGrid: { x: 80, y: 144, w: 736, h: 630, cols: 12, rows: 12 },
    bagGrid: { x: 1048, y: 324, w: 480, h: 450, cols: 12, rows: 5 },
    stashSearch: { x: 200, y: 790, w: 300, h: 30 },
  };
}

function stashItem(row: number, col: number, w: number, h: number): StashItem {
  const cells: Array<{ row: number; col: number }> = [];
  for (let r = 0; r < h; r += 1) {
    for (let c = 0; c < w; c += 1) cells.push({ row: row + r, col: col + c });
  }
  return {
    id: `${row},${col}:${w}x${h}`,
    grab: { row, col, x: 0, y: 0 },
    cells,
    w,
    h,
  };
}

function trace(input: QaActionTrace["input"]): QaActionTrace {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    scenarioId: "assistive-fill",
    module: "stash",
    mode: "authorized-qa",
    processName: "PathOfExile.exe",
    evidenceHash: "hash",
    confidence: 1,
    decisionRule: "dry-run-preview",
    reason: "preview; safety=dry-run",
    input,
    result: "blocked",
  };
}

describe("dry-run overlay planner", () => {
  it("maps calibrated grids and numbered click points from traces", () => {
    const stashClick = { kind: "click" as const, x: 211, y: 221 };
    const bagClick = { kind: "click" as const, x: 1168, y: 394 };
    const searchClick = { kind: "click" as const, x: 350, y: 855 };
    const plan = planDryRunOverlay({
      kind: "fill",
      profile: profile(),
      client: CLIENT,
      traces: [
        trace({ kind: "focus" }),
        trace(searchClick),
        trace({ kind: "type", text: '"class: Belts"' }),
        trace(stashClick),
        trace(bagClick),
        trace({ kind: "drag", x: 220, y: 230, x2: 1180, y2: 400 }),
      ],
    });

    expect(plan.grids.map((grid) => grid.region)).toEqual(["stash", "bag", "search"]);
    expect(plan.grids[0]).toMatchObject({
      region: "stash",
      label: "Stash 12×12",
      x: 180,
      y: 194,
      w: 736,
      h: 630,
      cols: 12,
      rows: 12,
    });
    expect(plan.grids[1]).toMatchObject({
      region: "bag",
      label: "Bag 12×5",
      x: 1148,
      y: 374,
      w: 480,
      h: 450,
    });
    expect(plan.clicks).toEqual([
      { n: 1, x: 350, y: 855, kind: "click", region: "search" },
      { n: 2, x: 211, y: 221, kind: "click", region: "stash" },
      { n: 3, x: 1168, y: 394, kind: "click", region: "bag" },
      { n: 4, x: 220, y: 230, kind: "drag-from", region: "stash" },
      { n: 5, x: 1180, y: 400, kind: "drag-to", region: "bag" },
    ]);
  });

  it("still draws stash and bag grids when dry-run produced no clicks", () => {
    const plan = planDryRunOverlay({
      kind: "empty",
      profile: profile(),
      client: CLIENT,
      traces: [trace({ kind: "focus" }), trace({ kind: "key", key: "I" })],
    });

    expect(plan.grids.map((grid) => grid.region)).toEqual(["stash", "bag"]);
    expect(plan.clicks).toEqual([]);
  });

  it("shifts screen coordinates into client-local overlay space", () => {
    const plan = overlayPlanToClientSpace(
      planDryRunOverlay({
        kind: "empty",
        profile: profile(),
        client: CLIENT,
        traces: [trace({ kind: "click", x: 211, y: 221 })],
      }),
    );

    expect(plan.client).toEqual({ left: 0, top: 0, width: 1600, height: 900 });
    expect(plan.grids[0]).toMatchObject({ region: "stash", x: 80, y: 144 });
    expect(plan.clicks).toEqual([
      { n: 1, x: 111, y: 171, kind: "click", region: "stash" },
    ]);
    expect(plan.occupied).toEqual([]);
    expect(plan.detected).toEqual([]);
  });

  it("includes occupied stash and bag cells from perception facts", () => {
    const plan = planDryRunOverlay({
      kind: "fill",
      profile: profile(),
      client: CLIENT,
      traces: [trace({ kind: "click", x: 211, y: 221 })],
      occupiedStash: [{ row: 0, col: 1, x: 0, y: 0 }],
      occupiedBag: [{ row: 2, col: 3, x: 0, y: 0 }],
      evidenceHash: "abc123",
      screenshotId: "assistive-1.png",
    });

    expect(plan.occupied).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ area: "stash", row: 0, col: 1 }),
        expect.objectContaining({ area: "bag", row: 2, col: 3 }),
      ]),
    );
    expect(plan.detected).toEqual(plan.occupied);
    expect(plan.clicks).toHaveLength(1);
    expect(plan.evidenceHash).toBe("abc123");
    expect(plan.screenshotId).toBe("assistive-1.png");
    const stash = plan.occupied.find((cell) => cell.area === "stash")!;
    const grid = plan.grids[0]!;
    expect(stash.x).toBeGreaterThanOrEqual(grid.x);
    expect(stash.y).toBeGreaterThanOrEqual(grid.y);
    expect(stash.w).toBeGreaterThan(0);
    expect(stash.h).toBeGreaterThan(0);
  });

  it("maps a click at a grid point to that cell", () => {
    const plan = planDryRunOverlay({
      kind: "empty",
      profile: profile(),
      client: CLIENT,
      traces: [],
      occupiedStash: [{ row: 0, col: 1, x: 0, y: 0 }],
      occupiedBag: [{ row: 4, col: 11, x: 0, y: 0 }],
    });
    const stash = plan.grids.find((grid) => grid.region === "stash")!;
    const bag = plan.grids.find((grid) => grid.region === "bag")!;
    const occupiedBox = overlayCellRect(stash, 0, 1);
    const emptyBox = overlayCellRect(stash, 5, 5);
    const bagBox = overlayCellRect(bag, 4, 11);

    expect(
      overlayCellAtPoint(plan, occupiedBox.x + occupiedBox.w / 2, occupiedBox.y + occupiedBox.h / 2),
    ).toEqual({ area: "stash", row: 0, col: 1, occupied: true });
    expect(overlayCellAtPoint(plan, emptyBox.x + 2, emptyBox.y + 2)).toEqual({
      area: "stash",
      row: 5,
      col: 5,
      occupied: false,
    });
    expect(overlayCellAtPoint(plan, bagBox.x + bagBox.w / 2, bagBox.y + bagBox.h / 2)).toEqual({
      area: "bag",
      row: 4,
      col: 11,
      occupied: true,
    });
    expect(overlayCellAtPoint(plan, 10, 10)).toBeUndefined();
  });

  it("keeps original detection when Wrong flips displayed occupancy", () => {
    const plan = planDryRunOverlay({
      kind: "empty",
      profile: profile(),
      client: CLIENT,
      traces: [],
      occupiedStash: [{ row: 0, col: 1, x: 0, y: 0 }],
    });
    const flipped = applyOverlayDetectionLabels(plan, [
      { area: "stash", row: 0, col: 1, perceivedOccupied: true, label: "wrong" },
      { area: "stash", row: 3, col: 3, perceivedOccupied: false, label: "wrong" },
    ]);

    expect(flipped.detected.some((cell) => cell.area === "stash" && cell.row === 0 && cell.col === 1)).toBe(
      true,
    );
    expect(flipped.occupied.some((cell) => cell.area === "stash" && cell.row === 0 && cell.col === 1)).toBe(
      false,
    );
    expect(flipped.occupied.some((cell) => cell.area === "stash" && cell.row === 3 && cell.col === 3)).toBe(
      true,
    );
    expect(overlayCellAtPoint(flipped, overlayCellRect(flipped.grids[0]!, 0, 1).x + 1, overlayCellRect(flipped.grids[0]!, 0, 1).y + 1)).toMatchObject({
      occupied: true,
    });
  });

  it("draws adjacent 1×1 items separately from one 2×1 footprint", () => {
    const occupied = [
      { row: 0, col: 0, x: 0, y: 0 },
      { row: 0, col: 1, x: 0, y: 0 },
    ];
    const split = planDryRunOverlay({
      kind: "empty",
      profile: profile(),
      client: CLIENT,
      traces: [],
      occupiedStash: occupied,
      stashItems: [stashItem(0, 0, 1, 1), stashItem(0, 1, 1, 1)],
    });
    const merged = planDryRunOverlay({
      kind: "empty",
      profile: profile(),
      client: CLIENT,
      traces: [],
      occupiedStash: occupied,
      stashItems: [stashItem(0, 0, 2, 1)],
    });

    expect(split.items).toHaveLength(2);
    expect(split.items.map((item) => `${item.w}x${item.h}`)).toEqual(["1x1", "1x1"]);
    expect(split.items[0]!.width).toBeLessThan(split.items[1]!.x);
    expect(merged.items).toHaveLength(1);
    expect(merged.items[0]).toMatchObject({ w: 2, h: 1, row: 0, col: 0 });
    expect(merged.items[0]!.width).toBeGreaterThan(split.items[0]!.width);
    expect(merged.items[0]!.cells).toHaveLength(2);
  });

  it("replaces selection on plain click and toggles on shift-add", () => {
    const a = { area: "stash" as const, row: 0, col: 0, occupied: true };
    const b = { area: "stash" as const, row: 0, col: 1, occupied: true };
    const c = { area: "bag" as const, row: 1, col: 2, occupied: false };

    expect(updateOverlaySelection([a], [b], false)).toEqual([b]);
    expect(updateOverlaySelection([a], [b], true)).toEqual([a, b]);
    expect(updateOverlaySelection([a, b], [b], true)).toEqual([a]);
    expect(updateOverlaySelection([a, b], [c], true)).toEqual([a, b, c]);
    expect(updateOverlaySelection([a, b], [], false)).toEqual([]);
    expect(overlaySelectionSummary([a, b, c])).toBe(
      "3 cells selected (stash + bag) · Wrong will invert all",
    );
  });

  it("expands a click on a 2×1 item to both cells", () => {
    const plan = planDryRunOverlay({
      kind: "empty",
      profile: profile(),
      client: CLIENT,
      traces: [],
      occupiedStash: [
        { row: 0, col: 0, x: 0, y: 0 },
        { row: 0, col: 1, x: 0, y: 0 },
      ],
      stashItems: [stashItem(0, 0, 2, 1)],
    });
    const expanded = overlayItemCellsAt(plan, {
      area: "stash",
      row: 0,
      col: 1,
      occupied: true,
    });
    expect(expanded).toEqual([
      { area: "stash", row: 0, col: 0, occupied: true },
      { area: "stash", row: 0, col: 1, occupied: true },
    ]);
    expect(overlayItemCellsAt(plan, { area: "stash", row: 5, col: 5, occupied: false })).toEqual([
      { area: "stash", row: 5, col: 5, occupied: false },
    ]);
  });
});
