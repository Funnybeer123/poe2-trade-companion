/** Cell-center grid math ported from Codex ScannerValidationCore.PositionFor. */

export interface Point {
  x: number;
  y: number;
}

export interface QuadCorners {
  topLeft: Point;
  topRight: Point;
  bottomLeft: Point;
  bottomRight: Point;
  nudgeX?: number;
  nudgeY?: number;
}

export interface TwoCornerGrid {
  topLeft: Point;
  bottomRight: Point;
  nudgeX?: number;
  nudgeY?: number;
}

function bilinear(corners: QuadCorners, u: number, v: number): Point {
  const { topLeft: tl, topRight: tr, bottomLeft: bl, bottomRight: br } = corners;
  return {
    x: (1 - u) * (1 - v) * tl.x + u * (1 - v) * tr.x + (1 - u) * v * bl.x + u * v * br.x,
    y: (1 - u) * (1 - v) * tl.y + u * (1 - v) * tr.y + (1 - u) * v * bl.y + u * v * br.y,
  };
}

/** 0-based row/col cell center using 4-corner interpolation (quad stash / inventory). */
export function cellCenterBilinear(
  corners: QuadCorners,
  col: number,
  row: number,
  cols: number,
  rows: number,
): Point {
  const u = (col + 0.5) / cols;
  const v = (row + 0.5) / rows;
  const point = bilinear(corners, u, v);
  return {
    x: Math.round(point.x + (corners.nudgeX ?? 0)),
    y: Math.round(point.y + (corners.nudgeY ?? 0)),
  };
}

/** 0-based row/col cell center using TL+BR (normal 12×12 stash). */
export function cellCenterTwoCorner(
  grid: TwoCornerGrid,
  col: number,
  row: number,
  cols: number,
  rows: number,
): Point {
  const stepX = (grid.bottomRight.x - grid.topLeft.x) / cols;
  const stepY = (grid.bottomRight.y - grid.topLeft.y) / rows;
  return {
    x: Math.round(grid.topLeft.x + (col + 0.5) * stepX + (grid.nudgeX ?? 0)),
    y: Math.round(grid.topLeft.y + (row + 0.5) * stepY + (grid.nudgeY ?? 0)),
  };
}

/** Center of a multi-cell item sitting at 0-based origin. */
export function itemCenterBilinear(
  corners: QuadCorners,
  col: number,
  row: number,
  width: number,
  height: number,
  cols: number,
  rows: number,
): Point {
  return cellCenterBilinear(corners, col + width / 2 - 0.5, row + height / 2 - 0.5, cols, rows);
}
