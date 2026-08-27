import {
  occupiedFromRgbScores,
  scoreGridCellsRgb,
  type BgrImage,
  type CellSampleResult,
} from "./cellOccupancy.js";
import {
  activeStashGrid,
  toScreenBox,
  type CalibrationProfile,
  type ClientBox,
  type GridMark,
} from "./calibrationProfile.js";
import { stashItems, type StashItem } from "./bagPack.js";
import { cellLooksOccupied, scoreGridCells, type CellScore } from "./itemSprites.js";
import type { GrayImage } from "./grayImage.js";
import type { ScreenRect } from "./screenLayout.js";
import type { OccupiedCell, UiFacts } from "./uiPerception.js";

export type DiagnosticGrid = "stash" | "bag";
export type DiagnosticCorrectionKind = "missed-item" | "false-occupied" | "wrong-footprint";

export interface DiagnosticCorrection {
  kind: DiagnosticCorrectionKind;
  grid: DiagnosticGrid;
  row: number;
  col: number;
  w?: number;
  h?: number;
  note?: string;
  createdAt: string;
}

export interface DiagnosticCell {
  grid: DiagnosticGrid;
  row: number;
  col: number;
  box: ClientBox;
  gray: CellScore;
  rgb?: CellSampleResult;
  grayOccupied: boolean;
  rgbOccupied?: boolean;
  disagreement: boolean;
  correction?: DiagnosticCorrectionKind;
}

export interface DiagnosticFootprint {
  grid: DiagnosticGrid;
  id: string;
  row: number;
  col: number;
  w: number;
  h: number;
  box: ClientBox;
  anchor: { x: number; y: number };
}

export interface TransferDiagnosticReport {
  generatedAt: string;
  client: ScreenRect;
  facts: UiFacts;
  cells: DiagnosticCell[];
  footprints: DiagnosticFootprint[];
  clickAnchors: Array<{ grid: DiagnosticGrid; itemId: string; x: number; y: number }>;
  searchBox?: ClientBox;
  corrections: DiagnosticCorrection[];
}

interface BuildDiagnosticArgs {
  gray: GrayImage;
  bgr?: BgrImage;
  client: ScreenRect;
  profile: CalibrationProfile;
  facts: UiFacts;
  corrections?: DiagnosticCorrection[];
}

function key(row: number, col: number): string {
  return `${row},${col}`;
}

function cellBox(grid: GridMark, row: number, col: number): ClientBox {
  const w = grid.w / grid.cols;
  const h = grid.h / grid.rows;
  return {
    x: grid.x + col * w,
    y: grid.y + row * h,
    w,
    h,
  };
}

function footprintBox(grid: GridMark, item: StashItem): ClientBox {
  const minRow = Math.min(...item.cells.map((cell) => cell.row), item.grab.row);
  const minCol = Math.min(...item.cells.map((cell) => cell.col), item.grab.col);
  const first = cellBox(grid, minRow, minCol);
  return {
    x: first.x,
    y: first.y,
    w: (grid.w / grid.cols) * item.w,
    h: (grid.h / grid.rows) * item.h,
  };
}

function correctedKind(
  corrections: DiagnosticCorrection[],
  grid: DiagnosticGrid,
  row: number,
  col: number,
): DiagnosticCorrectionKind | undefined {
  for (let index = corrections.length - 1; index >= 0; index -= 1) {
    const entry = corrections[index]!;
    if (entry.grid === grid && entry.row === row && entry.col === col) return entry.kind;
  }
  return undefined;
}

function gridDiagnostics(
  args: BuildDiagnosticArgs,
  gridId: DiagnosticGrid,
  grid: GridMark,
): DiagnosticCell[] {
  const screenGrid = toScreenBox(args.client, grid);
  const grayScores = scoreGridCells(args.gray, args.client, screenGrid, grid.cols, grid.rows);
  const rgbScores = args.bgr
    ? scoreGridCellsRgb(args.bgr, args.client, screenGrid, grid.cols, grid.rows)
    : [];
  const rgbByCell = new Map(rgbScores.map((score) => [key(score.row, score.col), score]));
  const rgbOccupied = new Set(occupiedFromRgbScores(rgbScores).map((cell) => key(cell.row, cell.col)));
  const corrections = args.corrections ?? [];
  return grayScores.map((gray) => {
    const rgb = rgbByCell.get(key(gray.row, gray.col))?.result;
    const grayOccupied = cellLooksOccupied(gray);
    const isRgbOccupied = rgb ? rgbOccupied.has(key(gray.row, gray.col)) : undefined;
    return {
      grid: gridId,
      row: gray.row,
      col: gray.col,
      box: cellBox(grid, gray.row, gray.col),
      gray,
      rgb,
      grayOccupied,
      rgbOccupied: isRgbOccupied,
      disagreement: isRgbOccupied != null && grayOccupied !== isRgbOccupied,
      correction: correctedKind(corrections, gridId, gray.row, gray.col),
    };
  });
}

function diagnosticFootprints(
  gridId: DiagnosticGrid,
  grid: GridMark,
  items: StashItem[],
): DiagnosticFootprint[] {
  return items.map((item) => ({
    grid: gridId,
    id: item.id,
    row: Math.min(...item.cells.map((cell) => cell.row), item.grab.row),
    col: Math.min(...item.cells.map((cell) => cell.col), item.grab.col),
    w: item.w,
    h: item.h,
    box: footprintBox(grid, item),
    anchor: { x: item.grab.x, y: item.grab.y },
  }));
}

export function buildTransferDiagnostic(args: BuildDiagnosticArgs): TransferDiagnosticReport {
  const stashGrid = activeStashGrid(args.profile);
  const bagGrid = args.profile.bagGrid;
  const correctedFacts = applyDiagnosticCorrections(
    args.facts,
    args.corrections ?? [],
    args.profile,
    args.client,
  );
  const cells = [
    ...(stashGrid ? gridDiagnostics(args, "stash", stashGrid) : []),
    ...(bagGrid ? gridDiagnostics(args, "bag", bagGrid) : []),
  ];
  const stash = stashGrid ? diagnosticFootprints("stash", stashGrid, correctedFacts.stashItems) : [];
  const bagItems = bagGrid ? stashItems(correctedFacts.occupiedBag, 12) : [];
  const bag = bagGrid ? diagnosticFootprints("bag", bagGrid, bagItems) : [];
  const footprints = [...stash, ...bag];
  return {
    generatedAt: new Date().toISOString(),
    client: args.client,
    facts: correctedFacts,
    cells,
    footprints,
    clickAnchors: footprints.map((item) => ({
      grid: item.grid,
      itemId: item.id,
      x: item.anchor.x,
      y: item.anchor.y,
    })),
    searchBox: args.profile.stashSearch,
    corrections: [...(args.corrections ?? [])],
  };
}

function correctedCells(
  occupied: OccupiedCell[],
  corrections: DiagnosticCorrection[],
  gridId: DiagnosticGrid,
  grid: GridMark | undefined,
  client: ScreenRect,
  existingItems: StashItem[],
): OccupiedCell[] {
  if (!grid) return [...occupied];
  const byKey = new Map(occupied.map((cell) => [key(cell.row, cell.col), { ...cell }]));
  for (const correction of corrections.filter((entry) => entry.grid === gridId)) {
    const w = Math.max(1, correction.w ?? 1);
    const h = Math.max(1, correction.h ?? 1);
    if (correction.kind === "false-occupied") {
      byKey.delete(key(correction.row, correction.col));
      continue;
    }
    if (correction.kind === "wrong-footprint") {
      const existing = existingItems.find((item) =>
        item.cells.some((cell) => cell.row === correction.row && cell.col === correction.col),
      );
      for (const cell of existing?.cells ?? []) byKey.delete(key(cell.row, cell.col));
    }
    for (let row = correction.row; row < Math.min(grid.rows, correction.row + h); row += 1) {
      for (let col = correction.col; col < Math.min(grid.cols, correction.col + w); col += 1) {
        const box = cellBox(grid, row, col);
        byKey.set(key(row, col), {
          row,
          col,
          x: Math.round(client.left + box.x + box.w / 2),
          y: Math.round(client.top + box.y + box.h / 2),
          bag: gridId,
        });
      }
    }
  }
  return [...byKey.values()].sort((a, b) => a.row - b.row || a.col - b.col);
}

export function applyDiagnosticCorrections(
  facts: UiFacts,
  corrections: DiagnosticCorrection[],
  profile: CalibrationProfile,
  client: ScreenRect,
): UiFacts {
  if (corrections.length === 0) return facts;
  const stashGrid = activeStashGrid(profile);
  const occupiedStash = correctedCells(
    facts.occupiedStash,
    corrections,
    "stash",
    stashGrid,
    client,
    facts.stashItems,
  );
  const occupiedBag = correctedCells(
    facts.occupiedBag,
    corrections,
    "bag",
    profile.bagGrid,
    client,
    stashItems(facts.occupiedBag, 12),
  );
  return {
    ...facts,
    occupiedStash,
    occupiedBag,
    stashItems: stashItems(occupiedStash, stashGrid?.cols ?? 12),
    bagEmpty: facts.inventoryPanelOpen && occupiedBag.length === 0,
  };
}
