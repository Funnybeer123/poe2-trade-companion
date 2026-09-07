/**
 * Gear sorter state machine: redistribute items between the Gear folder's
 * per-slot tabs so each tab holds only its class.
 *
 * Structure follows the rework handoff (docs/HANDOFF-sort-rework.md) with the
 * performance overhaul (docs/HANDOFF-sort-performance.md) applied:
 *
 * - `ensureSession` — unstick the mouse, get stash+inventory open with
 *   bounded recovery, open the Gear folder's strip row once; every tab hop
 *   then goes through the FOLDER side list (its own chevron, its own rows).
 *   The horizontal strip is never used for tab addressing (clipped labels,
 *   merged labels, stalling scroll arrows, phantom entries).
 * - `cleanTab` — identify every occupied cell by Ctrl+C ground truth,
 *   withdraw the foreigners a bag-load at a time, file each by its own text.
 *   Re-sweeps are INCREMENTAL (only cells that could have changed), hovers
 *   are batched, and pixel signatures may skip continuation cells of one
 *   sprite — always verified against the class footprint plus a re-read.
 * - Navigation caches list rows (they never move) and replaces fixed sleeps
 *   with pixel change-detection (`pixwait` host op); OCR runs only when the
 *   cheap paths cannot prove state.
 * - Every click and burst goes through the SortHarness (bullseye + label,
 *   step mode, corrections, overlay hygiene); there are no bare click sends.
 * - Round decisions come from src/core/gearSort.ts so they are unit-tested.
 */
import os from "node:os";
import path from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { StashTabKit, type TabListRow } from "./stashTabKit.js";
import { SortHarness, SortStop } from "./sortHarness.js";
import { labelsEqualFolded, labelsSimilar, normalizeTabLabel } from "../core/tabList.js";
import { isDrainableRemoveOnlyLabel, isRemoveOnlyTabLabel } from "../core/stashTabAdmin.js";
import {
  boundaryBrightness24,
  brightestCellPoint,
  cellEdgeContinuity,
  regionChangedFraction,
  scoreGridCells,
} from "../core/itemSprites.js";
import { loadProfile } from "../core/calibrationStore.js";
import { toScreenBox, type CalibrationProfile } from "../core/calibrationProfile.js";
import {
  CLICK_SURFACES,
  GEAR_TAB_NAMES,
  STASH_AREA,
  STASH_AREA_TOP_LEVEL,
  TOP_LEVEL_GRID_DY,
  bagCompletionVerdict,
  clampToArea,
  canonicalTTabLabel,
  claimNeedsReverify,
  clickRefusal,
  describeBagLeftovers,
  emptyCellKeysByBaseline,
  detectGridDivisions,
  foreignItemsFor,
  groupIdentifiedCells,
  guildDestForItem,
  isTTabLabel,
  packTripByDest,
  phantomSignatureMatches,
  stashRegionSane,
  withdrawObservation,
  type Cell,
  type GridCell,
  type IdentifiedItem,
} from "../core/gearSort.js";
import { STASH_SCAN } from "../core/copyTiming.js";
import { recordOccupancyLabel } from "../core/occupancyLabels.js";
import {
  DEFAULT_MIN_DETOUR_CONFIDENCE,
  findRecordFor,
  isTriageTabLabel,
  routeIdentifiedItem,
  type RoutedItem,
  type SortTriageConfig,
} from "../core/sortTriage.js";
import { inventoryRecordsFor } from "../core/inventoryLedger.js";
import { StashPerception } from "./gearSorter/stashPerception.js";
import { TabNavigation } from "./gearSorter/tabNavigation.js";
import { PARK, LIST_ROW_CLICK_X, GUILD_PACE } from "./gearSorter/context.js";
import type {
  SortHost,
  RawFrame,
  SourceTab,
  TabIndex,
  TabScanResult,
  GearSorterOptions,
  SorterContext,
} from "./gearSorter/context.js";

export type {
  SourceTab,
  TabIndex,
  TabScanResult,
  GearSorterTriageOptions,
  GearSorterOptions,
} from "./gearSorter/context.js";

export class GearSorter {
  private readonly debugDir: string;

  private currentStep = "starting";

  /** The last row this sorter selected (label#occurrence), for the case
   * where a tab's own highlight makes its row unreadable while ACTIVE. */
  private lastSelected: string | undefined;

  /**
   * Bag cells ("row,col") that survived deposit attempts in two DIFFERENT
   * tabs. Ctrl-click routes an item with a stash affinity to its affinity
   * tab regardless of the open tab — a full Unique tab makes every unique
   * undepositable ANYWHERE, and re-clicking it just spams "not enough
   * space" toasts (watched live). Stuck cells are never clicked again; they
   * ride in the bag and are reported at the end.
   */
  private readonly undepositableBag = new Set<string>();

  private readonly stuckObservations = new Map<string, Set<string>>();

  /**
   * Stash cells that read occupied+lit but yield NOTHING when ctrl-clicked
   * (the bag does not grow). They match every query — 9 of them turned every
   * route on the Rings tab into false positives — so once proven they are
   * never targeted again on that tab. Keyed "label#occurrence:row,col".
   */
  private readonly phantomStash = new Set<string>();

  /** Destinations observed FULL this session (their overflow already went to
   * T tabs). Top-level sources skip withdrawing items bound for these —
   * pulling them out would only churn them straight back to a T tab. */
  private readonly fullDests = new Set<string>();

  /** Last stash geometry that perceived sanely — the folder's tabs share
   * panel bounds, so it doubles as a fallback when perception goes blind on
   * one tab (the Boots tab returned NO region/grid on every frame). */
  private lastGoodStashGeometry:
    | { region: { x: number; y: number; w: number; h: number }; cols: number; rows: number }
    | undefined;

  private readonly log: (line: string) => void;

  private phantomKey(source: SourceTab, cell: GridCell): string {
    return `${source.label}#${source.occurrence}:${cell.row},${cell.col}`;
  }

  /** Scratch dir for the per-frame capture BMPs (24MB each, created and
   * deleted hundreds of times per run) — the system temp dir, NOT the
   * OneDrive-synced repo, whose sync watcher taxes rapid create/delete. */
  private readonly captureScratchDir: string;

  private readonly ctx: SorterContext;
  private readonly perception: StashPerception;
  private readonly navigation: TabNavigation;

  constructor(
    private readonly host: SortHost,
    private readonly harness: SortHarness,
    private readonly kit: StashTabKit,
    private readonly options: GearSorterOptions,
  ) {
    this.debugDir = path.join(options.root, "artifacts", "tab-admin", "debug");
    mkdirSync(this.debugDir, { recursive: true });
    this.captureScratchDir = path.join(os.tmpdir(), "poe2-sort-captures");
    mkdirSync(this.captureScratchDir, { recursive: true });
    this.log = options.log ?? ((line) => console.log(line));
    this.runId = options.runId ?? `run-${Date.now().toString(36)}`;
    this.ctx = GearSorter.contextFor(this);
    this.perception = new StashPerception(this.ctx);
    this.navigation = new TabNavigation(this.ctx);
  }

  /**
   * The modules' view of one sorter: fixed collaborators, the shared
   * helpers, accessors over the state more than one module touches, and
   * the modules themselves (constructed right after this in the
   * constructor, hence the lazy getters).
   */
  private static contextFor(sorter: GearSorter): SorterContext {
    return {
      host: sorter.host,
      harness: sorter.harness,
      kit: sorter.kit,
      options: sorter.options,
      log: sorter.log,
      debugDir: sorter.debugDir,
      captureScratchDir: sorter.captureScratchDir,
      get guildChest() {
        return sorter.guildChest;
      },
      get profile() {
        return sorter.profile;
      },
      titleMatchesChest: (text) => sorter.titleMatchesChest(text),
      park: () => sorter.park(),
      surfaceClick: (x, y, surface, why) => sorter.surfaceClick(x, y, surface, why),
      get lastGoodStashGeometry() {
        return sorter.lastGoodStashGeometry;
      },
      set lastGoodStashGeometry(value) {
        sorter.lastGoodStashGeometry = value;
      },
      get lastStashProofAt() {
        return sorter.lastStashProofAt;
      },
      set lastStashProofAt(value) {
        sorter.lastStashProofAt = value;
      },
      get lastSelected() {
        return sorter.lastSelected;
      },
      set lastSelected(value) {
        sorter.lastSelected = value;
      },
      get folderRowsCache() {
        return sorter.folderRowsCache;
      },
      set folderRowsCache(value) {
        sorter.folderRowsCache = value;
      },
      knownTopLabels: sorter.knownTopLabels,
      get gridCalibration() {
        return sorter.gridCalibration;
      },
      set gridCalibration(value) {
        sorter.gridCalibration = value;
      },
      get perception() {
        return sorter.perception;
      },
      get navigation() {
        return sorter.navigation;
      },
    };
  }

  get lastStep(): string {
    return this.currentStep;
  }

  private get guildChest(): boolean {
    return this.options.chest === "guild";
  }

  /**
   * Chest-specific panel-title match, specific in BOTH directions: "Guild
   * Stash" contains "stash", so the personal check must reject it or a
   * guild panel left open would pass for the personal stash (and vice
   * versa a bare /stash/ guild check would accept the personal panel).
   */
  private titleMatchesChest(text: string): boolean {
    return this.guildChest
      ? /guild/i.test(text) && /stash/i.test(text)
      : /stash/i.test(text) && !/guild/i.test(text);
  }

  private async step(text: string): Promise<void> {
    this.currentStep = text;
    this.log(`  · ${text}`);
    await this.harness.checkpoint(text);
  }

  /** Calibration profile, loaded once — captureFrame used to re-read the
   * JSON from disk on every single frame. */
  private profileCache: CalibrationProfile | undefined;

  private get profile(): CalibrationProfile {
    this.profileCache ??= loadProfile(this.options.templateDir);
    return this.profileCache;
  }

  /**
   * Click through the harness ONLY after the point passes its surface check:
   * every surface automation touches is declared (strip bands, dropdown,
   * grids, search box), and a click outside its surface is refused BEFORE
   * sending — a strip click computed while the strip was off screen once
   * sprayed the top-left of the bare world, and a drifted cached row Y would
   * land in the game world. Refusals are guarded so misfires are measurable,
   * and callers treat a refusal like a failed click: diagnose, never retry
   * the same point blind.
   */
  private async surfaceClick(
    x: number,
    y: number,
    surface: keyof typeof CLICK_SURFACES,
    why: string,
  ): Promise<boolean> {
    const refusal = clickRefusal({ x, y }, CLICK_SURFACES[surface]);
    if (this.harness.guard("click-surface-refused", refusal !== undefined)) {
      this.log(`  ! refusing click "${why}" at (${x},${y}) — ${refusal}`);
      return false;
    }
    await this.harness.click(x, y, why);
    return true;
  }

  private async park(): Promise<void> {
    await this.host.send({ op: "move", ...PARK });
  }

  /**
   * The last moment a POSITIVE stash proof succeeded (title OCR, grid
   * lattice, or an observed panel repaint). Full-screen OCR proofs cost
   * 1.5-2s each and the trip cycle was paying several per hop for a panel
   * that verifiably repainted moments earlier — a fresh proof (<20s, no
   * anomaly since) stands in for a new one. Any recovery entry or
   * unobserved click resets the freshness to zero.
   */
  private lastStashProofAt = 0;

  /* ---------------- ensureSession ---------------- */

  async ensureSession(): Promise<void> {
    const endPhase = this.harness.startPhase("ensure-session");
    try {
      // A process killed mid-click leaves the virtual left button LATCHED —
      // the game then eats every click. A tiny drag in the dead zone clears it.
      await this.host.send({ op: "drag", x: PARK.x, y: PARK.y, x2: PARK.x + 2, y2: PARK.y + 2 });
      await this.harness.sleep(300, false);
      if (!(await this.navigation.ensureStash())) throw new Error("stash-not-openable");
      // The guild stash has NO Gear folder — every tab is top-level.
      if (!this.guildChest && !(await this.navigation.ensureFolderRowOpen())) {
        throw new Error("gear-folder-row-not-openable");
      }
      // The Highlight (search) box is never touched any more — the user
      // confirmed it is unused (2026-09-01), and ground-truth Ctrl+C
      // identification does not care about dimming. If a stale query ever
      // dims a tab, clear it by hand.
      endPhase();
    } catch (error) {
      endPhase(error instanceof SortStop ? "stopped" : "failed");
      throw error;
    }
  }

  /** Folder-list rows from the last verified read. Rows never move while the
   * stash stays open, so a cached read addresses every later hop without
   * OCR; any failed verification invalidates the cache. */
  private folderRowsCache: TabListRow[] | undefined;

  /** See TabNavigation.gotoTab. */
  async gotoTab(
    label: string,
    occurrence = 0,
    topLevel = false,
    rowY?: number,
    drain = false,
    shop = false,
  ): Promise<boolean> {
    return this.navigation.gotoTab(label, occurrence, topLevel, rowY, drain, shop);
  }

  /** Canonical top-strip labels seen readable this session. Together with
   * the one-time unmask hop this tells "unreadable because ACTIVE" apart
   * from "does not exist". */
  private readonly knownTopLabels = new Set<string>();

  /** See TabNavigation.listTopSources. */
  async listTopSources(): Promise<SourceTab[]> {
    return this.navigation.listTopSources();
  }

  /** See TabNavigation.listRemoveOnlySources. */
  async listRemoveOnlySources(): Promise<SourceTab[]> {
    return this.navigation.listRemoveOnlySources();
  }

  /* ---------------- deposit ---------------- */

  /** Bag cells that are still worth clicking (not known-undepositable). */
  private depositTargets(cells: readonly GridCell[]): GridCell[] {
    return cells.filter((cell) => !this.undepositableBag.has(`${cell.row},${cell.col}`));
  }

  /** A cell bounced (plain AND shifted) in this tab; two different tabs = blacklist. */
  private markStuck(cells: readonly GridCell[], destLabel: string): void {
    for (const cell of cells) {
      const key = `${cell.row},${cell.col}`;
      const seen = this.stuckObservations.get(key) ?? new Set<string>();
      seen.add(destLabel);
      this.stuckObservations.set(key, seen);
      if (seen.size >= 2 && !this.undepositableBag.has(key)) {
        this.undepositableBag.add(key);
        this.log(
          `  · bag cell ${key} undepositable in ${[...seen].join(" and ")} — leaving it alone (quest item?)`,
        );
      }
    }
  }

  /* ---------------- triage ---------------- */

  /**
   * Hover a bag cell and Ctrl+C its item text, sentinel-verified, restoring
   * the user's clipboard afterwards. Stop/pause land inside harness.sleep.
   */
  private async copyItemAt(x: number, y: number, hoverMs?: number): Promise<string> {
    const original = await this.host.send({ op: "clipboard" });
    const originalText = String(original.text ?? "");
    const sentinel = `poe2-triage-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    try {
      await this.host.send({ op: "move", x, y });
      await this.harness.sleep(hoverMs ?? STASH_SCAN.inventory.hoverMs, false);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const cleared = await this.host.send({ op: "setclipboard", text: sentinel });
        if (!cleared.ok) return "";
        await this.host.send({ op: "hotkey", keys: "ctrlc" });
        await this.harness.sleep(
          attempt === 0 ? STASH_SCAN.inventory.copyMs + 30 : STASH_SCAN.inventory.afterMs + 50,
          false,
        );
        const copied = await this.host.send({ op: "clipboard" });
        const text = String(copied.text ?? "");
        if (copied.ok && text !== sentinel && /Item Class:/i.test(text)) return text;
      }
      return "";
    } finally {
      await this.host.send({ op: "setclipboard", text: originalText });
    }
  }

  /* ---------------- foreign-item purge ---------------- */

  /** The T tab that most recently accepted junk — tried first so a junk trip
   * usually needs no list enumeration at all. */
  private lastJunkTab: string | undefined;

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
  private async identifyCells(
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
      await this.harness.checkpoint(label);
      if (sweepDebug) {
        this.log(`    [sweep] row ${target[0]!.row}: ${target.length} cell(s) (${label})`);
      }
      const sentinel = `poe2-sweep-${Date.now()}-${target[0]!.row}`;
      const reply = await this.host.send({
        op: "copysweep",
        points: target.map((cell) => ({ x: cell.x, y: cell.y })),
        // 100ms turbo hover (99.8% read-rate pedigree, 419/420 live). A
        // 90ms retest on 2026-09-01 was inconclusive: the 23 unread cells
        // it hit were unreadable at 100ms too (a persistent silent cluster
        // in Dump, not a speed effect). Keeping 100ms as the proven
        // setting; a future 90ms retest needs a FULL tab, not the residue.
        hoverMs: this.options.turbo ? 100 : 130,
        sentinel,
      });
      const texts = Array.isArray(reply.texts) ? (reply.texts as string[]) : undefined;
      if (!reply.ok || !texts || texts.length !== target.length) {
        // Host too old or the sweep failed — per-cell fallback for this row.
        this.harness.guard("copysweep-fallback", true);
        for (const cell of target) {
          await this.harness.checkpoint(label);
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
        this.harness.guard("claim-reverify", true);
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
      await this.harness.checkpoint("identifying items (offset retry)");
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
        this.log(`  · cell ${cell.row},${cell.col} yields no item text three times — phantom, blacklisted`);
      } else {
        unread.push(cell);
      }
    }
    await this.park();
    if (unread.length > 0) {
      this.log(`  · read ${reads.length}/${cells.length} cells (${unread.length} unread this pass)`);
    }
    return { items: groupIdentifiedCells(reads), unread, reads };
  }

  /**
   * Deposit specific bag cells into the ACTIVE tab: plain ctrl-clicks, one
   * shift+ctrl retry for affinity bounces, stuck-marking for the rest.
   */
  /**
   * Verified-serial withdrawal for the guild stash: ONE ctrl-click at a
   * time, the next only after the bag pixel-verifiably GREW (the item
   * committed). No growth within the timeout = rollback/refusal — that is
   * a STOP signal for the batch (pace down, let the next round re-verify
   * state), never a retry hammer. Returns the items that actually left.
   */
  private async guildWithdrawSerial(
    batch: readonly IdentifiedItem[],
    leaving: readonly IdentifiedItem[],
    key: string,
  ): Promise<IdentifiedItem[]> {
    const withdrawn: IdentifiedItem[] = [];
    const paceMs = () => Math.round(GUILD_PACE.itemMs * Math.max(1, this.harness.pace));
    for (const item of batch) {
      const before = await this.perception.bagCount();
      const sent = await this.harness.burst([item.cells[0]!], {
        found: leaving.flatMap((entry) => entry.cells),
        cellW: 56,
        cellH: 56,
        label: `guild withdraw ${withdrawn.length + 1}/${batch.length} (${key})`,
      });
      if (sent === 0) return withdrawn; // rejected or dry-run
      // Poll for the commit: the bag grew. Unpaced reads — the pacing
      // interval below is the rate limiter, not these.
      let committed = false;
      const deadline = Date.now() + GUILD_PACE.commitTimeoutMs;
      while (Date.now() < deadline) {
        await this.harness.sleep(450, false);
        if ((await this.perception.bagCount()) > before) {
          committed = true;
          break;
        }
      }
      if (!committed) {
        this.harness.guard("guild-withdraw-rollback", true);
        this.harness.paceDown();
        await this.step(
          `${key}: withdrawal did not commit (rollback/refusal) — stopping this batch, pace down`,
        );
        return withdrawn;
      }
      withdrawn.push(item);
      await this.harness.sleep(paceMs(), false);
    }
    return withdrawn;
  }

  /**
   * Verified-serial deposit for the guild stash: one plain ctrl-click at a
   * time (no affinities exist — the item lands in the OPEN tab, and shift
   * adds nothing), each verified by the TWO-READ bounce check before the
   * next. A bounce means the tab refused (full) — stop the group, pace
   * down; callers already treat the remainder as a full destination.
   */
  private async guildDepositSerial(points: readonly GridCell[], destLabel: string): Promise<number> {
    const paceMs = () => Math.round(GUILD_PACE.itemMs * Math.max(1, this.harness.pace));
    let remaining = [...points];
    while (remaining.length > 0) {
      const cell = remaining[0]!;
      const sent = await this.harness.burst([cell], {
        cellW: 70,
        cellH: 70,
        label: `guild deposit → ${destLabel} (${remaining.length} left)`,
      });
      if (sent === 0) return remaining.length; // rejected or dry-run
      await this.harness.sleep(700, false);
      const first = new Set((await this.perception.currentBagCells()).map((c) => `${c.row},${c.col}`));
      await this.harness.sleep(650, false);
      const second = new Set((await this.perception.currentBagCells()).map((c) => `${c.row},${c.col}`));
      const stillThere =
        first.has(`${cell.row},${cell.col}`) || second.has(`${cell.row},${cell.col}`);
      if (stillThere) {
        this.harness.guard("guild-deposit-bounced", true);
        this.harness.paceDown();
        this.log(`  · guild deposit into ${destLabel} bounced — treating it as full, pace down`);
        return remaining.length;
      }
      remaining = remaining.slice(1);
      await this.harness.sleep(paceMs(), false);
    }
    return 0;
  }

  private async depositCells(
    points: readonly GridCell[],
    destLabel: string,
    options: { shiftOnly?: boolean } = {},
  ): Promise<number> {
    if (this.guildChest) return this.guildDepositSerial(points, destLabel);
    let targets = [...points];
    // shiftOnly (the shop flow): shift+ctrl targets the OPEN tab outright,
    // so a stash affinity can never divert an item away from the shop tab.
    for (let pass = options.shiftOnly ? 1 : 0; pass < 2 && targets.length > 0; pass += 1) {
      const sent = await this.harness.burst(targets, {
        cellW: 70,
        cellH: 70,
        label: `${pass === 0 ? "deposit" : "deposit (shift)"} ${targets.length} → ${destLabel}`,
        shift: pass === 1,
      });
      if (sent === 0) return targets.length; // rejected or dry-run
      // A bounced deposit (full tab) leaves the cells briefly EMPTY while
      // the items fly back to the bag (0.7-1.3s) — a read inside that
      // window called a full tab a clean deposit and re-filed the same
      // rings for whole rounds (watched live 2026-08-30). ONE read past
      // the window has the same detection power as the old 700ms+650ms
      // pair: their union rule meant the early read could only add an item
      // present at 700ms and gone at 1350ms, which no real bounce produces
      // (watcher-bot analysis #9, 2026-09-01).
      await this.harness.sleep(1450, false);
      const settled = new Set(
        (await this.perception.currentBagCells()).map((cell) => `${cell.row},${cell.col}`),
      );
      targets = targets.filter((cell) => settled.has(`${cell.row},${cell.col}`));
      if (targets.length > 0 && pass === 1) this.markStuck(targets, destLabel);
    }
    return targets.length;
  }

  /** Where finds are attributed while a tab is being cleaned. */
  private findLocation = "bag";

  /** Triage tabs that failed navigation this session — detours to them stop. */
  private readonly unreachableTriageTabs = new Set<string>();

  private triageRouting(): SortTriageConfig | undefined {
    const triage = this.options.triage;
    if (!triage) return undefined;
    // Review/Dump are PERSONAL tabs — a guild session must never detour
    // items toward them (the deposit would land in a guild tab of that
    // name, or nowhere).
    if (this.guildChest) return undefined;
    return {
      evaluate: triage.evaluate,
      routing: triage.routing,
      minDetourConfidence: triage.minDetourConfidence ?? DEFAULT_MIN_DETOUR_CONFIDENCE,
    };
  }

  /** Route through the value tiers, cancelling detours to dead triage tabs. */
  private routeWithFallback(item: IdentifiedItem, config: SortTriageConfig | undefined): RoutedItem {
    const routed = routeIdentifiedItem(item, config);
    if (routed.detoured && this.unreachableTriageTabs.has(routed.dest)) {
      return { ...routed, dest: routed.fallbackDest, detoured: false };
    }
    return routed;
  }

  private recordFind(routed: RoutedItem): void {
    const record = findRecordFor(routed, this.findLocation, new Date().toISOString());
    if (!record) return;
    this.options.triage?.onFind?.(record);
    this.log(
      `  ★ find: ${record.name} (${record.itemClass}) → ${record.routedTo}` +
        (record.valueScore !== undefined
          ? ` [score ${record.valueScore}/100, confidence ${record.confidence}%]`
          : ` [${record.source}]`),
    );
  }

  /** Ledger throttle: one record per fingerprint per location per run. */
  private readonly observedKeys = new Set<string>();

  private readonly runId: string;

  /** Append every identified item to the inventory ledger (never throws). */
  private recordObservations(items: readonly IdentifiedItem[], location: string, partial = false): void {
    const sink = this.options.onObservation;
    if (!sink || items.length === 0) return;
    const records = inventoryRecordsFor(items, {
      location,
      runId: this.runId,
      at: new Date().toISOString(),
      ...(this.options.triage ? { evaluate: this.options.triage.evaluate } : {}),
      partial,
    });
    for (const record of records) {
      const key = `${this.runId}|${location}|${partial ? "p" : "f"}|${record.fingerprint}`;
      if (this.observedKeys.has(key)) continue;
      this.observedKeys.add(key);
      try {
        sink(record);
      } catch {
        // The ledger is a side journal; it must never fail a sort.
      }
    }
  }

  /**
   * File every identifiable bag item into its TRUE tab (junk to T tabs).
   * This is what cleans a "dirty" bag left by interruptions — no blanket
   * cascades into whatever tab is first.
   *
   * The bag is identified ONCE per load and remembered: after a deposit
   * lands, the deposited cells drop out of the model instead of the whole
   * bag being re-copyswept before every group (the old flow re-read a
   * shrinking bag between every filing). The bag-occupancy capture after
   * each deposit is the ground truth that reconciles the model — cells that
   * unexpectedly remain stay modelled, cells that appear get identified.
   */
  private async distributeBag(
    context: { returnTo?: SourceTab; deadDests?: Set<string>; navFailed?: Set<string> } = {},
  ): Promise<number> {
    const endPhase = this.harness.startPhase("distribute-bag");
    let filed = 0;
    /** cell key -> copy text, valid for this bag-load. */
    const bagReads = new Map<string, { cell: GridCell; text: string }>();
    const cellKey = (cell: GridCell) => `${cell.row},${cell.col}`;
    const stillInBag = async (points: readonly GridCell[]): Promise<GridCell[]> => {
      const occupied = new Set((await this.perception.currentBagCells()).map(cellKey));
      return points.filter((cell) => occupied.has(cellKey(cell)));
    };
    /** Last-resort placement for cells with no reachable home: junk tabs
     * first, then BACK to the tab they came from — the user's new layout has
     * no Weapons quad and no T tabs, so an axe in the Dump tab must return
     * to Dump rather than ride the bag forever and stall the run. Returns
     * how many cells remain stuck in the bag. */
    const bail = async (points: readonly GridCell[]): Promise<number> => {
      let remaining = await stillInBag(points);
      if (remaining.length === 0) return 0;
      await this.depositJunkCells(remaining);
      remaining = await stillInBag(remaining);
      // A drain source is NEVER a bail target: the game refuses deposits
      // into Remove-only tabs, so the return trip would silently fail and
      // spam refused clicks. The cells ride in the bag instead — deadDests
      // already stops further withdrawals of their class, and the run-end
      // report lists what is left.
      if (remaining.length > 0 && context.returnTo?.drain) {
        this.harness.guard("bail-skipped-drain-source", true);
        this.log(
          `  · ${remaining.length} cell(s) have no reachable home and the source is Remove-only — they ride in the bag`,
        );
        return remaining.length;
      }
      if (remaining.length > 0 && context.returnTo) {
        this.harness.guard("bag-bailed-to-source", true);
        await this.step(
          `${remaining.length} cell(s) have no reachable home — returning them to ${context.returnTo.label}`,
        );
        const back = context.returnTo;
        try {
          if (await this.navigation.gotoTab(back.label, back.occurrence, back.topLevel, back.rowY)) {
            await this.depositCells(remaining, back.label);
            remaining = await stillInBag(remaining);
          }
        } catch (error) {
          // A failed RETURN trip must not kill the whole run — the cells
          // simply ride in the bag to the next round / the final report.
          if (error instanceof SortStop) throw error;
          this.harness.guard("bail-return-failed", true);
          this.log(`  ! could not return ${remaining.length} cell(s) to ${back.label}: ${String(error instanceof Error ? error.message : error)}`);
        }
      }
      return remaining.length;
    };
    try {
      for (let round = 0; round < 12; round += 1) {
        const bag = this.depositTargets(await this.perception.currentBagCells());
        if (bag.length === 0) {
          endPhase();
          return filed;
        }
        // Reconcile the model with reality: forget cells that left the bag,
        // read only the cells the model does not know yet.
        const present = new Set(bag.map(cellKey));
        for (const key of [...bagReads.keys()]) {
          if (!present.has(key)) bagReads.delete(key);
        }
        const unknown = bag.filter((cell) => !bagReads.has(cellKey(cell)));
        if (unknown.length > 0) {
          await this.step(`identifying ${unknown.length}/${bag.length} bag cells`);
          const raw = await this.perception.captureRaw();
          const bagGridBox = this.profile.bagGrid
            ? toScreenBox(raw.client, this.profile.bagGrid)
            : undefined;
          const { reads } = await this.identifyCells(unknown, {
            probePoint: bagGridBox
              ? (cell) => brightestCellPoint(raw.gray, raw.client, bagGridBox, 12, 5, cell)
              : undefined,
          });
          for (const read of reads) bagReads.set(cellKey(read.cell), read);
          this.recordObservations(groupIdentifiedCells(reads), "bag");
        }
        let items = groupIdentifiedCells([...bagReads.values()]);
        if (items.length === 0) {
          endPhase("bag-unreadable");
          return filed;
        }
        // Guild taxonomy remap, re-evaluated every round so a dest that
        // went full/dead mid-visit re-routes to its chain partner.
        if (this.guildChest) {
          const unavailable = new Set<string>([...this.fullDests, ...(context.deadDests ?? [])]);
          items = items.map((item) => ({ ...item, dest: guildDestForItem(item, unavailable) }));
        }
        // Value triage rides on the identification we already have: a
        // confident keep/sell detours to Review/Sell, a rule-dumped item to
        // Dump, everything else keeps its class destination.
        const config = this.triageRouting();
        const routed = items.map((item) => this.routeWithFallback(item, config));
        for (const entry of routed) {
          if (entry.detoured) this.recordFind(entry);
        }
        // Largest group first; the model carries the rest to later rounds
        // without re-reading them. Destinations already proven dead this
        // visit are bailed instead of re-probed every round.
        const groups = new Map<string, RoutedItem[]>();
        for (const entry of routed) {
          groups.set(entry.dest, [...(groups.get(entry.dest) ?? []), entry]);
        }
        const viable = [...groups.entries()]
          .filter(([groupDest]) => groupDest === "junk" || !context.deadDests?.has(groupDest))
          .sort((a, b) => b[1].length - a[1].length);
        if (viable.length === 0) {
          const stuck = await bail(routed.map((entry) => entry.item.cells[0]!));
          endPhase(stuck > 0 ? "dead-dests" : "bailed");
          return filed;
        }
        const [dest, group] = viable[0]!;
        const grabPoints = group.map((entry) => entry.item.cells[0]!);
        await this.step(`filing ${group.length} item(s) → ${dest}`);
        if (dest === "junk") {
          const left = await bail(grabPoints);
          filed += group.length - Math.min(group.length, left);
          if (left > 0) {
            endPhase("junk-stuck");
            return filed;
          }
          continue;
        }
        // Guild mode has no Gear folder: destination tabs are TOP-LEVEL
        // guild tabs of the same class names (whichever exist — missing
        // ones go dead and their items stay in the source, reported).
        if (!(await this.navigation.gotoTab(dest, 0, this.guildChest))) {
          const detours = group.filter((entry) => entry.detoured);
          if (detours.length === group.length) {
            // A dead triage tab must not loop the round forever: cancel
            // detours to it for the session; items re-route to class tabs.
            this.harness.guard("triage-tab-unreachable", true);
            this.unreachableTriageTabs.add(dest);
            this.log(`  ! triage tab "${dest}" unreachable — routing those items normally instead`);
            continue;
          }
          // Destination unreachable. Distinguish a NAVIGATION failure from
          // a genuinely missing tab (the layout has no Weapons quad since
          // the 2026-08-30 rework): a known gear tab that cannot be reached
          // right now gets ONE retry on a later trip before it is declared
          // dead — one flaky goto once dead-marked Helmets right after it
          // had accepted 12 deposits and stranded 7 items for the visit
          // (live 2026-09-01). Either way this group bails now.
          const knownTab = GEAR_TAB_NAMES.some((name) => labelsEqualFolded(name, dest));
          if (knownTab && context.navFailed && !context.navFailed.has(dest)) {
            context.navFailed.add(dest);
            this.harness.guard("dest-nav-failed-retry-later", true);
            this.log(`  ! "${dest}" navigation failed — items return to the source for one retry later`);
          } else {
            this.harness.guard("dest-unreachable-marked-dead", true);
            context.deadDests?.add(dest);
            this.log(`  ! "${dest}" unreachable — its items return to the source and stop being withdrawn`);
          }
          const left = await bail(grabPoints);
          filed += group.length - Math.min(group.length, left);
          continue;
        }
        const left = await this.depositCells(grabPoints, dest);
        filed += group.length - Math.min(group.length, left);
        // A clean deposit is a verified sighting at the destination (partial:
        // it adds to that tab's ledger contents without retiring anything).
        if (left === 0) this.recordObservations(group.map((entry) => entry.item), dest, true);
        if (left >= grabPoints.length) {
          if (group.every((entry) => entry.detoured)) {
            // A FULL triage tab must not push valuables into the junk flow:
            // stop detouring to it and let the items file to class tabs.
            this.harness.guard("triage-tab-full", true);
            this.unreachableTriageTabs.add(dest);
            await this.step(`${dest} is full — valuables route to their class tabs instead`);
            continue;
          }
          // The home tab refused the WHOLE group (full). A full home tab in
          // the same spot every round never trips the two-tab stuck rule —
          // overflow to junk tabs, else back to the source.
          this.harness.guard("home-tab-full-overflow", true);
          this.fullDests.add(dest);
          context.deadDests?.add(dest);
          await this.step(`${dest} is full — overflowing ${grabPoints.length} item(s)`);
          const junkLeft = await bail(grabPoints);
          filed += grabPoints.length - Math.min(grabPoints.length, junkLeft);
        }
      }
      endPhase("round-limit");
      return filed;
    } catch (error) {
      endPhase(error instanceof SortStop ? "stopped" : "failed");
      throw error;
    }
  }

  /** Deposit the given bag cells into T* tabs (top-level), cascading on
   * refusal. The tab that last accepted junk is tried first (no list read);
   * further candidates come from one top-list enumeration. */
  private async depositJunkCells(points: readonly GridCell[]): Promise<number> {
    // Layouts without any junk (T*) tab: once the strip has been read and
    // showed none, stop re-checking on every call.
    if (
      !this.lastJunkTab &&
      this.knownTopLabels.size >= 2 &&
      ![...this.knownTopLabels].some((label) => isTTabLabel(label))
    ) {
      return points.length;
    }
    let targets = [...points];
    const tried = new Set<string>();
    const fileInto = async (label: string): Promise<void> => {
      tried.add(label);
      const before = targets.length;
      const left = await this.depositCells(targets, label);
      if (left < before) {
        await this.step(`junk: filed ${before - left} into ${label}`);
        this.lastJunkTab = label;
      }
      if (left === 0) {
        targets = [];
        return;
      }
      const still = new Set((await this.perception.currentBagCells()).map((cell) => `${cell.row},${cell.col}`));
      targets = targets.filter((cell) => still.has(`${cell.row},${cell.col}`));
    };
    if (this.lastJunkTab && targets.length > 0 && (await this.navigation.gotoTopTab(this.lastJunkTab))) {
      await fileInto(this.lastJunkTab);
    }
    // Strip candidates next — in a no-overflow layout the top list cannot
    // even open, but every T tab (if any) shows unclipped on the strip.
    let stripHadTTabs = false;
    if (targets.length > 0) {
      const strip = await this.kit.readStrip();
      this.navigation.noteTopStrip(strip.top);
      for (const entry of strip.top) {
        const label = entry.label.trim();
        if (!isTTabLabel(label) || isRemoveOnlyTabLabel(label)) continue;
        stripHadTTabs = true;
        if (targets.length === 0 || tried.has(label)) continue;
        if (!(await this.navigation.gotoTopTab(label))) {
          tried.add(label);
          continue;
        }
        await fileInto(label);
      }
    }
    // The dropdown only helps in overflow layouts (strip showed T tabs);
    // without that evidence its toggle does not exist and clicking is dead.
    for (let round = 0; round < 4 && stripHadTTabs && targets.length > 0; round += 1) {
      let rows: TabListRow[];
      try {
        rows = await this.navigation.openTopList(2);
      } catch {
        break;
      }
      const candidate = rows.find(
        (row) =>
          row.readable &&
          !tried.has(row.label) &&
          isTTabLabel(row.label) &&
          !isRemoveOnlyTabLabel(row.label),
      );
      if (!candidate) break;
      tried.add(candidate.label);
      if (
        !(await this.surfaceClick(
          LIST_ROW_CLICK_X,
          candidate.clickY,
          "tabList",
          `select junk tab ${candidate.label}`,
        ))
      ) {
        continue;
      }
      this.lastSelected = `top:${candidate.label}#0`;
      await this.park();
      await this.harness.sleep(300);
      await this.navigation.closeTopListFast();
      await fileInto(candidate.label);
    }
    return targets.length;
  }

  /** User-taught grid geometry per tab, persisted across sessions. */
  private gridCalibration: Record<string, { x: number; y: number; w: number; h: number; cols: number; rows: number }> = {};

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
    const sizeDefault = this.gridCalibration[`__default_${cols}x${rows}`];
    if (sizeDefault) {
      region = { x: sizeDefault.x, y: sizeDefault.y, w: sizeDefault.w, h: sizeDefault.h };
    }
    for (let round = 0; round < 10; round += 1) {
      const verdict = await this.harness.confirmPlan(
        this.perception.latticeRects(region, cols, rows),
        `grid ${cols}x${rows} — 8 good · 9 then DRAG corners (or click = toggle 12/24)`,
      );
      if (verdict === "good") break;
      const correction = await this.harness.captureCorrection(`grid bounds ${key}`, {
        x: Math.round(region.x + region.w / 2),
        y: Math.round(region.y + region.h / 2),
      });
      if (correction?.box && correction.box.w > 400 && correction.box.h > 400) {
        region = { x: correction.box.x, y: correction.box.y, w: correction.box.w, h: correction.box.h };
        this.log(`  · teach: grid bounds redrawn to ${JSON.stringify(region)}`);
      } else if (correction) {
        cols = cols === 24 ? 12 : 24;
        rows = rows === 24 ? 12 : 24;
        this.log(`  · teach: grid size toggled to ${cols}x${rows}`);
      }
    }
    this.gridCalibration[key] = { ...region, cols, rows };
    // The panel bounds are shared: the first corrected grid becomes the
    // starting lattice for every other tab of the same size, so one drag
    // calibrates them all (later tabs just need a Numpad 8).
    this.gridCalibration[`__default_${cols}x${rows}`] = { ...region, cols, rows };
    this.perception.saveGridCalibration();
    this.log(`  · teach: grid for ${key} saved (${cols}x${rows}) and set as the ${cols}x${rows} default`);
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
      const verdict = await this.harness.confirmPlan(
        rects,
        `occupancy plan: ${current.length} cell(s) to read`,
      );
      if (verdict === "good") return current;
      const correction = await this.harness.captureCorrection("occupancy plan", {
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
            recordOccupancyLabel(this.options.root, {
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
      this.log(`  · teach: toggled ${toggled} cell(s) from your correction`);
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
      const verdict = await this.harness.confirmPlan(
        rects,
        `${current.length} item(s) found — 8 good · 9 then drag a box around ONE true item`,
      );
      if (verdict === "good") return current;
      const correction = await this.harness.captureCorrection(`item boundaries ${key}`, {
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
            path.join(this.options.root, "artifacts", "tab-admin", "footprint-labels.jsonl"),
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
        this.log(`  · teach: item redrawn as ${wCells}x${hCells} (${lead.itemClass ?? "?"})`);
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
  private async indexTab(source: SourceTab, key: string): Promise<TabIndex | undefined> {
    let raw: RawFrame = await this.perception.captureRaw();
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
    this.perception.loadGridCalibration();
    const taught = this.gridCalibration[`${source.label}#${source.occurrence}`];
    // Both layouts share the user-calibrated panel bounds; only the
    // number of divisions differs, and the tab's own separator lines say
    // which it is (a taught per-tab entry still outranks detection).
    // TOP-LEVEL tabs render the grid ONE STRIP ROW HIGHER than folder
    // tabs (no second tab row — user-diagnosed via the overlay,
    // 2026-09-01): use the top-level calibration, or shift the folder one.
    const folderBounds =
      this.gridCalibration["__default_24x24"] ?? this.gridCalibration["__default_12x12"];
    const bounds = source.topLevel
      ? this.gridCalibration["__default_24x24_toplevel"] ??
        (folderBounds
          ? { ...folderBounds, y: folderBounds.y + TOP_LEVEL_GRID_DY }
          : undefined)
      : folderBounds;
    if (taught) {
      this.lastGoodStashGeometry = {
        region: { x: taught.x, y: taught.y, w: taught.w, h: taught.h },
        cols: taught.cols,
        rows: taught.rows,
      };
    } else if (bounds && source.shop) {
      // Merchant tabs are 12x12 by construction (measured 2026-09-02); a
      // full tab's crowded sprites fooled the lattice detector into 24x24
      // live on 2026-09-03, which would have halved every cell.
      this.log(`  · ${key}: merchant tab — grid pinned to 12x12`);
      this.lastGoodStashGeometry = {
        region: { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h },
        cols: 12,
        rows: 12,
      };
    } else if (bounds) {
      const { odd, even } = boundaryBrightness24(raw.gray, raw.client, bounds);
      const { divisions, oddMedian, evenMedian } = detectGridDivisions(odd, even);
      this.log(
        `  · ${key}: grid ${divisions}x${divisions} by lattice lines (odd ${oddMedian.toFixed(0)} vs even ${evenMedian.toFixed(0)})`,
      );
      this.lastGoodStashGeometry = {
        region: { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h },
        cols: divisions,
        rows: divisions,
      };
    } else {
      // No calibration anywhere — only now is the full perception pass
      // worth its cost (geometry fallback for uncalibrated setups).
      const frame = await this.perception.captureFrame();
      raw = frame;
      if (stashRegionSane(frame.facts.stashRegion) && frame.facts.stashGridSize) {
        this.lastGoodStashGeometry = {
          region: frame.facts.stashRegion!,
          cols: frame.facts.stashGridSize.cols,
          rows: frame.facts.stashGridSize.rows,
        };
      }
    }
    if (!this.lastGoodStashGeometry) {
      const grid = this.profile.quadStashGrid ?? this.profile.stashGrid;
      if (grid) {
        this.lastGoodStashGeometry = {
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
    if (!this.lastGoodStashGeometry) {
      this.harness.guard("stash-region-insane", true);
      return undefined;
    }
    let { region, cols, rows } = this.lastGoodStashGeometry;
    if ((this.options.teach || this.options.teachGrid) && !taught) {
      ({ region, cols, rows } = await this.teachGrid(source, { region, cols, rows }));
      this.lastGoodStashGeometry = { region, cols, rows };
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
      this.harness.guard("dim-cell-rescued", true);
      this.log(
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
    const phantomStore = this.perception.loadPhantomStore();
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
      this.harness.guard("phantom-cells-skipped", true);
      this.log(
        `  · ${key}: skipping ${phantomsSkipped} known phantom cell(s) (signatures unchanged)`,
      );
    }
    if (this.options.teach) {
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
        this.perception.savePhantomStore();
      },
    };
    await this.step(`${key}: sweeping ${occupied.length}/${cols * rows} cells (black space skipped)`);
    const swept = await this.identifyCells(occupied, sweepOptions);
    const tabReads = new Map<string, { cell: GridCell; text: string }>();
    for (const read of swept.reads) tabReads.set(`${read.cell.row},${read.cell.col}`, read);
    // NO retry pass: the sweep already probes every silent cell deeply
    // (center + informed 140ms probe + blind cross), and onSilent has
    // already persisted each survivor's signature — no later run grinds
    // them again while their pixels stay unchanged.
    const unread = swept.unread;
    if (unread.length > 0) {
      this.log(
        `! ${key}: ${unread.length} cell(s) never yielded item text — recorded as phantoms ` +
          `(re-probed automatically if their pixels ever change); check them by hand once`,
      );
    }
    const reads = [...tabReads.values()];
    let modelItems = groupIdentifiedCells(reads);
    if (this.options.teach && modelItems.length > 0) {
      modelItems = await this.teachItems(source, modelItems, region, cols, rows);
    }
    this.recordObservations(modelItems, key);
    return { occupiedCount: occupied.length, modelItems, reads, unread, region, cols, rows };
  }

  /* ---------------- shop seams (docs/HANDOFF-shop-listings.md) ---------------- */

  /**
   * Read-only tab visit for the shop flow: navigate (the shop flag rides the
   * source) and return the full phase-1 index without withdrawing anything.
   */
  async scanTab(
    source: SourceTab,
    options: {
      /** false = the caller already put the tab on screen (the Merchant
       * panel's own tab strip is not stash navigation); just index it. */
      navigate?: boolean;
    } = {},
  ): Promise<TabScanResult> {
    const key = source.occurrence ? `${source.label}#${source.occurrence}` : source.label;
    const endPhase = this.harness.startPhase(`scan:${key}`);
    this.findLocation = key;
    try {
      if (
        options.navigate !== false &&
        !(await this.navigation.gotoTab(
          source.label,
          source.occurrence,
          source.topLevel,
          source.rowY,
          source.drain,
          source.shop,
        ))
      ) {
        endPhase("source-unreachable");
        return { ok: false, reason: "source-unreachable" };
      }
      const index = await this.indexTab(source, key);
      if (!index) {
        endPhase("no-geometry");
        return { ok: false, reason: "no-geometry" };
      }
      endPhase();
      return { ok: true, ...index };
    } catch (error) {
      endPhase(error instanceof SortStop ? "stopped" : "failed");
      throw error;
    } finally {
      this.findLocation = "bag";
    }
  }

  /** Current occupied bag cells (pixel occupancy), for the shop flow. */
  async bagCellsNow(): Promise<GridCell[]> {
    return this.perception.currentBagCells();
  }

  /** See StashPerception.occupiedStashCellsNow. */
  async occupiedStashCellsNow(
    geometry?: { region: { x: number; y: number; w: number; h: number }; cols: number; rows: number },
    topLevel = false,
  ): Promise<GridCell[]> {
    return this.perception.occupiedStashCellsNow(geometry, topLevel);
  }

  /** Identify every occupied bag cell by Ctrl+C — phase 2's item source. */
  async identifyBagItems(): Promise<{
    items: IdentifiedItem[];
    unread: GridCell[];
  }> {
    const cells = await this.perception.currentBagCells();
    const { items, unread } = await this.identifyCells(cells, {});
    this.recordObservations(items, "bag");
    return { items, unread };
  }

  /** Hover + Ctrl+C one screen point — the shop flow's Note-line re-read. */
  async copyAt(x: number, y: number, hoverMs = 140): Promise<string> {
    return this.copyItemAt(x, y, hoverMs);
  }

  /**
   * Verified-serial withdraw for the shop flow (delists): ONE ctrl-click at
   * a time, the next only after the bag pixel-verifiably grew. Listings are
   * few and every one matters to the ledger — the serial commit check is the
   * point, not speed. Returns the items that actually left the tab.
   */
  async withdrawItemsSerial(
    items: readonly IdentifiedItem[],
    label: string,
  ): Promise<IdentifiedItem[]> {
    const withdrawn: IdentifiedItem[] = [];
    for (const item of items) {
      const before = await this.perception.bagCount();
      const sent = await this.harness.burst([item.cells[0]!], {
        found: items.flatMap((entry) => entry.cells),
        cellW: 56,
        cellH: 56,
        label: `shop withdraw ${withdrawn.length + 1}/${items.length} (${label})`,
      });
      if (sent === 0) return withdrawn; // rejected or dry-run
      let committed = false;
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        await this.harness.sleep(300, false);
        if ((await this.perception.bagCount()) > before) {
          committed = true;
          break;
        }
      }
      if (!committed) {
        this.harness.guard("shop-withdraw-not-observed", true);
        await this.step(`${label}: a shop withdraw did not commit — stopping the batch`);
        return withdrawn;
      }
      withdrawn.push(item);
      await this.harness.sleep(250, false);
    }
    return withdrawn;
  }

  /**
   * Deposit specific bag cells into the ACTIVE tab, bounce-verified. The
   * shop flow deposits with `shiftOnly` so stash affinities can never divert
   * an item away from the open (shop) tab. Returns how many cells stayed.
   */
  async depositBagCells(
    points: readonly GridCell[],
    destLabel: string,
    options: { shiftOnly?: boolean } = {},
  ): Promise<number> {
    return this.depositCells(points, destLabel, options);
  }

  async cleanTab(source: SourceTab): Promise<number> {
    const key = source.occurrence ? `${source.label}#${source.occurrence}` : source.label;
    // Triage tabs hold what the value tiers detoured — cleaning one would
    // scatter the finds back into class tabs.
    const routingCfg = this.options.triage?.routing;
    if (routingCfg && !source.topLevel && isTriageTabLabel(source.label, routingCfg)) {
      this.log(`  · ${key} is a triage tab — never cleaned`);
      return 0;
    }
    // The shop tab holds public listings — withdrawing them is delisting.
    // Only the shop flow's own verified actions may do that, never a clean.
    if (source.shop) {
      this.log(`  · ${key} is the designated shop tab — never cleaned (scanTab is the only read)`);
      return 0;
    }
    // A gear-folder tab owns its class; a top-level T tab "owns" junk — gear
    // items leave for the folder, junk stays where it lives.
    const own = source.topLevel
      ? undefined
      : GEAR_TAB_NAMES.find((name) => labelsSimilar(name, source.label));
    const endPhase = this.harness.startPhase(`clean:${key}`);
    let moved = 0;
    let lastForeign = Number.POSITIVE_INFINITY;
    let withdrawMisses = 0;
    /** Destinations proven unreachable/full during THIS visit — their items
     * stop being withdrawn (they would only churn bag→source forever). */
    const deadDests = new Set<string>();
    /** Known gear tabs whose navigation failed ONCE — retried on a later
     * trip before dead-marking (see distributeBag). */
    const navFailed = new Set<string>();
    this.findLocation = key;
    try {
      /* ---------------- PHASE 1: index the tab ONCE ----------------
       * The user's guarantee (2026-09-01): nothing else touches the stash
       * while a sort runs, so this single sweep IS the tab's state for the
       * whole visit — withdrawn items leave the model and nothing is ever
       * re-swept (the per-trip re-scans and the belt-and-braces
       * verification sweep went away with the assumption that required
       * them). Bailed items land back here in cells the model does not
       * track, but their destinations are dead/full, so they are never
       * withdrawn again this visit.
       */
      if (
        !(await this.navigation.gotoTab(
          source.label,
          source.occurrence,
          source.topLevel,
          source.rowY,
          source.drain,
        ))
      ) {
        endPhase("source-unreachable");
        return moved;
      }
      const index = await this.indexTab(source, key);
      if (!index) {
        endPhase("no-geometry");
        return moved;
      }
      const { region, cols, rows, unread } = index;
      if (index.occupiedCount === 0) {
        if (source.drain) {
          this.log(`  · ${key}: zero occupied cells — fully drained (the tab will vanish on its own)`);
        }
        endPhase();
        return moved;
      }
      let modelItems = index.modelItems;
      /* ---------------- PHASE 2: withdraw trips from the index ----------------
       * Each trip packs the bag with the biggest DESTINATION groups that fit
       * (packTripByDest) so a bag-load deposits in one or two hops instead
       * of a dozen. The index is only ever reduced; the one read back from
       * the tab is the cheap pixel check for what a shortfall burst left.
       */
      for (let trip = 0; trip < 24; trip += 1) {
        const skippable = new Set<string>([
          ...deadDests,
          ...(source.topLevel ? this.fullDests : []),
        ]);
        // Guild taxonomy remap AFTER the unavailable set is known, so a
        // full "Armor 1" re-routes its items to "Armor 2" instead of
        // skipping them (and a fully unavailable chain resolves to "junk"
        // — the item stays put).
        const items = this.guildChest
          ? modelItems.map((item) => ({ ...item, dest: guildDestForItem(item, skippable) }))
          : modelItems;
        const foreign = foreignItemsFor(items, own, skippable.size > 0 ? skippable : undefined);
        const skipped = foreignItemsFor(items, own).length - foreign.length;
        if (skipped > 0) {
          this.log(
            `  · ${key}: leaving ${skipped} item(s) whose home tab is full or missing (${[...skippable].join(", ")})`,
          );
        }
        // Value triage: an item that gets to STAY by class may still be a
        // confident keep/sell — it leaves for the Review/Sell tab. Only
        // upward detours here; dump-tier items in a T tab already live where
        // junk lives, and churning them costs trips.
        const config = this.triageRouting();
        let leaving = foreign;
        if (config) {
          const alreadyLeaving = new Set(foreign);
          const detours = items
            .filter((item) => !alreadyLeaving.has(item))
            .map((item) => this.routeWithFallback(item, config))
            .filter(
              (entry) =>
                entry.detoured &&
                (entry.craft || entry.verdict?.tier === "keep" || entry.verdict?.tier === "sell"),
            );
          if (detours.length > 0) {
            this.log(`  · ${key}: ${detours.length} valuable item(s) detour to triage tabs`);
            leaving = [...foreign, ...detours.map((entry) => entry.item)];
          }
        }
        this.log(
          `  · ${key}: ${items.length} item(s) indexed, ${leaving.length} leaving ` +
            `(${[...new Set(leaving.map((f) => f.dest))].join(", ") || "none"})`,
        );
        if (leaving.length === 0) {
          if (source.drain) {
            // Everything routable has left; what stays is unreadable or
            // had a fully unavailable destination chain — report it.
            const staying = items.filter((item) => item.dest === "junk").length;
            this.log(
              `  · ${key}: drained — ${staying} item(s) left (unreadable or no open destination)` +
                (unread.length > 0 ? `, ${unread.length} unreadable cell(s)` : ""),
            );
          }
          endPhase();
          return moved;
        }
        if (leaving.length >= lastForeign) {
          await this.step(`${key}: ${leaving.length} item(s) refuse to move — stopping`);
          endPhase("stalled");
          return moved;
        }
        lastForeign = leaving.length;
        // Budget by PLACEMENT, not cell count: the packer simulates the
        // game's own first-fit fill of the 12x5 bag over its current
        // occupancy, so every withdraw click has a real landing spot.
        const bagCellsNow = await this.perception.currentBagCells();
        const batch = packTripByDest(leaving, bagCellsNow);
        const cellsNeeded = batch.reduce((sum, item) => sum + item.cells.length, 0);
        if (batch.length === 0) {
          await this.step("bag too full for any foreign item — filing bag first");
          await this.distributeBag({ returnTo: source, deadDests, navFailed });
          lastForeign = Number.POSITIVE_INFINITY;
          continue;
        }
        // Back to the source (the first trip is already there; later trips
        // return from wherever the last deposit landed).
        if (
          !(await this.navigation.gotoTab(
            source.label,
            source.occurrence,
            source.topLevel,
            source.rowY,
            source.drain,
          ))
        ) {
          endPhase("source-unreachable");
          return moved;
        }
        const grabPoints = batch.map((item) => item.cells[0]!);
        await this.step(
          `${key}: withdrawing ${batch.length} item(s) (${cellsNeeded} cells) → ${[...new Set(batch.map((item) => item.dest))].join(", ")}`,
        );
        let withdrawn: IdentifiedItem[];
        if (this.guildChest) {
          withdrawn = await this.guildWithdrawSerial(batch, leaving, key);
          if (withdrawn.length === 0) {
            endPhase("plan-not-executed");
            return moved;
          }
          await this.harness.sleep(400);
        } else {
          const bagBefore = bagCellsNow.length;
          // Park + one frame BEFORE the burst: if the burst under-delivers,
          // comparing this frame against a post-burst frame says exactly
          // which items stayed. The old occupancy-score check over-restored
          // 10 of 15 items live (2026-09-01) — the cursor rested on the last
          // clicked cell and its item TOOLTIP covered the grid, reading as
          // occupied cells everywhere.
          await this.park();
          const preBurst = await this.perception.captureRaw();
          const sent = await this.harness.burst(grabPoints, {
            found: leaving.flatMap((item) => item.cells),
            cellW: 56,
            cellH: 56,
            label: `clean ${key}: ${batch.length} items out`,
          });
          if (sent === 0) {
            endPhase("plan-not-executed");
            return moved;
          }
          // Unpaced settle POLL, not a fixed sleep: a paced 400ms (280ms at
          // pace 0.7) expired while the game was still processing the burst
          // chunks — the bag undercounted and the shortfall check
          // "restored" items that had actually left, every single trip
          // (watcher-bot finding #1, 2026-09-01). Two consecutive agreeing
          // reads are the commit signal.
          let bagAfter = await this.perception.bagCount();
          const settleDeadline = Date.now() + 2500 + batch.length * 50;
          for (;;) {
            await this.harness.sleep(300, false);
            const again = await this.perception.bagCount();
            const settled = again === bagAfter;
            bagAfter = again;
            if (settled || Date.now() >= settleDeadline) break;
          }
          // Postcondition: the bag must GROW by the batch's cells. Shrank
          // means the clicks landed on the WRONG side and deposited — the
          // world no longer matches the index; stop the visit loudly. Flat
          // means nothing came out (missed clicks / covered panel) — one
          // retry, then stop.
          const direction = withdrawObservation(bagBefore, bagAfter);
          if (direction === "shrank") {
            this.harness.guard("withdraw-wrong-direction", true);
            await this.step(`${key}: withdraw burst DEPOSITED (bag shrank) — stopping this visit`);
            endPhase("withdraw-anomaly");
            return moved;
          }
          if (direction === "flat") {
            this.harness.guard("withdraw-not-observed", true);
            withdrawMisses += 1;
            if (withdrawMisses >= 2) {
              await this.step(`${key}: two withdraw bursts landed nothing — stopping`);
              endPhase("stalled");
              return moved;
            }
            await this.step(`${key}: withdraw burst did not land — retrying`);
            lastForeign = Number.POSITIVE_INFINITY;
            continue;
          }
          withdrawMisses = 0;
          withdrawn = batch;
          const actualGrowth = bagAfter - bagBefore;
          if (actualGrowth < cellsNeeded) {
            // A partial burst: some clicks missed or were refused. Compare
            // the pre-burst frame against a fresh one, per item bounding
            // box: a withdrawn item's cells changed massively (sprite →
            // background), a stayed item's changed not at all. Park first
            // so no tooltip pollutes the after-frame. No re-sweep, no
            // hovering, immune to glare and occupancy-threshold guesses.
            await this.park();
            const cw = region.w / cols;
            const ch = region.h / rows;
            const stayedIn = (check: RawFrame): Set<IdentifiedItem> =>
              new Set(
                batch.filter((item) => {
                  const minR = Math.min(...item.cells.map((cell) => cell.row));
                  const maxR = Math.max(...item.cells.map((cell) => cell.row));
                  const minC = Math.min(...item.cells.map((cell) => cell.col));
                  const maxC = Math.max(...item.cells.map((cell) => cell.col));
                  const box = {
                    x: region.x + minC * cw,
                    y: region.y + minR * ch,
                    w: (maxC - minC + 1) * cw,
                    h: (maxR - minR + 1) * ch,
                  };
                  const fraction = regionChangedFraction(
                    preBurst.gray,
                    check.gray,
                    check.client,
                    box,
                    2,
                  );
                  return fraction < 0.15; // its pixels never moved — it stayed
                }),
              );
            let stayed = stayedIn(await this.perception.captureRaw());
            if (stayed.size > Math.ceil(batch.length * 0.3)) {
              // Implausibly many "stayed" — the removal animation may still
              // be painting. One later frame decides (the same trust-the-
              // later-read pattern the deposit bounce check uses).
              await this.harness.sleep(700, false);
              stayed = stayedIn(await this.perception.captureRaw());
            }
            if (stayed.size > 0) {
              this.harness.guard("withdraw-partial-restored", true);
              this.log(
                `  · ${key}: ${stayed.size} item(s) did not leave — kept in the index for the next trip`,
              );
              withdrawn = batch.filter((item) => !stayed.has(item));
            }
          }
        }
        moved += withdrawn.length;
        // The withdrawn items are the ONLY change to the tab — drop exactly
        // them from the index, matched by grab cell (guild remaps clone the
        // items, so identity alone cannot be trusted).
        const withdrawnKeys = new Set(
          withdrawn.map((item) => `${item.cells[0]!.row},${item.cells[0]!.col}`),
        );
        modelItems = modelItems.filter(
          (item) => !withdrawnKeys.has(`${item.cells[0]!.row},${item.cells[0]!.col}`),
        );
        await this.distributeBag({ returnTo: source, deadDests, navFailed });
      }
      endPhase("trip-limit");
      return moved;
    } catch (error) {
      endPhase(error instanceof SortStop ? "stopped" : "failed");
      throw error;
    } finally {
      this.findLocation = "bag";
    }
  }

  /**
   * The EMPTY-BAG GUARANTEE (dump-sort handoff item 4): the run may not end
   * — other than Numpad 0 or fatal stash loss — while depositable identified
   * items remain in the bag. Keeps filing until the bag is verifiably empty
   * (TWO agreeing pixel reads; the bounce animation fakes empty frames) or
   * only blacklisted cells remain, then reports every leftover with its item
   * class and the reason it could not leave. Nothing is silently carried.
   */
  private async finishBag(returnTo?: SourceTab): Promise<number> {
    const endPhase = this.harness.startPhase("finish-bag");
    let filed = 0;
    try {
      const deadDests = new Set<string>(this.fullDests);
      const navFailed = new Set<string>();
      for (let round = 0; round < 4; round += 1) {
        const occupied = await this.perception.currentBagCells();
        const verdict = bagCompletionVerdict(occupied, this.undepositableBag);
        if (verdict === "empty") {
          await this.harness.sleep(650, false);
          if ((await this.perception.currentBagCells()).length === 0) {
            endPhase();
            return filed;
          }
          continue; // a bounce flyback re-filled it — file again
        }
        if (verdict === "only-undepositable") break;
        filed += await this.distributeBag({ ...(returnTo ? { returnTo } : {}), deadDests, navFailed });
      }
      const leftovers = await this.perception.currentBagCells();
      if (leftovers.length === 0) {
        endPhase();
        return filed;
      }
      this.harness.guard("bag-not-empty-at-end", true);
      await this.step(`bag not empty at run end — identifying ${leftovers.length} leftover cell(s)`);
      const { items, unread } = await this.identifyCells(leftovers, {});
      const report = describeBagLeftovers(items, unread, {
        undepositable: this.undepositableBag,
        stuckTabs: this.stuckObservations,
        unavailableDests: deadDests,
      });
      for (const entry of report) {
        this.log(
          `! bag leftover at ${entry.cell}: ${entry.itemClass ?? "unreadable"}` +
            (entry.dest && entry.dest !== "junk" ? ` (home ${entry.dest})` : "") +
            ` — ${entry.why}`,
        );
      }
      endPhase("leftovers-reported");
      return filed;
    } catch (error) {
      endPhase(error instanceof SortStop ? "stopped" : "failed");
      throw error;
    }
  }

  /* ---------------- run ---------------- */

  /**
   * Enumerate the folder's tabs from the live folder list, in row order.
   * Duplicate labels (two "Rings" rows) become distinct sources via their
   * occurrence index; Remove-only rows are excluded outright.
   */
  async listSources(): Promise<SourceTab[]> {
    const rows = await this.navigation.openFolderList();
    this.folderRowsCache = rows; // rows never move — later hops skip the OCR
    const seen = new Map<string, number>();
    const sources: SourceTab[] = [];
    for (const row of rows) {
      if (!row.readable) continue;
      const label = row.label.trim();
      if (!label || isRemoveOnlyTabLabel(label)) continue;
      // A row whose label collapses to a single character is OCR debris (the
      // Sceptre row once read as "O") — the synthesis pass below re-queues
      // the real tab it garbled from by its known name.
      if (normalizeTabLabel(label).length < 2) continue;
      // Top-level rows can bleed into a folder read on a list-transition
      // frame (Gear, AFFINITIES and T10 were once queued as folder tabs).
      // The folder only ever holds gear tabs — drop such labels outright.
      const lower = label.toLowerCase();
      if (lower === "gear" || lower === "affinities" || canonicalTTabLabel(label)) continue;
      const occurrence = seen.get(label) ?? 0;
      seen.set(label, occurrence + 1);
      sources.push({ label, occurrence });
    }
    // The ACTIVE tab's highlight can defeat its own row's OCR (Jewels'
    // magenta, Amulets'), silently dropping a different tab from every run.
    // Synthesize the known gear tabs that are missing; the goto probe +
    // requeue in run() sort out whether they really exist.
    for (const name of GEAR_TAB_NAMES) {
      // A row that exactly names a DIFFERENT tab cannot claim this one —
      // the Staff row loose-matches "QuarterStaff" by containment and once
      // silently dropped QuarterStaff from the whole run.
      const claimed = sources.some(
        (source) =>
          labelsSimilar(source.label, name) &&
          !GEAR_TAB_NAMES.some(
            (other) => !labelsEqualFolded(other, name) && labelsEqualFolded(source.label, other),
          ),
      );
      if (!claimed) {
        this.log(`  · "${name}" not visible in the list (active-tab highlight?) — queueing it anyway`);
        sources.push({ label: name, occurrence: 0 });
      }
    }
    return sources;
  }

  /**
   * Sort everything in scope by ground truth: the Gear folder's tabs (each
   * ends holding only its class) and/or the top-level T* tabs (gear items
   * leave for the folder, junk stays). `sourceFilter` (from --sources=)
   * restricts which tabs to process.
   */
  async run(
    sourceFilter?: readonly string[],
    scope: "gear" | "tabs" | "all" = "all",
  ): Promise<number> {
    const drainMode = this.options.drainRemoveOnly === true;
    if (this.guildChest && !drainMode) {
      // The only guild flow so far is the Remove-only drain; a plain sort
      // would enumerate personal-stash structures that do not exist here.
      throw new Error("guild-chest-requires-drain-remove-only");
    }
    await this.ensureSession();
    if (this.guildChest && !this.options.dryRun) {
      // A guild live run files the whole bag into GUILD tabs — anything the
      // character was already carrying would be donated to the guild by
      // accident. Demand an empty bag instead of guessing what is loot.
      const carried = await this.perception.bagCount();
      if (carried > 0) {
        throw new Error(
          `guild-live-requires-empty-bag — ${carried} occupied bag cell(s); empty the inventory and rerun`,
        );
      }
      this.log(
        `guild pacing: serial actions, ≥${GUILD_PACE.itemMs}ms/item, ≥${GUILD_PACE.tabMs}ms/tab-switch, ` +
          "commit-verified each action; every action is visible in the guild log",
      );
    }
    const discovered: SourceTab[] = [];
    if (drainMode) {
      // The drain flow's sources are the Remove-only tabs and NOTHING else —
      // normal discovery stays out so a drain run cannot wander into sorting.
      discovered.push(...(await this.navigation.listRemoveOnlySources()));
    } else {
      if (scope !== "tabs") discovered.push(...(await this.listSources()));
      if (scope !== "gear") discovered.push(...(await this.navigation.listTopSources()));
    }
    // Drain filters match EXACTLY: Remove-only labels OCR reliably, and the
    // guild's numeric labels containment-match each other under the loose
    // rule ("1 (Remove-only)" sits inside "31 (Remove-only)") — a one-tab
    // live test must stay one tab.
    const filterMatches = (wanted: string, label: string): boolean =>
      drainMode
        ? wanted === label || labelsEqualFolded(wanted, label)
        : wanted === label || labelsSimilar(wanted, label);
    const sources = sourceFilter?.length
      ? discovered.filter((source) => sourceFilter.some((wanted) => filterMatches(wanted, source.label)))
      : discovered;
    // A tab the user NAMED must be tried even when discovery missed it — the
    // ACTIVE tab's label routinely fails to OCR (highlight), and it is very
    // often the active one the user wants sorted. The goto probe decides
    // whether it really exists.
    for (const wanted of sourceFilter ?? []) {
      if (sources.some((source) => filterMatches(wanted, source.label))) {
        continue;
      }
      if (drainMode) {
        // A drain probe must NAME a Remove-only label — probing "Armour"
        // could select and drain a regular tab of that name. (Sorting a
        // wrong tab is harmless; the refusal is about keeping drain runs
        // exact.) The full label with its (Remove-only) suffix is required.
        if (!isDrainableRemoveOnlyLabel(wanted)) {
          this.log(
            `  ! drain source "${wanted}" is not a Remove-only label — skipped (use the full label, e.g. "${wanted} (Remove-only)")`,
          );
          continue;
        }
        this.log(`  · requested drain source "${wanted}" not in discovery — probing it directly`);
        sources.push({ label: wanted, occurrence: 0, topLevel: true, drain: true });
        continue;
      }
      const isGearTab = GEAR_TAB_NAMES.some((name) => labelsEqualFolded(name, wanted));
      this.log(`  · requested source "${wanted}" not in discovery — probing it directly`);
      sources.push({ label: wanted, occurrence: 0, ...(isGearTab ? {} : { topLevel: true as const }) });
    }
    if (drainMode && sources.length === 0) {
      this.log("no Remove-only tabs found — nothing to drain");
      return 0;
    }
    this.log(
      `${drainMode ? "DRAINING (withdraw-only)" : "sorting"} ${sources.length} tab(s): ${sources
        .map((s) => (s.occurrence ? `${s.label}#${s.occurrence}` : s.label) + (s.topLevel ? "^" : ""))
        .join(", ")} (^ = top-level)`,
    );
    // Bail target for homeless items: the first top-level source (the Dump
    // tab in the default flow). Items whose home tab is full or missing get
    // verifiably returned there instead of riding the bag forever — a drain
    // source never qualifies (deposits into Remove-only tabs are refused).
    const defaultReturn = sources.find((source) => source.topLevel && !source.drain);
    // A dirty bag from earlier interruptions gets filed FIRST, each item to
    // its true tab by Ctrl+C identity — never dumped wholesale somewhere.
    // Guild runs skip this: live requires an empty bag (gate above), and a
    // dry-run must not churn plans for personal items against guild tabs.
    let moved = this.guildChest
      ? 0
      : await this.distributeBag(defaultReturn ? { returnTo: defaultReturn } : {});
    const queue = [...sources];
    const requeued = new Set<string>();
    const unreachable: string[] = [];
    while (queue.length > 0) {
      const source = queue.shift()!;
      const key =
        (source.occurrence ? `${source.label}#${source.occurrence}` : source.label) +
        (source.topLevel ? "^" : "");
      // Probe the source once. An unreachable tab is usually the CURRENTLY
      // ACTIVE one whose highlight defeats OCR (Jewels' magenta) — by the
      // time it comes around again another tab is active and it reads fine.
      // (A fully drained Remove-only tab also VANISHES from the account —
      // for drain sources, unreachable-and-skipped is a normal outcome.)
      if (
        !(await this.navigation.gotoTab(source.label, source.occurrence, source.topLevel, source.rowY, source.drain))
      ) {
        if (!requeued.has(key)) {
          requeued.add(key);
          queue.push(source);
          this.log(`  · ${key} unreachable right now — retrying after the other tabs`);
        } else {
          this.log(`! source ${key} unreachable — skipped`);
          unreachable.push(key);
        }
        continue;
      }
      moved += await this.cleanTab(source);
      this.log(`${key}: done`);
    }
    // The run may not end while depositable identified items remain in the
    // bag — file them (bailing the homeless to the default source) and
    // REPORT whatever survives, cell by cell. Guild runs demanded an empty
    // bag up front and file everything inline.
    if (!this.guildChest) moved += await this.finishBag(defaultReturn);
    if (unreachable.length > 0) {
      this.log(`! unreachable tabs this session (labels never OCRed): ${unreachable.join(", ")}`);
    }
    if (this.fullDests.size > 0) {
      this.log(
        `! full destination tab(s): ${[...this.fullDests].join(", ")} — their overflow lives in T tabs until space frees up`,
      );
    }
    if (this.undepositableBag.size > 0) {
      this.log(
        `! ${this.undepositableBag.size} bag cell(s) would not deposit anywhere ` +
          `(shift+ctrl included) — left in the bag for you to place by hand`,
      );
    }
    return moved;
  }
}
