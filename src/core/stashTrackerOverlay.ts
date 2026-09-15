/**
 * Stash tracker — the in-stash price overlay plan (package "stash-tracker").
 *
 * Turns the ledger's latest observations of ONE tab into labelled rectangles
 * over the calibrated stash grid. Pure geometry and text: the main process
 * hands the plan to a click-through label window, and nothing here touches
 * Electron, the game, or the network.
 *
 * Two traps this module exists to handle (memory `dump-sort-default.md`):
 *   1. Top-level tabs draw their grid ONE strip row higher than folder tabs
 *      (`TOP_LEVEL_GRID_DY`), so a folder calibration used verbatim on a
 *      top-level tab paints every label a row off.
 *   2. A taught `grid-calibration.json` entry is measured truth and always
 *      beats a computed default.
 *
 * Every number drawn is an ESTIMATE from the local price table / appraisal —
 * the grid caption says so, so a screenshot can never read as a price sheet.
 */
import {
  footprintsFromOccupied,
  overlayItemPixelRect,
  type DryRunOverlayPlan,
  type OverlayGrid,
  type OverlayItem,
} from "./dryRunOverlay.js";
import { BAG_CELLS, toScreenBox, stashGridForKind, type CalibrationProfile } from "./calibrationProfile.js";
import { TOP_LEVEL_GRID_DY } from "./gearSort.js";
import {
  describeAge,
  valueObservation,
  type InventoryObservation,
  type LocationStaleness,
  type ValuedObservation,
} from "./inventoryLedger.js";
import type { PriceTable } from "./priceTable.js";
import type { ScreenRect } from "./screenLayout.js";
import { formatExalted } from "./stashTrackerTimeline.js";

/** One taught grid in `artifacts/tab-admin/grid-calibration.json` (screen-absolute px). */
export interface TaughtGrid {
  x: number;
  y: number;
  w: number;
  h: number;
  cols: number;
  rows: number;
}

export type GridCalibrationFile = Record<string, TaughtGrid>;

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Junk, a missing file or a hand-edit that lost a field → no taught grids. */
export function parseGridCalibration(text: string | undefined): GridCalibrationFile {
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: GridCalibrationFile = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    const x = finite(entry.x);
    const y = finite(entry.y);
    const w = finite(entry.w);
    const h = finite(entry.h);
    const cols = finite(entry.cols);
    const rows = finite(entry.rows);
    if (x === undefined || y === undefined || !w || !h || !cols || !rows) continue;
    if (w <= 0 || h <= 0 || cols <= 0 || rows <= 0) continue;
    out[key] = { x, y, w, h, cols: Math.round(cols), rows: Math.round(rows) };
  }
  return out;
}

/** The sorter writes "Rings#0" for the first tab named "Rings"; "bag" stays "bag". */
export function gridCalibrationKey(tabKey: string): string {
  const key = String(tabKey ?? "").trim();
  if (!key) return "";
  if (key === "bag") return "bag";
  return key.includes("#") ? key : `${key}#0`;
}

/**
 * Top-level tabs are the "T band" the sorter names T1…T99. They draw the
 * grid one strip row higher than a tab inside a folder.
 */
export function isTopLevelTabLabel(label: string): boolean {
  return /^T\d{1,2}$/i.test(String(label ?? "").replace(/#\d+$/, "").trim());
}

export type GeometrySource =
  | "taught"
  | "default-toplevel"
  | "default-shifted"
  | "default"
  | "profile"
  | "bag";

export interface PriceOverlayGeometry {
  region: { x: number; y: number; w: number; h: number };
  cols: number;
  rows: number;
  source: GeometrySource;
}

export interface PriceOverlayGeometryInput {
  tabKey: string;
  topLevel: boolean;
  gridCalibration: GridCalibrationFile;
  profile?: CalibrationProfile;
  client: ScreenRect;
  /** The tab's observed cells; a cell beyond 11 proves a quad tab. */
  cellsHint?: readonly { row: number; col: number }[];
}

function box(grid: TaughtGrid, dy = 0): { x: number; y: number; w: number; h: number } {
  return { x: grid.x, y: grid.y + dy, w: grid.w, h: grid.h };
}

/**
 * Where to draw, in screen-absolute px. Priority: a taught per-tab entry,
 * then the taught top-level default, then the folder default shifted by
 * `TOP_LEVEL_GRID_DY`, then the folder default, then the calibration
 * profile. `undefined` means "not calibrated" — the caller shows a notice
 * rather than painting labels somewhere plausible.
 */
export function priceOverlayGeometry(
  args: PriceOverlayGeometryInput,
): PriceOverlayGeometry | undefined {
  const { gridCalibration, profile, client } = args;
  if (args.tabKey === "bag") {
    const bagGrid = profile?.bagGrid;
    if (!bagGrid) return undefined;
    const screen = toScreenBox(client, bagGrid);
    return {
      region: { x: screen.x, y: screen.y, w: screen.w, h: screen.h },
      cols: bagGrid.cols || BAG_CELLS.cols,
      rows: bagGrid.rows || BAG_CELLS.rows,
      source: "bag",
    };
  }
  const taught = gridCalibration[gridCalibrationKey(args.tabKey)];
  if (taught) {
    return { region: box(taught), cols: taught.cols, rows: taught.rows, source: "taught" };
  }
  const quadByHint = (args.cellsHint ?? []).some((cell) => cell.row >= 12 || cell.col >= 12);
  const size = quadByHint ? 24 : profile?.activeStashTab === "quad" ? 24 : 12;
  if (args.topLevel) {
    const topLevel =
      gridCalibration[`__default_${size}x${size}_toplevel`] ??
      gridCalibration["__default_24x24_toplevel"] ??
      gridCalibration["__default_12x12_toplevel"];
    if (topLevel) {
      return { region: box(topLevel), cols: size, rows: size, source: "default-toplevel" };
    }
  }
  const folder =
    gridCalibration[`__default_${size}x${size}`] ??
    gridCalibration["__default_24x24"] ??
    gridCalibration["__default_12x12"];
  if (folder) {
    return {
      region: box(folder, args.topLevel ? TOP_LEVEL_GRID_DY : 0),
      cols: size,
      rows: size,
      source: args.topLevel ? "default-shifted" : "default",
    };
  }
  const fromProfile = stashGridForKind(profile, size === 24 ? "stash-quad" : "stash-normal");
  if (fromProfile) {
    const screen = toScreenBox(client, fromProfile);
    return {
      // Same one-strip-row shift applies when the geometry comes from the
      // calibration profile, which was taught on a folder tab.
      region: {
        x: screen.x,
        y: screen.y + (args.topLevel ? TOP_LEVEL_GRID_DY : 0),
        w: screen.w,
        h: screen.h,
      },
      cols: size,
      rows: size,
      source: "profile",
    };
  }
  return undefined;
}

/* ---------------- the plan ---------------- */

export type LabelTone = "table" | "estimate" | "unknown";

export interface PriceOverlayItem extends OverlayItem {
  label: string;
  tone: LabelTone;
  name: string;
  valueExalted?: number;
  unitExalted?: number;
  opacity: number;
  fontPx: number;
}

export interface PriceOverlayPlan extends DryRunOverlayPlan {
  items: PriceOverlayItem[];
  detectedItems: PriceOverlayItem[];
  tab: string;
  ageLabel: string;
  /** Worth of the labelled tab after exclusions, in exalted. */
  totalExalted: number;
  priced: number;
  unpriced: number;
}

export interface PriceOverlayOptions {
  fadeByValue: boolean;
  showUnpriced: boolean;
  minLabelExalted: number;
}

export interface PlanPriceOverlayInput {
  /** Already filtered to one tab. */
  observations: readonly InventoryObservation[];
  table: PriceTable;
  geometry: PriceOverlayGeometry;
  client: ScreenRect;
  tab: string;
  staleness?: LocationStaleness;
  excluded: ReadonlySet<string>;
  options: PriceOverlayOptions;
}

export interface PriceLabel {
  label: string;
  tone: LabelTone;
  unitExalted?: number;
  /** Same label with the stack count in front ("×37 37 ex") when it fits. */
  stackLabel?: string;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The text over one footprint. `footprintCopies` splits a grouped ledger
 * row (two identical rings, one currency stack per cell) evenly, because
 * the ledger records the group's total worth, not each copy's.
 */
export function priceLabel(valued: ValuedObservation, footprintCopies: number): PriceLabel {
  const copies = Math.max(1, footprintCopies);
  if (valued.valueExalted === undefined) return { label: "?", tone: "unknown" };
  const unit = round2(valued.valueExalted / copies);
  const tone: LabelTone = valued.source === "price-table" ? "table" : "estimate";
  const label = `${tone === "estimate" ? "~" : ""}${formatExalted(unit)} ex`;
  const stackCount = valued.observation.stackCount;
  if (stackCount === undefined) return { label, tone, unitExalted: unit };
  const perCopy = Math.max(1, Math.round(stackCount / copies));
  return { label, tone, unitExalted: unit, stackLabel: `×${perCopy} ${label}` };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function planPriceOverlay(input: PlanPriceOverlayInput): PriceOverlayPlan {
  const { geometry, options } = input;
  const area = input.tab === "bag" ? "bag" : "stash";
  const ageLabel = input.staleness ? describeAge(input.staleness.ageMs) : "age unknown";
  const grid: OverlayGrid = {
    region: area,
    // "est." is not decoration: a screenshot of this overlay must never
    // read as a list of guaranteed prices.
    label: `${input.tab} · ${ageLabel} · est. prices`,
    x: geometry.region.x,
    y: geometry.region.y,
    w: geometry.region.w,
    h: geometry.region.h,
    cols: geometry.cols,
    rows: geometry.rows,
  };
  const cellH = geometry.rows > 0 ? geometry.region.h / geometry.rows : geometry.region.h;
  const items: PriceOverlayItem[] = [];
  let totalExalted = 0;
  let priced = 0;
  let unpriced = 0;
  for (const observation of input.observations) {
    if (input.excluded.has(observation.fingerprint)) continue;
    const valued = valueObservation(observation, input.table);
    const count = observation.count ?? 1;
    if (valued.valueExalted === undefined) unpriced += count;
    else {
      priced += count;
      totalExalted += valued.valueExalted;
    }
    const footprints = footprintsFromOccupied(
      observation.cells.map((cell) => ({ row: cell.row, col: cell.col, x: 0, y: 0 })),
    );
    const copies = Math.max(1, footprints.length);
    const text = priceLabel(valued, copies);
    if (text.tone === "unknown" && !options.showUnpriced) continue;
    if (options.minLabelExalted > 0 && (text.unitExalted ?? 0) < options.minLabelExalted) continue;
    for (const footprint of footprints) {
      const row = Math.min(...footprint.cells.map((cell) => cell.row));
      const col = Math.min(...footprint.cells.map((cell) => cell.col));
      if (row < 0 || col < 0 || row >= geometry.rows || col >= geometry.cols) continue;
      const rect = overlayItemPixelRect(grid, row, col, footprint.w, footprint.h);
      const fontPx = Math.round(clamp(cellH * 0.32 * (footprint.h > 1 ? 1.15 : 1), 10, 22));
      // A one-cell-wide footprint cannot carry "×37 12 ex" at this size.
      const fits =
        footprint.w >= 2 ||
        (text.stackLabel !== undefined && fontPx * text.stackLabel.length * 0.6 <= rect.width);
      items.push({
        area,
        id: `${row},${col}:${footprint.w}x${footprint.h}`,
        row,
        col,
        w: footprint.w,
        h: footprint.h,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        cells: footprint.cells.map((cell) => ({ row: cell.row, col: cell.col })),
        label: fits && text.stackLabel ? text.stackLabel : text.label,
        tone: text.tone,
        name: observation.name,
        ...(valued.valueExalted !== undefined
          ? { valueExalted: round2(valued.valueExalted / copies) }
          : {}),
        ...(text.unitExalted !== undefined ? { unitExalted: text.unitExalted } : {}),
        opacity: 1,
        fontPx,
      });
    }
  }
  const maxUnit = items.reduce((max, item) => Math.max(max, item.unitExalted ?? 0), 0);
  for (const item of items) {
    if (!options.fadeByValue) {
      item.opacity = 1;
      continue;
    }
    if (item.unitExalted === undefined || maxUnit <= 0) {
      item.opacity = 0.6;
      continue;
    }
    item.opacity = round2(0.45 + 0.55 * Math.sqrt(item.unitExalted / maxUnit));
  }
  return {
    kind: "fill",
    client: input.client,
    grids: [grid],
    clicks: [],
    occupied: [],
    detected: [],
    items,
    detectedItems: items,
    tab: input.tab,
    ageLabel,
    totalExalted: round2(totalExalted),
    priced,
    unpriced,
  };
}

/* ---------------- tab choice ---------------- */

function sortedTabs(locations: readonly string[]): string[] {
  const unique = [...new Set(locations.filter((entry) => typeof entry === "string" && entry))];
  return unique.sort((a, b) => {
    if (a === "bag") return 1;
    if (b === "bag") return -1;
    return a.localeCompare(b);
  });
}

/** The preferred tab when it is still in the ledger, else the freshest scan. */
export function pickOverlayTab(
  locations: readonly string[],
  preferred: string | undefined,
  staleness: readonly LocationStaleness[],
): string | undefined {
  const tabs = sortedTabs(locations);
  if (!tabs.length) return undefined;
  if (preferred && tabs.includes(preferred)) return preferred;
  const freshest = [...staleness]
    .filter((entry) => entry.location !== "bag" && tabs.includes(entry.location))
    .sort((a, b) => a.ageMs - b.ageMs)[0];
  if (freshest) return freshest.location;
  const nonBag = tabs.find((tab) => tab !== "bag");
  return nonBag ?? tabs[0];
}

/** ◀ / ▶ in the legend: alphabetical, the bag last, wrapping both ways. */
export function cycleOverlayTab(
  locations: readonly string[],
  current: string | undefined,
  direction: 1 | -1,
): string | undefined {
  const tabs = sortedTabs(locations);
  if (!tabs.length) return undefined;
  const index = current ? tabs.indexOf(current) : -1;
  if (index < 0) return direction === 1 ? tabs[0] : tabs[tabs.length - 1];
  const next = (index + direction + tabs.length) % tabs.length;
  return tabs[next];
}
