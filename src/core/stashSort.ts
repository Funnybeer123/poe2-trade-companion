import { LEGAL_SIZES } from "./bagPack.js";

export interface SortCell {
  row: number;
  col: number;
}

export type SortTabKind = "normal" | "quad" | "unsupported";
export type SortFootprintSource = "measured-base" | "fixed-class";

export interface SortTabDescriptor {
  signature: string;
  label: string;
  kind: SortTabKind;
  cols: number;
  rows: number;
  writable: boolean;
  removeOnly?: boolean;
  special?: boolean;
}

export interface SortableStashItem {
  id: string;
  fingerprint: string;
  itemClass: string;
  baseType: string;
  source: SortCell;
  /** Footprint in cells of the active stash grid. Quad tabs use 2x cell scale. */
  w: number;
  h: number;
  /** Physical inventory footprint, used only for bounded staging. */
  bagW: number;
  bagH: number;
  footprintSource: SortFootprintSource;
  confidence: number;
}

export interface SortScanIssue {
  code: string;
  message: string;
  itemId?: string;
  cells?: SortCell[];
  blocking: boolean;
}

export interface SortPlanRequest {
  tab: SortTabDescriptor;
  items: SortableStashItem[];
  observedOccupied?: SortCell[];
  scanIssues?: SortScanIssue[];
  generatedAt?: string;
}

export interface SortPlacement extends SortableStashItem {
  target: SortCell;
  groupKey: string;
  moved: boolean;
}

export interface SortGroup {
  key: string;
  itemClass: string;
  baseType: string;
  itemIds: string[];
  bounds: { row: number; col: number; w: number; h: number };
  colorIndex: number;
}

export interface SortPlanDiagnostics {
  capacityCells: number;
  itemCells: number;
  occupiedCells: number;
  freeCells: number;
  groupCount: number;
  moveCount: number;
  plannedRows: number;
  plannedCols: number;
  compactness: number;
  qualityScore: number;
  groupPaddingReserved: boolean;
}

export interface StashSortPlan {
  id: string;
  generatedAt: string;
  snapshotHash: string;
  tab: SortTabDescriptor;
  placements: SortPlacement[];
  groups: SortGroup[];
  blockers: SortScanIssue[];
  warnings: SortScanIssue[];
  diagnostics: SortPlanDiagnostics;
  executable: boolean;
}

export interface SortBagState {
  cols: number;
  rows: number;
  occupied: SortCell[];
}

export type SortMoveKind = "stash-to-stash" | "stash-to-bag" | "bag-to-stash";
export type SortMoveArea = "stash" | "bag";

export interface SortMoveStep {
  index: number;
  itemId: string;
  kind: SortMoveKind;
  fromArea: SortMoveArea;
  toArea: SortMoveArea;
  from: SortCell;
  to: SortCell;
  fromW: number;
  fromH: number;
  toW: number;
  toH: number;
}

export interface SortMoveSchedule {
  ok: boolean;
  reason: string;
  steps: SortMoveStep[];
  peakStagedItems: number;
  peakStagedCells: number;
}

interface GroupLayout {
  across: number;
  width: number;
  height: number;
  padding: number;
  shapePenalty: number;
}

interface PackedGroup {
  group: GroupBucket;
  row: number;
  col: number;
  layout: GroupLayout;
  targets: SortCell[];
}

interface GroupBucket {
  key: string;
  itemClass: string;
  baseType: string;
  items: SortableStashItem[];
}

interface LocatedItem {
  placement: SortPlacement;
  area: SortMoveArea;
  position: SortCell;
}

const MAX_PACKING_NODES = 50_000;
const MAX_CANDIDATES_PER_GROUP = 96;

function key(cell: SortCell): string {
  return `${cell.row},${cell.col}`;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, "en", { sensitivity: "base", numeric: true });
}

function rectCells(origin: SortCell, w: number, h: number): SortCell[] {
  const cells: SortCell[] = [];
  for (let row = 0; row < h; row += 1) {
    for (let col = 0; col < w; col += 1) {
      cells.push({ row: origin.row + row, col: origin.col + col });
    }
  }
  return cells;
}

function inside(cell: SortCell, cols: number, rows: number): boolean {
  return cell.row >= 0 && cell.col >= 0 && cell.row < rows && cell.col < cols;
}

function validBaseType(baseType: string): boolean {
  const value = normalize(baseType);
  return value.length > 0 && value !== "unknown" && value !== "unknown item";
}

function legalBagSize(w: number, h: number): boolean {
  return LEGAL_SIZES.some((entry) => entry.w === w && entry.h === h);
}

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stableSnapshotHash(
  tab: SortTabDescriptor,
  items: SortableStashItem[],
  occupied: SortCell[],
): string {
  const itemRows = [...items]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(
      (item) =>
        `${item.id}:${item.fingerprint}:${normalize(item.itemClass)}:${normalize(item.baseType)}:` +
        `${item.source.row},${item.source.col}:${item.w}x${item.h}:${item.bagW}x${item.bagH}`,
    );
  const occupiedRows = [...occupied].sort((a, b) => a.row - b.row || a.col - b.col).map(key);
  return hashText(
    [
      tab.signature,
      tab.kind,
      `${tab.cols}x${tab.rows}`,
      ...itemRows,
      `occupied=${occupiedRows.join("|")}`,
    ].join(";"),
  );
}

export function stashSortSnapshotHash(
  tab: SortTabDescriptor,
  items: SortableStashItem[],
  occupied: SortCell[],
): string {
  return stableSnapshotHash(tab, items, occupied);
}

function tabBlockers(tab: SortTabDescriptor): SortScanIssue[] {
  const blockers: SortScanIssue[] = [];
  const supportedShape =
    (tab.kind === "normal" && tab.cols === 12 && tab.rows === 12) ||
    (tab.kind === "quad" && tab.cols === 24 && tab.rows === 24);
  if (!tab.signature.trim()) {
    blockers.push({
      code: "active-tab-unpinned",
      message: "The active stash tab does not have a stable pin signature.",
      blocking: true,
    });
  }
  if (!supportedShape || tab.kind === "unsupported") {
    blockers.push({
      code: "unsupported-tab",
      message: `Only calibrated 12×12 normal and 24×24 quad grid tabs are supported; received ${tab.cols}×${tab.rows}.`,
      blocking: true,
    });
  }
  if (!tab.writable) {
    blockers.push({
      code: "tab-not-writable",
      message: "The active stash tab is not positively confirmed writable.",
      blocking: true,
    });
  }
  if (tab.removeOnly) {
    blockers.push({
      code: "remove-only-tab",
      message: "Remove-only stash tabs cannot be sorted.",
      blocking: true,
    });
  }
  if (tab.special) {
    blockers.push({
      code: "special-tab",
      message: "This special stash tab layout is not supported by the grid sorter.",
      blocking: true,
    });
  }
  return blockers;
}

function validateItems(
  tab: SortTabDescriptor,
  items: SortableStashItem[],
  observedOccupied: SortCell[],
): SortScanIssue[] {
  const issues: SortScanIssue[] = [];
  const claimed = new Map<string, string>();
  const ids = new Set<string>();
  const observed = new Set(observedOccupied.map(key));
  const expectedScale = tab.kind === "quad" ? 2 : 1;

  for (const item of items) {
    if (!item.id.trim() || ids.has(item.id)) {
      issues.push({
        code: "duplicate-item-id",
        message: `Scanned item identity is missing or duplicated: ${item.id || "(empty)"}.`,
        itemId: item.id,
        blocking: true,
      });
    }
    ids.add(item.id);
    if (!validBaseType(item.baseType)) {
      issues.push({
        code: "unknown-base-type",
        message: "Clipboard parsing did not yield an exact base type.",
        itemId: item.id,
        blocking: true,
      });
    }
    if (!item.itemClass.trim() || normalize(item.itemClass) === "unknown") {
      issues.push({
        code: "unknown-item-class",
        message: "Clipboard parsing did not yield a trustworthy item class.",
        itemId: item.id,
        blocking: true,
      });
    }
    if (!legalBagSize(item.bagW, item.bagH)) {
      issues.push({
        code: "unknown-footprint",
        message: `No legal positively identified inventory footprint is available for ${item.baseType}.`,
        itemId: item.id,
        blocking: true,
      });
    }
    if (item.w !== item.bagW * expectedScale || item.h !== item.bagH * expectedScale) {
      issues.push({
        code: "stash-footprint-scale-mismatch",
        message: `${item.baseType} has an inconsistent ${item.w}×${item.h} stash footprint for this tab.`,
        itemId: item.id,
        blocking: true,
      });
    }
    if (!["measured-base", "fixed-class"].includes(item.footprintSource) || item.confidence < 0.9) {
      issues.push({
        code: "untrusted-footprint",
        message: `${item.baseType} does not have a high-confidence measured or fixed footprint.`,
        itemId: item.id,
        blocking: true,
      });
    }
    const cells = rectCells(item.source, item.w, item.h);
    if (!cells.every((cell) => inside(cell, tab.cols, tab.rows))) {
      issues.push({
        code: "source-outside-grid",
        message: `${item.baseType} extends outside the active stash grid.`,
        itemId: item.id,
        cells,
        blocking: true,
      });
      continue;
    }
    for (const cell of cells) {
      const cellKey = key(cell);
      const prior = claimed.get(cellKey);
      if (prior && prior !== item.id) {
        issues.push({
          code: "overlapping-source-footprints",
          message: `Scanned source footprints overlap at ${cellKey}.`,
          itemId: item.id,
          cells: [cell],
          blocking: true,
        });
      }
      claimed.set(cellKey, item.id);
      if (!observed.has(cellKey)) {
        issues.push({
          code: "source-footprint-not-occupied",
          message: `${item.baseType} has a source cell that perception did not verify occupied.`,
          itemId: item.id,
          cells: [cell],
          blocking: true,
        });
      }
    }
  }

  const unknown = observedOccupied.filter((cell) => !claimed.has(key(cell)));
  if (unknown.length > 0) {
    issues.push({
      code: "unidentified-occupied-cells",
      message: `${unknown.length} occupied stash cell(s) are not covered by a positively identified item footprint.`,
      cells: unknown,
      blocking: true,
    });
  }
  return issues;
}

function groupItems(items: SortableStashItem[]): GroupBucket[] {
  const groups = new Map<string, GroupBucket>();
  for (const item of items) {
    const groupKey = `${normalize(item.itemClass)}\u0000${normalize(item.baseType)}`;
    const current = groups.get(groupKey) ?? {
      key: groupKey,
      itemClass: item.itemClass.trim(),
      baseType: item.baseType.trim(),
      items: [],
    };
    current.items.push(item);
    groups.set(groupKey, current);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      items: [...group.items].sort(
        (a, b) =>
          a.source.row - b.source.row ||
          a.source.col - b.source.col ||
          a.fingerprint.localeCompare(b.fingerprint) ||
          a.id.localeCompare(b.id),
      ),
    }))
    .sort(
      (a, b) =>
        compareText(a.itemClass, b.itemClass) ||
        compareText(a.baseType, b.baseType) ||
        a.key.localeCompare(b.key),
    );
}

function layoutsFor(group: GroupBucket, cols: number, rows: number): GroupLayout[] {
  const first = group.items[0];
  if (!first) return [];
  if (group.items.some((item) => item.w !== first.w || item.h !== first.h)) return [];
  const count = group.items.length;
  const targetWidth = Math.sqrt(count * first.w * first.h * 1.6);
  const layouts: GroupLayout[] = [];
  for (let across = 1; across <= Math.min(count, Math.floor(cols / first.w)); across += 1) {
    const down = Math.ceil(count / across);
    const width = across * first.w;
    const height = down * first.h;
    if (height > rows) continue;
    layouts.push({
      across,
      width,
      height,
      padding: width * height - count * first.w * first.h,
      shapePenalty: Math.abs(width - targetWidth) + Math.max(0, height - width) * 0.25,
    });
  }
  return layouts.sort(
    (a, b) =>
      a.padding - b.padding ||
      a.shapePenalty - b.shapePenalty ||
      b.across - a.across ||
      a.height - b.height,
  );
}

function itemTargets(group: GroupBucket, layout: GroupLayout, row: number, col: number): SortCell[] {
  const first = group.items[0]!;
  return group.items.map((_item, index) => ({
    row: row + Math.floor(index / layout.across) * first.h,
    col: col + (index % layout.across) * first.w,
  }));
}

function canReserve(
  taken: Set<string>,
  group: GroupBucket,
  layout: GroupLayout,
  row: number,
  col: number,
  reservePadding: boolean,
): boolean {
  const cells = reservePadding
    ? rectCells({ row, col }, layout.width, layout.height)
    : itemTargets(group, layout, row, col).flatMap((target, index) =>
        rectCells(target, group.items[index]!.w, group.items[index]!.h),
      );
  return cells.every((cell) => !taken.has(key(cell)));
}

function reservedCells(packed: PackedGroup, reservePadding: boolean): SortCell[] {
  if (reservePadding) {
    return rectCells({ row: packed.row, col: packed.col }, packed.layout.width, packed.layout.height);
  }
  return packed.targets.flatMap((target, index) => {
    const item = packed.group.items[index]!;
    return rectCells(target, item.w, item.h);
  });
}

function packGroups(
  groups: GroupBucket[],
  cols: number,
  rows: number,
  reservePadding: boolean,
  initialTaken: Set<string> = new Set(),
): PackedGroup[] | undefined {
  const layoutMap = new Map(groups.map((group) => [group.key, layoutsFor(group, cols, rows)]));
  if ([...layoutMap.values()].some((layouts) => layouts.length === 0)) return undefined;
  let nodes = 0;

  const visit = (index: number, taken: Set<string>, packed: PackedGroup[]): PackedGroup[] | undefined => {
    if (index >= groups.length) return packed;
    if (nodes >= MAX_PACKING_NODES) return undefined;
    const group = groups[index]!;
    const candidates: Array<PackedGroup & { score: number }> = [];
    for (const layout of layoutMap.get(group.key) ?? []) {
      for (let row = 0; row <= rows - layout.height; row += 1) {
        for (let col = 0; col <= cols - layout.width; col += 1) {
          if (!canReserve(taken, group, layout, row, col, reservePadding)) continue;
          const targets = itemTargets(group, layout, row, col);
          const score =
            (row + layout.height) * cols * 10 +
            (col + layout.width) * 4 +
            row * cols +
            col +
            layout.padding * 2 +
            layout.shapePenalty;
          candidates.push({ group, row, col, layout, targets, score });
        }
      }
    }
    candidates.sort(
      (a, b) =>
        a.score - b.score ||
        a.row - b.row ||
        a.col - b.col ||
        a.layout.width - b.layout.width,
    );
    for (const candidate of candidates.slice(0, MAX_CANDIDATES_PER_GROUP)) {
      nodes += 1;
      const nextTaken = new Set(taken);
      for (const cell of reservedCells(candidate, reservePadding)) nextTaken.add(key(cell));
      const result = visit(index + 1, nextTaken, [...packed, candidate]);
      if (result) return result;
      if (nodes >= MAX_PACKING_NODES) break;
    }
    return undefined;
  };

  return visit(0, new Set(initialTaken), []);
}

function inconsistentGroupIssues(groups: GroupBucket[]): SortScanIssue[] {
  return groups.flatMap((group) => {
    const first = group.items[0];
    if (!first || group.items.every((item) => item.w === first.w && item.h === first.h)) return [];
    return [{
      code: "inconsistent-base-footprint",
      message: `${group.baseType} was observed with conflicting footprints.`,
      blocking: true,
    }];
  });
}

function emptyDiagnostics(tab: SortTabDescriptor, items: SortableStashItem[], occupied: SortCell[]): SortPlanDiagnostics {
  const itemCells = items.reduce((sum, item) => sum + item.w * item.h, 0);
  return {
    capacityCells: Math.max(0, tab.cols * tab.rows),
    itemCells,
    occupiedCells: occupied.length,
    freeCells: Math.max(0, tab.cols * tab.rows - occupied.length),
    groupCount: 0,
    moveCount: 0,
    plannedRows: 0,
    plannedCols: 0,
    compactness: 0,
    qualityScore: 0,
    groupPaddingReserved: false,
  };
}

export function planStashSort(request: SortPlanRequest): StashSortPlan {
  const generatedAt = request.generatedAt ?? new Date().toISOString();
  const observedOccupied =
    request.observedOccupied ??
    request.items.flatMap((item) => rectCells(item.source, item.w, item.h));
  const blockers = [
    ...tabBlockers(request.tab),
    ...validateItems(request.tab, request.items, observedOccupied),
    ...(request.scanIssues ?? []).filter((issue) => issue.blocking),
  ];
  const warnings = (request.scanIssues ?? []).filter((issue) => !issue.blocking);
  const groups = groupItems(request.items);
  blockers.push(...inconsistentGroupIssues(groups));
  const snapshotHash = stableSnapshotHash(request.tab, request.items, observedOccupied);
  let diagnostics = emptyDiagnostics(request.tab, request.items, observedOccupied);
  let placements: SortPlacement[] = [];
  let planGroups: SortGroup[] = [];
  let paddingReserved = true;

  const sourceCells = new Set(
    request.items.flatMap((item) => rectCells(item.source, item.w, item.h)).map(key),
  );
  const immutableCells = new Set(
    observedOccupied.filter((cell) => !sourceCells.has(key(cell))).map(key),
  );
  const previewOnlyCodes = new Set([
    "tab-not-writable",
    "remove-only-tab",
    "special-tab",
    "unidentified-occupied-cells",
    ...(request.scanIssues ?? []).map((issue) => issue.code),
  ]);
  const structurallyUnsafe = blockers.some((blocker) => !previewOnlyCodes.has(blocker.code));

  if (!structurallyUnsafe) {
    let packed = packGroups(groups, request.tab.cols, request.tab.rows, true, immutableCells);
    if (!packed) {
      paddingReserved = false;
      packed = packGroups(groups, request.tab.cols, request.tab.rows, false, immutableCells);
    }
    if (!packed) {
      blockers.push({
        code: "insufficient-stash-capacity",
        message: "The identified items cannot be packed into non-overlapping legal placements in this grid.",
        blocking: true,
      });
    } else {
      placements = packed.flatMap((packedGroup) =>
        packedGroup.group.items.map((item, index) => {
          const target = packedGroup.targets[index]!;
          return {
            ...item,
            target,
            groupKey: packedGroup.group.key,
            moved: target.row !== item.source.row || target.col !== item.source.col,
          };
        }),
      );
      planGroups = packed.map((packedGroup, colorIndex) => ({
        key: packedGroup.group.key,
        itemClass: packedGroup.group.itemClass,
        baseType: packedGroup.group.baseType,
        itemIds: packedGroup.group.items.map((item) => item.id),
        bounds: {
          row: packedGroup.row,
          col: packedGroup.col,
          w: packedGroup.layout.width,
          h: packedGroup.layout.height,
        },
        colorIndex,
      }));
      const targetCells = placements.flatMap((item) => rectCells(item.target, item.w, item.h));
      const plannedRows = targetCells.length ? Math.max(...targetCells.map((cell) => cell.row)) + 1 : 0;
      const plannedCols = targetCells.length ? Math.max(...targetCells.map((cell) => cell.col)) + 1 : 0;
      const boundingCells = Math.max(1, plannedRows * plannedCols);
      const itemCells = placements.reduce((sum, item) => sum + item.w * item.h, 0);
      const compactness = Number((itemCells / boundingCells).toFixed(3));
      const groupedTogether = planGroups.every((group) => {
        const groupCells = placements
          .filter((item) => item.groupKey === group.key)
          .flatMap((item) => rectCells(item.target, item.w, item.h));
        return cellsConnected(groupCells);
      });
      diagnostics = {
        capacityCells: request.tab.cols * request.tab.rows,
        itemCells,
        occupiedCells: observedOccupied.length,
        freeCells: request.tab.cols * request.tab.rows - observedOccupied.length,
        groupCount: planGroups.length,
        moveCount: placements.filter((item) => item.moved).length,
        plannedRows,
        plannedCols,
        compactness,
        qualityScore: Math.round(
          Math.max(0, Math.min(100, compactness * 80 + (groupedTogether ? 20 : 0))),
        ),
        groupPaddingReserved: paddingReserved,
      };
    }
  }

  const planId = `stash-sort-${hashText(
    `${snapshotHash};${placements.map((item) => `${item.id}@${key(item.target)}`).join(";")}`,
  )}`;
  return {
    id: planId,
    generatedAt,
    snapshotHash,
    tab: request.tab,
    placements,
    groups: planGroups,
    blockers,
    warnings,
    diagnostics,
    executable: blockers.length === 0,
  };
}

export function cellsConnected(cells: SortCell[]): boolean {
  if (cells.length === 0) return true;
  const remaining = new Set(cells.map(key));
  const queue = [cells[0]!];
  remaining.delete(key(cells[0]!));
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const [dr, dc] of [
      [0, 1],
      [1, 0],
      [0, -1],
      [-1, 0],
    ] as const) {
      const next = { row: current.row + dr, col: current.col + dc };
      if (!remaining.delete(key(next))) continue;
      queue.push(next);
    }
  }
  return remaining.size === 0;
}

function occupancy(locations: LocatedItem[], area: SortMoveArea, exceptId?: string): Set<string> {
  const cells = new Set<string>();
  for (const located of locations) {
    if (located.area !== area || located.placement.id === exceptId) continue;
    const width = area === "stash" ? located.placement.w : located.placement.bagW;
    const height = area === "stash" ? located.placement.h : located.placement.bagH;
    for (const cell of rectCells(located.position, width, height)) cells.add(key(cell));
  }
  return cells;
}

function firstBagPlacement(
  bag: SortBagState,
  locations: LocatedItem[],
  item: SortPlacement,
): SortCell | undefined {
  const taken = new Set(bag.occupied.map(key));
  for (const cellKey of occupancy(locations, "bag")) taken.add(cellKey);
  for (let row = 0; row <= bag.rows - item.bagH; row += 1) {
    for (let col = 0; col <= bag.cols - item.bagW; col += 1) {
      const origin = { row, col };
      if (rectCells(origin, item.bagW, item.bagH).every((cell) => !taken.has(key(cell)))) {
        return origin;
      }
    }
  }
  return undefined;
}

function targetClear(locations: LocatedItem[], located: LocatedItem): boolean {
  const taken = occupancy(locations, "stash", located.placement.id);
  return rectCells(located.placement.target, located.placement.w, located.placement.h).every(
    (cell) => !taken.has(key(cell)),
  );
}

function atTarget(located: LocatedItem): boolean {
  return (
    located.area === "stash" &&
    located.position.row === located.placement.target.row &&
    located.position.col === located.placement.target.col
  );
}

function blockingWeight(candidate: LocatedItem, locations: LocatedItem[]): number {
  const source = new Set(
    rectCells(candidate.position, candidate.placement.w, candidate.placement.h).map(key),
  );
  return locations.reduce((score, located) => {
    if (located.placement.id === candidate.placement.id || atTarget(located)) return score;
    const overlap = rectCells(
      located.placement.target,
      located.placement.w,
      located.placement.h,
    ).filter((cell) => source.has(key(cell))).length;
    return score + overlap;
  }, 0);
}

export function buildSortMoveSchedule(
  plan: StashSortPlan,
  bag: SortBagState,
): SortMoveSchedule {
  if (!plan.executable) {
    return {
      ok: false,
      reason: plan.blockers[0]?.code ?? "plan-not-executable",
      steps: [],
      peakStagedItems: 0,
      peakStagedCells: 0,
    };
  }
  if (
    bag.cols <= 0 ||
    bag.rows <= 0 ||
    bag.occupied.some((cell) => !inside(cell, bag.cols, bag.rows))
  ) {
    return {
      ok: false,
      reason: "invalid-bag-state",
      steps: [],
      peakStagedItems: 0,
      peakStagedCells: 0,
    };
  }

  const locations: LocatedItem[] = plan.placements.map((placement) => ({
    placement,
    area: "stash",
    position: { ...placement.source },
  }));
  const steps: SortMoveStep[] = [];
  let peakStagedItems = 0;
  let peakStagedCells = 0;
  const maxSteps = plan.placements.length * 2 + 1;

  const addStep = (
    located: LocatedItem,
    kind: SortMoveKind,
    toArea: SortMoveArea,
    to: SortCell,
  ) => {
    const fromArea = located.area;
    const from = { ...located.position };
    const fromW = fromArea === "stash" ? located.placement.w : located.placement.bagW;
    const fromH = fromArea === "stash" ? located.placement.h : located.placement.bagH;
    const toW = toArea === "stash" ? located.placement.w : located.placement.bagW;
    const toH = toArea === "stash" ? located.placement.h : located.placement.bagH;
    steps.push({
      index: steps.length,
      itemId: located.placement.id,
      kind,
      fromArea,
      toArea,
      from,
      to: { ...to },
      fromW,
      fromH,
      toW,
      toH,
    });
    located.area = toArea;
    located.position = { ...to };
    const staged = locations.filter((item) => item.area === "bag");
    peakStagedItems = Math.max(peakStagedItems, staged.length);
    peakStagedCells = Math.max(
      peakStagedCells,
      staged.reduce((sum, item) => sum + item.placement.bagW * item.placement.bagH, 0),
    );
  };

  while (locations.some((located) => !atTarget(located))) {
    if (steps.length >= maxSteps) {
      return { ok: false, reason: "move-schedule-did-not-converge", steps, peakStagedItems, peakStagedCells };
    }

    const stagedReady = locations
      .filter((located) => located.area === "bag" && targetClear(locations, located))
      .sort((a, b) => a.placement.target.row - b.placement.target.row || a.placement.target.col - b.placement.target.col)[0];
    if (stagedReady) {
      addStep(stagedReady, "bag-to-stash", "stash", stagedReady.placement.target);
      continue;
    }

    const directReady = locations
      .filter((located) => located.area === "stash" && !atTarget(located) && targetClear(locations, located))
      .sort(
        (a, b) =>
          a.placement.target.row - b.placement.target.row ||
          a.placement.target.col - b.placement.target.col ||
          a.placement.id.localeCompare(b.placement.id),
      )[0];
    if (directReady) {
      addStep(directReady, "stash-to-stash", "stash", directReady.placement.target);
      continue;
    }

    const stagingCandidates = locations
      .filter((located) => located.area === "stash" && !atTarget(located))
      .sort(
        (a, b) =>
          blockingWeight(b, locations) - blockingWeight(a, locations) ||
          b.placement.bagW * b.placement.bagH - a.placement.bagW * a.placement.bagH ||
          a.placement.source.row - b.placement.source.row ||
          a.placement.source.col - b.placement.source.col ||
          a.placement.id.localeCompare(b.placement.id),
      );
    let staged = false;
    for (const candidate of stagingCandidates) {
      const destination = firstBagPlacement(bag, locations, candidate.placement);
      if (!destination) continue;
      addStep(candidate, "stash-to-bag", "bag", destination);
      staged = true;
      break;
    }
    if (!staged) {
      return {
        ok: false,
        reason: "insufficient-bag-staging-capacity",
        steps,
        peakStagedItems,
        peakStagedCells,
      };
    }
  }

  return {
    ok: true,
    reason: steps.length === 0 ? "already-sorted" : "ok",
    steps,
    peakStagedItems,
    peakStagedCells,
  };
}

export function sortRectCells(origin: SortCell, w: number, h: number): SortCell[] {
  return rectCells(origin, w, h);
}
