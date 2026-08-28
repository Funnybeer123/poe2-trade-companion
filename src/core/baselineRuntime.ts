import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  BASELINE_OCCUPIED_DIFF,
  emptyBaseline,
  learnBaseline,
  scoreAgainstBaseline,
  type BaselineModel,
} from "./cellBaseline.js";
import type { BgrImage, ScreenRegion } from "./cellOccupancy.js";
import { occupiedFromRgbScores, scoreGridCellsRgb } from "./cellOccupancy.js";
import type { GrayImage } from "./grayImage.js";
import { occupiedFromScores, scoreGridCells } from "./itemSprites.js";
import type { ScreenRect } from "./screenLayout.js";
import type { BBox, OccupiedCell, UiFacts } from "./uiPerception.js";

export interface BaselineAdjustment {
  area: "bag" | "stash";
  /** Cells the primary classifier called occupied that the learned baseline confidently rejects. */
  removed: Array<{ row: number; col: number }>;
  /** Cells the primary classifier missed that the learned baseline confidently flags. */
  added: Array<{ row: number; col: number }>;
  /** Cells folded into the empty-reference model this capture. */
  learned: number;
}

export interface RefineResult {
  facts: UiFacts;
  adjustments: BaselineAdjustment[];
}

const SAVE_THROTTLE_MS = 5_000;
/** Override empty only well below the occupied threshold; override occupied only well above it. */
const CONFIDENT_EMPTY = BASELINE_OCCUPIED_DIFF * 0.5;
const CONFIDENT_OCCUPIED = BASELINE_OCCUPIED_DIFF * 2;
/** A reference patch must have merged at least this many observations before it can override. */
const MIN_SAMPLES = 2;

interface GridTarget {
  area: "bag" | "stash";
  region: BBox;
  cols: number;
  rows: number;
  modelName: string;
  occupied: OccupiedCell[];
}

/**
 * Runtime empty-cell baseline: every capture, cells that BOTH the gray and
 * RGB classifiers agree are empty are folded into a persistent per-cell
 * reference model. Once a cell's reference is established, the baseline can
 * conservatively veto the primary classifier — rescuing dark item art the
 * gray path misses and rejecting tinted backgrounds the RGB path misreads.
 * Overrides only fire far from the decision threshold, so an under-trained
 * model changes nothing.
 */
export class BaselineRuntime {
  private models = new Map<string, BaselineModel>();
  private lastSave = new Map<string, number>();

  constructor(private readonly dir: string) {}

  refine(facts: UiFacts, frame: GrayImage, bgr: BgrImage | undefined, client: ScreenRect): RefineResult {
    if (!bgr) return { facts, adjustments: [] };
    const targets: GridTarget[] = [];
    if (facts.inventoryPanelOpen && facts.inventoryRegion) {
      targets.push({
        area: "bag",
        region: facts.inventoryRegion,
        cols: 12,
        rows: 5,
        modelName: "bag",
        occupied: facts.occupiedBag,
      });
    }
    if (facts.stashPanelOpen && facts.stashRegion && facts.stashGridSize) {
      targets.push({
        area: "stash",
        region: facts.stashRegion,
        cols: facts.stashGridSize.cols,
        rows: facts.stashGridSize.rows,
        modelName: `stash-${facts.stashGridSize.cols}x${facts.stashGridSize.rows}`,
        occupied: facts.occupiedStash,
      });
    }

    const adjustments: BaselineAdjustment[] = [];
    let nextFacts = facts;
    for (const target of targets) {
      const adjustment = this.refineGrid(target, frame, bgr, client);
      adjustments.push(adjustment);
      if (adjustment.removed.length === 0 && adjustment.added.length === 0) continue;
      const removedKeys = new Set(adjustment.removed.map((cell) => `${cell.row},${cell.col}`));
      const kept = target.occupied.filter((cell) => !removedKeys.has(`${cell.row},${cell.col}`));
      const cellW = target.region.w / target.cols;
      const cellH = target.region.h / target.rows;
      const appended: OccupiedCell[] = adjustment.added.map((cell) => ({
        row: cell.row,
        col: cell.col,
        x: Math.round(target.region.x + cellW * (cell.col + 0.5)),
        y: Math.round(target.region.y + cellH * (cell.row + 0.5)),
        ...(target.area === "stash" ? { bag: "stash" } : {}),
      }));
      const occupied = [...kept, ...appended];
      nextFacts =
        target.area === "bag"
          ? { ...nextFacts, occupiedBag: occupied, bagEmpty: nextFacts.inventoryPanelOpen && occupied.length === 0 }
          : { ...nextFacts, occupiedStash: occupied };
    }
    return { facts: nextFacts, adjustments };
  }

  private refineGrid(
    target: GridTarget,
    frame: GrayImage,
    bgr: BgrImage,
    client: ScreenRect,
  ): BaselineAdjustment {
    const region = target.region as ScreenRegion;
    const gray = occupiedFromScores(scoreGridCells(frame, client, target.region, target.cols, target.rows));
    const rgb = occupiedFromRgbScores(scoreGridCellsRgb(bgr, client, region, target.cols, target.rows));
    const anyOccupied = new Set([
      ...gray.map((cell) => `${cell.row},${cell.col}`),
      ...rgb.map((cell) => `${cell.row},${cell.col}`),
      ...target.occupied.map((cell) => `${cell.row},${cell.col}`),
    ]);
    const agreedEmpty: Array<{ row: number; col: number }> = [];
    for (let row = 0; row < target.rows; row += 1) {
      for (let col = 0; col < target.cols; col += 1) {
        if (!anyOccupied.has(`${row},${col}`)) agreedEmpty.push({ row, col });
      }
    }

    let model = this.load(target.modelName, target.cols, target.rows);
    if (agreedEmpty.length > 0) {
      model = learnBaseline(model, bgr, client, region, agreedEmpty);
      this.models.set(target.modelName, model);
      this.save(target.modelName, model);
    }

    const removed: Array<{ row: number; col: number }> = [];
    const added: Array<{ row: number; col: number }> = [];
    const occupiedKeys = new Set(target.occupied.map((cell) => `${cell.row},${cell.col}`));
    for (const score of scoreAgainstBaseline(model, bgr, client, region)) {
      if (score.reference !== "cell") continue;
      const reference = model.cells[score.row * model.cols + score.col];
      if (!reference || reference.samples < MIN_SAMPLES) continue;
      const key = `${score.row},${score.col}`;
      if (occupiedKeys.has(key) && score.diff < CONFIDENT_EMPTY) {
        removed.push({ row: score.row, col: score.col });
      } else if (!occupiedKeys.has(key) && score.diff > CONFIDENT_OCCUPIED) {
        added.push({ row: score.row, col: score.col });
      }
    }
    return { area: target.area, removed, added, learned: agreedEmpty.length };
  }

  private modelPath(name: string): string {
    return path.join(this.dir, `baseline-${name}.json`);
  }

  private load(name: string, cols: number, rows: number): BaselineModel {
    const cached = this.models.get(name);
    if (cached && cached.cols === cols && cached.rows === rows) return cached;
    const file = this.modelPath(name);
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as BaselineModel;
        if (parsed.version === 1 && parsed.cols === cols && parsed.rows === rows) {
          this.models.set(name, parsed);
          return parsed;
        }
      } catch {
        // Corrupt model file — relearn from scratch.
      }
    }
    const fresh = emptyBaseline(cols, rows);
    this.models.set(name, fresh);
    return fresh;
  }

  private save(name: string, model: BaselineModel): void {
    const last = this.lastSave.get(name) ?? 0;
    if (Date.now() - last < SAVE_THROTTLE_MS) return;
    this.lastSave.set(name, Date.now());
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.modelPath(name), JSON.stringify(model));
  }
}
