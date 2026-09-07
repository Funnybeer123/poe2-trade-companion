/**
 * Gear sorter — ground-truth item identification: hover + Ctrl+C reads,
 * the row sweeps, the teach-mode gates and the per-tab index. Split out of
 * gearSorter.ts mechanically; the orchestrator (GearSorter) owns the shared
 * state and hands it over through SorterContext.
 */
import path from "node:path";
import { appendFileSync } from "node:fs";
import {
  boundaryBrightness24,
  brightestCellPoint,
  cellEdgeContinuity,
  scoreGridCells,
} from "../../core/itemSprites.js";
import {
  STASH_AREA,
  STASH_AREA_TOP_LEVEL,
  TOP_LEVEL_GRID_DY,
  clampToArea,
  claimNeedsReverify,
  emptyCellKeysByBaseline,
  detectGridDivisions,
  groupIdentifiedCells,
  phantomSignatureMatches,
  stashRegionSane,
  type Cell,
  type GridCell,
  type IdentifiedItem,
} from "../../core/gearSort.js";
import { STASH_SCAN } from "../../core/copyTiming.js";
import { recordOccupancyLabel } from "../../core/occupancyLabels.js";
import type { RawFrame, SourceTab, TabIndex, SorterContext } from "./context.js";

export class ItemIdentification {
  constructor(private readonly ctx: SorterContext) {}

  /**
   * Stash cells that read occupied+lit but yield NOTHING when ctrl-clicked
   * (the bag does not grow). They match every query — 9 of them turned every
   * route on the Rings tab into false positives — so once proven they are
   * never targeted again on that tab. Keyed "label#occurrence:row,col".
   */
  private readonly phantomStash = new Set<string>();

  private phantomKey(source: SourceTab, cell: GridCell): string {
    return `${source.label}#${source.occurrence}:${cell.row},${cell.col}`;
  }

  /* ---------------- triage ---------------- */

  /**
   * Hover a bag cell and Ctrl+C its item text, sentinel-verified, restoring
   * the user's clipboard afterwards. Stop/pause land inside harness.sleep.
   */
  async copyItemAt(x: number, y: number, hoverMs?: number): Promise<string> {
    const original = await this.ctx.host.send({ op: "clipboard" });
    const originalText = String(original.text ?? "");
    const sentinel = `poe2-triage-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    try {
      await this.ctx.host.send({ op: "move", x, y });
      await this.ctx.harness.sleep(hoverMs ?? STASH_SCAN.inventory.hoverMs, false);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const cleared = await this.ctx.host.send({ op: "setclipboard", text: sentinel });
        if (!cleared.ok) return "";
        await this.ctx.host.send({ op: "hotkey", keys: "ctrlc" });
        await this.ctx.harness.sleep(
          attempt === 0 ? STASH_SCAN.inventory.copyMs + 30 : STASH_SCAN.inventory.afterMs + 50,
          false,
        );
        const copied = await this.ctx.host.send({ op: "clipboard" });
        const text = String(copied.text ?? "");
        if (copied.ok && text !== sentinel && /Item Class:/i.test(text)) return text;
      }
      return "";
    } finally {
      await this.ctx.host.send({ op: "setclipboard", text: originalText });
    }
  }

  /* ---------------- ground-truth identification (Ctrl+C) ---------------- */

  /** How often a cell's copy came back empty; twice = phantom, blacklist. */
  private readonly emptyCopyCounts = new Map<string, number>();

  /**
   * Read every given cell's item text via hover + Ctrl+C and group the reads
   * into items. This is the authoritative identification the user asked for:
   * the item's own text, perfect every time — no pixel guessing. Cells that
   * yield no text repeatedly are phantoms and get blacklisted for the tab.
   *
   * Speed layers (each with its safety net):
   * - Rows sweep as ONE host request each (per-op IPC made scans 3-4x slower).
   * - `sameSpriteAsLeft` (pixel edge continuity) may propose skipping the
   *   hover for a cell that CONTINUES its left neighbour's sprite. The claim
   *   is trusted only when the finished item's bounding box exactly matches
   *   its class's minimum footprint (claimNeedsReverify) — any disagreement
   *   re-hovers the skipped cells. Class-footprint assumptions alone never
   *   skip anything: that exact shortcut once hid rings beside helmets.
   * - A silent cell gets ONE informed offset probe (the brightest block in
   *   the cell) instead of the old four blind hovers.
   */
  async identifyCells(
    cells: readonly GridCell[],
    options: {
      phantomScope?: SourceTab;
      looksEmpty?: (cell: GridCell) => boolean;
      probePoint?: (cell: GridCell) => Cell | undefined;
      sameSpriteAsLeft?: (cell: GridCell) => boolean;
      /** Called the MOMENT a cell finishes the whole probe battery silent —
       * so the learning survives a Numpad 0 mid-sweep (two stopped runs
       * lost it and re-ground the same glare cells, 2026-09-01). */
      onSilent?: (cell: GridCell) => void;
    } = {},
  ): Promise<{ items: IdentifiedItem[]; unread: GridCell[]; reads: Array<{ cell: GridCell; text: string }> }> {
    const { phantomScope, looksEmpty, probePoint, sameSpriteAsLeft, onSilent } = options;
    const reads: Array<{ cell: GridCell; text: string }> = [];
    const unread: GridCell[] = [];
    const gotText = (cell: GridCell, text: string): boolean => {
      if (text && /Item Class:/i.test(text)) {
        reads.push({ cell, text });
        return true;
      }
      return false;
    };
    const byRow = new Map<number, GridCell[]>();
    for (const cell of cells) {
      byRow.set(cell.row, [...(byRow.get(cell.row) ?? []), cell]);
    }
    const noText: GridCell[] = [];
    /** Cells whose text was CLAIMED from a continuation, pending verification. */
    const claimed = new Map<string, GridCell>();
    const sweepDebug = process.env.POE2_SWEEP_DEBUG === "1";
    const sweepRow = async (target: readonly GridCell[], label: string): Promise<GridCell[]> => {
      const failed: GridCell[] = [];
      if (target.length === 0) return failed;
      await this.ctx.harness.checkpoint(label);
      if (sweepDebug) {
        this.ctx.log(`    [sweep] row ${target[0]!.row}: ${target.length} cell(s) (${label})`);
      }
      const sentinel = `poe2-sweep-${Date.now()}-${target[0]!.row}`;
      const reply = await this.ctx.host.send({
        op: "copysweep",
        points: target.map((cell) => ({ x: cell.x, y: cell.y })),
        // 100ms turbo hover (99.8% read-rate pedigree, 419/420 live). A
        // 90ms retest on 2026-09-01 was inconclusive: the 23 unread cells
        // it hit were unreadable at 100ms too (a persistent silent cluster
        // in Dump, not a speed effect). Keeping 100ms as the proven
        // setting; a future 90ms retest needs a FULL tab, not the residue.
        hoverMs: this.ctx.options.turbo ? 100 : 130,
        sentinel,
      });
      const texts = Array.isArray(reply.texts) ? (reply.texts as string[]) : undefined;
      if (!reply.ok || !texts || texts.length !== target.length) {
        // Host too old or the sweep failed — per-cell fallback for this row.
        this.ctx.harness.guard("copysweep-fallback", true);
        for (const cell of target) {
          await this.ctx.harness.checkpoint(label);
          if (!gotText(cell, await this.copyItemAt(cell.x, cell.y))) failed.push(cell);
        }
        return failed;
      }
      target.forEach((cell, index) => {
        if (!gotText(cell, texts[index] ?? "")) failed.push(cell);
      });
      return failed;
    };
    for (const row of [...byRow.keys()].sort((a, b) => a - b)) {
      const rowCells = byRow.get(row)!.sort((a, b) => a.col - b.col);
      // Split the row into hovered cells and continuation claims. A claim
      // needs its immediate left neighbour IN THE PLAN and the pixel edge to
      // say the sprite flows across; the claimed text comes from the nearest
      // hovered cell of the chain after the sweep.
      const hover: GridCell[] = [];
      const chains = new Map<string, GridCell>(); // claimed key -> chain root cell
      for (const cell of rowCells) {
        const left = rowCells.find((other) => other.col === cell.col - 1);
        if (left && sameSpriteAsLeft?.(cell)) {
          const leftKey = `${left.row},${left.col}`;
          const root = chains.get(leftKey) ?? left;
          chains.set(`${cell.row},${cell.col}`, root);
          claimed.set(`${cell.row},${cell.col}`, cell);
          continue;
        }
        hover.push(cell);
      }
      const failed = await sweepRow(hover, "identifying items");
      const failedKeys = new Set(failed.map((cell) => `${cell.row},${cell.col}`));
      const textByKey = new Map(reads.map((entry) => [`${entry.cell.row},${entry.cell.col}`, entry.text]));
      const orphaned: GridCell[] = [];
      for (const [key, root] of chains) {
        const cell = claimed.get(key)!;
        const rootText = textByKey.get(`${root.row},${root.col}`);
        if (rootText && !failedKeys.has(`${root.row},${root.col}`)) {
          reads.push({ cell, text: rootText });
        } else {
          // The chain's read failed — the claim has no text to inherit.
          claimed.delete(key);
          orphaned.push(cell);
        }
      }
      noText.push(...failed, ...(await sweepRow(orphaned, "identifying items (claim fallback)")));
    }
    // Verified claiming: any item whose bounding box disagrees with its
    // class's minimum footprint gets its claimed cells RE-HOVERED — pixels
    // may propose, only the Ctrl+C re-read disposes.
    if (claimed.size > 0) {
      const claimedKeys = new Set(claimed.keys());
      const suspect = groupIdentifiedCells(reads)
        .filter((item) => claimNeedsReverify(item, claimedKeys))
        .flatMap((item) => item.cells.filter((cell) => claimedKeys.has(`${cell.row},${cell.col}`)));
      if (suspect.length > 0) {
        this.ctx.harness.guard("claim-reverify", true);
        const suspectKeys = new Set(suspect.map((cell) => `${cell.row},${cell.col}`));
        for (let i = reads.length - 1; i >= 0; i -= 1) {
          const key = `${reads[i]!.cell.row},${reads[i]!.cell.col}`;
          if (suspectKeys.has(key) && claimedKeys.has(key)) reads.splice(i, 1);
        }
        const byRowSuspect = new Map<number, GridCell[]>();
        for (const cell of suspect) {
          byRowSuspect.set(cell.row, [...(byRowSuspect.get(cell.row) ?? []), cell]);
        }
        for (const row of [...byRowSuspect.keys()].sort((a, b) => a - b)) {
          noText.push(
            ...(await sweepRow(
              byRowSuspect.get(row)!.sort((a, b) => a.col - b.col),
              "verifying claimed cells",
            )),
          );
        }
      }
    }
    // Second chance for no-text cells whose pixels look item-like: small art
    // (rings, amulets, jewels) can sit off the cell centre where the hover
    // pokes dead space. ONE informed probe at the brightest block in the
    // cell replaces the old four blind offsets; without pixel data the blind
    // pattern remains the fallback.
    for (const cell of noText) {
      if (looksEmpty?.(cell)) continue; // flat empty cell on a colored background
      await this.ctx.harness.checkpoint("identifying items (offset retry)");
      let found = false;
      if (probePoint) {
        const informed = probePoint(cell);
        if (!informed) {
          // Pixel data is available and says there is NOTHING to aim at —
          // no block brighter than the cell's own floor. A silent centre
          // hover plus nothing-to-probe is an EMPTY cell, not an unread one:
          // an empty quad's 36 glare cells once ground through three phantom
          // retry rounds ("stuck on the Dump tab").
          continue;
        }
        // 140ms probe hover: the default inventory hover is 35ms, which is
        // too short for a reluctant tooltip — top-of-Dump jewels stayed
        // silent through the whole sweep (2026-09-01, user found them).
        found = gotText(cell, await this.copyItemAt(informed.x, informed.y, 140));
        if (!found) {
          // Blind-cross fallback: small art (jewels!) can sit where even
          // the brightest-block probe misses the hover hitbox. Only cells
          // with something bright to aim at pay these four hovers, so the
          // probeless-empty short-circuit above still protects glare.
          for (const [dx, dy] of [[14, 0], [-14, 0], [0, 14], [0, -14]] as const) {
            if (gotText(cell, await this.copyItemAt(cell.x + dx, cell.y + dy, 140))) {
              found = true;
              break;
            }
          }
        }
      } else {
        for (const [dx, dy] of [[14, 0], [-14, 0], [0, 14], [0, -14]] as const) {
          if (gotText(cell, await this.copyItemAt(cell.x + dx, cell.y + dy, 140))) {
            found = true;
            break;
          }
        }
      }
      if (found) continue;
      onSilent?.(cell);
      const key = phantomScope ? this.phantomKey(phantomScope, cell) : `bag:${cell.row},${cell.col}`;
      const misses = (this.emptyCopyCounts.get(key) ?? 0) + 1;
      this.emptyCopyCounts.set(key, misses);
      if (misses >= 3 && phantomScope) {
        this.phantomStash.add(this.phantomKey(phantomScope, cell));
        this.ctx.log(`  · cell ${cell.row},${cell.col} yields no item text three times — phantom, blacklisted`);
      } else {
        unread.push(cell);
      }
    }
    await this.ctx.park();
    if (unread.length > 0) {
      this.ctx.log(`  · read ${reads.length}/${cells.length} cells (${unread.length} unread this pass)`);
    }
    return { items: groupIdentifiedCells(reads), unread, reads };
  }

  /**
   * Teach the GRID itself: draw the full lattice over the tab; Numpad 8
   * accepts (and persists it for this tab); Numpad 9 then a corner-to-corner
   * DRAG redefines the bounds, while Numpad 9 then a single CLICK toggles
   * 24x24 <-> 12x12. The saved grid outranks perception from then on.
   */
  private async teachGrid(
    source: SourceTab,
    initial: { region: { x: number; y: number; w: number; h: number }; cols: number; rows: number },
  ): Promise<{ region: { x: number; y: number; w: number; h: number }; cols: number; rows: number }> {
    const key = `${source.label}#${source.occurrence}`;
    let { region, cols, rows } = initial;
    const sizeDefault = this.ctx.gridCalibration[`__default_${cols}x${rows}`];
    if (sizeDefault) {
      region = { x: sizeDefault.x, y: sizeDefault.y, w: sizeDefault.w, h: sizeDefault.h };
    }
    for (let round = 0; round < 10; round += 1) {
      const verdict = await this.ctx.harness.confirmPlan(
        this.ctx.perception.latticeRects(region, cols, rows),
        `grid ${cols}x${rows} — 8 good · 9 then DRAG corners (or click = toggle 12/24)`,
      );
      if (verdict === "good") break;
      const correction = await this.ctx.harness.captureCorrection(`grid bounds ${key}`, {
        x: Math.round(region.x + region.w / 2),
        y: Math.round(region.y + region.h / 2),
      });
      if (correction?.box && correction.box.w > 400 && correction.box.h > 400) {
        region = { x: correction.box.x, y: correction.box.y, w: correction.box.w, h: correction.box.h };
        this.ctx.log(`  · teach: grid bounds redrawn to ${JSON.stringify(region)}`);
      } else if (correction) {
        cols = cols === 24 ? 12 : 24;
        rows = rows === 24 ? 12 : 24;
        this.ctx.log(`  · teach: grid size toggled to ${cols}x${rows}`);
      }
    }
    this.ctx.gridCalibration[key] = { ...region, cols, rows };
    // The panel bounds are shared: the first corrected grid becomes the
    // starting lattice for every other tab of the same size, so one drag
    // calibrates them all (later tabs just need a Numpad 8).
    this.ctx.gridCalibration[`__default_${cols}x${rows}`] = { ...region, cols, rows };
    this.ctx.perception.saveGridCalibration();
    this.ctx.log(`  · teach: grid for ${key} saved (${cols}x${rows}) and set as the ${cols}x${rows} default`);
    return { region, cols, rows };
  }

  /**
   * Teach mode: show the sweep plan (lime = cells judged occupied, dark =
   * judged empty and skipped) and let the user correct it. Numpad 8 accepts;
   * Numpad 9 asks for a click or drag-box over misjudged cells — those cells
   * TOGGLE (skipped ones get hovered, planned ones get dropped), the labels
   * persist for tuning, and the plan re-shows until accepted.
   */
  private async teachOccupancy(
    source: SourceTab,
    planned: GridCell[],
    cellAt: (r: number, c: number) => GridCell,
    region: { x: number; y: number; w: number; h: number },
    cols: number,
    rows: number,
  ): Promise<GridCell[]> {
    const cellW = region.w / cols;
    const cellH = region.h / rows;
    let current = [...planned];
    for (let round = 0; round < 8; round += 1) {
      const rects = current.map((cell) => ({
        x: Math.round(cell.x - cellW / 2),
        y: Math.round(cell.y - cellH / 2),
        w: Math.round(cellW),
        h: Math.round(cellH),
        kind: "found" as const,
      }));
      const verdict = await this.ctx.harness.confirmPlan(
        rects,
        `occupancy plan: ${current.length} cell(s) to read`,
      );
      if (verdict === "good") return current;
      const correction = await this.ctx.harness.captureCorrection("occupancy plan", {
        x: Math.round(region.x + region.w / 2),
        y: Math.round(region.y + region.h / 2),
      });
      if (!correction) continue;
      const box = correction.box ?? {
        x: (correction.corrected?.x ?? 0) - 4,
        y: (correction.corrected?.y ?? 0) - 4,
        w: 8,
        h: 8,
      };
      const have = new Set(current.map((cell) => `${cell.row},${cell.col}`));
      let toggled = 0;
      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          const cell = cellAt(r, c);
          // Box-intersects-cell (not centre-in-box): a single click must
          // toggle the cell CONTAINING it, and a dragged box every cell it
          // touches.
          const cw = region.w / cols;
          const ch = region.h / rows;
          const intersects =
            box.x < cell.x + cw / 2 &&
            box.x + box.w > cell.x - cw / 2 &&
            box.y < cell.y + ch / 2 &&
            box.y + box.h > cell.y - ch / 2;
          if (!intersects) continue;
          const key = `${cell.row},${cell.col}`;
          toggled += 1;
          try {
            recordOccupancyLabel(this.ctx.options.root, {
              timestamp: new Date().toISOString(),
              area: "stash",
              row: cell.row,
              col: cell.col,
              perceivedOccupied: have.has(key),
              label: "wrong",
              evidenceHash: `${source.label}#${source.occurrence}`,
              screenshotId: "teach-occupancy",
            });
          } catch {
            // labels are learning data, never a failure
          }
          if (have.has(key)) {
            have.delete(key);
          } else {
            have.add(key);
          }
        }
      }
      this.ctx.log(`  · teach: toggled ${toggled} cell(s) from your correction`);
      current = [...have].map((key) => {
        const [r, c] = key.split(",").map(Number);
        return cellAt(r!, c!);
      });
      current = clampToArea(current, STASH_AREA);
    }
    return current;
  }

  /**
   * Teach ITEM boundaries: one lime box per identified item (a helmet spans
   * 4 cells but shows as a single 2x2 outline). Numpad 8 accepts; Numpad 9
   * then a dragged box around ONE true item splits/merges the grouping to
   * match, and the corrected footprint (class + true size) is appended to
   * footprint-labels.jsonl as learning data.
   */
  private async teachItems(
    source: SourceTab,
    items: IdentifiedItem[],
    region: { x: number; y: number; w: number; h: number },
    cols: number,
    rows: number,
  ): Promise<IdentifiedItem[]> {
    const key = `${source.label}#${source.occurrence}`;
    const cw = region.w / cols;
    const ch = region.h / rows;
    let current = items;
    for (let round = 0; round < 6; round += 1) {
      const rects = current.map((item) => {
        const minR = Math.min(...item.cells.map((c) => c.row));
        const maxR = Math.max(...item.cells.map((c) => c.row));
        const minC = Math.min(...item.cells.map((c) => c.col));
        const maxC = Math.max(...item.cells.map((c) => c.col));
        return {
          x: Math.round(region.x + minC * cw),
          y: Math.round(region.y + minR * ch),
          w: Math.round((maxC - minC + 1) * cw),
          h: Math.round((maxR - minR + 1) * ch),
          kind: "found" as const,
        };
      });
      const verdict = await this.ctx.harness.confirmPlan(
        rects,
        `${current.length} item(s) found — 8 good · 9 then drag a box around ONE true item`,
      );
      if (verdict === "good") return current;
      const correction = await this.ctx.harness.captureCorrection(`item boundaries ${key}`, {
        x: Math.round(region.x + region.w / 2),
        y: Math.round(region.y + region.h / 2),
      });
      if (!correction?.box) continue;
      const box = correction.box;
      const inBox = (cell: GridCell) =>
        box.x < cell.x + cw / 2 &&
        box.x + box.w > cell.x - cw / 2 &&
        box.y < cell.y + ch / 2 &&
        box.y + box.h > cell.y - ch / 2;
      const affected = current.filter((item) => item.cells.some(inBox));
      if (affected.length === 0) continue;
      const untouched = current.filter((item) => !affected.includes(item));
      const inside = affected.flatMap((item) => item.cells.filter(inBox));
      const outside = affected.flatMap((item) =>
        item.cells.filter((cell) => !inBox(cell)).map((cell) => ({ cell, text: item.text })),
      );
      const next = [...untouched];
      if (inside.length > 0) {
        const lead = affected[0]!;
        next.push({ dest: lead.dest, itemClass: lead.itemClass, text: lead.text, cells: inside });
        const wCells = new Set(inside.map((c) => c.col)).size;
        const hCells = new Set(inside.map((c) => c.row)).size;
        try {
          appendFileSync(
            path.join(this.ctx.options.root, "artifacts", "tab-admin", "footprint-labels.jsonl"),
            JSON.stringify({
              at: new Date().toISOString(),
              tab: key,
              itemClass: lead.itemClass,
              w: wCells,
              h: hCells,
            }) + "\n",
          );
        } catch {
          // learning data, never a failure
        }
        this.ctx.log(`  · teach: item redrawn as ${wCells}x${hCells} (${lead.itemClass ?? "?"})`);
      }
      next.push(...groupIdentifiedCells(outside));
      current = next;
    }
    return current;
  }

  /**
   * Empty a tab of everything that is not its own class — the user's core
   * requirement, driven entirely by Ctrl+C ground truth: index every
   * occupied cell ONCE, then withdraw the foreigners a destination-packed
   * bag-load at a time and file each by its own text (junk to T*).
   */
  /**
   * PHASE 1 of a tab visit, shared by cleanTab and scanTab: index the tab
   * ONCE — geometry (user-taught first, per-tab-kind calibrated defaults,
   * lattice detection), the occupancy scan with the dim-cell rescue, and the
   * Ctrl+C sweep with the persistent phantom store. The caller must already
   * have navigated to the tab. Returns undefined when no geometry source
   * exists (the stash-region-insane guard has fired by then).
   */
  async indexTab(source: SourceTab, key: string): Promise<TabIndex | undefined> {
    let raw: RawFrame = await this.ctx.perception.captureRaw();
    // The scan ALWAYS covers the full grid — trusting pixel occupancy to
    // pick cells let foreigners hide in cells it under-read. Cheap pixel
    // stats only SKIP cells that are unmistakably black; everything else
    // gets hovered. Geometry priority: the USER-TAUGHT grid for this tab,
    // else the user's calibrated default for the perceived grid size, else
    // this frame if sane, else the best seen this session, else the
    // calibration profile. The calibrated default outranks perception
    // because the panel bounds are shared across tabs and a perceived
    // region can pass the sanity check while sitting a full row high —
    // the very failure that made manual calibration necessary.
    this.ctx.perception.loadGridCalibration();
    const taught = this.ctx.gridCalibration[`${source.label}#${source.occurrence}`];
    // Both layouts share the user-calibrated panel bounds; only the
    // number of divisions differs, and the tab's own separator lines say
    // which it is (a taught per-tab entry still outranks detection).
    // TOP-LEVEL tabs render the grid ONE STRIP ROW HIGHER than folder
    // tabs (no second tab row — user-diagnosed via the overlay,
    // 2026-09-01): use the top-level calibration, or shift the folder one.
    const folderBounds =
      this.ctx.gridCalibration["__default_24x24"] ?? this.ctx.gridCalibration["__default_12x12"];
    const bounds = source.topLevel
      ? this.ctx.gridCalibration["__default_24x24_toplevel"] ??
        (folderBounds
          ? { ...folderBounds, y: folderBounds.y + TOP_LEVEL_GRID_DY }
          : undefined)
      : folderBounds;
    if (taught) {
      this.ctx.lastGoodStashGeometry = {
        region: { x: taught.x, y: taught.y, w: taught.w, h: taught.h },
        cols: taught.cols,
        rows: taught.rows,
      };
    } else if (bounds && source.shop) {
      // Merchant tabs are 12x12 by construction (measured 2026-09-02); a
      // full tab's crowded sprites fooled the lattice detector into 24x24
      // live on 2026-09-03, which would have halved every cell.
      this.ctx.log(`  · ${key}: merchant tab — grid pinned to 12x12`);
      this.ctx.lastGoodStashGeometry = {
        region: { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h },
        cols: 12,
        rows: 12,
      };
    } else if (bounds) {
      const { odd, even } = boundaryBrightness24(raw.gray, raw.client, bounds);
      const { divisions, oddMedian, evenMedian } = detectGridDivisions(odd, even);
      this.ctx.log(
        `  · ${key}: grid ${divisions}x${divisions} by lattice lines (odd ${oddMedian.toFixed(0)} vs even ${evenMedian.toFixed(0)})`,
      );
      this.ctx.lastGoodStashGeometry = {
        region: { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h },
        cols: divisions,
        rows: divisions,
      };
    } else {
      // No calibration anywhere — only now is the full perception pass
      // worth its cost (geometry fallback for uncalibrated setups).
      const frame = await this.ctx.perception.captureFrame();
      raw = frame;
      if (stashRegionSane(frame.facts.stashRegion) && frame.facts.stashGridSize) {
        this.ctx.lastGoodStashGeometry = {
          region: frame.facts.stashRegion!,
          cols: frame.facts.stashGridSize.cols,
          rows: frame.facts.stashGridSize.rows,
        };
      }
    }
    if (!this.ctx.lastGoodStashGeometry) {
      const grid = this.ctx.profile.quadStashGrid ?? this.ctx.profile.stashGrid;
      if (grid) {
        this.ctx.lastGoodStashGeometry = {
          region: {
            x: raw.client.left + grid.x,
            y: raw.client.top + grid.y,
            w: grid.w,
            h: grid.h,
          },
          cols: grid.cols ?? 24,
          rows: grid.rows ?? 24,
        };
      }
    }
    if (!this.ctx.lastGoodStashGeometry) {
      this.ctx.harness.guard("stash-region-insane", true);
      return undefined;
    }
    let { region, cols, rows } = this.ctx.lastGoodStashGeometry;
    if ((this.ctx.options.teach || this.ctx.options.teachGrid) && !taught) {
      ({ region, cols, rows } = await this.teachGrid(source, { region, cols, rows }));
      this.ctx.lastGoodStashGeometry = { region, cols, rows };
    }
    const scores = scoreGridCells(raw.gray, raw.client, region, cols, rows);
    const byKey = new Map(scores.map((score) => [`${score.row},${score.col}`, score]));
    const emptyKeys = emptyCellKeysByBaseline(scores);
    const cellAt = (r: number, c: number): GridCell => ({
      row: r,
      col: c,
      x: Math.round(region.x + ((c + 0.5) * region.w) / cols),
      y: Math.round(region.y + ((r + 0.5) * region.h) / rows),
    });
    let occupied: GridCell[] = [];
    let dimRescues = 0;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        if (emptyKeys.has(`${r},${c}`)) {
          // The baseline may only skip cells that are unmistakably black —
          // but tiny dim art (amulets, charms, thin blades) sits UNDER its
          // thresholds: ten small items survived three runs unseen (user
          // screenshot, 2026-09-01). A cell with any block meaningfully
          // brighter than its own floor is not unmistakable: sweep it.
          // Glare cells rescued this way go silent once and land in the
          // phantom store, so the cost is one-time.
          if (!brightestCellPoint(raw.gray, raw.client, region, cols, rows, { row: r, col: c })) {
            continue;
          }
          dimRescues += 1;
        }
        occupied.push(cellAt(r, c));
      }
    }
    if (dimRescues > 0) {
      this.ctx.harness.guard("dim-cell-rescued", true);
      this.ctx.log(
        `  · ${key}: ${dimRescues} baseline-empty cell(s) hold bright blocks — sweeping them too`,
      );
    }
    occupied = clampToArea(
      occupied,
      source.topLevel ? STASH_AREA_TOP_LEVEL : STASH_AREA,
    ).filter((cell) => !this.phantomStash.has(this.phantomKey(source, cell)));
    // PERSISTED phantoms: cells that survived the full probe battery in a
    // previous run are skipped outright while their pixel SIGNATURE still
    // matches — a real item landing there changes the signature and gets
    // probed normally. This is what stops the per-run "clicking around"
    // grind on the same glare cells.
    const phantomStore = this.ctx.perception.loadPhantomStore();
    const tabKey = `${source.label}#${source.occurrence}`;
    let phantomsSkipped = 0;
    occupied = occupied.filter((cell) => {
      const stored = phantomStore.get(`${tabKey}:${cell.row},${cell.col}`);
      if (!stored) return true;
      const score = byKey.get(`${cell.row},${cell.col}`);
      if (score && phantomSignatureMatches(stored, score)) {
        phantomsSkipped += 1;
        return false;
      }
      return true;
    });
    if (phantomsSkipped > 0) {
      this.ctx.harness.guard("phantom-cells-skipped", true);
      this.ctx.log(
        `  · ${key}: skipping ${phantomsSkipped} known phantom cell(s) (signatures unchanged)`,
      );
    }
    if (this.ctx.options.teach) {
      occupied = await this.teachOccupancy(source, occupied, cellAt, region, cols, rows);
    }
    if (occupied.length === 0) {
      return { occupiedCount: 0, modelItems: [], reads: [], unread: [], region, cols, rows };
    }
    const sweepOptions = {
      phantomScope: source,
      looksEmpty: (cell: GridCell) => {
        const score = byKey.get(`${cell.row},${cell.col}`);
        return !score || (score.itemFrac < 0.08 && score.variance < 120);
      },
      probePoint: (cell: GridCell) =>
        brightestCellPoint(raw.gray, raw.client, region, cols, rows, cell),
      sameSpriteAsLeft: (cell: GridCell) =>
        cellEdgeContinuity(raw.gray, raw.client, region, cols, rows, cell.row, cell.col),
      // Persist each phantom the MOMENT it proves silent — a Numpad 0
      // mid-sweep must never throw the probing away (it did, twice).
      onSilent: (cell: GridCell) => {
        const score = byKey.get(`${cell.row},${cell.col}`);
        if (!score) return;
        phantomStore.set(`${tabKey}:${cell.row},${cell.col}`, {
          tab: tabKey,
          row: cell.row,
          col: cell.col,
          mean: score.mean,
          variance: score.variance,
          at: new Date().toISOString(),
        });
        this.ctx.perception.savePhantomStore();
      },
    };
    await this.ctx.step(`${key}: sweeping ${occupied.length}/${cols * rows} cells (black space skipped)`);
    const swept = await this.identifyCells(occupied, sweepOptions);
    const tabReads = new Map<string, { cell: GridCell; text: string }>();
    for (const read of swept.reads) tabReads.set(`${read.cell.row},${read.cell.col}`, read);
    // NO retry pass: the sweep already probes every silent cell deeply
    // (center + informed 140ms probe + blind cross), and onSilent has
    // already persisted each survivor's signature — no later run grinds
    // them again while their pixels stay unchanged.
    const unread = swept.unread;
    if (unread.length > 0) {
      this.ctx.log(
        `! ${key}: ${unread.length} cell(s) never yielded item text — recorded as phantoms ` +
          `(re-probed automatically if their pixels ever change); check them by hand once`,
      );
    }
    const reads = [...tabReads.values()];
    let modelItems = groupIdentifiedCells(reads);
    if (this.ctx.options.teach && modelItems.length > 0) {
      modelItems = await this.teachItems(source, modelItems, region, cols, rows);
    }
    this.ctx.recordObservations(modelItems, key);
    return { occupiedCount: occupied.length, modelItems, reads, unread, region, cols, rows };
  }
}
