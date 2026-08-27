import type { BBox, OccupiedCell } from "./uiPerception.js";

export const BAG_COLS = 12;
export const BAG_ROWS = 5;

export const LEGAL_SIZES = [
  { w: 2, h: 4 },
  { w: 2, h: 3 },
  { w: 1, h: 4 },
  { w: 2, h: 2 },
  { w: 1, h: 3 },
  { w: 2, h: 1 },
  { w: 1, h: 2 },
  { w: 1, h: 1 },
] as const;

export interface StashItem {
  id: string;
  grab: OccupiedCell;
  cells: Array<{ row: number; col: number }>;
  w: number;
  h: number;
  itemClass?: string;
}

export interface FillMove {
  item: StashItem;
  dest: { row: number; col: number };
  from: { x: number; y: number };
  to: { x: number; y: number };
}

type Cell = { row: number; col: number };

export function clusterOccupied(cells: OccupiedCell[]): OccupiedCell[][] {
  const byKey = new Map<string, OccupiedCell>();
  for (const cell of cells) byKey.set(`${cell.row},${cell.col}`, cell);
  const seen = new Set<string>();
  const groups: OccupiedCell[][] = [];
  for (const cell of cells) {
    const start = `${cell.row},${cell.col}`;
    if (seen.has(start)) continue;
    const group: OccupiedCell[] = [];
    const queue = [cell];
    seen.add(start);
    while (queue.length) {
      const cur = queue.shift()!;
      group.push(cur);
      for (const [dr, dc] of [
        [0, 1],
        [1, 0],
        [0, -1],
        [-1, 0],
      ] as const) {
        const key = `${cur.row + dr},${cur.col + dc}`;
        const next = byKey.get(key);
        if (!next || seen.has(key)) continue;
        seen.add(key);
        queue.push(next);
      }
    }
    groups.push(group);
  }
  return groups;
}

export function toBagCells(cells: OccupiedCell[], stashCols = BAG_COLS): Cell[] {
  const scale = stashCols >= 24 ? 2 : 1;
  const unique = new Map<string, Cell>();
  for (const cell of cells) {
    const row = Math.floor(cell.row / scale);
    const col = Math.floor(cell.col / scale);
    unique.set(`${row},${col}`, { row, col });
  }
  return [...unique.values()];
}

export function emptyBagMask(
  occupiedBag: OccupiedCell[],
  cols = BAG_COLS,
  rows = BAG_ROWS,
): boolean[][] {
  const empty = Array.from({ length: rows }, () => Array.from({ length: cols }, () => true));
  for (const cell of occupiedBag) {
    if (cell.row >= 0 && cell.row < rows && cell.col >= 0 && cell.col < cols) {
      empty[cell.row]![cell.col] = false;
    }
  }
  return empty;
}

export function findPlacement(shape: Cell[], empty: boolean[][]): { row: number; col: number } | null {
  if (shape.length === 0) return null;
  const minR = Math.min(...shape.map((cell) => cell.row));
  const minC = Math.min(...shape.map((cell) => cell.col));
  const rel = shape.map((cell) => ({ row: cell.row - minR, col: cell.col - minC }));
  const rows = empty.length;
  const cols = empty[0]?.length ?? 0;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (rel.every((cell) => empty[row + cell.row]?.[col + cell.col])) {
        return { row, col };
      }
    }
  }
  return null;
}

function keyOf(cell: Cell): string {
  return `${cell.row},${cell.col}`;
}

function rectCells(row: number, col: number, w: number, h: number): Cell[] {
  const cells: Cell[] = [];
  for (let r = 0; r < h; r += 1) {
    for (let c = 0; c < w; c += 1) cells.push({ row: row + r, col: col + c });
  }
  return cells;
}

function fillThreshold(w: number, h: number): number {
  return w === 1 && h >= 3 ? 0.4 : 0.7;
}

function isLegal(w: number, h: number): boolean {
  return LEGAL_SIZES.some((size) => size.w === w && size.h === h);
}

export function snapToItemShape(cells: Cell[]): { w: number; h: number; cells: Cell[] }[] {
  if (cells.length === 0) return [];
  const remaining = new Set(cells.map(keyOf));
  const byKey = new Map(cells.map((cell) => [keyOf(cell), cell]));
  const items: { w: number; h: number; cells: Cell[] }[] = [];

  const peel = () => {
    let best: { score: number; cells: Cell[]; w: number; h: number } | null = null;
    const rows = [...remaining].map((key) => Number(key.split(",")[0]));
    const cols = [...remaining].map((key) => Number(key.split(",")[1]));
    const minR = Math.min(...rows);
    const maxR = Math.max(...rows);
    const minC = Math.min(...cols);
    const maxC = Math.max(...cols);
    for (const { w, h } of LEGAL_SIZES) {
      for (let row = minR; row <= maxR - h + 1; row += 1) {
        for (let col = minC; col <= maxC - w + 1; col += 1) {
          const rect = rectCells(row, col, w, h);
          const hit = rect.filter((cell) => remaining.has(keyOf(cell))).length;
          if (hit / rect.length < fillThreshold(w, h)) continue;
          if (!rect.every((cell) => remaining.has(keyOf(cell))) && hit / rect.length < 0.99 && !(w === 1 && h >= 3)) {
            continue;
          }
          const score = w * h;
          if (!best || score > best.score) best = { score, cells: rect, w, h };
        }
      }
    }
    if (!best) {
      const first = byKey.get([...remaining][0]!)!;
      best = { score: 1, cells: [{ row: first.row, col: first.col }], w: 1, h: 1 };
    }
    items.push({ w: best.w, h: best.h, cells: best.cells });
    for (const cell of best.cells) remaining.delete(keyOf(cell));
  };

  const minR = Math.min(...cells.map((cell) => cell.row));
  const minC = Math.min(...cells.map((cell) => cell.col));
  const w = Math.max(...cells.map((cell) => cell.col)) - minC + 1;
  const h = Math.max(...cells.map((cell) => cell.row)) - minR + 1;
  const fill = cells.length / (w * h);
  if (isLegal(w, h) && fill >= fillThreshold(w, h)) {
    return [{ w, h, cells: rectCells(minR, minC, w, h) }];
  }
  while (remaining.size) peel();
  return items;
}

export function stashItems(occupiedStash: OccupiedCell[], stashCols = BAG_COLS): StashItem[] {
  const scale = stashCols >= 24 ? 2 : 1;
  const bagToStash = new Map<string, OccupiedCell[]>();
  for (const cell of occupiedStash) {
    const row = Math.floor(cell.row / scale);
    const col = Math.floor(cell.col / scale);
    const key = `${row},${col}`;
    const list = bagToStash.get(key) ?? [];
    list.push(cell);
    bagToStash.set(key, list);
  }
  const bagCells: OccupiedCell[] = [...bagToStash.entries()].map(([key, group]) => {
    const [row, col] = key.split(",").map(Number) as [number, number];
    const grab = [...group].sort((a, b) => a.row - b.row || a.col - b.col)[0]!;
    return { row, col, x: grab.x, y: grab.y, bag: "stash" };
  });
  const items: StashItem[] = [];
  for (const group of clusterOccupied(bagCells)) {
    for (const shape of snapToItemShape(group)) {
      const origin = [...shape.cells].sort((a, b) => a.row - b.row || a.col - b.col)[0]!;
      const grab =
        bagToStash.get(keyOf(origin))?.sort((a, b) => a.row - b.row || a.col - b.col)[0] ??
        group.sort((a, b) => a.row - b.row || a.col - b.col)[0]!;
      items.push({
        id: `${origin.row},${origin.col}:${shape.w}x${shape.h}`,
        grab,
        cells: shape.cells,
        w: shape.w,
        h: shape.h,
      });
    }
  }
  return items.sort((a, b) => b.cells.length - a.cells.length || b.h - a.h || a.id.localeCompare(b.id));
}

export function pickNextFill(
  occupiedStash: OccupiedCell[],
  occupiedBag: OccupiedCell[],
  stashCols = BAG_COLS,
  skipped: Set<string> = new Set(),
): { item: StashItem; dest: { row: number; col: number } } | null {
  return (
    planFillMoves(occupiedStash, occupiedBag, { x: 0, y: 0, w: 120, h: 50 }, stashCols).find(
      (move) => !skipped.has(move.item.id),
    ) ?? null
  );
}

export function sizeStashItem(item: StashItem, w: number, h: number): StashItem {
  return {
    ...item,
    w,
    h,
    cells: rectCells(item.grab.row, item.grab.col, w, h),
    id: `${item.grab.row},${item.grab.col}:${w}x${h}`,
  };
}

export function fitKnownSize(
  item: StashItem,
  w: number,
  h: number,
  occupiedKeys: Set<string>,
): StashItem {
  const grabRow = item.grab.row;
  const grabCol = item.grab.col;
  let best = { row: grabRow, col: grabCol, score: -1 };
  for (let row = grabRow - h + 1; row <= grabRow; row += 1) {
    for (let col = grabCol - w + 1; col <= grabCol; col += 1) {
      let score = 0;
      for (const cell of rectCells(row, col, w, h)) {
        if (occupiedKeys.has(keyOf(cell))) score += 1;
      }
      if (score > best.score) best = { row, col, score };
    }
  }
  return {
    ...item,
    w,
    h,
    cells: rectCells(best.row, best.col, w, h),
    id: `${best.row},${best.col}:${w}x${h}`,
  };
}

export function itemFootprintKeys(item: StashItem): string[] {
  return item.cells.map((cell) => `${cell.row},${cell.col}`);
}

export function claimItemFootprint(taken: Set<string>, item: StashItem): boolean {
  const keys = itemFootprintKeys(item);
  if (keys.some((key) => taken.has(key))) return false;
  for (const key of keys) taken.add(key);
  return true;
}

export function plannedFillCells(moves: FillMove[]): number {
  return moves.reduce((sum, move) => sum + move.item.w * move.item.h, 0);
}

export function unusedStashItems(items: StashItem[], exclude: Set<string>): StashItem[] {
  return items.filter((item) => !exclude.has(`${item.grab.row},${item.grab.col}`));
}

export function rememberItemCells(exclude: Set<string>, item: StashItem): void {
  exclude.add(`${item.grab.row},${item.grab.col}`);
}

export function itemsTouch(a: StashItem, b: StashItem): boolean {
  const cellsA = a.cells.length ? a.cells : [{ row: a.grab.row, col: a.grab.col }];
  const cellsB = b.cells.length ? b.cells : [{ row: b.grab.row, col: b.grab.col }];
  return cellsA.some((left) =>
    cellsB.some((right) => Math.abs(left.row - right.row) <= 1 && Math.abs(left.col - right.col) <= 1),
  );
}

export function likelySameSprite(a: StashItem, b: StashItem): boolean {
  if (a.w * a.h > 2 && b.w * b.h > 2) return false;
  return itemsTouch(a, b);
}

export const BAG_FILL_TARGET = 60;
export const BAG_LOOKS_FULL = 60;
export const MAX_FILL_CLICKS = 8;

export function bagCellsForItem(item: StashItem, _stashCols = BAG_COLS): number {
  return Math.max(1, item.w * item.h);
}

export function takeUntilBagCapacity(
  items: StashItem[],
  remaining: number,
  stashCols = BAG_COLS,
  maxClicks = MAX_FILL_CLICKS,
): StashItem[] {
  const room = Math.max(0, remaining);
  const batch: StashItem[] = [];
  const taken = new Set<string>();
  let used = 0;
  for (const item of items) {
    if (batch.length >= maxClicks || used >= room) break;
    const cells = bagCellsForItem(item, stashCols);
    if (used + cells > room) continue;
    if (batch.some((prev) => likelySameSprite(prev, item))) continue;
    if (!claimItemFootprint(taken, item)) continue;
    batch.push(item);
    used += cells;
  }
  return batch;
}

export function planFillMoves(
  occupiedStash: OccupiedCell[],
  occupiedBag: OccupiedCell[],
  bagRegion: BBox,
  stashCols = BAG_COLS,
  items?: StashItem[],
): FillMove[] {
  const empty = emptyBagMask(occupiedBag);
  const moves: FillMove[] = [];
  const ordered = [...(items ?? stashItems(occupiedStash, stashCols))].sort(
    (a, b) => b.w * b.h - a.w * a.h || b.h - a.h || a.id.localeCompare(b.id),
  );
  for (const item of ordered) {
    const dest = findPlacement(item.cells, empty);
    if (!dest) continue;
    const minR = Math.min(...item.cells.map((cell) => cell.row));
    const minC = Math.min(...item.cells.map((cell) => cell.col));
    for (const cell of item.cells) {
      const row = dest.row + (cell.row - minR);
      const col = dest.col + (cell.col - minC);
      if (empty[row]) empty[row][col] = false;
    }
    moves.push({
      item,
      dest,
      from: { x: item.grab.x, y: item.grab.y },
      to: bagCellCenter(bagRegion, dest.col, dest.row),
    });
  }
  return moves;
}

export function bagCellCenter(
  region: BBox,
  col: number,
  row: number,
  cols = BAG_COLS,
  rows = BAG_ROWS,
): { x: number; y: number } {
  return {
    x: Math.round(region.x + (region.w * (col + 0.5)) / cols),
    y: Math.round(region.y + (region.h * (row + 0.5)) / rows),
  };
}

export function emptyGridClick(
  region: BBox | undefined,
  cols: number | undefined,
  rows: number | undefined,
  occupied: Array<{ row: number; col: number }>,
): { x: number; y: number; row: number; col: number } | null {
  if (!region || !cols || !rows) return null;
  const taken = new Set(occupied.map((cell) => `${cell.row},${cell.col}`));
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (taken.has(`${row},${col}`)) continue;
      const point = bagCellCenter(region, col, row, cols, rows);
      return { ...point, row, col };
    }
  }
  return null;
}
