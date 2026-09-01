import { crop, downsample, meanVariance, ncc, regionStats, type GrayImage } from "./grayImage.js";
import type { ScreenRect } from "./screenLayout.js";
import {
  GRID_LAYOUT_NCC,
  GRID_NCC,
  matchChrome,
  matchGridLayout,
  matchGridRim,
  profileHasGrids,
  resolveStashGrids,
  toScreenBox,
  type CalibrationProfile,
  type ClientBox,
  type GridMark,
  type ResolvedStashGrids,
  type StashTabKind,
} from "./calibrationProfile.js";
import { detectSpriteItems, occupiedFromScores, scoreGridCells } from "./itemSprites.js";
import { locateStashNameplate, NAMEPLATE_NCC, pickStashNameplate } from "./nameplates.js";
import type { StashItem } from "./bagPack.js";
import {
  occupiedFromRgbScores,
  scoreGridCellsRgb,
  type BgrImage,
} from "./cellOccupancy.js";

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OccupiedCell {
  row: number;
  col: number;
  x: number;
  y: number;
  bag?: string;
}

export interface PerceptionScores {
  sceneOpen: number;
  sceneClosed: number;
  stashPanel: number;
  inventoryPanel: number;
  chest: number;
  options: number;
  stashGrid: boolean;
  inventoryGrid: boolean;
}

export interface UiFacts {
  optionsOpen: boolean;
  loading: boolean;
  stashPanelOpen: boolean;
  inventoryPanelOpen: boolean;
  vendorPanelOpen: boolean;
  stashChestVisible: boolean;
  chest?: BBox;
  inventoryRegion?: BBox;
  vendorRegion?: BBox;
  stashRegion?: BBox;
  occupiedBag: OccupiedCell[];
  occupiedStash: OccupiedCell[];
  stashItems: StashItem[];
  stashGridSize?: { cols: number; rows: number };
  bagEmpty: boolean;
  confidence: number;
  reason: string;
  scores: PerceptionScores;
}

export interface PerceptionTemplates {
  options?: GrayImage;
  sceneOpen?: GrayImage;
  sceneClosed?: GrayImage;
  stashPanel?: GrayImage;
  inventoryPanel?: GrayImage;
  chest?: GrayImage;
  emptyCell?: GrayImage;
}

export const INV_UV = { x: 0.655, y: 0.36, w: 0.3, h: 0.5 };
export const STASH_UV = { x: 0.05, y: 0.16, w: 0.46, h: 0.7 };

const OPTIONS_NCC = 0.55;
const PANEL_NCC = 0.62;
const SCENE_NCC = 0.7;
const CHEST_NCC = 0.6;
const EMPTY_CELL_NCC = 0.72;

export function perceiveUi(
  frame: GrayImage,
  client: ScreenRect,
  templates: PerceptionTemplates = {},
  profile?: CalibrationProfile,
  bgr?: BgrImage,
): UiFacts {
  if (profile && (profileHasGrids(profile) || profile.npcs.length)) {
    return lookCalibrated(frame, client, profile, bgr);
  }
  const view = downsample(frame, 160, 90);
  const left = crop(view, 6, 14, 46, 64);
  const right = crop(view, 102, 30, 50, 50);
  const center = crop(view, 54, 22, 52, 46);
  const leftStats = meanVariance(left);
  const rightStats = meanVariance(right);
  const centerStats = meanVariance(center);

  const scores: PerceptionScores = {
    sceneOpen: templates.sceneOpen ? nccFit(view, templates.sceneOpen) : -1,
    sceneClosed: templates.sceneClosed ? nccFit(view, templates.sceneClosed) : -1,
    stashPanel: templates.stashPanel ? nccFit(left, templates.stashPanel) : -1,
    inventoryPanel: templates.inventoryPanel ? nccFit(right, templates.inventoryPanel) : -1,
    chest: -1,
    options: templates.options ? nccFit(view, templates.options) : -1,
    stashGrid: hasRegularCellGrid(frame, STASH_UV, 12, 8),
    inventoryGrid: hasRegularCellGrid(frame, INV_UV, 12, 5),
  };

  let optionsOpen =
    centerStats.mean > 40 &&
    centerStats.variance > 400 &&
    leftStats.variance < 180 &&
    rightStats.variance < 180;
  if (templates.options) optionsOpen = scores.options >= OPTIONS_NCC;

  const sceneLooksOpen =
    scores.sceneOpen >= SCENE_NCC &&
    (scores.sceneClosed < 0 || scores.sceneOpen >= scores.sceneClosed + 0.04);

  const stashProven = (sceneLooksOpen || scores.stashPanel >= PANEL_NCC) && scores.stashGrid;
  const inventoryProven = (sceneLooksOpen || scores.inventoryPanel >= PANEL_NCC) && scores.inventoryGrid;

  const stashPanelOpen = stashProven;
  const inventoryPanelOpen = inventoryProven;

  let chest: BBox | undefined;
  let stashChestVisible = false;
  if (templates.chest && !stashPanelOpen && !optionsOpen) {
    const match = scanNcc(view, templates.chest);
    scores.chest = match.score;
    stashChestVisible = match.score >= CHEST_NCC;
    if (stashChestVisible) {
      chest = scaleBox(
        { x: match.x, y: match.y, w: templates.chest.width, h: templates.chest.height },
        view,
        client,
      );
    }
  }

  const inventoryRegion = uvBox(client, INV_UV);
  const stashRegion = uvBox(client, STASH_UV);

  const occupiedBag = inventoryPanelOpen
    ? bgr
      ? occupiedFromRgbScores(scoreGridCellsRgb(bgr, client, inventoryRegion, 12, 5))
      : detectOccupiedCells(frame, client, inventoryRegion, templates.emptyCell)
    : [];

  let confidence = 0.2;
  if (optionsOpen) confidence = 0.9;
  else if (stashPanelOpen && inventoryPanelOpen) confidence = 0.9;
  else if (stashChestVisible) confidence = 0.75;
  else if (stashPanelOpen || inventoryPanelOpen) confidence = 0.55;

  let reason = "world-or-unknown";
  if (optionsOpen) reason = "options-open";
  else if (stashPanelOpen && inventoryPanelOpen) reason = "stash-and-bag-open";
  else if (stashPanelOpen) reason = "stash-open-bag-closed";
  else if (inventoryPanelOpen) reason = "bag-open-stash-closed";
  else if (stashChestVisible) reason = "chest-visible";
  else if (!hasAnyPanelTemplate(templates)) reason = "needs-calibration";

  return {
    optionsOpen,
    loading: false,
    stashPanelOpen,
    inventoryPanelOpen,
    vendorPanelOpen: false,
    stashChestVisible,
    chest,
    inventoryRegion: inventoryPanelOpen ? inventoryRegion : undefined,
    stashRegion: stashPanelOpen ? stashRegion : undefined,
    occupiedBag,
    occupiedStash: [],
    stashItems: [],
    bagEmpty: inventoryPanelOpen && occupiedBag.length === 0,
    confidence,
    reason,
    scores,
  };
}

export function lookCalibrated(
  frame: GrayImage,
  client: ScreenRect,
  profile: CalibrationProfile,
  bgr?: BgrImage,
): UiFacts {
  const bagDirect = gridLooksOpen(frame, client, profile.bagGrid);
  const stashGrids = resolveStashGrids(profile);
  const stashGrid = chooseOpenStashGrid(frame, client, profile, stashGrids);
  const stashPanelOpen = Boolean(stashGrid);
  // The game never shows the vendor and stash panels at once, and the vendor
  // box often overlaps the stash area, so an open stash wins the arbitration.
  const vendorOpen = !stashPanelOpen && gridLooksOpen(frame, client, profile.ventorBagGrid);
  const bagOpenRaw = bagDirect || bagOpenBesideStash(frame, client, profile, stashPanelOpen);
  const bagOpen =
    bagOpenRaw &&
    !(vendorOpen && profile.bagGrid && profile.ventorBagGrid && boxesOverlap(profile.bagGrid, profile.ventorBagGrid));
  const stashScore = stashGrid ? 1 : 0;
  const npc = profile.npcs[0];
  const nameplate = locateStashNameplate(frame, npc) ?? pickStashNameplate(frame);
  const npcScore = nameplate?.score ?? -1;
  const inventoryPanelOpen = bagOpen;
  const vendorPanelOpen = vendorOpen;
  const stashChestVisible = !stashPanelOpen && !vendorPanelOpen && Boolean(nameplate);
  const inventoryRegion = inventoryPanelOpen && profile.bagGrid ? toScreenBox(client, profile.bagGrid) : undefined;
  const vendorRegion = vendorPanelOpen && profile.ventorBagGrid ? toScreenBox(client, profile.ventorBagGrid) : undefined;
  const stashRegion = stashPanelOpen && stashGrid ? toScreenBox(client, stashGrid) : undefined;
  const occupiedBag =
    bagOpen && inventoryRegion
      ? bgr
        ? occupiedFromRgbScores(scoreGridCellsRgb(bgr, client, inventoryRegion, 12, 5))
        : occupiedFromScores(scoreGridCells(frame, client, inventoryRegion, 12, 5))
      : occupiedInGrid(frame, client, bagOpen ? profile.bagGrid : undefined, "bag", bagOpen);
  const stashItems =
    stashPanelOpen && stashRegion && stashGrid
      ? detectSpriteItems(frame, client, stashRegion, stashGrid.cols, stashGrid.rows)
      : [];
  const occupiedStash: OccupiedCell[] = stashItems.flatMap((item) =>
    item.cells.map((cell) => {
      const scored = cell as Partial<OccupiedCell>;
      return {
        row: cell.row,
        col: cell.col,
        x: scored.x ?? item.grab.x,
        y: scored.y ?? item.grab.y,
        bag: "stash",
      };
    }),
  );
  let reason = "world-or-unknown";
  if (stashPanelOpen && inventoryPanelOpen) reason = "stash-and-bag-open";
  else if (vendorPanelOpen && inventoryPanelOpen) reason = "vendor-and-bag-open";
  else if (stashPanelOpen && vendorPanelOpen) reason = "stash-and-vendor-open";
  else if (stashPanelOpen) reason = "stash-open-bag-closed";
  else if (inventoryPanelOpen) reason = "bag-open-stash-closed";
  else if (vendorPanelOpen) reason = "vendor-open";
  else if (stashChestVisible) reason = "chest-visible";
  else if (!profileHasGrids(profile) && !profile.npcs.length) reason = "needs-calibration";
  return {
    optionsOpen: false,
    loading: false,
    stashPanelOpen,
    inventoryPanelOpen,
    vendorPanelOpen,
    stashChestVisible,
    chest:
      stashChestVisible && nameplate
        ? { x: client.left + nameplate.x, y: client.top + nameplate.y, w: nameplate.w, h: nameplate.h }
        : undefined,
    inventoryRegion,
    vendorRegion,
    stashRegion,
    occupiedBag,
    occupiedStash,
    stashItems,
    stashGridSize: stashGrid ? { cols: stashGrid.cols, rows: stashGrid.rows } : undefined,
    bagEmpty: inventoryPanelOpen && occupiedBag.length === 0,
    confidence:
      stashPanelOpen && inventoryPanelOpen
        ? 0.95
        : vendorPanelOpen || stashChestVisible
          ? 0.8
          : stashPanelOpen || inventoryPanelOpen
            ? 0.7
            : 0.2,
    reason,
    scores: {
      sceneOpen: -1,
      sceneClosed: -1,
      stashPanel: stashScore,
      inventoryPanel: bagOpen ? 1 : 0,
      chest: npcScore,
      options: -1,
      stashGrid: Boolean(stashGrid),
      inventoryGrid: Boolean(profile.bagGrid),
    },
  };
}

function boxesOverlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const smaller = Math.min(a.w * a.h, b.w * b.h);
  return smaller > 0 && (x * y) / smaller > 0.45;
}

function occupiedInGrid(
  frame: GrayImage,
  client: ScreenRect,
  grid: GridMark | undefined,
  bag: string,
  assumeOpen = false,
): OccupiedCell[] {
  if (!grid || (!assumeOpen && !gridLooksOpen(frame, client, grid))) return [];
  return detectOccupiedCells(frame, client, toScreenBox(client, grid), undefined, grid.cols, grid.rows).map(
    (cell) => ({ ...cell, bag }),
  );
}

function bagOpenBesideStash(
  frame: GrayImage,
  client: ScreenRect,
  profile: CalibrationProfile,
  stashPanelOpen: boolean,
): boolean {
  const grid = profile.bagGrid;
  if (!stashPanelOpen || !grid?.patch) return false;
  const uv = {
    x: grid.x / client.width,
    y: grid.y / client.height,
    w: grid.w / client.width,
    h: grid.h / client.height,
  };
  return hasRegularCellGrid(frame, uv, grid.cols, grid.rows);
}

function gridLooksOpen(frame: GrayImage, client: ScreenRect, grid?: GridMark): boolean {
  if (!grid) return false;
  const uv = {
    x: grid.x / client.width,
    y: grid.y / client.height,
    w: grid.w / client.width,
    h: grid.h / client.height,
  };
  if (!grid.patch) return hasRegularCellGrid(frame, uv, grid.cols, grid.rows);
  const chrome = { box: grid, patch: grid.patch };
  const full = matchChrome(frame, client, chrome);
  const rim = matchGridRim(frame, client, chrome);
  const layout = matchGridLayout(frame, client, chrome);
  if (
    full >= GRID_NCC ||
    rim >= GRID_NCC ||
    layout >= GRID_LAYOUT_NCC ||
    (rim >= 0.5 && layout >= 0.14)
  ) {
    return true;
  }
  // Chrome matching fails when an overlay (tab dropdown, tooltip, selection
  // glow) sits near the panel border even though the grid itself is visible.
  return hasConsistentCellGrid(frame, uv, grid.cols, grid.rows);
}

function chooseOpenStashGrid(
  frame: GrayImage,
  client: ScreenRect,
  profile: CalibrationProfile,
  grids: ResolvedStashGrids,
): GridMark | undefined {
  const normalOpen = gridLooksOpen(frame, client, grids.normal);
  const quadOpen = gridLooksOpen(frame, client, grids.quad);
  if (grids.shared && grids.normal && grids.quad) {
    if (!normalOpen && !quadOpen) return undefined;
    const kind = pickSharedStashTab(frame, client, grids.normal, profile.activeStashTab);
    return kind === "quad" ? grids.quad : grids.normal;
  }
  if (profile.activeStashTab === "quad" && grids.quad && (quadOpen || normalOpen)) {
    return grids.quad;
  }
  if (quadOpen && !normalOpen) return grids.quad;
  if (normalOpen && !quadOpen) return grids.normal;
  if (quadOpen && normalOpen) {
    return profile.activeStashTab === "quad" ? grids.quad : grids.normal;
  }
  return undefined;
}

/** Shared panel: cell regularity and occupancy density pick 12×12 vs 24×24. */
export function pickSharedStashTab(
  frame: GrayImage,
  client: ScreenRect,
  box: ClientBox,
  hint?: StashTabKind,
): StashTabKind {
  const uv = {
    x: box.x / client.width,
    y: box.y / client.height,
    w: box.w / client.width,
    h: box.h / client.height,
  };
  const normalCells = hasRegularCellGrid(frame, uv, 12, 12);
  const quadCells = hasRegularCellGrid(frame, uv, 24, 24);
  if (normalCells !== quadCells) return quadCells ? "quad" : "normal";

  const region = toScreenBox(client, box);
  const items12 = detectSpriteItems(frame, client, region, 12, 12);
  const items24 = detectSpriteItems(frame, client, region, 24, 24);
  const odd24 = items24.some((item) => item.w % 2 === 1 || item.h % 2 === 1);
  const even24 = items24.length > 0 && items24.every((item) => item.w % 2 === 0 && item.h % 2 === 0);
  if (odd24 && !even24) return "quad";
  if (even24 && items12.length > 0) return "normal";
  if (items24.length > items12.length * 2 && odd24) return "quad";
  return hint === "quad" ? "quad" : "normal";
}

export function canActOnFacts(facts: UiFacts): boolean {
  return (
    !facts.optionsOpen &&
    !facts.loading &&
    facts.confidence >= 0.7 &&
    (facts.reason === "stash-and-bag-open" ||
      facts.reason === "chest-visible" ||
      facts.reason === "stash-open-bag-closed" ||
      facts.reason === "bag-open-stash-closed")
  );
}

function hasAnyPanelTemplate(templates: PerceptionTemplates): boolean {
  return Boolean(templates.sceneOpen || templates.stashPanel || templates.inventoryPanel || templates.chest);
}

function uvBox(client: ScreenRect, uv: { x: number; y: number; w: number; h: number }): BBox {
  return {
    x: Math.round(client.left + client.width * uv.x),
    y: Math.round(client.top + client.height * uv.y),
    w: Math.round(client.width * uv.w),
    h: Math.round(client.height * uv.h),
  };
}

function nccFit(haystack: GrayImage, needle: GrayImage): number {
  const scaled = downsample(needle, Math.min(needle.width, haystack.width), Math.min(needle.height, haystack.height));
  return ncc(haystack, scaled, 0, 0);
}

function scanNcc(haystack: GrayImage, needle: GrayImage): { x: number; y: number; score: number } {
  const nw = Math.min(needle.width, Math.max(8, Math.floor(haystack.width / 6)));
  const nh = Math.min(needle.height, Math.max(8, Math.floor(haystack.height / 6)));
  const scaled = downsample(needle, nw, nh);
  let best = { x: 0, y: 0, score: -1 };
  for (let y = 0; y <= haystack.height - scaled.height; y += 3) {
    for (let x = 0; x <= haystack.width - scaled.width; x += 3) {
      const score = ncc(haystack, scaled, x, y);
      if (score > best.score) best = { x, y, score };
    }
  }
  return best;
}

function scaleBox(box: BBox, from: GrayImage, client: ScreenRect): BBox {
  return {
    x: Math.round(client.left + (box.x / from.width) * client.width),
    y: Math.round(client.top + (box.y / from.height) * client.height),
    w: Math.round((box.w / from.width) * client.width),
    h: Math.round((box.h / from.height) * client.height),
  };
}

function cellGridSignals(
  frame: GrayImage,
  uv: { x: number; y: number; w: number; h: number },
  cols: number,
  rows: number,
): { lowVar: number; border: number; borderFraction: number } {
  const means: number[] = [];
  const borderSignals: number[] = [];
  const cellW = (uv.w * frame.width) / cols;
  const cellH = (uv.h * frame.height) / rows;
  const originX = uv.x * frame.width;
  const originY = uv.y * frame.height;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = originX + col * cellW;
      const y = originY + row * cellH;
      const fullStats = regionStats(frame, x, y, cellW, cellH);
      const insetStats = regionStats(frame, x + cellW * 0.2, y + cellH * 0.2, cellW * 0.6, cellH * 0.6);
      means.push(insetStats.mean);
      borderSignals.push(Math.abs(fullStats.mean - insetStats.mean) + Math.abs(fullStats.variance - insetStats.variance) * 0.05);
    }
  }
  const sorted = [...means].sort((a, b) => a - b);
  const lowN = Math.max(4, Math.floor(means.length * 0.35));
  const low = sorted.slice(0, lowN);
  return {
    lowVar: sampleVariance(low),
    border: average(borderSignals),
    borderFraction:
      borderSignals.length === 0
        ? 0
        : borderSignals.filter((signal) => signal > 2.5).length / borderSignals.length,
  };
}

/** Empty-ish cells should look alike, and cell borders should differ from interiors. */
export function hasRegularCellGrid(
  frame: GrayImage,
  uv: { x: number; y: number; w: number; h: number },
  cols: number,
  rows: number,
): boolean {
  const signals = cellGridSignals(frame, uv, cols, rows);
  return signals.lowVar < 320 && signals.border > 3.5;
}

/**
 * Stricter variant for overriding a failed chrome match: a real grid shows
 * border-vs-interior contrast in most individual cells, while world scenery
 * that merely averages out gets rejected.
 */
export function hasConsistentCellGrid(
  frame: GrayImage,
  uv: { x: number; y: number; w: number; h: number },
  cols: number,
  rows: number,
): boolean {
  const signals = cellGridSignals(frame, uv, cols, rows);
  return signals.lowVar < 320 && signals.border > 3.5 && signals.borderFraction >= 0.6;
}

function sampleVariance(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = average(values);
  return values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / values.length;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((acc, value) => acc + value, 0) / values.length;
}

export function detectOccupiedCells(
  frame: GrayImage,
  client: ScreenRect,
  inventory: BBox,
  emptyCell?: GrayImage,
  cols = 12,
  rows = 5,
): OccupiedCell[] {
  const occupied: OccupiedCell[] = [];
  const cellW = inventory.w / cols;
  const cellH = inventory.h / rows;
  const scaleX = frame.width / client.width;
  const scaleY = frame.height / client.height;
  const means: number[] = [];
  const cells: Array<{ row: number; col: number; x: number; y: number; mean: number; variance: number; emptyScore: number }> =
    [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = inventory.x + cellW * (col + 0.5);
      const y = inventory.y + cellH * (row + 0.5);
      const fx = (inventory.x - client.left + col * cellW) * scaleX;
      const fy = (inventory.y - client.top + row * cellH) * scaleY;
      const fw = cellW * scaleX;
      const fh = cellH * scaleY;
      const cell = crop(frame, fx + fw * 0.15, fy + fh * 0.15, fw * 0.7, fh * 0.7);
      const stats = meanVariance(cell);
      let emptyScore = -1;
      if (emptyCell) {
        const empty = downsample(emptyCell, cell.width, cell.height);
        emptyScore = ncc(cell, empty, 0, 0);
      }
      means.push(stats.mean);
      cells.push({ row, col, x: Math.round(x), y: Math.round(y), mean: stats.mean, variance: stats.variance, emptyScore });
    }
  }
  const sorted = [...means].sort((a, b) => a - b);
  const baseline = sorted[Math.floor(sorted.length * 0.3)] ?? 0;
  for (const cell of cells) {
    const vsEmpty = cell.emptyScore >= 0 ? cell.emptyScore < EMPTY_CELL_NCC : true;
    const vsBaseline = cell.mean > baseline + 28 || (cell.mean > baseline + 16 && cell.variance > 50);
    if (vsEmpty && vsBaseline) occupied.push({ row: cell.row, col: cell.col, x: cell.x, y: cell.y });
  }
  return occupied;
}
