import {
  assertScanGridCell,
  assertSupportedScanGrid,
  toUtcTimestamp,
  type ScanGridCell,
  type ScanGridSpec,
} from "./scanContracts.js";

export interface LeftPackItem {
  id: string;
  fingerprint: string;
  source: ScanGridCell;
  width: number;
  height: number;
  /**
   * Optional perception cells. When supplied they must describe exactly one
   * rectangle matching source/width/height; irregular or partial shapes block.
   */
  cells?: ScanGridCell[];
}

export interface LeftPackBuffer {
  id: string;
  cols: number;
  rows: number;
  occupied: ScanGridCell[];
}

export interface LeftPackCancellation {
  requested: boolean;
  reason?: string;
}

export interface LeftPackRequest {
  grid: ScanGridSpec;
  items: LeftPackItem[];
  sourceEvidenceHash: string;
  generatedAt: string | number | Date;
  buffer?: LeftPackBuffer;
  cancellation?: LeftPackCancellation;
}

export interface LeftPackPlacement {
  itemId: string;
  fingerprint: string;
  source: ScanGridCell;
  target: ScanGridCell;
  width: number;
  height: number;
  moved: boolean;
}

export type LeftPackArea = "grid" | "buffer";

export interface LeftPackLocation {
  area: LeftPackArea;
  origin: ScanGridCell;
}

export interface LeftPackStateFingerprint {
  gridHash: string;
  bufferHash: string;
  combinedHash: string;
}

export interface LeftPackMove {
  index: number;
  kind: "direct" | "stage-to-buffer" | "restore-from-buffer";
  itemId: string;
  fingerprint: string;
  from: LeftPackLocation;
  to: LeftPackLocation;
  width: number;
  height: number;
  before: LeftPackStateFingerprint;
  expectedAfter: LeftPackStateFingerprint;
}

export interface LeftPackBlocker {
  code:
    | "cancelled"
    | "duplicate-item-id"
    | "invalid-item"
    | "ambiguous-shape"
    | "source-overlap"
    | "insufficient-grid-capacity"
    | "invalid-buffer"
    | "buffer-required"
    | "insufficient-buffer-space"
    | "planning-cycle";
  message: string;
  itemId?: string;
  cells?: ScanGridCell[];
}

export interface LeftPackReconciliation {
  sourceEvidenceHash: string;
  before: LeftPackStateFingerprint;
  expectedAfter: LeftPackStateFingerprint;
  expectedItems: Array<{
    id: string;
    fingerprint: string;
    location: LeftPackLocation;
    width: number;
    height: number;
  }>;
}

export interface LeftPackDiagnostics {
  itemCount: number;
  occupiedCells: number;
  moveCount: number;
  directMoves: number;
  stagedMoves: number;
  peakBufferItems: number;
  peakBufferCells: number;
  plannedStepsBeforeFailure: number;
}

export interface LeftPackPlan {
  version: 1;
  id: string;
  generatedAt: string;
  grid: ScanGridSpec;
  buffer?: LeftPackBuffer;
  placements: LeftPackPlacement[];
  steps: LeftPackMove[];
  blockers: LeftPackBlocker[];
  executable: boolean;
  reason: string;
  reconciliation: LeftPackReconciliation;
  diagnostics: LeftPackDiagnostics;
}

export interface RectangleOccupancy {
  cols: number;
  rows: number;
  occupied: readonly ScanGridCell[];
}

type ItemLocationState = {
  area: LeftPackArea;
  origin: ScanGridCell;
};

type WorkingState = {
  positions: Map<string, ItemLocationState>;
  gridOwners: Map<string, string>;
  bufferOwners: Map<string, string>;
};

function cellKey(cell: ScanGridCell): string {
  return `${cell.row},${cell.col}`;
}

function cloneCell(cell: ScanGridCell): ScanGridCell {
  return { row: cell.row, col: cell.col };
}

function cloneBuffer(buffer: LeftPackBuffer | undefined): LeftPackBuffer | undefined {
  return buffer
    ? {
        ...buffer,
        occupied: buffer.occupied.map(cloneCell),
      }
    : undefined;
}

function compareCells(left: ScanGridCell, right: ScanGridCell): number {
  return left.row - right.row || left.col - right.col;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function rectangleCells(
  origin: ScanGridCell,
  width: number,
  height: number,
): ScanGridCell[] {
  const cells: ScanGridCell[] = [];
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    return cells;
  }
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      cells.push({ row: origin.row + row, col: origin.col + col });
    }
  }
  return cells;
}

function validBounds(cols: number, rows: number): boolean {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols > 0 &&
    rows > 0 &&
    cols * rows <= 576
  );
}

function inside(cell: ScanGridCell, cols: number, rows: number): boolean {
  return cell.row >= 0 && cell.col >= 0 && cell.row < rows && cell.col < cols;
}

export function rectangleFits(
  occupancy: RectangleOccupancy,
  origin: ScanGridCell,
  width: number,
  height: number,
): boolean {
  if (!validBounds(occupancy.cols, occupancy.rows)) return false;
  const occupied = new Set(occupancy.occupied.map(cellKey));
  const cells = rectangleCells(origin, width, height);
  return (
    cells.length === width * height &&
    cells.every(
      (cell) =>
        inside(cell, occupancy.cols, occupancy.rows) && !occupied.has(cellKey(cell)),
    )
  );
}

/**
 * Returns a new occupancy value; the caller's cells are never mutated.
 */
export function markRectangle(
  occupancy: RectangleOccupancy,
  origin: ScanGridCell,
  width: number,
  height: number,
  occupied = true,
): RectangleOccupancy {
  if (!validBounds(occupancy.cols, occupancy.rows)) {
    throw new Error("invalid-rectangle-occupancy");
  }
  const next = new Map(occupancy.occupied.map((cell) => [cellKey(cell), cloneCell(cell)]));
  const cells = rectangleCells(origin, width, height);
  if (
    cells.length !== width * height ||
    !cells.every((cell) => inside(cell, occupancy.cols, occupancy.rows))
  ) {
    throw new Error("rectangle-out-of-bounds");
  }
  for (const cell of cells) {
    if (occupied) next.set(cellKey(cell), cloneCell(cell));
    else next.delete(cellKey(cell));
  }
  return {
    cols: occupancy.cols,
    rows: occupancy.rows,
    occupied: [...next.values()].sort(compareCells),
  };
}

function findFirstFit(
  cols: number,
  rows: number,
  occupied: ReadonlySet<string>,
  width: number,
  height: number,
): ScanGridCell | undefined {
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const origin = { row, col };
      const cells = rectangleCells(origin, width, height);
      if (
        cells.length === width * height &&
        cells.every(
          (cell) =>
            inside(cell, cols, rows) && !occupied.has(cellKey(cell)),
        )
      ) {
        return origin;
      }
    }
  }
  return undefined;
}

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stateFingerprint(
  state: WorkingState,
  items: readonly LeftPackItem[],
): LeftPackStateFingerprint {
  const identities = new Map(items.map((item) => [item.id, item.fingerprint]));
  const grid = [...state.gridOwners.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([cell, id]) => `${cell}=${id}:${identities.get(id) ?? "reserved"}`)
    .join("|");
  const buffer = [...state.bufferOwners.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([cell, id]) => `${cell}=${id}:${identities.get(id) ?? "reserved"}`)
    .join("|");
  const positions = [...state.positions.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(
      ([id, location]) =>
        `${id}@${location.area}:${location.origin.row},${location.origin.col}`,
    )
    .join("|");
  return {
    gridHash: hashText(grid),
    bufferHash: hashText(buffer),
    combinedHash: hashText(`${grid};${buffer};${positions}`),
  };
}

function buildWorkingState(
  items: readonly LeftPackItem[],
  buffer: LeftPackBuffer | undefined,
): WorkingState {
  const positions = new Map<string, ItemLocationState>();
  const gridOwners = new Map<string, string>();
  for (const item of items) {
    positions.set(item.id, { area: "grid", origin: cloneCell(item.source) });
    for (const cell of rectangleCells(item.source, item.width, item.height)) {
      gridOwners.set(cellKey(cell), item.id);
    }
  }
  const bufferOwners = new Map<string, string>();
  for (const cell of buffer?.occupied ?? []) {
    bufferOwners.set(cellKey(cell), "__reserved__");
  }
  return { positions, gridOwners, bufferOwners };
}

function clearItem(
  owners: Map<string, string>,
  itemId: string,
): void {
  for (const [key, owner] of owners) {
    if (owner === itemId) owners.delete(key);
  }
}

function placeItem(
  owners: Map<string, string>,
  item: LeftPackItem,
  origin: ScanGridCell,
): void {
  for (const cell of rectangleCells(origin, item.width, item.height)) {
    owners.set(cellKey(cell), item.id);
  }
}

function canMoveToGrid(
  state: WorkingState,
  item: LeftPackItem,
  target: ScanGridCell,
  grid: ScanGridSpec,
): boolean {
  return rectangleCells(target, item.width, item.height).every((cell) => {
    if (!inside(cell, grid.cols, grid.rows)) return false;
    const owner = state.gridOwners.get(cellKey(cell));
    return owner == null || owner === item.id;
  });
}

function canMoveToBuffer(
  state: WorkingState,
  item: LeftPackItem,
  buffer: LeftPackBuffer,
): ScanGridCell | undefined {
  return findFirstFit(
    buffer.cols,
    buffer.rows,
    new Set(state.bufferOwners.keys()),
    item.width,
    item.height,
  );
}

function moveWorkingItem(
  state: WorkingState,
  item: LeftPackItem,
  to: ItemLocationState,
): void {
  const current = state.positions.get(item.id);
  if (!current) throw new Error(`missing-working-item:${item.id}`);
  clearItem(
    current.area === "grid" ? state.gridOwners : state.bufferOwners,
    item.id,
  );
  placeItem(
    to.area === "grid" ? state.gridOwners : state.bufferOwners,
    item,
    to.origin,
  );
  state.positions.set(item.id, {
    area: to.area,
    origin: cloneCell(to.origin),
  });
}

function sameCell(left: ScanGridCell, right: ScanGridCell): boolean {
  return left.row === right.row && left.col === right.col;
}

function validateInputs(request: LeftPackRequest): LeftPackBlocker[] {
  const blockers: LeftPackBlocker[] = [];
  const ids = new Set<string>();
  const occupied = new Map<string, string>();

  for (const item of request.items) {
    if (!item.id.trim() || ids.has(item.id)) {
      blockers.push({
        code: "duplicate-item-id",
        message: `Item id is empty or duplicated: ${item.id || "(empty)"}.`,
        itemId: item.id,
      });
    }
    ids.add(item.id);
    const cells = rectangleCells(item.source, item.width, item.height);
    if (
      !item.fingerprint.trim() ||
      cells.length !== item.width * item.height ||
      !cells.every((cell) => inside(cell, request.grid.cols, request.grid.rows))
    ) {
      blockers.push({
        code: "invalid-item",
        message: `Item ${item.id || "(empty)"} has invalid rectangle geometry.`,
        itemId: item.id,
        cells,
      });
      continue;
    }
    if (item.cells) {
      const expected = new Set(cells.map(cellKey));
      const observed = new Set(item.cells.map(cellKey));
      if (
        observed.size !== item.cells.length ||
        observed.size !== expected.size ||
        [...observed].some((key) => !expected.has(key))
      ) {
        blockers.push({
          code: "ambiguous-shape",
          message: `Item ${item.id} does not describe one exact rectangle.`,
          itemId: item.id,
          cells: item.cells.map(cloneCell),
        });
        continue;
      }
    }
    for (const cell of cells) {
      const key = cellKey(cell);
      const prior = occupied.get(key);
      if (prior && prior !== item.id) {
        blockers.push({
          code: "source-overlap",
          message: `Items ${prior} and ${item.id} overlap at ${key}.`,
          itemId: item.id,
          cells: [cloneCell(cell)],
        });
      }
      occupied.set(key, item.id);
    }
  }

  if (request.buffer) {
    if (
      !request.buffer.id.trim() ||
      !validBounds(request.buffer.cols, request.buffer.rows)
    ) {
      blockers.push({
        code: "invalid-buffer",
        message: "Buffer id and dimensions must describe a bounded grid.",
      });
    } else {
      const seen = new Set<string>();
      for (const cell of request.buffer.occupied) {
        const key = cellKey(cell);
        if (
          !inside(cell, request.buffer.cols, request.buffer.rows) ||
          seen.has(key)
        ) {
          blockers.push({
            code: "invalid-buffer",
            message: `Buffer occupancy is invalid at ${key}.`,
            cells: [cloneCell(cell)],
          });
        }
        seen.add(key);
      }
    }
  }
  return blockers;
}

function targetPlacements(
  request: LeftPackRequest,
): {
  placements: LeftPackPlacement[];
  blocker?: LeftPackBlocker;
} {
  const occupied = new Set<string>();
  const ordered = [...request.items].sort(
    (left, right) =>
      right.width * right.height - left.width * left.height ||
      right.height - left.height ||
      right.width - left.width ||
      compareCells(left.source, right.source) ||
      compareText(left.id, right.id) ||
      compareText(left.fingerprint, right.fingerprint),
  );
  const placements: LeftPackPlacement[] = [];
  for (const item of ordered) {
    const target = findFirstFit(
      request.grid.cols,
      request.grid.rows,
      occupied,
      item.width,
      item.height,
    );
    if (!target) {
      return {
        placements,
        blocker: {
          code: "insufficient-grid-capacity",
          message: `No deterministic left-pack target fits item ${item.id}.`,
          itemId: item.id,
        },
      };
    }
    for (const cell of rectangleCells(target, item.width, item.height)) {
      occupied.add(cellKey(cell));
    }
    placements.push({
      itemId: item.id,
      fingerprint: item.fingerprint,
      source: cloneCell(item.source),
      target: cloneCell(target),
      width: item.width,
      height: item.height,
      moved: !sameCell(item.source, target),
    });
  }
  return { placements };
}

function emptyFingerprint(): LeftPackStateFingerprint {
  const empty = hashText("");
  return { gridHash: empty, bufferHash: empty, combinedHash: empty };
}

function failurePlan(
  request: LeftPackRequest,
  generatedAt: string,
  placements: LeftPackPlacement[],
  blockers: LeftPackBlocker[],
  before: LeftPackStateFingerprint,
  expectedAfter = before,
  plannedStepsBeforeFailure = 0,
): LeftPackPlan {
  const itemCells = request.items.reduce(
    (sum, item) =>
      sum +
      (Number.isInteger(item.width) && Number.isInteger(item.height)
        ? Math.max(0, item.width * item.height)
        : 0),
    0,
  );
  return {
    version: 1,
    id: `left-pack-${hashText(
      `${request.sourceEvidenceHash}:${before.combinedHash}:${placements
        .map((placement) => `${placement.itemId}@${cellKey(placement.target)}`)
        .join("|")}`,
    )}`,
    generatedAt,
    grid: { ...request.grid },
    ...(request.buffer ? { buffer: cloneBuffer(request.buffer) } : {}),
    placements: placements.map((placement) => ({
      ...placement,
      source: cloneCell(placement.source),
      target: cloneCell(placement.target),
    })),
    steps: [],
    blockers,
    executable: false,
    reason: blockers[0]?.code ?? "planning-failed",
    reconciliation: {
      sourceEvidenceHash: request.sourceEvidenceHash,
      before,
      expectedAfter,
      expectedItems: [],
    },
    diagnostics: {
      itemCount: request.items.length,
      occupiedCells: itemCells,
      moveCount: 0,
      directMoves: 0,
      stagedMoves: 0,
      peakBufferItems: 0,
      peakBufferCells: 0,
      plannedStepsBeforeFailure,
    },
  };
}

/**
 * Builds a deterministic preview/schedule only. No input adapter is imported
 * or invoked. If a collision cycle cannot be staged safely, all partial steps
 * are discarded and the returned plan is non-executable.
 */
export function planLeftPack(request: LeftPackRequest): LeftPackPlan {
  assertSupportedScanGrid(request.grid);
  if (!request.sourceEvidenceHash.trim()) {
    throw new Error("left-pack-source-evidence-required");
  }
  const generatedAt = toUtcTimestamp(request.generatedAt);
  const blockers = validateInputs(request);
  if (blockers.length > 0) {
    return failurePlan(
      request,
      generatedAt,
      [],
      blockers,
      emptyFingerprint(),
    );
  }

  const state = buildWorkingState(request.items, request.buffer);
  const before = stateFingerprint(state, request.items);
  const targetResult = targetPlacements(request);
  if (targetResult.blocker) {
    return failurePlan(
      request,
      generatedAt,
      targetResult.placements,
      [targetResult.blocker],
      before,
    );
  }
  const placements = targetResult.placements;
  if (request.cancellation?.requested) {
    return failurePlan(
      request,
      generatedAt,
      placements,
      [{
        code: "cancelled",
        message: request.cancellation.reason?.trim() || "Left-pack planning was cancelled.",
      }],
      before,
    );
  }

  const itemById = new Map(request.items.map((item) => [item.id, item]));
  const placementById = new Map(
    placements.map((placement) => [placement.itemId, placement]),
  );
  const remaining = new Set(
    placements
      .filter((placement) => placement.moved)
      .map((placement) => placement.itemId),
  );
  const staged = new Set<string>();
  const steps: LeftPackMove[] = [];
  let peakBufferItems = 0;
  let peakBufferCells = 0;
  let planningOperations = 0;
  const operationLimit = request.items.length * 3 + 1;

  const sortedRemaining = () =>
    [...remaining].sort((leftId, rightId) => {
      const left = placementById.get(leftId)!;
      const right = placementById.get(rightId)!;
      return (
        compareCells(left.target, right.target) ||
        compareText(left.itemId, right.itemId)
      );
    });

  const appendMove = (
    item: LeftPackItem,
    to: ItemLocationState,
    kind: LeftPackMove["kind"],
  ) => {
    const from = state.positions.get(item.id)!;
    const prior = stateFingerprint(state, request.items);
    moveWorkingItem(state, item, to);
    const after = stateFingerprint(state, request.items);
    steps.push({
      index: steps.length,
      kind,
      itemId: item.id,
      fingerprint: item.fingerprint,
      from: { area: from.area, origin: cloneCell(from.origin) },
      to: { area: to.area, origin: cloneCell(to.origin) },
      width: item.width,
      height: item.height,
      before: prior,
      expectedAfter: after,
    });
  };

  while (remaining.size > 0) {
    planningOperations += 1;
    if (planningOperations > operationLimit) {
      return failurePlan(
        request,
        generatedAt,
        placements,
        [{
          code: "planning-cycle",
          message: "Left-pack dependency scheduling exceeded its bounded operation limit.",
        }],
        before,
        before,
        steps.length,
      );
    }

    const directId = sortedRemaining().find((itemId) => {
      const item = itemById.get(itemId)!;
      const placement = placementById.get(itemId)!;
      return canMoveToGrid(state, item, placement.target, request.grid);
    });
    if (directId) {
      const item = itemById.get(directId)!;
      const placement = placementById.get(directId)!;
      const current = state.positions.get(directId)!;
      appendMove(
        item,
        { area: "grid", origin: cloneCell(placement.target) },
        current.area === "buffer" ? "restore-from-buffer" : "direct",
      );
      remaining.delete(directId);
      staged.delete(directId);
      continue;
    }

    if (!request.buffer) {
      return failurePlan(
        request,
        generatedAt,
        placements,
        [{
          code: "buffer-required",
          message: "A collision cycle requires a verified staging buffer.",
        }],
        before,
        before,
        steps.length,
      );
    }

    let stagedOne = false;
    for (const itemId of sortedRemaining()) {
      if (staged.has(itemId)) continue;
      const item = itemById.get(itemId)!;
      const target = canMoveToBuffer(state, item, request.buffer);
      if (!target) continue;
      appendMove(item, { area: "buffer", origin: target }, "stage-to-buffer");
      staged.add(itemId);
      stagedOne = true;
      const bufferItems = [...state.positions.values()].filter(
        (location) => location.area === "buffer",
      ).length;
      const bufferCells = [...state.bufferOwners.values()].filter(
        (owner) => owner !== "__reserved__",
      ).length;
      peakBufferItems = Math.max(peakBufferItems, bufferItems);
      peakBufferCells = Math.max(peakBufferCells, bufferCells);
      break;
    }
    if (!stagedOne) {
      return failurePlan(
        request,
        generatedAt,
        placements,
        [{
          code: "insufficient-buffer-space",
          message: "No remaining dependency item fits the verified staging buffer.",
        }],
        before,
        before,
        steps.length,
      );
    }
  }

  const expectedAfter = stateFingerprint(state, request.items);
  const expectedItems = [...request.items]
    .sort((left, right) => compareText(left.id, right.id))
    .map((item) => {
      const location = state.positions.get(item.id)!;
      return {
        id: item.id,
        fingerprint: item.fingerprint,
        location: {
          area: location.area,
          origin: cloneCell(location.origin),
        },
        width: item.width,
        height: item.height,
      };
    });
  const directMoves = steps.filter((step) => step.kind === "direct").length;
  const stagedMoves = steps.length - directMoves;
  return {
    version: 1,
    id: `left-pack-${hashText(
      `${request.sourceEvidenceHash}:${before.combinedHash}:${expectedAfter.combinedHash}`,
    )}`,
    generatedAt,
    grid: { ...request.grid },
    ...(request.buffer ? { buffer: cloneBuffer(request.buffer) } : {}),
    placements,
    steps,
    blockers: [],
    executable: true,
    reason: steps.length === 0 ? "already-packed" : "ready",
    reconciliation: {
      sourceEvidenceHash: request.sourceEvidenceHash,
      before,
      expectedAfter,
      expectedItems,
    },
    diagnostics: {
      itemCount: request.items.length,
      occupiedCells: request.items.reduce(
        (sum, item) => sum + item.width * item.height,
        0,
      ),
      moveCount: steps.length,
      directMoves,
      stagedMoves,
      peakBufferItems,
      peakBufferCells,
      plannedStepsBeforeFailure: steps.length,
    },
  };
}
