import type { GridGeometry } from "../inventory/gridGeometry.js";
import type { GridCell, PixelPoint } from "../world-state/types.js";

export const DEFAULT_INVENTORY_GRID: GridGeometry = {
  originX: 100,
  originY: 500,
  cellWidth: 50,
  cellHeight: 50,
  columns: 12,
  rows: 5,
};

export const DEFAULT_STASH_GRID: GridGeometry = {
  originX: 800,
  originY: 500,
  cellWidth: 50,
  cellHeight: 50,
  columns: 12,
  rows: 12,
};

export const DEFAULT_TAB_CLICKS: Record<string, PixelPoint> = {
  currency: { x: 820, y: 350 },
  waystones: { x: 870, y: 350 },
  uniques: { x: 920, y: 350 },
  "high-value-sell": { x: 970, y: 350 },
  "normal-sell": { x: 1020, y: 350 },
  crafting: { x: 1070, y: 350 },
  bulk: { x: 1120, y: 350 },
  dump: { x: 1170, y: 350 },
  vendor: { x: 1220, y: 350 },
};

export function cellCenter(
  cell: Pick<GridCell, "x" | "y" | "w" | "h">,
  grid: GridGeometry,
): PixelPoint {
  const width = grid.cellWidth;
  const height = grid.cellHeight;
  return {
    x: grid.originX + cell.x * width + width / 2,
    y: grid.originY + cell.y * height + height / 2,
  };
}

export function tabClickPoint(tabId: string): PixelPoint {
  return DEFAULT_TAB_CLICKS[tabId] ?? { x: DEFAULT_STASH_GRID.originX, y: 350 };
}
