import { describe, expect, it } from "vitest";
import { emptyProfile, stampMapsStashPanel, stampStashPanel } from "../src/core/calibrationProfile.js";
import { cellCenterTwoCorner } from "../src/core/gridMath.js";
import {
  gridCellBox,
  gridClickCenters,
  hostLatticeRects,
  juiceGridsForOverlay,
  latticeLines,
  markToScreenGrid,
  planJuiceGridOverlay,
} from "../src/core/gridLattice.js";

const maps = { x: 63, y: 735, w: 1224, h: 816, cols: 12, rows: 8 } as const;
const bag = { x: 1400, y: 900, w: 600, h: 250, cols: 12, rows: 5 } as const;
const client = { left: 10, top: 20, width: 3840, height: 2160 };

describe("juice grid lattices", () => {
  it("keeps click centers on the same two-corner math juice-maps uses", () => {
    const screen = markToScreenGrid(client.left, client.top, maps);
    const dots = gridClickCenters(maps);
    expect(dots).toHaveLength(96);
    expect(dots[0]).toEqual({
      row: 0,
      col: 0,
      ...cellCenterTwoCorner(markToScreenGrid(0, 0, maps), 0, 0, 12, 8),
    });
    expect(cellCenterTwoCorner(screen, 3, 2, 12, 8)).toEqual({
      x: client.left + dots.find((dot) => dot.row === 2 && dot.col === 3)!.x,
      y: client.top + dots.find((dot) => dot.row === 2 && dot.col === 3)!.y,
    });
    const cell = gridCellBox(maps, 2, 3);
    expect(cell.w).toBeCloseTo(1224 / 12);
    expect(cell.h).toBeCloseTo(816 / 8);
    expect(dots.find((dot) => dot.row === 2 && dot.col === 3)).toMatchObject({
      x: Math.round(cell.x + cell.w / 2),
      y: Math.round(cell.y + cell.h / 2),
    });
  });

  it("builds a Maps + bag overlay plan and host lattice without regular stash", () => {
    const profile = {
      ...stampMapsStashPanel(stampStashPanel(emptyProfile(3840, 2160), { x: 28, y: 250, w: 1272, h: 1265 }), maps),
      bagGrid: { ...bag },
    };
    expect(juiceGridsForOverlay(profile).map((grid) => grid.region)).toEqual(["maps", "bag"]);
    const plan = planJuiceGridOverlay(profile, client);
    expect(plan.grids).toHaveLength(2);
    expect(plan.grids[0]).toMatchObject({
      region: "maps",
      label: "Maps 12×8",
      x: client.left + maps.x,
      y: client.top + maps.y,
      cols: 12,
      rows: 8,
    });
    expect(plan.clicks).toHaveLength(96 + 60);
    expect(latticeLines(maps)).toHaveLength(12 + 1 + 8 + 1);
    const marks = hostLatticeRects(plan);
    expect(marks.some((rect) => rect.label === "Maps 12×8 — dots are juice click centers")).toBe(true);
    expect(marks.some((rect) => rect.label === "Bag 12×5 — dots are juice click centers")).toBe(true);
    expect(marks.filter((rect) => rect.w === 6 && rect.h === 6)).toHaveLength(156);
  });
});
