import { clusterOccupied, snapToItemShape, type StashItem } from "./bagPack.js";
import { activeStashGrid, toScreenBox, type CalibrationProfile } from "./calibrationProfile.js";
import type { ScreenRect } from "./screenLayout.js";
import type { QaActionTrace } from "./types.js";
import type { OccupiedCell } from "./uiPerception.js";

export type DryRunOverlayKind = "fill" | "empty" | "two-cycle";
export type OverlayRegion = "stash" | "bag" | "search" | "other";
export type OverlayGridArea = "stash" | "bag";

export interface OverlayGrid {
  region: Exclude<OverlayRegion, "other">;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cols?: number;
  rows?: number;
}

export interface OverlayClick {
  n: number;
  x: number;
  y: number;
  kind: "click" | "drag-from" | "drag-to";
  region: OverlayRegion;
  button?: "left" | "right";
}

/** One perceived-occupied cell, distinct from yellow click markers. */
export interface OverlayOccupiedCell {
  area: OverlayGridArea;
  row: number;
  col: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OverlayCellRef {
  area: OverlayGridArea;
  row: number;
  col: number;
  /** Original perception at plan time (item detected vs empty). */
  occupied: boolean;
}

/** One complete item footprint (2×3 armour, 1×1 ring, …), not a single cell. */
export interface OverlayItem {
  area: OverlayGridArea;
  id: string;
  row: number;
  col: number;
  /** Footprint width in cells. */
  w: number;
  /** Footprint height in cells. */
  h: number;
  x: number;
  y: number;
  width: number;
  height: number;
  itemClass?: string;
  cells: Array<{ row: number; col: number }>;
}

export interface OverlayDetectionLabel {
  area: OverlayGridArea;
  row: number;
  col: number;
  perceivedOccupied: boolean;
  label: "right" | "wrong";
}

export interface DryRunOverlayPlan {
  kind: DryRunOverlayKind;
  client: ScreenRect;
  grids: OverlayGrid[];
  clicks: OverlayClick[];
  /** Display occupancy after any in-session Right/Wrong flips. */
  occupied: OverlayOccupiedCell[];
  /** Immutable perception snapshot used for labeling. */
  detected: OverlayOccupiedCell[];
  /** Display item footprints after any occupancy flips. */
  items: OverlayItem[];
  /** Immutable item footprints from plan-time perception. */
  detectedItems: OverlayItem[];
  selected?: OverlayCellRef[];
  evidenceHash?: string;
  screenshotId?: string;
}

export interface PlanDryRunOverlayInput {
  kind: DryRunOverlayKind;
  traces: readonly QaActionTrace[];
  profile: CalibrationProfile;
  client: ScreenRect;
  occupiedStash?: readonly OccupiedCell[];
  occupiedBag?: readonly OccupiedCell[];
  /** Sprite-detected stash items. When omitted, occupied stash cells are clustered. */
  stashItems?: readonly StashItem[];
  /** Grouped bag items. When omitted, occupied bag cells are clustered. */
  bagItems?: readonly StashItem[];
  evidenceHash?: string;
  screenshotId?: string;
}

function contains(box: { x: number; y: number; w: number; h: number }, x: number, y: number): boolean {
  return x >= box.x && y >= box.y && x < box.x + box.w && y < box.y + box.h;
}

function classify(grids: OverlayGrid[], x: number, y: number): OverlayRegion {
  const bag = grids.find((grid) => grid.region === "bag");
  const search = grids.find((grid) => grid.region === "search");
  const stash = grids.find((grid) => grid.region === "stash");
  if (bag && contains(bag, x, y)) return "bag";
  if (search && contains(search, x, y)) return "search";
  if (stash && contains(stash, x, y)) return "stash";
  return "other";
}

function addClick(
  clicks: OverlayClick[],
  grids: OverlayGrid[],
  x: number,
  y: number,
  kind: OverlayClick["kind"],
  button?: "left" | "right",
): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  clicks.push({
    n: clicks.length + 1,
    x: Math.round(x),
    y: Math.round(y),
    kind,
    region: classify(grids, x, y),
    ...(button ? { button } : {}),
  });
}

export function overlayCellRect(
  grid: OverlayGrid,
  row: number,
  col: number,
): { x: number; y: number; w: number; h: number } {
  const cols = Math.max(1, grid.cols ?? 1);
  const rows = Math.max(1, grid.rows ?? 1);
  const w = grid.w / cols;
  const h = grid.h / rows;
  return {
    x: grid.x + col * w,
    y: grid.y + row * h,
    w,
    h,
  };
}

export function overlayItemPixelRect(
  grid: OverlayGrid,
  row: number,
  col: number,
  cellW: number,
  cellH: number,
): { x: number; y: number; width: number; height: number } {
  const origin = overlayCellRect(grid, row, col);
  const last = overlayCellRect(grid, row + Math.max(1, cellH) - 1, col + Math.max(1, cellW) - 1);
  return {
    x: origin.x,
    y: origin.y,
    width: last.x + last.w - origin.x,
    height: last.y + last.h - origin.y,
  };
}

export function overlayCellKey(cell: Pick<OverlayCellRef, "area" | "row" | "col">): string {
  return `${cell.area}:${cell.row},${cell.col}`;
}

function itemContains(
  item: Pick<OverlayItem, "area" | "cells">,
  cell: Pick<OverlayCellRef, "area" | "row" | "col">,
): boolean {
  return (
    item.area === cell.area &&
    item.cells.some((entry) => entry.row === cell.row && entry.col === cell.col)
  );
}

/** Cluster 4-connected occupied cells into legal item shapes in native grid coords. */
export function footprintsFromOccupied(cells: readonly OccupiedCell[]): StashItem[] {
  const items: StashItem[] = [];
  for (const group of clusterOccupied([...cells])) {
    for (const shape of snapToItemShape(group.map((cell) => ({ row: cell.row, col: cell.col })))) {
      const origin = [...shape.cells].sort((a, b) => a.row - b.row || a.col - b.col)[0]!;
      const grab =
        group.find((cell) => cell.row === origin.row && cell.col === origin.col) ??
        [...group].sort((a, b) => a.row - b.row || a.col - b.col)[0]!;
      items.push({
        id: `${origin.row},${origin.col}:${shape.w}x${shape.h}`,
        grab,
        cells: shape.cells,
        w: shape.w,
        h: shape.h,
      });
    }
  }
  return items;
}

function toOverlayItems(
  area: OverlayGridArea,
  grid: OverlayGrid | undefined,
  items: readonly StashItem[],
): OverlayItem[] {
  if (!grid || !grid.cols || !grid.rows) return [];
  return items.map((item) => {
    const row = Math.min(item.grab.row, ...item.cells.map((cell) => cell.row));
    const col = Math.min(item.grab.col, ...item.cells.map((cell) => cell.col));
    const pixels = overlayItemPixelRect(grid, row, col, item.w, item.h);
    return {
      area,
      id: item.id,
      row,
      col,
      w: item.w,
      h: item.h,
      x: pixels.x,
      y: pixels.y,
      width: pixels.width,
      height: pixels.height,
      ...(item.itemClass ? { itemClass: item.itemClass } : {}),
      cells: item.cells.map((cell) => ({ row: cell.row, col: cell.col })),
    };
  });
}

function occupiedAsCells(cells: readonly OverlayOccupiedCell[]): OccupiedCell[] {
  return cells.map((cell) => ({ row: cell.row, col: cell.col, x: cell.x, y: cell.y }));
}

function clusterOverlayItems(
  plan: Pick<DryRunOverlayPlan, "grids">,
  occupied: readonly OverlayOccupiedCell[],
): OverlayItem[] {
  const stashGrid = plan.grids.find((grid) => grid.region === "stash");
  const bagGrid = plan.grids.find((grid) => grid.region === "bag");
  return [
    ...toOverlayItems(
      "stash",
      stashGrid,
      footprintsFromOccupied(occupiedAsCells(occupied.filter((cell) => cell.area === "stash"))),
    ),
    ...toOverlayItems(
      "bag",
      bagGrid,
      footprintsFromOccupied(occupiedAsCells(occupied.filter((cell) => cell.area === "bag"))),
    ),
  ];
}

/**
 * Plain click replaces the selection with `incoming`.
 * Shift-click toggles that group (usually one item footprint) in or out.
 */
export function updateOverlaySelection(
  current: readonly OverlayCellRef[],
  incoming: readonly OverlayCellRef[],
  additive = false,
): OverlayCellRef[] {
  if (!additive) return [...incoming];
  if (incoming.length === 0) return [...current];
  const currentKeys = new Set(current.map(overlayCellKey));
  const incomingKeys = incoming.map(overlayCellKey);
  const allSelected = incomingKeys.every((key) => currentKeys.has(key));
  if (allSelected) {
    const drop = new Set(incomingKeys);
    return current.filter((cell) => !drop.has(overlayCellKey(cell)));
  }
  const extra = incoming.filter((cell) => !currentKeys.has(overlayCellKey(cell)));
  return [...current, ...extra];
}

/** Expand a clicked cell to every cell of its item, or keep a lone empty cell. */
export function overlayItemCellsAt(plan: DryRunOverlayPlan, cell: OverlayCellRef): OverlayCellRef[] {
  const item = (plan.items ?? plan.detectedItems ?? []).find((entry) => itemContains(entry, cell));
  if (!item) return [cell];
  return item.cells.map((entry) => ({
    area: item.area,
    row: entry.row,
    col: entry.col,
    occupied: plan.detected.some(
      (detected) =>
        detected.area === item.area && detected.row === entry.row && detected.col === entry.col,
    ),
  }));
}

export function overlaySelectionSummary(cells: readonly OverlayCellRef[]): string {
  if (cells.length === 0) {
    return "Click a stash or bag item to label occupancy. Shift-click adds more.";
  }
  if (cells.length === 1) {
    const selected = cells[0]!;
    return `Selected ${selected.area} r${selected.row} c${selected.col} · perceived ${
      selected.occupied ? "OCCUPIED (item detected)" : "EMPTY (no item detected)"
    }`;
  }
  const areas = new Set(cells.map((cell) => cell.area));
  const mix = areas.size > 1 ? " (stash + bag)" : "";
  return `${cells.length} cells selected${mix} · Wrong will invert all`;
}

function occupiedMarks(
  grid: OverlayGrid | undefined,
  area: OverlayGridArea,
  cells: readonly OccupiedCell[] | undefined,
): OverlayOccupiedCell[] {
  if (!grid || !grid.cols || !grid.rows) return [];
  const seen = new Set<string>();
  const out: OverlayOccupiedCell[] = [];
  for (const cell of cells ?? []) {
    if (cell.row < 0 || cell.col < 0 || cell.row >= grid.rows || cell.col >= grid.cols) continue;
    const key = `${cell.row},${cell.col}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      area,
      row: cell.row,
      col: cell.col,
      ...overlayCellRect(grid, cell.row, cell.col),
    });
  }
  return out;
}

function shiftBox<T extends { x: number; y: number }>(item: T, left: number, top: number): T {
  return { ...item, x: item.x - left, y: item.y - top };
}

/**
 * Maps dry-run traces + calibrated grids + the PoE client rect into overlay
 * primitives. Coordinates stay in the same screen space GameInputController uses.
 */
export function planDryRunOverlay(input: PlanDryRunOverlayInput): DryRunOverlayPlan {
  const { kind, traces, profile, client } = input;
  const grids: OverlayGrid[] = [];
  const stash = activeStashGrid(profile);
  if (stash) {
    grids.push({
      region: "stash",
      label: profile.activeStashTab === "quad" ? "Stash 24×24" : "Stash 12×12",
      ...toScreenBox(client, stash),
      cols: stash.cols,
      rows: stash.rows,
    });
  }
  if (profile.bagGrid) {
    grids.push({
      region: "bag",
      label: "Bag 12×5",
      ...toScreenBox(client, profile.bagGrid),
      cols: profile.bagGrid.cols,
      rows: profile.bagGrid.rows,
    });
  }
  if (profile.stashSearch && kind !== "empty") {
    grids.push({
      region: "search",
      label: "Search",
      ...toScreenBox(client, profile.stashSearch),
    });
  }

  const clicks: OverlayClick[] = [];
  for (const trace of traces) {
    const action = trace.input;
    if (!action) continue;
    if (action.kind === "click") {
      addClick(clicks, grids, Number(action.x), Number(action.y), "click", action.button);
    } else if (action.kind === "drag") {
      addClick(clicks, grids, Number(action.x), Number(action.y), "drag-from");
      addClick(clicks, grids, Number(action.x2), Number(action.y2), "drag-to");
    }
  }

  const stashGrid = grids.find((grid) => grid.region === "stash");
  const bagGrid = grids.find((grid) => grid.region === "bag");
  const detected = [
    ...occupiedMarks(stashGrid, "stash", input.occupiedStash),
    ...occupiedMarks(bagGrid, "bag", input.occupiedBag),
  ];
  const items = [
    ...toOverlayItems(
      "stash",
      stashGrid,
      input.stashItems ?? footprintsFromOccupied(input.occupiedStash ?? []),
    ),
    ...toOverlayItems(
      "bag",
      bagGrid,
      input.bagItems ?? footprintsFromOccupied(input.occupiedBag ?? []),
    ),
  ];

  return {
    kind,
    client: { ...client },
    grids,
    clicks,
    occupied: detected.map((cell) => ({ ...cell })),
    detected: detected.map((cell) => ({ ...cell })),
    items: items.map((item) => ({ ...item, cells: item.cells.map((cell) => ({ ...cell })) })),
    detectedItems: items.map((item) => ({ ...item, cells: item.cells.map((cell) => ({ ...cell })) })),
    ...(input.evidenceHash ? { evidenceHash: input.evidenceHash } : {}),
    ...(input.screenshotId ? { screenshotId: input.screenshotId } : {}),
  };
}

/** Shift screen-space primitives into client-local coordinates for an overlay window. */
export function overlayPlanToClientSpace(plan: DryRunOverlayPlan): DryRunOverlayPlan {
  const { left, top } = plan.client;
  return {
    ...plan,
    client: { left: 0, top: 0, width: plan.client.width, height: plan.client.height },
    grids: plan.grids.map((grid) => shiftBox(grid, left, top)),
    clicks: plan.clicks.map((click) => shiftBox(click, left, top)),
    occupied: plan.occupied.map((cell) => shiftBox(cell, left, top)),
    detected: plan.detected.map((cell) => shiftBox(cell, left, top)),
    items: (plan.items ?? []).map((item) => shiftBox(item, left, top)),
    detectedItems: (plan.detectedItems ?? []).map((item) => shiftBox(item, left, top)),
  };
}

/**
 * Maps an overlay-local click to a stash or bag cell. Bag wins if grids overlap.
 * `occupied` is the original detection, not the in-session flipped display.
 */
export function overlayCellAtPoint(
  plan: DryRunOverlayPlan,
  x: number,
  y: number,
): OverlayCellRef | undefined {
  for (const area of ["bag", "stash"] as const) {
    const grid = plan.grids.find((entry) => entry.region === area);
    if (!grid || !grid.cols || !grid.rows || grid.w <= 0 || grid.h <= 0) continue;
    if (!contains(grid, x, y)) continue;
    const col = Math.min(grid.cols - 1, Math.max(0, Math.floor((x - grid.x) / (grid.w / grid.cols))));
    const row = Math.min(grid.rows - 1, Math.max(0, Math.floor((y - grid.y) / (grid.h / grid.rows))));
    const occupied = plan.detected.some(
      (cell) => cell.area === area && cell.row === row && cell.col === col,
    );
    return { area, row, col, occupied };
  }
  return undefined;
}

/** Latest in-session Right/Wrong updates displayed occupancy without changing `detected`. */
export function applyOverlayDetectionLabels(
  plan: DryRunOverlayPlan,
  labels: readonly OverlayDetectionLabel[],
): DryRunOverlayPlan {
  const latest = new Map<string, OverlayDetectionLabel>();
  for (const label of labels) latest.set(`${label.area}:${label.row},${label.col}`, label);
  const byKey = new Map(
    plan.detected.map((cell) => [`${cell.area}:${cell.row},${cell.col}`, { ...cell }]),
  );
  for (const label of latest.values()) {
    const key = `${label.area}:${label.row},${label.col}`;
    const shouldOccupy = label.label === "right" ? label.perceivedOccupied : !label.perceivedOccupied;
    if (shouldOccupy) {
      if (byKey.has(key)) continue;
      const grid = plan.grids.find((entry) => entry.region === label.area);
      if (!grid) continue;
      byKey.set(key, {
        area: label.area,
        row: label.row,
        col: label.col,
        ...overlayCellRect(grid, label.row, label.col),
      });
    } else {
      byKey.delete(key);
    }
  }
  const occupied = [...byKey.values()];
  const hasWrong = [...latest.values()].some((label) => label.label === "wrong");
  return {
    ...plan,
    occupied,
    items: hasWrong
      ? clusterOverlayItems(plan, occupied)
      : (plan.detectedItems ?? []).map((item) => ({
          ...item,
          cells: item.cells.map((cell) => ({ ...cell })),
        })),
  };
}
