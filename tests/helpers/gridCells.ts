import { makeGridCells, type GridCell } from "@poe2tc/core";

export const INVENTORY_COLUMNS = 4;
export const INVENTORY_ROWS = 3;
export const INVENTORY_CAPACITY = INVENTORY_COLUMNS * INVENTORY_ROWS;

export function allCellCoords(
  columns = INVENTORY_COLUMNS,
  rows = INVENTORY_ROWS,
): Array<readonly [number, number]> {
  const coords: Array<readonly [number, number]> = [];
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      coords.push([x, y]);
    }
  }
  return coords;
}

export function occupiedExcept(
  drop: { x: number; y: number },
  columns = INVENTORY_COLUMNS,
  rows = INVENTORY_ROWS,
): Array<readonly [number, number]> {
  return allCellCoords(columns, rows).filter(([x, y]) => x !== drop.x || y !== drop.y);
}

export function fullInventoryCells(fingerprints?: Record<string, string>): GridCell[] {
  return makeGridCells({
    columns: INVENTORY_COLUMNS,
    rows: INVENTORY_ROWS,
    occupied: allCellCoords().map(([x, y]) => {
      const fingerprint = fingerprints?.[`${String(x)}:${String(y)}`];
      return fingerprint === undefined ? ([x, y] as const) : { x, y, fingerprint };
    }),
  });
}

export function inventoryCellsWithDrop(drop: { x: number; y: number }): GridCell[] {
  return makeGridCells({
    columns: INVENTORY_COLUMNS,
    rows: INVENTORY_ROWS,
    occupied: occupiedExcept(drop),
  });
}
