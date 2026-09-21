import { mapsStashGrid, type CalibrationProfile, type ClientBox, type GridMark } from "./calibrationProfile.js";
import { cellCenterTwoCorner, type TwoCornerGrid } from "./gridMath.js";
import type { ScreenRect } from "./screenLayout.js";

export type JuiceOverlayRegion = "maps" | "bag";

export interface JuiceOverlayGrid {
  region: JuiceOverlayRegion;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cols: number;
  rows: number;
}

export interface JuiceOverlayClick {
  region: JuiceOverlayRegion;
  row: number;
  col: number;
  x: number;
  y: number;
}

export interface JuiceGridOverlayPlan {
  client: ScreenRect;
  grids: JuiceOverlayGrid[];
  clicks: JuiceOverlayClick[];
}

export interface HostMarkRect {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: "click" | "found";
  label?: string;
}

/** Same TL/BR conversion juice-maps uses before cellCenterTwoCorner. */
export function markToScreenGrid(
  clientLeft: number,
  clientTop: number,
  mark: Pick<GridMark, "x" | "y" | "w" | "h">,
): TwoCornerGrid {
  return {
    topLeft: { x: clientLeft + mark.x, y: clientTop + mark.y },
    bottomRight: { x: clientLeft + mark.x + mark.w, y: clientTop + mark.y + mark.h },
  };
}

export function gridCellBox(mark: GridMark, row: number, col: number): ClientBox {
  const cols = Math.max(1, mark.cols);
  const rows = Math.max(1, mark.rows);
  const w = mark.w / cols;
  const h = mark.h / rows;
  return {
    x: mark.x + col * w,
    y: mark.y + row * h,
    w,
    h,
  };
}

/** Juice click points in the mark's own client space. */
export function gridClickCenters(mark: GridMark): Array<{ row: number; col: number; x: number; y: number }> {
  const grid = markToScreenGrid(0, 0, mark);
  const out: Array<{ row: number; col: number; x: number; y: number }> = [];
  for (let row = 0; row < mark.rows; row += 1) {
    for (let col = 0; col < mark.cols; col += 1) {
      out.push({ row, col, ...cellCenterTwoCorner(grid, col, row, mark.cols, mark.rows) });
    }
  }
  return out;
}

export function latticeLines(mark: Pick<GridMark, "x" | "y" | "w" | "h" | "cols" | "rows">): ClientBox[] {
  const lines: ClientBox[] = [];
  for (let col = 0; col <= mark.cols; col += 1) {
    lines.push({
      x: Math.round(mark.x + (col * mark.w) / mark.cols) - 1,
      y: mark.y,
      w: 2,
      h: mark.h,
    });
  }
  for (let row = 0; row <= mark.rows; row += 1) {
    lines.push({
      x: mark.x,
      y: Math.round(mark.y + (row * mark.h) / mark.rows) - 1,
      w: mark.w,
      h: 2,
    });
  }
  return lines;
}

export function juiceGridsForOverlay(
  profile: CalibrationProfile,
): Array<{ region: JuiceOverlayRegion; label: string; mark: GridMark }> {
  const grids: Array<{ region: JuiceOverlayRegion; label: string; mark: GridMark }> = [];
  const maps = mapsStashGrid(profile);
  if (maps) grids.push({ region: "maps", label: `Maps ${maps.cols}×${maps.rows}`, mark: maps });
  if (profile.bagGrid) {
    grids.push({
      region: "bag",
      label: `Bag ${profile.bagGrid.cols}×${profile.bagGrid.rows}`,
      mark: profile.bagGrid,
    });
  }
  return grids;
}

export function planJuiceGridOverlay(profile: CalibrationProfile, client: ScreenRect): JuiceGridOverlayPlan {
  const grids: JuiceOverlayGrid[] = [];
  const clicks: JuiceOverlayClick[] = [];
  for (const entry of juiceGridsForOverlay(profile)) {
    grids.push({
      region: entry.region,
      label: entry.label,
      x: client.left + entry.mark.x,
      y: client.top + entry.mark.y,
      w: entry.mark.w,
      h: entry.mark.h,
      cols: entry.mark.cols,
      rows: entry.mark.rows,
    });
    for (const dot of gridClickCenters(entry.mark)) {
      clicks.push({
        region: entry.region,
        row: dot.row,
        col: dot.col,
        x: client.left + dot.x,
        y: client.top + dot.y,
      });
    }
  }
  return { client: { ...client }, grids, clicks };
}

export function hostLatticeRects(plan: JuiceGridOverlayPlan): HostMarkRect[] {
  const rects: HostMarkRect[] = [];
  for (const grid of plan.grids) {
    const kind = grid.region === "maps" ? "click" : "found";
    for (const line of latticeLines(grid)) rects.push({ ...line, kind });
    rects.push({
      x: grid.x,
      y: Math.max(8, grid.y - 36),
      w: Math.max(280, Math.round(grid.w * 0.45)),
      h: 28,
      kind,
      label: `${grid.label} — dots are juice click centers`,
    });
  }
  for (const click of plan.clicks) {
    rects.push({
      x: click.x - 3,
      y: click.y - 3,
      w: 6,
      h: 6,
      kind: click.region === "maps" ? "click" : "found",
    });
  }
  return rects;
}
