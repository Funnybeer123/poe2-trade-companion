import { describe, expect, it } from "vitest";
import {
  claimItemFootprint,
  findPlacement,
  fitKnownSize,
  pickNextFill,
  planFillMoves,
  plannedFillCells,
  snapToItemShape,
  toBagCells,
  takeUntilBagCapacity,
  unusedStashItems,
  emptyGridClick,
  likelySameSprite,
  type StashItem,
} from "../src/core/bagPack.js";
import type { OccupiedCell } from "../src/core/uiPerception.js";

function cell(row: number, col: number): OccupiedCell {
  return { row, col, x: col * 10, y: row * 10 };
}

describe("bag packing", () => {
  it("places the largest stash item that still fits the empty bag", () => {
    const pick = pickNextFill(
      [cell(0, 0), cell(0, 1), cell(1, 0), cell(1, 1), cell(0, 3)],
      [cell(0, 0), cell(0, 1)],
    );
    expect(pick?.item.cells).toHaveLength(4);
    expect(pick?.dest).toEqual({ row: 0, col: 2 });
  });

  it("does not place an item that is larger than remaining bag space", () => {
    const bag = Array.from({ length: 59 }, (_, i) => cell(Math.floor(i / 12), i % 12));
    expect(pickNextFill([cell(0, 0), cell(0, 1)], bag)).toBeNull();
  });

  it("maps a quad stash cluster down to bag cells", () => {
    const bag = toBagCells([cell(0, 0), cell(0, 1), cell(1, 0), cell(1, 1), cell(2, 0), cell(2, 1), cell(3, 0), cell(3, 1)], 24);
    expect(bag).toEqual([
      { row: 0, col: 0 },
      { row: 1, col: 0 },
    ]);
  });

  it("finds the first hole that matches a 1x2 shape", () => {
    const empty = [
      [false, true, true],
      [false, true, false],
    ];
    expect(findPlacement([{ row: 0, col: 0 }, { row: 1, col: 0 }], empty)).toEqual({ row: 0, col: 1 });
  });

  it("snaps a sparse staff-shaped cluster to a 1x4 item", () => {
    const snapped = snapToItemShape([
      { row: 0, col: 1 },
      { row: 1, col: 1 },
      { row: 3, col: 1 },
    ]);
    expect(snapped).toEqual([{ w: 1, h: 4, cells: [
      { row: 0, col: 1 },
      { row: 1, col: 1 },
      { row: 2, col: 1 },
      { row: 3, col: 1 },
    ] }]);
  });

  it("plans non-overlapping bag holes for several item sizes", () => {
    const stash = [
      cell(0, 0), cell(0, 1), cell(1, 0), cell(1, 1), cell(2, 0), cell(2, 1), cell(3, 0), cell(3, 1),
      cell(0, 3),
    ];
    const moves = planFillMoves(stash, [], { x: 1000, y: 200, w: 120, h: 50 });
    expect(moves.map((move) => `${move.item.w}x${move.item.h}@${move.dest.row},${move.dest.col}`)).toEqual([
      "2x4@0,0",
      "1x1@0,2",
    ]);
    expect(moves[0]!.to.x).toBeGreaterThan(1000);
  });

  it("fits a known size around any hovered cell of the item", () => {
    const occupied = new Set(["10,4", "11,4", "12,4", "13,4", "10,5", "11,5", "12,5", "13,5"]);
    const hovered: StashItem = {
      id: "13,5:1x1",
      w: 1,
      h: 1,
      grab: { row: 13, col: 5, x: 220, y: 400, bag: "stash" },
      cells: [{ row: 13, col: 5 }],
    };
    const fitted = fitKnownSize(hovered, 2, 4, occupied);
    expect(fitted.w).toBe(2);
    expect(fitted.h).toBe(4);
    expect(fitted.cells[0]).toEqual({ row: 10, col: 4 });
    expect(fitted.grab).toEqual(hovered.grab);
  });

  it("skips later sprites that sit inside an already-sized footprint", () => {
    const taken = new Set<string>();
    const staff = fitKnownSize(
      {
        id: "2,2:1x1",
        w: 1,
        h: 1,
        grab: { row: 2, col: 2, x: 1, y: 1 },
        cells: [{ row: 2, col: 2 }],
      },
      2,
      4,
      new Set(["2,2", "3,2", "4,2", "5,2", "2,3", "3,3", "4,3", "5,3"]),
    );
    expect(claimItemFootprint(taken, staff)).toBe(true);
    expect(
      claimItemFootprint(taken, {
        id: "4,3:1x1",
        w: 1,
        h: 1,
        grab: { row: 4, col: 3, x: 2, y: 2 },
        cells: [{ row: 4, col: 3 }],
      }),
    ).toBe(false);
  });

  it("packs identified sizes largest-first until the bag is full", () => {
    const staff: StashItem = {
      id: "0,0:2x4",
      w: 2,
      h: 4,
      grab: { row: 0, col: 0, x: 10, y: 10 },
      cells: [
        { row: 0, col: 0 },
        { row: 0, col: 1 },
        { row: 1, col: 0 },
        { row: 1, col: 1 },
        { row: 2, col: 0 },
        { row: 2, col: 1 },
        { row: 3, col: 0 },
        { row: 3, col: 1 },
      ],
    };
    const jewel: StashItem = {
      id: "0,4:1x1",
      w: 1,
      h: 1,
      grab: { row: 0, col: 4, x: 40, y: 10 },
      cells: [{ row: 0, col: 4 }],
    };
    const moves = planFillMoves([], [], { x: 1000, y: 200, w: 120, h: 50 }, 24, [jewel, staff]);
    expect(moves.map((move) => `${move.item.w}x${move.item.h}`)).toEqual(["2x4", "1x1"]);
    expect(plannedFillCells(moves)).toBe(9);
  });

  it("skips only the grab cell used in a previous fill cycle", () => {
    const used = new Set(["0,0"]);
    const items: StashItem[] = [
      {
        id: "0,0:2x1",
        w: 2,
        h: 1,
        grab: { row: 0, col: 0, x: 1, y: 1 },
        cells: [{ row: 0, col: 0 }, { row: 0, col: 1 }],
      },
      {
        id: "2,0:1x1",
        w: 1,
        h: 1,
        grab: { row: 2, col: 0, x: 2, y: 2 },
        cells: [{ row: 2, col: 0 }],
      },
    ];
    expect(unusedStashItems(items, used).map((item) => item.id)).toEqual(["2,0:1x1"]);
    expect(unusedStashItems(items, new Set(["0,1"])).map((item) => item.id)).toEqual([
      "0,0:2x1",
      "2,0:1x1",
    ]);
  });

  it("does not ctrl-click neighboring 1x1s from the same sprite in one burst", () => {
    const cluster: StashItem[] = [
      { id: "0,0:1x1", w: 1, h: 1, grab: { row: 0, col: 0, x: 1, y: 1 }, cells: [{ row: 0, col: 0 }] },
      { id: "0,1:1x1", w: 1, h: 1, grab: { row: 0, col: 1, x: 2, y: 1 }, cells: [{ row: 0, col: 1 }] },
      { id: "1,0:1x1", w: 1, h: 1, grab: { row: 1, col: 0, x: 1, y: 2 }, cells: [{ row: 1, col: 0 }] },
      { id: "1,1:1x1", w: 1, h: 1, grab: { row: 1, col: 1, x: 2, y: 2 }, cells: [{ row: 1, col: 1 }] },
      { id: "0,4:1x1", w: 1, h: 1, grab: { row: 0, col: 4, x: 5, y: 1 }, cells: [{ row: 0, col: 4 }] },
    ];
    expect(likelySameSprite(cluster[0]!, cluster[1]!)).toBe(true);
    expect(takeUntilBagCapacity(cluster, 60, 24).map((item) => item.id)).toEqual(["0,0:1x1", "0,4:1x1"]);
  });

  it("stops withdrawing once estimated bag cells are full", () => {
    const items: StashItem[] = Array.from({ length: 10 }, (_, index) => ({
      id: `0,${index}:2x2`,
      w: 2,
      h: 2,
      grab: { row: 0, col: index * 2, x: index, y: 0 },
      cells: [
        { row: 0, col: index * 2 },
        { row: 0, col: index * 2 + 1 },
        { row: 1, col: index * 2 },
        { row: 1, col: index * 2 + 1 },
      ],
    }));
    expect(takeUntilBagCapacity(items, 8, 12)).toHaveLength(2);
    expect(takeUntilBagCapacity(items, 8, 24)).toHaveLength(2);
  });

  it("skips an oversized first item instead of overfilling the bag", () => {
    const items: StashItem[] = [
      {
        id: "0,0:2x2",
        w: 2,
        h: 2,
        grab: { row: 0, col: 0, x: 1, y: 1 },
        cells: [{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 1, col: 0 }, { row: 1, col: 1 }],
      },
      {
        id: "0,3:1x1",
        w: 1,
        h: 1,
        grab: { row: 0, col: 3, x: 3, y: 1 },
        cells: [{ row: 0, col: 3 }],
      },
    ];
    expect(takeUntilBagCapacity(items, 1).map((item) => item.id)).toEqual(["0,3:1x1"]);
  });

  it("clicks the first empty stash cell so a held item can be dropped", () => {
    const drop = emptyGridClick({ x: 100, y: 200, w: 240, h: 240 }, 12, 12, [{ row: 0, col: 0 }]);
    expect(drop).toMatchObject({ row: 0, col: 1 });
    expect(drop?.x).toBeGreaterThan(100);
  });
});
