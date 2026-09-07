/**
 * Gear sorter — stash perception: frame capture, calibrated-bounds pixel
 * proofs, OCR bands, bag/stash occupancy scoring, and the persisted grid
 * calibration and phantom-cell stores. Split out of gearSorter.ts
 * mechanically; the orchestrator (GearSorter) owns the shared state and
 * hands it over through SorterContext.
 */
import path from "node:path";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { bgrToGray, readBmpBgr } from "../bmp.js";
import {
  brightestCellPoint,
  regionChangedFraction,
  scoreGridCells,
} from "../../core/itemSprites.js";
import { hasConsistentCellGrid, perceiveUi } from "../../core/uiPerception.js";
import { occupiedFromRgbScores, scoreGridCellsRgb } from "../../core/cellOccupancy.js";
import { toScreenBox } from "../../core/calibrationProfile.js";
import { resolvePhysicalClient } from "../../core/screenLayout.js";
import { encodeBgrPng } from "../../core/pngWrite.js";
import {
  BAG_AREA,
  STASH_AREA,
  STASH_AREA_TOP_LEVEL,
  clampToArea,
  emptyCellKeysByBaseline,
  stashRegionSane,
  type PhantomCellRecord,
  type GridCell,
} from "../../core/gearSort.js";
import { STASH_BAND } from "./context.js";
import type { OcrText, Frame, RawFrame, SorterContext } from "./context.js";

export class StashPerception {
  constructor(private readonly ctx: SorterContext) {}

  /* ---------------- perception ---------------- */

  async captureRaw(): Promise<RawFrame> {
    const rect = await this.ctx.host.send({ op: "rect" });
    const file = path.join(this.ctx.captureScratchDir, `cap-${Date.now()}-${Math.random().toString(16).slice(2, 6)}.bmp`);
    const captured = await this.ctx.host.send({ op: "capture", path: file });
    if (!captured.ok) throw new Error(String(captured.error ?? "capture-failed"));
    const bgr = readBmpBgr(file);
    rmSync(file, { force: true });
    const client = resolvePhysicalClient(
      {
        left: Number(captured.left),
        top: Number(captured.top),
        width: Number(captured.width),
        height: Number(captured.height),
      },
      Number(rect.monitorWidth) || Number(captured.width),
      Number(rect.monitorHeight) || Number(captured.height),
      { left: Number(rect.monitorLeft ?? 0), top: Number(rect.monitorTop ?? 0) },
    );
    return { gray: bgrToGray(bgr), bgr, client };
  }

  async captureFrame(): Promise<Frame> {
    const { gray, bgr, client } = await this.captureRaw();
    // ventorBagGrid is stripped like the daemon and drain tooling do: when
    // the stash-open pixel check flakes (open side list, sparse tab), the
    // vendor-box grid hijacks the interpretation and perceiveUi returns NO
    // facts at all — stash AND bag read empty on a visibly full screen.
    const facts = perceiveUi(
      gray,
      client,
      {},
      { ...this.ctx.profile, ventorBagGrid: undefined },
      bgr,
    );
    // Remember the FINEST sanely perceived stash geometry — the folder's
    // tabs share panel bounds, and this seeds the blind-tab Ctrl+C sweep.
    // Prefer quad pitch (24 cols): a 12-col sweep on a quad tab would sample
    // only a quarter of the cells and could miss 1x1 items entirely.
    if (
      stashRegionSane(facts.stashRegion) &&
      facts.stashGridSize &&
      (!this.ctx.lastGoodStashGeometry || facts.stashGridSize.cols >= this.ctx.lastGoodStashGeometry.cols)
    ) {
      this.ctx.lastGoodStashGeometry = {
        region: facts.stashRegion!,
        cols: facts.stashGridSize.cols,
        rows: facts.stashGridSize.rows,
      };
    }
    return { gray, bgr, client, facts };
  }

  saveDebugFrame(frame: Frame, tag: string): void {
    if (!this.ctx.options.debug) return;
    try {
      writeFileSync(path.join(this.ctx.debugDir, `${Date.now()}-${tag}.png`), encodeBgrPng(frame.bgr));
    } catch {
      // best-effort diagnostics
    }
  }

  /** The user-calibrated stash panel bounds (shared across the folder's
   * tabs), for pixel checks that must not wait on OCR or perception. */
  calibratedStashBounds():
    | { x: number; y: number; w: number; h: number }
    | undefined {
    this.loadGridCalibration();
    const bounds =
      this.ctx.gridCalibration["__default_24x24"] ?? this.ctx.gridCalibration["__default_12x12"];
    if (bounds) return { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h };
    return this.ctx.lastGoodStashGeometry?.region;
  }

  /**
   * Cheap "the stash grid is on screen" proof: capture one frame and run the
   * STRICT cell-grid detector over the calibrated bounds (12x12 and 24x24 —
   * whichever layout the active tab uses should pass). Strict, because the
   * user's hideout floor is a regular tile pattern that PASSES the loose
   * detector with the stash closed (measured live 2026-08-30: loose=true,
   * strict=false on the bare world). No OCR, no template search. A false
   * negative only costs a fall-through to slower OCR-verified paths.
   */
  async stashGridVisible(raw?: RawFrame): Promise<boolean> {
    const bounds = this.calibratedStashBounds();
    if (!bounds) return false;
    const frame = raw ?? (await this.captureRaw());
    const uv = {
      x: (bounds.x - frame.client.left) / frame.client.width,
      y: (bounds.y - frame.client.top) / frame.client.height,
      w: bounds.w / frame.client.width,
      h: bounds.h / frame.client.height,
    };
    const visible =
      hasConsistentCellGrid(frame.gray, uv, 12, 12) ||
      hasConsistentCellGrid(frame.gray, uv, 24, 24);
    if (visible) this.noteStashProof();
    return visible;
  }

  /**
   * Wait for the pixels of a screen region to CHANGE (a tab switch repaints
   * the grid) and then hold STABLE, via the host's pixwait op — this replaces
   * fixed 1000ms sleeps with returns as soon as the game has actually acted.
   * Returns whether a change was observed; on a host too old for the op the
   * caller's fixed-sleep fallback runs instead (changed=undefined).
   */
  async pixwait(
    region: { x: number; y: number; w: number; h: number },
    options: { waitChangeMs?: number; stableMs?: number },
  ): Promise<boolean | undefined> {
    const reply = await this.ctx.host.send({
      op: "pixwait",
      left: Math.round(region.x),
      top: Math.round(region.y),
      width: Math.round(region.w),
      height: Math.round(region.h),
      waitChangeMs: options.waitChangeMs ?? 0,
      stableMs: options.stableMs ?? 0,
    });
    if (!reply.ok) return undefined;
    return Boolean(reply.changed);
  }

  /**
   * Poll until `region` differs from the `before` frame (true) or the cap
   * expires (false). This is the race-free change primitive: the baseline
   * predates the click, so a change that completes in any window is seen.
   * Each poll is one capture (~250-350ms), so the wait lasts exactly as
   * long as the animation does instead of a blind worst-case sleep.
   */
  async regionChangedSince(
    before: RawFrame,
    region: { x: number; y: number; w: number; h: number },
    capMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + capMs;
    for (;;) {
      const now = await this.captureRaw();
      if (regionChangedFraction(before.gray, now.gray, now.client, region) > 0.002) return true;
      if (Date.now() >= deadline) return false;
      await this.ctx.harness.sleep(150, false);
    }
  }

  /* ---------------- stash-proof freshness ---------------- */

  noteStashProof(): void {
    this.ctx.lastStashProofAt = Date.now();
  }

  stashRecentlyProven(): boolean {
    return Date.now() - this.ctx.lastStashProofAt < 20_000;
  }

  async ocrBand(band: { left: number; top: number; width: number; height: number }): Promise<string> {
    // Full-screen OCR only, filtered client-side: mid-size region crops
    // (~400-1900px wide) sit in the Windows.Media.Ocr dead zone and
    // intermittently return ZERO lines — a 900px band read of a box that
    // visibly held text came back empty and derailed a whole route.
    const reply = await this.ctx.host.send({ op: "ocr" });
    const lines = (Array.isArray(reply.lines) ? reply.lines : []) as OcrText[];
    return lines
      .filter(
        (line) =>
          line.x >= band.left &&
          line.x <= band.left + band.width &&
          line.y >= band.top &&
          line.y <= band.top + band.height,
      )
      .map((line) => line.text)
      .join(" ");
  }

  /**
   * Title-band OCR with the cursor PARKED first (tooltips cover titles) and a
   * second read before trusting a negative — wrong recoveries from one flaky
   * read (blind Escape, blind `i`) caused real damage.
   */
  async stashTitleVisible(): Promise<boolean> {
    await this.ctx.park();
    await this.ctx.harness.sleep(350, false);
    if (this.ctx.titleMatchesChest(await this.ocrBand(STASH_BAND))) {
      this.noteStashProof();
      return true;
    }
    await this.ctx.harness.sleep(600, false);
    const visible = this.ctx.titleMatchesChest(await this.ocrBand(STASH_BAND));
    if (visible) this.noteStashProof();
    return visible;
  }

  /** Wait until the newly selected tab renders a real grid before acting. */
  async settleGrid(): Promise<void> {
    for (let settle = 0; settle < 4; settle += 1) {
      const frame = await this.captureFrame();
      if (!this.ctx.harness.guard("grid-not-settled", !stashRegionSane(frame.facts.stashRegion))) return;
      await this.ctx.harness.sleep(500, false);
    }
  }

  /**
   * Occupied bag cells straight from the calibrated bag grid — the exact
   * scoring lookCalibrated uses when a BGR frame is available, minus the
   * whole perception pass around it. Falls back to full perception only
   * when the profile has no bag grid.
   */
  private bagCellsRaw(raw: RawFrame): GridCell[] {
    const grid = this.ctx.profile.bagGrid;
    if (!grid) return [];
    const region = toScreenBox(raw.client, grid);
    return clampToArea(
      occupiedFromRgbScores(scoreGridCellsRgb(raw.bgr, raw.client, region, 12, 5)),
      BAG_AREA,
    );
  }

  private bagCells(frame: Frame): GridCell[] {
    if (this.ctx.profile.bagGrid) return this.bagCellsRaw(frame);
    return clampToArea(
      frame.facts.occupiedBag.map((cell) => ({ row: cell.row, col: cell.col, x: cell.x, y: cell.y })),
      BAG_AREA,
    );
  }

  async currentBagCells(): Promise<GridCell[]> {
    if (this.ctx.profile.bagGrid) return this.bagCellsRaw(await this.captureRaw());
    return this.bagCells(await this.captureFrame());
  }

  async bagCount(): Promise<number> {
    return (await this.currentBagCells()).length;
  }

  /** Persistent phantom cells (see PhantomCellRecord). Keyed "tab:row,col". */
  private phantomStore: Map<string, PhantomCellRecord> | undefined;

  private get phantomStoreFile(): string {
    return path.join(this.ctx.options.root, "artifacts", "tab-admin", "phantom-cells.json");
  }

  loadPhantomStore(): Map<string, PhantomCellRecord> {
    if (this.phantomStore) return this.phantomStore;
    this.phantomStore = new Map();
    try {
      const parsed = JSON.parse(readFileSync(this.phantomStoreFile, "utf8")) as PhantomCellRecord[];
      for (const record of parsed) {
        this.phantomStore.set(`${record.tab}:${record.row},${record.col}`, record);
      }
    } catch {
      // no store yet
    }
    return this.phantomStore;
  }

  savePhantomStore(): void {
    if (!this.phantomStore) return;
    try {
      writeFileSync(this.phantomStoreFile, JSON.stringify([...this.phantomStore.values()], null, 2));
    } catch {
      // the store is a convenience cache, never a failure
    }
  }

  private gridCalibrationLoaded = false;

  private get gridCalibrationFile(): string {
    return path.join(this.ctx.options.root, "artifacts", "tab-admin", "grid-calibration.json");
  }

  loadGridCalibration(): void {
    if (this.gridCalibrationLoaded) return;
    this.gridCalibrationLoaded = true;
    try {
      this.ctx.gridCalibration = JSON.parse(readFileSync(this.gridCalibrationFile, "utf8"));
    } catch {
      this.ctx.gridCalibration = {};
    }
  }

  saveGridCalibration(): void {
    try {
      writeFileSync(this.gridCalibrationFile, JSON.stringify(this.ctx.gridCalibration, null, 2));
    } catch {
      // calibration is a convenience cache, never a failure
    }
  }

  /** Thin lattice lines outlining every cell of the grid. */
  latticeRects(
    region: { x: number; y: number; w: number; h: number },
    cols: number,
    rows: number,
  ): Array<{ x: number; y: number; w: number; h: number; kind: "found" }> {
    const rects: Array<{ x: number; y: number; w: number; h: number; kind: "found" }> = [];
    for (let c = 0; c <= cols; c += 1) {
      rects.push({ x: Math.round(region.x + (c * region.w) / cols) - 1, y: region.y, w: 2, h: region.h, kind: "found" });
    }
    for (let r = 0; r <= rows; r += 1) {
      rects.push({ x: region.x, y: Math.round(region.y + (r * region.h) / rows) - 1, w: region.w, h: 2, kind: "found" });
    }
    return rects;
  }

  /**
   * Occupied cells of the ACTIVE stash/merchant grid by pixel scoring alone
   * — no hover, no Ctrl+C. The same baseline-plus-bright-block rule indexTab
   * sweeps with, over the geometry the last index established (or the one
   * given), so a diff between two reads is exactly "which cells filled".
   * The shop flow's cheap landing-spot probe between a listing click and
   * its targeted verification (docs/HANDOFF-shop-listings.md).
   */
  async occupiedStashCellsNow(
    geometry?: { region: { x: number; y: number; w: number; h: number }; cols: number; rows: number },
    topLevel = false,
  ): Promise<GridCell[]> {
    const geo = geometry ?? this.ctx.lastGoodStashGeometry;
    if (!geo) return [];
    const raw = await this.captureRaw();
    const { region, cols, rows } = geo;
    const scores = scoreGridCells(raw.gray, raw.client, region, cols, rows);
    const emptyKeys = emptyCellKeysByBaseline(scores);
    const cells: GridCell[] = [];
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        if (
          emptyKeys.has(`${r},${c}`) &&
          !brightestCellPoint(raw.gray, raw.client, region, cols, rows, { row: r, col: c })
        ) {
          continue;
        }
        cells.push({
          row: r,
          col: c,
          x: Math.round(region.x + ((c + 0.5) * region.w) / cols),
          y: Math.round(region.y + ((r + 0.5) * region.h) / rows),
        });
      }
    }
    return clampToArea(cells, topLevel ? STASH_AREA_TOP_LEVEL : STASH_AREA);
  }
}
