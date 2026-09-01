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
import path from "node:path";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  STRIP_ROWS,
  StashTabKit,
  TAB_LIST,
  findLabelSegment,
  pickExact,
  pickUnique,
  type StripEntry,
  type TabListRow,
} from "./stashTabKit.js";
import { SortHarness, SortStop } from "./sortHarness.js";
import type { WinReply } from "./winHost.js";
import { labelsEqualFolded, labelsSimilar, normalizeTabLabel } from "../core/tabList.js";
import { isDrainableRemoveOnlyLabel, isRemoveOnlyTabLabel } from "../core/stashTabAdmin.js";
import { bgrToGray, readBmpBgr } from "./bmp.js";
import {
  boundaryBrightness24,
  brightHeaderRuns,
  brightestCellPoint,
  cellEdgeContinuity,
  scoreGridCells,
} from "../core/itemSprites.js";
import { hasConsistentCellGrid, perceiveUi } from "../core/uiPerception.js";
import { occupiedFromRgbScores, scoreGridCellsRgb } from "../core/cellOccupancy.js";
import { loadProfile } from "../core/calibrationStore.js";
import { toScreenBox, type CalibrationProfile } from "../core/calibrationProfile.js";
import { resolvePhysicalClient } from "../core/screenLayout.js";
import { encodeBgrPng } from "../core/pngWrite.js";
import {
  BAG_AREA,
  BAG_CELL_CAPACITY,
  GEAR_TAB_NAMES,
  SEARCH_BOX,
  STASH_AREA,
  clampToArea,
  canonicalTTabLabel,
  claimNeedsReverify,
  emptyCellKeysByBaseline,
  detectGridDivisions,
  foreignItemsFor,
  groupIdentifiedCells,
  guildDestForItem,
  isTTabLabel,
  stashRegionSane,
  type Cell,
  type GridCell,
  type IdentifiedItem,
} from "../core/gearSort.js";
import type { TriageRouting } from "../core/bagTriage.js";
import { STASH_SCAN } from "../core/copyTiming.js";
import { recordOccupancyLabel } from "../core/occupancyLabels.js";
import {
  DEFAULT_MIN_DETOUR_CONFIDENCE,
  findRecordFor,
  isTriageTabLabel,
  routeIdentifiedItem,
  type FindRecord,
  type RoutedItem,
  type SortTriageConfig,
} from "../core/sortTriage.js";
import type { TierVerdict } from "../core/valueTiers.js";

interface SortHost {
  send(payload: Record<string, unknown>): Promise<WinReply>;
}

interface OcrText {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One tab to sort: label plus which duplicate of it (0 = first). */
export interface SourceTab {
  label: string;
  occurrence: number;
  /** True for top-level T* tabs (navigated via the TOP list; junk stays). */
  topLevel?: boolean;
  /**
   * Absolute dropdown click Y for a top-level row whose SHORT label never
   * OCRs (T1-T9 read as blanks). Navigation clicks the position directly —
   * sweep semantics are identical for every T tab, so the exact number does
   * not matter. Only rows inside the T band (after AFFINITIES, before the
   * first readable special/Remove-only row) ever get one.
   */
  rowY?: number;
  /**
   * Remove-only DRAIN source (the 2026-08-30 rule change): navigation may
   * SELECT the Remove-only tab, gear items leave for the folder exactly like
   * a top-level source. The tab stays permanently forbidden as a deposit
   * target — bail must never return items to a drain source (the game
   * refuses the deposit, so the return would silently fail).
   */
  drain?: boolean;
}

export interface GearSorterTriageOptions {
  /** Tier decision for one copied item's text (rules + price table). */
  evaluate: (itemText: string) => TierVerdict;
  /** Destination tabs for keep/sell/dump items. Must live in the Gear folder. */
  routing: TriageRouting;
  /** Appraisal confidence an item needs before it detours (default 55). */
  minDetourConfidence?: number;
  /** Session log sink for detoured keeps/sells (the finds journal). */
  onFind?: (record: FindRecord) => void;
}

export interface GearSorterOptions {
  root: string;
  templateDir: string;
  dryRun?: boolean;
  debug?: boolean;
  maxChestClicks?: number;
  /** When set, every withdrawn bag-load is read item-by-item and valuable
   * or trash items detour to the routing tabs before the normal deposit. */
  triage?: GearSorterTriageOptions;
  /** Shorter hovers and settles for the speed-baseline profile. */
  turbo?: boolean;
  /** Show the occupancy plan before each sweep and accept corrections
   * (Numpad 8 good / 9 teach with a click or drag-box). */
  teach?: boolean;
  /** Gate only the GRID lattice per tab (Numpad 8 good / 9 adjust) without
   * the occupancy and item-boundary gates full teach mode adds. */
  teachGrid?: boolean;
  /** Explicit drain flow (--drain-remove-only): sources are the Remove-only
   * tabs instead of the normal discovery, withdraw-only. Default runs keep
   * refusing Remove-only tabs exactly as before. */
  drainRemoveOnly?: boolean;
  /**
   * Which chest this session works: "personal" (default) clicks the Stash
   * chest and excludes Guild nameplates; "guild" inverts that — it clicks
   * the GUILD Stash chest, requires the "Guild Stash" panel title, treats
   * every tab as top-level (no Gear folder exists), and disables triage
   * (Review/Dump are personal tabs). Guild mode is DRY-RUN ONLY until the
   * verified-serial pacing layer lands: every guild write is a synchronous
   * realm-master round trip and must never be burst.
   */
  chest?: "personal" | "guild";
  log?: (line: string) => void;
}

interface Frame {
  gray: ReturnType<typeof bgrToGray>;
  bgr: ReturnType<typeof readBmpBgr>;
  client: ReturnType<typeof resolvePhysicalClient>;
  facts: ReturnType<typeof perceiveUi>;
}

/** A cheap frame: pixels only, no perception pass. The identification hot
 * path needs nothing more — occupancy comes from scoring the CALIBRATED
 * regions directly, which skips template matching, nameplate search, and
 * sprite detection on every capture. */
interface RawFrame {
  gray: ReturnType<typeof bgrToGray>;
  bgr: ReturnType<typeof readBmpBgr>;
  client: ReturnType<typeof resolvePhysicalClient>;
}

const STASH_BAND = { left: 450, top: 100, width: 700, height: 110 } as const;
const INVENTORY_BAND = { left: 2900, top: 100, width: 800, height: 110 } as const;
const PARK = { x: 660, y: 1900 } as const;

/**
 * There are TWO side-list toggles, one per strip row (verified from the
 * user's screenshot, 2026-08-29): (1287,212) opens the TOP-LEVEL list, and
 * the folder row's own chevron below it opens the FOLDER list. Confusing
 * them silently switches navigation context — an earlier build clicked the
 * top toggle for everything and kept reading "Gear | AFFINITIES | T13...".
 */
const LIST_TOGGLE_TOP = TAB_LIST.toggle;
const LIST_TOGGLE_FOLDER = { x: 1287, y: 278 } as const;

/**
 * Row clicks land in the label column. The folder list is only ~330px wide
 * (right edge ≈ x1670), so the drain tooling's x=1700 click point falls PAST
 * its edge into the world — selecting nothing.
 */
const LIST_ROW_CLICK_X = 1430;

/**
 * Guild pacing floors (docs/HANDOFF-standard-drain-guild-stash.md): every
 * guild-stash write is a synchronous realm-master round trip with no
 * published rate limit — actions are verified-serial (one at a time, next
 * only after the previous is pixel-verified committed) and never faster
 * than these floors. The harness pace multiplier can only slow this down
 * (paceDown on any rollback), never below the floor.
 */
const GUILD_PACE = { itemMs: 1000, tabMs: 2500, commitTimeoutMs: 4000 } as const;

export class GearSorter {
  private readonly debugDir: string;
  private currentStep = "starting";
  /**
   * label -> ABSOLUTE list-row click Y, remembered from successful finds.
   * Some labels (the red Weapons tab) OCR as unreadable more often than not —
   * a cached position lets navigation keep working through an unreadable
   * frame. It must be the screen Y, never a slot INDEX: slot numbering
   * re-anchors to the first line OCR happens to see, so one missed top row
   * shifted every cached slot one row down and deposited 56 rings into
   * Helmets (watched live). Row positions themselves never move.
   */
  private readonly rowYCache = new Map<string, number>();
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

  constructor(
    private readonly host: SortHost,
    private readonly harness: SortHarness,
    private readonly kit: StashTabKit,
    private readonly options: GearSorterOptions,
  ) {
    this.debugDir = path.join(options.root, "artifacts", "tab-admin", "debug");
    mkdirSync(this.debugDir, { recursive: true });
    this.log = options.log ?? ((line) => console.log(line));
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

  /* ---------------- perception ---------------- */

  /** Calibration profile, loaded once — captureFrame used to re-read the
   * JSON from disk on every single frame. */
  private profileCache: CalibrationProfile | undefined;

  private get profile(): CalibrationProfile {
    this.profileCache ??= loadProfile(this.options.templateDir);
    return this.profileCache;
  }

  private async captureRaw(): Promise<RawFrame> {
    const rect = await this.host.send({ op: "rect" });
    const file = path.join(this.debugDir, `cap-${Date.now()}.bmp`);
    const captured = await this.host.send({ op: "capture", path: file });
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

  private async captureFrame(): Promise<Frame> {
    const { gray, bgr, client } = await this.captureRaw();
    // ventorBagGrid is stripped like the daemon and drain tooling do: when
    // the stash-open pixel check flakes (open side list, sparse tab), the
    // vendor-box grid hijacks the interpretation and perceiveUi returns NO
    // facts at all — stash AND bag read empty on a visibly full screen.
    const facts = perceiveUi(
      gray,
      client,
      {},
      { ...this.profile, ventorBagGrid: undefined },
      bgr,
    );
    // Remember the FINEST sanely perceived stash geometry — the folder's
    // tabs share panel bounds, and this seeds the blind-tab Ctrl+C sweep.
    // Prefer quad pitch (24 cols): a 12-col sweep on a quad tab would sample
    // only a quarter of the cells and could miss 1x1 items entirely.
    if (
      stashRegionSane(facts.stashRegion) &&
      facts.stashGridSize &&
      (!this.lastGoodStashGeometry || facts.stashGridSize.cols >= this.lastGoodStashGeometry.cols)
    ) {
      this.lastGoodStashGeometry = {
        region: facts.stashRegion!,
        cols: facts.stashGridSize.cols,
        rows: facts.stashGridSize.rows,
      };
    }
    return { gray, bgr, client, facts };
  }

  private saveDebugFrame(frame: Frame, tag: string): void {
    if (!this.options.debug) return;
    try {
      writeFileSync(path.join(this.debugDir, `${Date.now()}-${tag}.png`), encodeBgrPng(frame.bgr));
    } catch {
      // best-effort diagnostics
    }
  }

  /** The user-calibrated stash panel bounds (shared across the folder's
   * tabs), for pixel checks that must not wait on OCR or perception. */
  private calibratedStashBounds():
    | { x: number; y: number; w: number; h: number }
    | undefined {
    this.loadGridCalibration();
    const bounds =
      this.gridCalibration["__default_24x24"] ?? this.gridCalibration["__default_12x12"];
    if (bounds) return { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h };
    return this.lastGoodStashGeometry?.region;
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
  private async stashGridVisible(raw?: RawFrame): Promise<boolean> {
    const bounds = this.calibratedStashBounds();
    if (!bounds) return false;
    const frame = raw ?? (await this.captureRaw());
    const uv = {
      x: (bounds.x - frame.client.left) / frame.client.width,
      y: (bounds.y - frame.client.top) / frame.client.height,
      w: bounds.w / frame.client.width,
      h: bounds.h / frame.client.height,
    };
    return (
      hasConsistentCellGrid(frame.gray, uv, 12, 12) ||
      hasConsistentCellGrid(frame.gray, uv, 24, 24)
    );
  }

  /**
   * Wait for the pixels of a screen region to CHANGE (a tab switch repaints
   * the grid) and then hold STABLE, via the host's pixwait op — this replaces
   * fixed 1000ms sleeps with returns as soon as the game has actually acted.
   * Returns whether a change was observed; on a host too old for the op the
   * caller's fixed-sleep fallback runs instead (changed=undefined).
   */
  private async pixwait(
    region: { x: number; y: number; w: number; h: number },
    options: { waitChangeMs?: number; stableMs?: number },
  ): Promise<boolean | undefined> {
    const reply = await this.host.send({
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

  /** Positive "the stash panel is open" proof: the cheap lattice check
   * first (one capture, no OCR), the panel-title OCR as fallback — a
   * jam-packed quad defeats the lattice detector (watched live on the
   * user's Dump tab). */
  private async stashOpenProof(): Promise<boolean> {
    return (await this.stashGridVisible()) || (await this.stashTitleVisible());
  }

  /** A 60px band across the middle of the stash grid — the change-detection
   * probe for "the tab actually switched". */
  private gridProbeStrip(): { x: number; y: number; w: number; h: number } | undefined {
    const bounds = this.calibratedStashBounds();
    if (!bounds) return undefined;
    return { x: bounds.x, y: bounds.y + bounds.h * 0.4, w: bounds.w, h: 60 };
  }

  /**
   * Wait for the newly clicked tab to render: change-then-stable on the grid
   * strip when calibration gives us a probe region, else the legacy fixed
   * sleep + perception settle. Returns what the probe SAW — "changed" is the
   * positive proof a repaint happened; "unknown" means the legacy settle ran
   * (no probe region, or a host without the pixwait op).
   */
  private async settleAfterTabClick(
    expectChange: boolean,
  ): Promise<"changed" | "unchanged" | "unknown"> {
    const strip = this.gridProbeStrip();
    if (strip) {
      const changed = await this.pixwait(strip, {
        waitChangeMs: expectChange ? 1100 : 0,
        stableMs: 140,
      });
      if (changed !== undefined) {
        if (expectChange && !changed) {
          // No repaint seen — could be the same tab, a slow frame, or a
          // missed click. One legacy-style settle keeps this honest.
          this.harness.guard("tab-switch-not-observed", true);
          await this.harness.sleep(500, false);
          return "unchanged";
        }
        return changed ? "changed" : "unknown";
      }
    }
    await this.harness.sleep(1000);
    await this.settleGrid();
    return "unknown";
  }

  private async park(): Promise<void> {
    await this.host.send({ op: "move", ...PARK });
  }

  private async ocrBand(band: { left: number; top: number; width: number; height: number }): Promise<string> {
    // Full-screen OCR only, filtered client-side: mid-size region crops
    // (~400-1900px wide) sit in the Windows.Media.Ocr dead zone and
    // intermittently return ZERO lines — a 900px band read of a box that
    // visibly held text came back empty and derailed a whole route.
    const reply = await this.host.send({ op: "ocr" });
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
  private async stashTitleVisible(): Promise<boolean> {
    await this.park();
    await this.harness.sleep(350, false);
    if (this.titleMatchesChest(await this.ocrBand(STASH_BAND))) return true;
    await this.harness.sleep(600, false);
    return this.titleMatchesChest(await this.ocrBand(STASH_BAND));
  }

  /* ---------------- ensureSession ---------------- */

  /** True once the Highlight box has been cleared this session. Nothing in
   * the ground-truth flow ever TYPES a query, so one clear per session is
   * enough — the old per-tab clear cost a focus-proof + typing per tab. */
  private searchCleared = false;

  async ensureSession(): Promise<void> {
    const endPhase = this.harness.startPhase("ensure-session");
    try {
      // A process killed mid-click leaves the virtual left button LATCHED —
      // the game then eats every click. A tiny drag in the dead zone clears it.
      await this.host.send({ op: "drag", x: PARK.x, y: PARK.y, x2: PARK.x + 2, y2: PARK.y + 2 });
      await this.harness.sleep(300, false);
      if (!(await this.ensureStash())) throw new Error("stash-not-openable");
      // The guild stash has NO Gear folder — every tab is top-level.
      if (!this.guildChest && !(await this.ensureFolderRowOpen())) {
        throw new Error("gear-folder-row-not-openable");
      }
      // A stale Highlight query dims everything it does not match and sinks
      // dimmed cells below the occupancy thresholds — a boots tab full of
      // boots once read EMPTY under a leftover "class: jewel" filter. The
      // sorter itself never types queries any more, so once per session.
      if (await this.clearSearch()) this.searchCleared = true;
      endPhase();
    } catch (error) {
      endPhase(error instanceof SortStop ? "stopped" : "failed");
      throw error;
    }
  }

  /** Get the stash panel + inventory open, with bounded, diagnosed recovery. */
  private async ensureStash(): Promise<boolean> {
    let chestClicks = 0;
    let invToggles = 0;
    let navClicks = 0;
    const maxChestClicks = this.options.maxChestClicks ?? 2;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await this.park();
      await this.harness.sleep(350, false);
      const stashOpen = this.titleMatchesChest(await this.ocrBand(STASH_BAND));
      let invOpen = /inventor/i.test(await this.ocrBand(INVENTORY_BAND));
      if (stashOpen && !invOpen) {
        // Second opinion before touching anything — a tooltip can cover the title.
        await this.harness.sleep(600, false);
        invOpen = /inventor/i.test(await this.ocrBand(INVENTORY_BAND));
      }
      if (stashOpen && invOpen) return true;
      if (stashOpen && !invOpen) {
        // Never fight a toggle: at most one corrective `i` press.
        if (this.harness.guard("inventory-toggle", invToggles >= 1)) return false;
        invToggles += 1;
        await this.host.send({ op: "focus" });
        await this.harness.sleep(250);
        await this.host.send({ op: "hotkey", keys: "i" });
        await this.harness.sleep(700);
        continue;
      }
      // Diagnose from one full OCR pass — a blind Escape here once OPENED the
      // pause menu on top of a perfectly good stash and sabotaged the retries.
      const reply = await this.host.send({ op: "ocr" });
      const lines = (Array.isArray(reply.lines) ? reply.lines : []) as OcrText[];
      const find = (re: RegExp) => lines.find((line) => re.test(line.text.trim()));
      const resume = find(/^resume/i);
      if (this.harness.guard("pause-menu-open", !!resume)) {
        await this.host.send({ op: "focus" });
        await this.harness.sleep(200);
        await this.harness.click(
          Math.round(resume!.x + resume!.w / 2),
          Math.round(resume!.y + resume!.h / 2),
          "close pause menu (Resume)",
        );
        await this.harness.sleep(800);
        continue;
      }
      const optionsOpen =
        !!find(/DISPLAY SETTINGS|SUPPORT GEM CAPACITY|PASSIVE SKILL|CHARACTER SHEET|ATLAS/i) ||
        (!!find(/^OPTIONS$/i) && !!find(/GRAPHICS|RENDERER/i));
      if (this.harness.guard("options-panel-open", optionsOpen)) {
        await this.host.send({ op: "focus" });
        await this.harness.sleep(200);
        await this.host.send({ op: "hotkey", keys: "escape" });
        await this.harness.sleep(800);
        continue;
      }
      // Find the wanted chest's nameplate at click time, full-screen OCR
      // only: mid-size region crops intermittently return zero lines. The
      // rule inverts per chest mode: personal wants the bare "Stash" plate
      // and excludes anything near a "Guild" line (±300px); guild wants the
      // plate that READS guild ("Guild Stash", or a split "Guild" line).
      // Both exclude the minimap/quest area (x>3000) — the minimap prints
      // the same names and clicking it walks the character into a corner.
      const inWorld = (line: OcrText) =>
        line.y >= 150 && line.y <= 1800 && line.x >= 500 && line.x <= 3000;
      const guilds = lines.filter((line) => /guild/i.test(line.text));
      const plate = this.guildChest
        ? lines.find((line) => /guild/i.test(line.text) && inWorld(line))
        : lines.find(
            (line) =>
              /^stash$/i.test(line.text.trim()) &&
              inWorld(line) &&
              !guilds.some((g) => Math.abs(g.x - line.x) < 300 && Math.abs(g.y - line.y) < 60),
          );
      // DESTRUCTIVE-CLICK GATE: a "not enough space" toast (bounced deposit)
      // can cover the stash TITLE for a few seconds, faking "panel closed"
      // while the panel is fully open — and the world's Stash nameplate is
      // visible BESIDE the open panel, so the chest-click below would land
      // in the world, walk the character, and close the panel for real
      // (killed two live runs, 2026-08-30). Before any walk/chest click,
      // require the PIXELS to agree that no stash grid is on screen.
      if (await this.stashGridVisible()) {
        this.harness.guard("stash-open-by-grid-despite-title-miss", true);
        await this.harness.sleep(1200, false); // let the toast fade
        continue;
      }
      if (!plate) {
        // Chest not on screen — the minimap's label is safe as a
        // NAVIGATION click: it walks the character toward the chest.
        const miniStash = this.guildChest
          ? lines.find((line) => /guild/i.test(line.text) && line.x > 3250 && line.y < 600)
          : lines.find(
              (line) => /^stash$/i.test(line.text.trim()) && line.x > 3250 && line.y < 600,
            );
        if (this.harness.guard("minimap-navigation", !!miniStash && navClicks < 2)) {
          navClicks += 1;
          await this.host.send({ op: "focus" });
          await this.harness.sleep(250);
          await this.harness.click(
            Math.round(miniStash!.x + miniStash!.w / 2),
            Math.round(miniStash!.y + miniStash!.h / 2),
            "walk toward stash (minimap)",
          );
          await this.harness.sleep(6000, false); // let the character walk
          continue;
        }
      }
      if (plate) {
        // Two attempts with generous pathing time, then give up loudly —
        // wandering click-spam reads as "randomly clicking around my hideout".
        if (this.harness.guard("chest-clicks-exhausted", chestClicks >= maxChestClicks)) return false;
        chestClicks += 1;
        await this.host.send({ op: "focus" });
        await this.harness.sleep(250);
        await this.harness.click(
          Math.round(plate.x + plate.w / 2),
          Math.round(plate.y + plate.h / 2 + 70),
          "open stash chest",
        );
        await this.harness.sleep(5000, false);
        continue;
      }
      // Nothing recognisable — transient frame. Wait it out, never guess-click.
      await this.harness.sleep(1500, false);
    }
    this.saveDebugFrame(await this.captureFrame(), "stash-unrecoverable");
    return false;
  }

  /* ---------------- tab-list-only navigation ---------------- */

  private gearRowsIn(rows: readonly TabListRow[]): TabListRow[] {
    return rows.filter((row) =>
      GEAR_TAB_NAMES.some((name) => row.label.trim() === name || labelsSimilar(row.label, name)),
    );
  }

  /**
   * The dropdown lists the ACTIVE tab's container. Detect which one by
   * POSITIVE markers on both sides: gear tab names mean the folder,
   * "Gear"/"AFFINITIES" rows mean the top level. A read matching neither is a
   * bad OCR frame ("ambiguous") and must be retried, never acted on — judging
   * top-level by the mere absence of gear names once flapped the dropdown
   * closed/open forever on garbled reads.
   */
  private listContext(rows: readonly TabListRow[]): "folder" | "top-level" | "ambiguous" {
    // The guild stash has no folders at all — any stable list read IS the
    // top-level list; demanding the personal-stash markers ("Gear",
    // "AFFINITIES") would flap the dropdown forever.
    if (this.guildChest) return "top-level";
    // The dropdown is ONE scrollable list: top-level rows sit above the
    // folder's children, and a scrolled state shows both at once (stable
    // across reads — not a transition glitch; watched live). A frame with
    // gear rows is therefore usable as a folder read; the caller strips the
    // top-level rows so matching can never click them.
    if (this.gearRowsIn(rows).length >= 2) return "folder";
    if (rows.some((row) => /^(gear|affinities)$/i.test(row.label.trim()))) return "top-level";
    return "ambiguous";
  }

  /** True for rows that belong to the top-level part of the combined list —
   * the Gear folder row itself, AFFINITIES, T tabs, and Remove-only tabs. */
  private isTopLevelRowLabel(label: string): boolean {
    const trimmed = label.trim();
    return (
      /^(gear|affinities)$/i.test(trimmed) ||
      Boolean(canonicalTTabLabel(trimmed)) ||
      isRemoveOnlyTabLabel(trimmed)
    );
  }

  private describeRows(rows: readonly TabListRow[]): string {
    return rows.map((row) => (row.readable ? row.label : "·")).join(" | ");
  }

  /**
   * Make sure the strip's second row (the open Gear folder's tabs) exists —
   * the folder list chevron only renders alongside it. This is the only
   * strip interaction in the sorter, and it clicks the FOLDER HEADER on the
   * top row, never a tab.
   */
  private async ensureFolderRowOpen(): Promise<boolean> {
    // With a SPECIAL tab active (Currency, Flask, Maps …) the strip's second
    // row — and its chevron — belongs to THAT group, and the chevron then
    // opens the special list forever (livelocked a run). Only positive
    // evidence of the special group rejects the row; garbled gear labels
    // must not trigger a pointless (and collapsing) header re-click.
    const specialGroup = (entries: ReadonlyArray<{ label: string }>): boolean =>
      entries.some(
        (entry) =>
          /flask|abyss|breach|relic|map|fragment|ritual|rune|expedition|gem|delir|essenc|dist|price|\bcur\b/i.test(
            entry.label,
          ) || isRemoveOnlyTabLabel(entry.label),
      );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const strip = await this.kit.readStrip();
      const wrongGroup = specialGroup(strip.folder);
      if (strip.folder.length > 0 && !wrongGroup) return true;
      if (this.harness.guard("strip-wrong-group", wrongGroup)) {
        this.log(
          `  · strip second row shows the SPECIAL group [${strip.folder.map((e) => e.label).join(" | ")}] — re-selecting Gear`,
        );
      }
      let header = strip.top.find((entry) => /gear/i.test(entry.label));
      if (!header) {
        // Selecting any tab scrolls the strip; a junk trip to a T tab can
        // leave it far right with "Gear" off-screen (seen live: top row read
        // only "T13"). Page the top row back toward its left end, where the
        // Gear header lives, checking as we go.
        this.harness.guard("strip-scrolled-off-gear", true);
        for (let page = 0; page < 4 && !header; page += 1) {
          for (let step = 0; step < 4; step += 1) {
            await this.harness.click(52, 212, `scroll tab strip left (${page * 4 + step + 1}/16)`);
            await this.harness.sleep(260, false);
          }
          await this.park();
          header = (await this.kit.readStrip()).top.find((entry) => /gear/i.test(entry.label));
        }
      }
      if (!header) {
        if (!(await this.ensureStash())) return false;
        continue;
      }
      // A merged OCR line centres on the crack between headers; bias left.
      const merged = !/^gear$/i.test(header.label.trim());
      const clickX = merged ? Math.round(header.point.x - header.width / 2 + 35) : header.point.x;
      await this.host.send({ op: "focus" });
      await this.harness.sleep(200);
      await this.harness.click(clickX, header.point.y, "open Gear folder row");
      await this.harness.sleep(900);
    }
    const strip = await this.kit.readStrip();
    return strip.folder.length > 0 && !specialGroup(strip.folder);
  }

  /**
   * Get the FOLDER list open and read its rows. The folder chevron
   * (LIST_TOGGLE_FOLDER) is the only opener used; a top-level list that
   * somehow got opened is closed via its own toggle first. Ambiguous reads
   * are re-read, never acted on.
   */
  private async openFolderList(): Promise<TabListRow[]> {
    if (!(await this.stashTitleVisible())) throw new Error("stash-panel-closed");
    this.folderListOpen = false; // unknown until this read verifies it
    // A hover tooltip from wherever the cursor last rested can overlap the
    // list region and OCR as phantom tab rows (jewel names once queued as
    // eight tabs) — park before every read so no tooltip is showing.
    await this.park();
    // Eight attempts, not four: recovering from a scrolled/parity-flipped
    // list costs one attempt per corrective toggle (reset scroll, close top
    // list, reopen folder), and a budget of four ran out mid-recovery.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const rows = await this.kit.readTabList();
      if (rows.length >= 4) {
        const context = this.listContext(rows);
        // Strip the top-level rows of the combined list before returning: a
        // scrolled window shows them above the children, and matching must
        // never click Gear/AFFINITIES/T-tab rows while hunting a folder tab.
        if (context === "folder") {
          this.folderListOpen = true;
          return rows.filter((row) => !(row.readable && this.isTopLevelRowLabel(row.label)));
        }
        if (this.harness.guard("top-level-list-open", context === "top-level")) {
          this.log(`  · top-level list open: [${this.describeRows(rows)}] — closing it`);
          await this.harness.click(LIST_TOGGLE_TOP.x, LIST_TOGGLE_TOP.y, "close top-level tab list");
          await this.park();
          await this.harness.sleep(700);
        } else {
          // An ambiguous read can be a STABLE scrolled state (the dropdown
          // parked in the special-tabs region shows no gear rows at all, and
          // re-reading forever livelocked a run) — actively close the list
          // so the reopen below resets its scroll.
          this.harness.guard("tab-list-ambiguous", true);
          this.log(`  · list read ambiguous: [${this.describeRows(rows)}] — closing to reset scroll`);
          await this.harness.click(LIST_TOGGLE_TOP.x, LIST_TOGGLE_TOP.y, "close scrolled tab list");
          await this.park();
          await this.harness.sleep(700);
        }
      }
      if (!(await this.ensureFolderRowOpen())) continue;
      await this.host.send({ op: "focus" });
      await this.harness.sleep(200);
      await this.harness.click(
        LIST_TOGGLE_FOLDER.x,
        LIST_TOGGLE_FOLDER.y,
        "open gear folder list",
      );
      await this.park();
      await this.harness.sleep(900);
    }
    throw new Error("gear-folder-list-unreadable");
  }

  /**
   * Close whatever list is open, with the toggle matching its CONTENT — the
   * two toggles sit 66px apart and clicking the wrong one opens the other
   * list instead of closing this one. Policy: the FOLDER list lives to the
   * right of the stash panel and stays open between hops; this is only for
   * recovery paths and for the top-level list, which does need closing.
   */
  private async closeTabListIfOpen(): Promise<void> {
    const rows = await this.kit.readTabList();
    if (!this.harness.guard("dropdown-stayed-open", rows.length >= 4)) return;
    const context = this.listContext(rows);
    const toggle = context === "top-level" ? LIST_TOGGLE_TOP : LIST_TOGGLE_FOLDER;
    if (context !== "top-level") this.folderListOpen = false;
    await this.harness.click(toggle.x, toggle.y, `close ${context} tab list`);
    await this.park();
    await this.harness.sleep(600);
  }

  /** Folder-list rows from the last verified read. Rows never move while the
   * stash stays open, so a cached read addresses every later hop without
   * OCR; any failed verification invalidates the cache. */
  private folderRowsCache: TabListRow[] | undefined;

  /** True while the folder side list is verifiably open. The cached-row fast
   * path clicks list coordinates WITHOUT re-reading the list, so it may only
   * fire while this is true — the top-list flows CLOSE the folder list (one
   * physical dropdown), and clicking a remembered row with no list open
   * would click into the game world. */
  private folderListOpen = false;

  /**
   * Resolve a folder-list row for `label`#`occurrence` from `rows`, with the
   * full matcher stack: exact folded > loose (with canonical-collision
   * exclusion) > remembered absolute Y > elimination. Returns undefined when
   * nothing safe matches.
   */
  private matchFolderRow(
    rows: readonly TabListRow[],
    label: string,
    occurrence: number,
  ): TabListRow | undefined {
    const cacheKey = `${label}#${occurrence}`;
    // EXACT (confusable-folded) matches outrank loose similarity, and a
    // row exactly naming a DIFFERENT known tab can never be a loose
    // match — "QuarterStaff" contains "staff" and once swallowed every
    // Staff deposit.
    const exact = rows.filter(
      (candidate) => candidate.readable && labelsEqualFolded(candidate.label, label),
    );
    // The exclusion below only makes sense when WE know exactly which
    // canonical tab we want — a garbled queue label ("Bunker/Sheildsl")
    // must still loose-match the real row it garbled from.
    const wantedIsCanonical = GEAR_TAB_NAMES.some((name) => labelsEqualFolded(name, label));
    const matches = exact.length > 0
      ? exact
      : rows.filter(
          (candidate) =>
            candidate.readable &&
            labelsSimilar(candidate.label, label) &&
            !(
              wantedIsCanonical &&
              GEAR_TAB_NAMES.some(
                (name) =>
                  !labelsEqualFolded(name, label) && labelsEqualFolded(candidate.label, name),
              )
            ),
        );
    let row: TabListRow | undefined = matches[occurrence];
    if (!row) {
      // Fall back to the remembered ABSOLUTE Y when the label merely
      // failed to OCR this frame — unless a DIFFERENT readable label now
      // sits at that position (the list changed; do not click blind).
      const cachedY = this.rowYCache.get(cacheKey);
      const near = cachedY === undefined
        ? undefined
        : rows.find((candidate) => Math.abs(candidate.clickY - cachedY) < 24);
      // Only a SUBSTANTIAL different label at the remembered position
      // blocks the click — single-char OCR debris ("O" is how Sceptre's
      // row usually reads) is the very garble the cache exists to ride
      // through, not evidence the list moved.
      const conflicting =
        near?.readable === true &&
        normalizeTabLabel(near.label).length >= 2 &&
        !labelsSimilar(near.label, label);
      if (this.harness.guard("row-y-cache-used", cachedY !== undefined && !conflicting)) {
        this.log(`  · "${label}" unreadable this frame — using its remembered y=${cachedY}`);
        row = { index: near?.index ?? -1, label, readable: false, clickY: cachedY! };
      }
    }
    if (!row && occurrence === 0 && GEAR_TAB_NAMES.some((name) => labelsSimilar(name, label))) {
      // Match by ELIMINATION: the folder's membership is fully known, so
      // when every other row claims a known gear tab and exactly ONE row
      // is unclaimed garble, that row must be the missing tab (Sceptre's
      // row OCRs as a bare "O" more often than not).
      const unclaimed = rows.filter(
        (candidate) => !GEAR_TAB_NAMES.some((name) => labelsSimilar(candidate.label, name)),
      );
      if (unclaimed.length === 1 && this.harness.guard("row-by-elimination", true)) {
        const only = unclaimed[0]!;
        this.log(
          `  · "${label}" matched by elimination — the only unclaimed row (reads "${only.readable ? only.label : "?"}") at y=${only.clickY}`,
        );
        row = { ...only, label, readable: false };
      }
    }
    return row;
  }

  /**
   * Select a tab by label, via the FOLDER list only. `occurrence` addresses
   * duplicate labels (the folder holds two tabs that read "Rings"): 0 = the
   * first matching row top-to-bottom, 1 = the second, and so on. Remove-only
   * tabs are refused outright (standing rule). Returns false when the tab
   * cannot be reached — the caller decides whether that kills the route.
   *
   * Fast paths (bench: goto averaged 9.9s over 273 hops, ~45min/session):
   * - Already the active tab → one pixel proof the grid is on screen, done.
   * - Cached folder rows + grid visible → click the remembered row and
   *   verify the switch by pixel change-detection; any doubt falls through
   *   to the slow OCR-verified path, which also refreshes the cache.
   */
  async gotoTab(
    label: string,
    occurrence = 0,
    topLevel = false,
    rowY?: number,
    drain = false,
  ): Promise<boolean> {
    // Symmetric refusals: a drain goto may ONLY select a drainable
    // Remove-only row; every other goto keeps refusing them exactly as
    // before. Both directions guard against garbled labels selecting the
    // wrong kind of tab.
    if (drain && (!topLevel || !isDrainableRemoveOnlyLabel(label))) {
      this.harness.guard("drain-goto-refused", true);
      this.log(`  ! drain navigation requires a top-level Remove-only label — refusing "${label}"`);
      return false;
    }
    if (!drain && isRemoveOnlyTabLabel(label)) {
      this.harness.guard("remove-only-refused", true);
      this.log(`  ! refusing to select Remove-only tab "${label}"`);
      return false;
    }
    if (topLevel) return this.gotoTopTab(label, rowY, drain, occurrence);
    const cacheKey = `${label}#${occurrence}`;
    const endPhase = this.harness.startPhase(`goto:${cacheKey}`);
    try {
      await this.harness.checkpoint(`goto ${label}`);
      // Already active: the run loop probes a tab and cleanTab immediately
      // re-navigates to it — that second hop needs one cheap grid proof.
      if (this.lastSelected === cacheKey && (await this.stashOpenProof())) {
        endPhase("already-active");
        return true;
      }
      const cachedRow = this.folderListOpen && this.folderRowsCache
        ? this.matchFolderRow(this.folderRowsCache, label, occurrence)
        : undefined;
      if (cachedRow && !isRemoveOnlyTabLabel(cachedRow.label) && (await this.stashGridVisible())) {
        await this.harness.click(LIST_ROW_CLICK_X, cachedRow.clickY, `select tab ${label} (cached row)`);
        const wasSelected = this.lastSelected;
        this.lastSelected = cacheKey;
        await this.park();
        const observed = await this.settleAfterTabClick(true);
        // The fast path accepts only POSITIVE proof: the grid repainted and
        // is still a grid. Anything less (no repaint seen, grid gone) means
        // the click may have missed a closed list — re-prove the slow way
        // before anything deposits into a wrong tab.
        if (observed === "changed" && (await this.stashGridVisible())) {
          if (cachedRow.readable) this.rowYCache.set(cacheKey, cachedRow.clickY);
          endPhase("cached-row");
          return true;
        }
        this.harness.guard("goto-fast-path-miss", true);
        this.folderRowsCache = undefined;
        this.folderListOpen = false;
        this.lastSelected = wasSelected;
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await this.harness.checkpoint(`goto ${label}`);
        if (!(await this.stashTitleVisible())) {
          if (!(await this.ensureStash())) throw new Error("stash-lost-and-unrecoverable");
        }
        let rows: TabListRow[];
        try {
          rows = await this.openFolderList();
        } catch {
          continue; // list unreadable — retry from the top
        }
        this.folderRowsCache = rows;
        const row = this.matchFolderRow(rows, label, occurrence);
        if (!row && this.lastSelected === cacheKey) {
          // Some tab highlights (Jewels' magenta) defeat OCR while the tab is
          // ACTIVE — and the tab we last selected is still the active one, so
          // there is nothing to click. Verify the grid and stay put.
          this.harness.guard("already-selected-fallback", true);
          this.log(`  · "${label}" is the active tab (row unreadable while highlighted) — staying`);
          await this.settleGrid();
          endPhase("already-selected");
          return true;
        }
        if (!row) {
          // The folder list is short and unclipped; a missing row is a bad
          // read, not a scrolled-away tab. Close and retry.
          this.log(`  · "${label}"#${occurrence} not in folder list: [${this.describeRows(rows)}]`);
          this.folderRowsCache = undefined;
          await this.closeTabListIfOpen();
          continue;
        }
        if (row.readable) this.rowYCache.set(cacheKey, row.clickY);
        if (isRemoveOnlyTabLabel(row.label)) {
          this.harness.guard("remove-only-refused", true);
          this.log(`  ! folder list row for "${label}" reads Remove-only — refusing`);
          endPhase("refused");
          return false;
        }
        await this.harness.click(LIST_ROW_CLICK_X, row.clickY, `select tab ${label}`);
        const expectChange = this.lastSelected !== cacheKey;
        this.lastSelected = cacheKey;
        await this.park();
        // The folder list sits to the RIGHT of the stash panel and obstructs
        // nothing — leave it open between hops (the user asked for exactly
        // this: only a top-level list ever needs closing).
        await this.settleAfterTabClick(expectChange);
        endPhase();
        return true;
      }
      endPhase("unreachable");
      return false;
    } catch (error) {
      endPhase(error instanceof SortStop ? "stopped" : "failed");
      throw error;
    }
  }

  /**
   * Close the top list without an OCR round trip when possible: the list was
   * verifiably open moments ago (its rows were just read or clicked), so one
   * toggle click closes it; the pixel change on the list region plus a grid
   * proof confirm. Any doubt falls back to the OCR-verified close.
   */
  private async closeTopListFast(): Promise<void> {
    const listRegion = {
      x: TAB_LIST.region.left,
      y: TAB_LIST.region.top,
      w: 700,
      h: TAB_LIST.region.height,
    };
    await this.harness.click(LIST_TOGGLE_TOP.x, LIST_TOGGLE_TOP.y, "close top-level tab list");
    await this.park();
    // Wait for the close animation to finish (stability), then prove the
    // grid is showing. The toggle click happened before the pixwait baseline,
    // so only stability is meaningful here — the grid proof is the verdict.
    await this.pixwait(listRegion, { stableMs: 150 });
    if (await this.stashGridVisible()) return;
    this.harness.guard("top-list-close-unverified", true);
    await this.closeTabListIfOpen();
  }

  /** Canonical top-strip labels seen readable this session. Together with
   * the one-time unmask hop this tells "unreadable because ACTIVE" apart
   * from "does not exist". */
  private readonly knownTopLabels = new Set<string>();
  private topStripDisambiguated = false;

  private canonTopLabel(label: string): string {
    return canonicalTTabLabel(label) ?? normalizeTabLabel(label);
  }

  private noteTopStrip(entries: readonly StripEntry[]): void {
    for (const entry of entries) {
      const canon = this.canonTopLabel(entry.label);
      if (canon.length >= 2) this.knownTopLabels.add(canon);
    }
  }

  /** Top-strip entries that are safe to CLICK (real tabs, not folders or
   * protected tabs). A drain goto inverts the Remove-only rule: it may ONLY
   * click Remove-only entries (priced protection still outranks it). */
  private clickableTopEntry(entry: StripEntry, drain = false): boolean {
    const trimmed = entry.label.trim();
    if (drain) return isDrainableRemoveOnlyLabel(trimmed);
    return (
      trimmed.length >= 2 &&
      !/^(gear|affinities)$/i.test(trimmed) &&
      !isRemoveOnlyTabLabel(trimmed) &&
      !trimmed.startsWith("~") &&
      !/price/i.test(trimmed)
    );
  }

  /**
   * Selection of a top-level tab by its own STRIP HEADER — the user's chosen
   * navigation for top-level tabs and folders (2026-08-30): the strip shows
   * every label unclipped, and with no overflow the dropdown's top toggle
   * does not even render. The wanted label can be unreadable because it is
   * the ACTIVE tab (its highlight defeats OCR) — pixel elimination detects
   * that with zero clicks; failing that, ONE unmask hop to a gear tab makes
   * every header readable (once per session). Returns true on positively
   * verified selection, false on a definitive refusal, undefined when this
   * attempt proved nothing (caller retries).
   */
  private async gotoTopTabViaStrip(
    label: string,
    cacheKey: string,
    drain = false,
  ): Promise<boolean | undefined> {
    const findEntry = (entries: readonly StripEntry[]): StripEntry | undefined =>
      pickExact(entries, label) ?? pickUnique(entries, label) ?? findLabelSegment(entries, label);
    let strip = await this.kit.readStrip();
    this.noteTopStrip(strip.top);
    let entry = findEntry(strip.top);
    if (entry && !this.clickableTopEntry(entry, drain)) return false; // protected — refuse
    if (!entry && drain) {
      // Remove-only labels are long and always OCR; the guesswork fallbacks
      // below (bright-header elimination, the unmask hop) could select a
      // DIFFERENT tab, and a drain must never run against a guessed tab.
      // Report nothing-proven and let the caller retry or skip the source.
      return undefined;
    }
    if (!entry) {
      // BRIGHT-HEADER elimination: a light-coloured tab (the user's Dump tab
      // is silver) NEVER OCRs — dark text on a light background defeats the
      // engine whether the tab is active or not. But that same brightness
      // makes it findable by pixels: when exactly one plausible bright
      // header exists, no readable label overlaps it, and no readable label
      // matches the wanted tab, that header must be the wanted tab. Click
      // it — a click on an already-active header is a harmless no-op.
      const raw = await this.captureRaw();
      const band = {
        x: 40,
        y: STRIP_ROWS.top.min + 6,
        w: 1240,
        h: STRIP_ROWS.top.max - STRIP_ROWS.top.min - 12,
      };
      const runs = brightHeaderRuns(raw.gray, raw.client, band).filter(
        (run) => run.x1 - run.x0 <= 420,
      );
      const overlapsReadable = (run: { x0: number; x1: number }) =>
        strip.top.some(
          (candidate) =>
            candidate.point.x - candidate.width / 2 - 12 < run.x1 &&
            candidate.point.x + candidate.width / 2 + 12 > run.x0,
        );
      if (runs.length === 1 && !overlapsReadable(runs[0]!)) {
        const run = runs[0]!;
        const cx = Math.round((run.x0 + run.x1) / 2);
        const cy = Math.round((STRIP_ROWS.top.min + STRIP_ROWS.top.max) / 2);
        this.harness.guard("top-tab-by-brightness", true);
        this.log(
          `  · "${label}" has no readable header, but exactly one bright unlabeled header sits at x≈${cx} — clicking it as ${label}`,
        );
        await this.host.send({ op: "focus" });
        await this.harness.sleep(200);
        await this.harness.click(cx, cy, `select top tab ${label} (bright header)`);
        this.lastSelected = cacheKey;
        await this.park();
        // No repaint is legitimate here — the header may already have been
        // the active tab. The verdict is simply "is the stash still open":
        // the dense-quad case defeats the lattice check, so the panel title
        // is the fallback proof.
        await this.settleAfterTabClick(true);
        if (await this.stashOpenProof()) return true;
        return undefined;
      }
      if (!this.topStripDisambiguated && !this.guildChest) {
        // Last resort: hop to a known gear tab once so every top header is
        // inactive and readable, then look again. (Guild mode has no gear
        // folder to hop into — skip straight to the retry.)
        this.topStripDisambiguated = true;
        this.harness.guard("top-strip-unmask-hop", true);
        this.log(`  · "${label}" not readable in the strip — hopping to a gear tab to unmask it`);
        for (const gearTab of ["Belts", "Rings", "Helmets"]) {
          if (await this.gotoTab(gearTab)) break;
        }
        strip = await this.kit.readStrip();
        this.noteTopStrip(strip.top);
        entry = findEntry(strip.top);
        if (entry && !this.clickableTopEntry(entry)) return false;
      }
    }
    if (!entry) return undefined;
    await this.host.send({ op: "focus" });
    await this.harness.sleep(200);
    await this.harness.click(entry.point.x, entry.point.y, `select top tab ${label} (strip)`);
    this.lastSelected = cacheKey;
    await this.park();
    const observed = await this.settleAfterTabClick(true);
    if (observed !== "unchanged" && (await this.stashOpenProof())) return true;
    this.harness.guard("top-strip-click-unverified", true);
    return undefined;
  }

  /**
   * Select a TOP-LEVEL tab. Named labels click their own STRIP HEADER —
   * the user's chosen navigation for top-level tabs (2026-08-30). Only
   * positional T-band rows (no readable header anywhere, addressed by their
   * remembered dropdown Y) still go through the top list, which covers the
   * grid and is always closed after selection.
   */
  private async gotoTopTab(
    label: string,
    rowY?: number,
    drain = false,
    occurrence = 0,
  ): Promise<boolean> {
    // The guild stash repeats labels (three "2 (Remove-only)" tabs live);
    // occurrence keys the cache and picks the nth matching list row, the
    // folder machinery's trick applied to the top level.
    const cacheKey = `top:${label}#${occurrence}`;
    const endPhase = this.harness.startPhase(`goto:${cacheKey}`);
    try {
      await this.harness.checkpoint(`goto top ${label}`);
      if (this.lastSelected === cacheKey && (await this.stashOpenProof())) {
        endPhase("already-active");
        return true;
      }
      // Guild mode navigates EVERYTHING through the list: the strip shows
      // only a couple of headers in the overflowed guild layout, and the
      // strip path's guess fallbacks must never pick a deposit target.
      if (!this.guildChest && !label.startsWith("T@row") && rowY === undefined) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await this.harness.checkpoint(`goto top ${label}`);
          const viaStrip = await this.gotoTopTabViaStrip(label, cacheKey, drain);
          if (viaStrip !== undefined) {
            endPhase(viaStrip ? "strip" : "refused");
            return viaStrip;
          }
          // Nothing proven this attempt — make sure the stash is even open
          // before reading the strip again.
          if (!(await this.stashTitleVisible())) {
            if (!(await this.ensureStash())) throw new Error("stash-lost-and-unrecoverable");
          }
        }
        endPhase("unreachable");
        return false;
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await this.harness.checkpoint(`goto top ${label}`);
        if (!(await this.stashTitleVisible())) {
          if (!(await this.ensureStash())) throw new Error("stash-lost-and-unrecoverable");
        }
        let rows: TabListRow[];
        try {
          rows = await this.openTopList();
        } catch {
          continue;
        }
        // The Remove-only rule inverts per goto kind: a drain goto matches
        // ONLY drainable Remove-only rows, every other goto refuses them.
        const rowSelectable = (candidate: TabListRow): boolean =>
          drain
            ? isDrainableRemoveOnlyLabel(candidate.label)
            : !isRemoveOnlyTabLabel(candidate.label);
        // Duplicate labels: exact matches are picked by OCCURRENCE (nth
        // row top-to-bottom). The loose-similarity fallback is only safe
        // for occurrence 0 and NEVER for drains — the guild's numeric
        // labels containment-match each other ("1 (Remove-only)" is inside
        // "31 (Remove-only)"), and a drain must not select a lookalike.
        const exact = rows.filter(
          (candidate) =>
            candidate.readable &&
            rowSelectable(candidate) &&
            labelsEqualFolded(candidate.label, label),
        );
        let row: TabListRow | undefined =
          exact[occurrence] ??
          (occurrence === 0 && !drain
            ? rows.find(
                (candidate) =>
                  candidate.readable &&
                  rowSelectable(candidate) &&
                  labelsSimilar(candidate.label, label),
              )
            : undefined);
        if (!row) {
          // A positional source (unreadable T-band row) or a remembered Y:
          // click the absolute position, unless a readable protected label
          // now sits there. A drain source's row must additionally still
          // read Remove-only if it reads at all — Remove-only tabs VANISH
          // when fully drained, so a stale Y may point at a shifted row.
          const targetY = this.rowYCache.get(cacheKey) ?? rowY;
          const near = targetY === undefined
            ? undefined
            : rows.find((candidate) => Math.abs(candidate.clickY - targetY) < 24);
          const conflicting =
            (near?.readable === true &&
              normalizeTabLabel(near.label).length >= 2 &&
              !labelsSimilar(near.label, label) &&
              !canonicalTTabLabel(near.label)) ||
            (drain && near?.readable === true && !isDrainableRemoveOnlyLabel(near.label)) ||
            (drain && !near);
          if (this.harness.guard("row-y-cache-used", targetY !== undefined && !conflicting)) {
            this.log(`  · "${label}" unreadable this frame — using y=${targetY}`);
            row = { index: near?.index ?? -1, label, readable: false, clickY: targetY! };
          }
        }
        if (!row && this.lastSelected === cacheKey) {
          this.harness.guard("already-selected-fallback", true);
          this.log(`  · "${label}" is the active tab (row unreadable while highlighted) — staying`);
          await this.closeTopListFast();
          endPhase("already-selected");
          return true;
        }
        if (!row) {
          this.log(`  · "${label}" not in top list: [${this.describeRows(rows)}]`);
          await this.closeTabListIfOpen();
          continue;
        }
        if (row.readable) this.rowYCache.set(cacheKey, row.clickY);
        await this.harness.click(LIST_ROW_CLICK_X, row.clickY, `select top tab ${label}`);
        this.lastSelected = cacheKey;
        await this.park();
        await this.harness.sleep(300);
        // The TOP list covers the grid — always close it after selecting.
        await this.closeTopListFast();
        // Guild tab switches are realm writes too — hold the floor.
        if (this.guildChest) await this.harness.sleep(GUILD_PACE.tabMs, false);
        endPhase();
        return true;
      }
      endPhase("unreachable");
      return false;
    } catch (error) {
      endPhase(error instanceof SortStop ? "stopped" : "failed");
      throw error;
    }
  }

  /**
   * Enumerate the sortable top-level T* tabs from the live top list, plus
   * synthesized T1..T16 candidates for rows whose labels do not OCR (short
   * labels routinely read as blank) — the goto probe sorts out which of
   * those actually exist. Remove-only rows are excluded outright; folders
   * (Gear, AFFINITIES) never match the T pattern.
   */
  async listTopSources(): Promise<SourceTab[]> {
    const sources: SourceTab[] = [];
    const seen = new Set<string>();
    // Every readable top-level tab is a source (the user adds plain storage
    // tabs the T* pattern can't predict) EXCEPT protected ones: ~price tabs
    // carry public listings that moving items would delist, the Gear row is
    // a folder rather than a tab, and AFFINITIES has its own semantics.
    const admit = (label: string): boolean => {
      if (!label || isRemoveOnlyTabLabel(label)) return false;
      const lower = label.toLowerCase();
      if (lower.startsWith("~") || lower.includes("price") || lower === "gear" || lower === "affinities") {
        return false;
      }
      if (normalizeTabLabel(label).length < 2) return false; // OCR debris
      const canonical = canonicalTTabLabel(label) ?? lower;
      if (seen.has(canonical)) return false;
      seen.add(canonical);
      return true;
    };
    // STRIP-FIRST: a no-overflow top row (the user's 2026-08-30 tab rework)
    // shows every label unclipped and renders NO top-list toggle at all —
    // the list path cannot even open there. The ACTIVE tab's label may be
    // missing here (highlight defeats OCR); run()'s requested-source probe
    // plus the goto unmask hop cover it.
    const strip = await this.kit.readStrip();
    this.noteTopStrip(strip.top);
    for (const entry of strip.top) {
      const label = entry.label.trim();
      if (admit(label)) sources.push({ label, occurrence: 0, topLevel: true });
    }
    // The dropdown still adds scrolled-off tabs and the positional T band in
    // OVERFLOW layouts — evidenced by the strip showing T tabs at all. In a
    // no-overflow layout (the current one) the toggle does not exist, every
    // attempt would be a dead click, and the strip row above is complete.
    let rows: TabListRow[] = [];
    if (strip.top.some((entry) => isTTabLabel(entry.label))) {
      try {
        rows = await this.openTopList(2);
      } catch {
        this.harness.guard("top-list-unavailable", true);
        rows = [];
      }
    }
    for (const row of rows) {
      if (!row.readable) continue;
      const label = row.label.trim();
      if (admit(label)) sources.push({ label, occurrence: 0, topLevel: true });
    }
    // The T tabs' SHORT labels are chronically unreadable, and synthesizing
    // T1..T16 by NAME queued ghosts that can never be clicked. Instead queue
    // the UNREADABLE rows positionally — but only inside the T band: strictly
    // after the AFFINITIES (or Gear) row and before the first readable row
    // that is not a T tab. Protected tabs (Remove-only, ~price, specials)
    // all have long, readable labels and sit outside the band, so a blind
    // positional click cannot land on one.
    const anchor = rows.find((row) => row.readable && /^(affinities|gear)$/i.test(row.label.trim()));
    if (anchor) {
      const anchorAt = rows.findIndex((row) => row === anchor);
      for (let i = anchorAt + 1; i < rows.length; i += 1) {
        const row = rows[i]!;
        if (row.readable) {
          const trimmed = row.label.trim();
          if (/^(affinities|gear)$/i.test(trimmed)) continue;
          if (canonicalTTabLabel(trimmed)) continue; // readable T rows already queued
          break; // first readable non-T row ends the band
        }
        const label = `T@row${row.index}`;
        if (seen.has(label)) continue;
        seen.add(label);
        sources.push({ label, occurrence: 0, topLevel: true, rowY: row.clickY });
      }
    }
    if (rows.length > 0) await this.closeTabListIfOpen();
    return sources;
  }

  /**
   * Enumerate Remove-only tabs as DRAIN sources (withdraw-only; the
   * 2026-08-30 rule change). Strip first — but in an OVERFLOWED layout the
   * Remove-only tabs sit at the END of the top list, exactly the rows the
   * strip cannot show, so the top list is always attempted too. Its absence
   * (no-overflow layout: the toggle does not render) proves the strip
   * already showed everything. Labels are long and OCR-readable; rows that
   * do not read are NOT synthesized — a drain never runs on a guessed tab.
   * A fully drained Remove-only tab vanishes from the account, so any tab
   * enumerated here may legitimately be gone by the time it is visited.
   */
  async listRemoveOnlySources(): Promise<SourceTab[]> {
    const admit = (label: string): boolean =>
      isDrainableRemoveOnlyLabel(label.trim()) && normalizeTabLabel(label.trim()).length >= 2;
    // LIST FIRST: in an overflowed layout the Remove-only tabs sit at the
    // END of the top list — exactly the rows the strip cannot show — and
    // the list gives every row a position, which duplicate labels need
    // (the guild repeats "2 (Remove-only)" three times; occurrence picks
    // the nth row, rowY remembers where it was).
    const sources: SourceTab[] = [];
    try {
      const rows = await this.openTopList(2);
      const counts = new Map<string, number>();
      for (const row of rows) {
        if (!row.readable || !admit(row.label)) continue;
        const label = row.label.trim();
        const canon = normalizeTabLabel(label);
        const occurrence = counts.get(canon) ?? 0;
        counts.set(canon, occurrence + 1);
        sources.push({ label, occurrence, topLevel: true, drain: true, rowY: row.clickY });
      }
      await this.closeTabListIfOpen();
      if (sources.length > 0) return sources;
    } catch {
      this.log("  · top list did not open (no-overflow layout) — falling back to the strip");
    }
    // Strip fallback for no-overflow layouts (the toggle does not render
    // there, and the strip shows every label unclipped, without duplicates
    // hidden behind it).
    const strip = await this.kit.readStrip();
    this.noteTopStrip(strip.top);
    const seen = new Set<string>();
    for (const entry of strip.top) {
      const label = entry.label.trim();
      if (!admit(label)) continue;
      const canon = normalizeTabLabel(label);
      if (seen.has(canon)) continue;
      seen.add(canon);
      sources.push({ label, occurrence: 0, topLevel: true, drain: true });
    }
    return sources;
  }

  /**
   * Get the TOP-LEVEL list open and read its rows — the folder list's mirror
   * image, used to reach the T* tabs.
   */
  private async openTopList(attempts = 8): Promise<TabListRow[]> {
    if (!(await this.stashTitleVisible())) throw new Error("stash-panel-closed");
    // There is ONE physical dropdown: getting the top list open means the
    // folder list is (or is about to be) closed — the folder fast path must
    // not click remembered rows after this.
    this.folderListOpen = false;
    await this.park(); // no tooltip over the list region (see openFolderList)
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const rows = await this.kit.readTabList();
      if (rows.length >= 4) {
        const context = this.listContext(rows);
        if (context === "top-level") return rows;
        if (context === "folder") {
          await this.harness.click(
            LIST_TOGGLE_FOLDER.x,
            LIST_TOGGLE_FOLDER.y,
            "close gear folder list",
          );
          await this.park();
          await this.harness.sleep(700);
        } else {
          // Stable scrolled state showing only special tabs — close so the
          // reopen below resets the scroll (see openFolderList).
          this.harness.guard("tab-list-ambiguous", true);
          this.log(`  · list read ambiguous: [${this.describeRows(rows)}] — closing to reset scroll`);
          await this.harness.click(LIST_TOGGLE_TOP.x, LIST_TOGGLE_TOP.y, "close scrolled tab list");
          await this.park();
          await this.harness.sleep(700);
        }
      }
      await this.host.send({ op: "focus" });
      await this.harness.sleep(200);
      await this.harness.click(LIST_TOGGLE_TOP.x, LIST_TOGGLE_TOP.y, "open top-level tab list");
      await this.park();
      await this.harness.sleep(900);
    }
    throw new Error("top-level-list-unreadable");
  }

  /** Wait until the newly selected tab renders a real grid before acting. */
  private async settleGrid(): Promise<void> {
    for (let settle = 0; settle < 4; settle += 1) {
      const frame = await this.captureFrame();
      if (!this.harness.guard("grid-not-settled", !stashRegionSane(frame.facts.stashRegion))) return;
      await this.harness.sleep(500, false);
    }
  }

  /* ---------------- search ---------------- */

  /**
   * Clear the Highlight box (click, select-all, backspace). The sorter never
   * TYPES queries any more — ground-truth Ctrl+C identification replaced the
   * whole search/highlight flow — so the old focus-probe machinery (typing
   * `---`, pixel-differencing the box) went with it. A clear that misses the
   * box sends one harmless backspace to the game.
   */
  private async clearSearch(): Promise<boolean> {
    if (!/stash/i.test(await this.ocrBand(STASH_BAND))) return false;
    await this.host.send({ op: "focus" });
    await this.harness.sleep(150);
    await this.harness.click(SEARCH_BOX.x, SEARCH_BOX.y, "clear search box");
    await this.harness.sleep(250);
    await this.host.send({ op: "hotkey", keys: "ctrla" });
    await this.harness.sleep(120);
    await this.host.send({ op: "hotkey", keys: "backspace" });
    await this.harness.sleep(120);
    await this.park();
    await this.harness.sleep(250);
    return true;
  }

  /* ---------------- deposit ---------------- */

  /**
   * Occupied bag cells straight from the calibrated bag grid — the exact
   * scoring lookCalibrated uses when a BGR frame is available, minus the
   * whole perception pass around it. Falls back to full perception only
   * when the profile has no bag grid.
   */
  private bagCellsRaw(raw: RawFrame): GridCell[] {
    const grid = this.profile.bagGrid;
    if (!grid) return [];
    const region = toScreenBox(raw.client, grid);
    return clampToArea(
      occupiedFromRgbScores(scoreGridCellsRgb(raw.bgr, raw.client, region, 12, 5)),
      BAG_AREA,
    );
  }

  private bagCells(frame: Frame): GridCell[] {
    if (this.profile.bagGrid) return this.bagCellsRaw(frame);
    return clampToArea(
      frame.facts.occupiedBag.map((cell) => ({ row: cell.row, col: cell.col, x: cell.x, y: cell.y })),
      BAG_AREA,
    );
  }

  private async currentBagCells(): Promise<GridCell[]> {
    if (this.profile.bagGrid) return this.bagCellsRaw(await this.captureRaw());
    return this.bagCells(await this.captureFrame());
  }

  private async bagCount(): Promise<number> {
    return (await this.currentBagCells()).length;
  }

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
  private async copyItemAt(x: number, y: number): Promise<string> {
    const original = await this.host.send({ op: "clipboard" });
    const originalText = String(original.text ?? "");
    const sentinel = `poe2-triage-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    try {
      await this.host.send({ op: "move", x, y });
      await this.harness.sleep(STASH_SCAN.inventory.hoverMs, false);
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
    } = {},
  ): Promise<{ items: IdentifiedItem[]; unread: GridCell[]; reads: Array<{ cell: GridCell; text: string }> }> {
    const { phantomScope, looksEmpty, probePoint, sameSpriteAsLeft } = options;
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
        // 100ms turbo hover: retested after grid calibration centred the
        // hovers (90ms pre-calibration read 22/93 — watch the read-rate).
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
        found = gotText(cell, await this.copyItemAt(informed.x, informed.y));
      } else {
        for (const [dx, dy] of [[14, 0], [-14, 0], [0, 14], [0, -14]] as const) {
          if (gotText(cell, await this.copyItemAt(cell.x + dx, cell.y + dy))) {
            found = true;
            break;
          }
        }
      }
      if (found) continue;
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
      const before = await this.bagCount();
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
        if ((await this.bagCount()) > before) {
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
      const first = new Set((await this.currentBagCells()).map((c) => `${c.row},${c.col}`));
      await this.harness.sleep(650, false);
      const second = new Set((await this.currentBagCells()).map((c) => `${c.row},${c.col}`));
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

  private async depositCells(points: readonly GridCell[], destLabel: string): Promise<number> {
    if (this.guildChest) return this.guildDepositSerial(points, destLabel);
    let targets = [...points];
    for (let pass = 0; pass < 2 && targets.length > 0; pass += 1) {
      const sent = await this.harness.burst(targets, {
        cellW: 70,
        cellH: 70,
        label: `${pass === 0 ? "deposit" : "deposit (shift)"} ${targets.length} → ${destLabel}`,
        shift: pass === 1,
      });
      if (sent === 0) return targets.length; // rejected or dry-run
      // A bounced deposit (full tab) leaves the cells briefly EMPTY while
      // the items fly back to the bag — a too-early read called a full tab
      // a clean deposit and re-filed the same rings for whole rounds
      // (watched live 2026-08-30). Wait out the animation UNPACED, then
      // require TWO agreeing reads before believing a cell emptied.
      await this.harness.sleep(700, false);
      const first = new Set((await this.currentBagCells()).map((cell) => `${cell.row},${cell.col}`));
      // Some bounces (Jewels) outlast even a ~1s window — the second read
      // waits substantially longer so a slow flyback cannot fake a landing.
      await this.harness.sleep(650, false);
      const second = new Set((await this.currentBagCells()).map((cell) => `${cell.row},${cell.col}`));
      const stillThere = (cell: GridCell) =>
        first.has(`${cell.row},${cell.col}`) || second.has(`${cell.row},${cell.col}`);
      if (this.harness.guard("deposit-bounce-detected", targets.some((cell) => !first.has(`${cell.row},${cell.col}`) && second.has(`${cell.row},${cell.col}`)))) {
        this.log(`  · deposit read raced the bounce animation in ${destLabel} — trusting the later read`);
      }
      targets = targets.filter(stillThere);
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
    context: { returnTo?: SourceTab; deadDests?: Set<string> } = {},
  ): Promise<number> {
    const endPhase = this.harness.startPhase("distribute-bag");
    let filed = 0;
    /** cell key -> copy text, valid for this bag-load. */
    const bagReads = new Map<string, { cell: GridCell; text: string }>();
    const cellKey = (cell: GridCell) => `${cell.row},${cell.col}`;
    const stillInBag = async (points: readonly GridCell[]): Promise<GridCell[]> => {
      const occupied = new Set((await this.currentBagCells()).map(cellKey));
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
          if (await this.gotoTab(back.label, back.occurrence, back.topLevel, back.rowY)) {
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
        const bag = this.depositTargets(await this.currentBagCells());
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
          const raw = await this.captureRaw();
          const bagGridBox = this.profile.bagGrid
            ? toScreenBox(raw.client, this.profile.bagGrid)
            : undefined;
          const { reads } = await this.identifyCells(unknown, {
            probePoint: bagGridBox
              ? (cell) => brightestCellPoint(raw.gray, raw.client, bagGridBox, 12, 5, cell)
              : undefined,
          });
          for (const read of reads) bagReads.set(cellKey(read.cell), read);
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
        if (!(await this.gotoTab(dest, 0, this.guildChest))) {
          const detours = group.filter((entry) => entry.detoured);
          if (detours.length === group.length) {
            // A dead triage tab must not loop the round forever: cancel
            // detours to it for the session; items re-route to class tabs.
            this.harness.guard("triage-tab-unreachable", true);
            this.unreachableTriageTabs.add(dest);
            this.log(`  ! triage tab "${dest}" unreachable — routing those items normally instead`);
            continue;
          }
          // Destination unreachable (the layout may simply not have this
          // tab any more — no Weapons quad since the 2026-08-30 rework):
          // remember it as dead for this visit so its items stop being
          // withdrawn, and bail this group.
          this.harness.guard("dest-unreachable-marked-dead", true);
          context.deadDests?.add(dest);
          this.log(`  ! "${dest}" unreachable — its items return to the source and stop being withdrawn`);
          const left = await bail(grabPoints);
          filed += group.length - Math.min(group.length, left);
          continue;
        }
        const left = await this.depositCells(grabPoints, dest);
        filed += group.length - Math.min(group.length, left);
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
      const still = new Set((await this.currentBagCells()).map((cell) => `${cell.row},${cell.col}`));
      targets = targets.filter((cell) => still.has(`${cell.row},${cell.col}`));
    };
    if (this.lastJunkTab && targets.length > 0 && (await this.gotoTopTab(this.lastJunkTab))) {
      await fileInto(this.lastJunkTab);
    }
    // Strip candidates next — in a no-overflow layout the top list cannot
    // even open, but every T tab (if any) shows unclipped on the strip.
    let stripHadTTabs = false;
    if (targets.length > 0) {
      const strip = await this.kit.readStrip();
      this.noteTopStrip(strip.top);
      for (const entry of strip.top) {
        const label = entry.label.trim();
        if (!isTTabLabel(label) || isRemoveOnlyTabLabel(label)) continue;
        stripHadTTabs = true;
        if (targets.length === 0 || tried.has(label)) continue;
        if (!(await this.gotoTopTab(label))) {
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
        rows = await this.openTopList(2);
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
      await this.harness.click(LIST_ROW_CLICK_X, candidate.clickY, `select junk tab ${candidate.label}`);
      this.lastSelected = `top:${candidate.label}#0`;
      await this.park();
      await this.harness.sleep(300);
      await this.closeTopListFast();
      await fileInto(candidate.label);
    }
    return targets.length;
  }

  /** User-taught grid geometry per tab, persisted across sessions. */
  private gridCalibration: Record<string, { x: number; y: number; w: number; h: number; cols: number; rows: number }> = {};
  private gridCalibrationLoaded = false;

  private get gridCalibrationFile(): string {
    return path.join(this.options.root, "artifacts", "tab-admin", "grid-calibration.json");
  }

  private loadGridCalibration(): void {
    if (this.gridCalibrationLoaded) return;
    this.gridCalibrationLoaded = true;
    try {
      this.gridCalibration = JSON.parse(readFileSync(this.gridCalibrationFile, "utf8"));
    } catch {
      this.gridCalibration = {};
    }
  }

  private saveGridCalibration(): void {
    try {
      writeFileSync(this.gridCalibrationFile, JSON.stringify(this.gridCalibration, null, 2));
    } catch {
      // calibration is a convenience cache, never a failure
    }
  }

  /** Thin lattice lines outlining every cell of the grid. */
  private latticeRects(
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
        this.latticeRects(region, cols, rows),
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
    this.saveGridCalibration();
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
   * requirement, driven entirely by Ctrl+C ground truth: identify every
   * occupied cell, withdraw the foreigners a bag-load at a time, and file
   * each withdrawn item into its true tab (junk to T*).
   */
  async cleanTab(source: SourceTab): Promise<number> {
    const key = source.occurrence ? `${source.label}#${source.occurrence}` : source.label;
    // Triage tabs hold what the value tiers detoured — cleaning one would
    // scatter the finds back into class tabs.
    const routingCfg = this.options.triage?.routing;
    if (routingCfg && !source.topLevel && isTriageTabLabel(source.label, routingCfg)) {
      this.log(`  · ${key} is a triage tab — never cleaned`);
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
    /** cell key -> Ctrl+C read, valid for this tab visit (incremental model). */
    const tabReads = new Map<string, { cell: GridCell; text: string }>();
    /** Set once the belt-and-braces full re-sweep has been queued, so a
     * clean verdict built on trusted reads is verified exactly once. */
    let finalSweepQueued = false;
    /** Destinations proven unreachable/full during THIS visit — their items
     * stop being withdrawn (they would only churn bag→source forever). */
    const deadDests = new Set<string>();
    this.findLocation = key;
    try {
      for (let round = 0; round < 10; round += 1) {
        if (
          !(await this.gotoTab(
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
        // Occupancy must be read with NO search filter dimming the grid; the
        // sorter never types queries, so one clear per SESSION covers it.
        if (round === 0 && !this.searchCleared) {
          if (!(await this.clearSearch())) {
            endPhase("search-clear-failed");
            return moved;
          }
          this.searchCleared = true;
        }
        let raw: RawFrame = await this.captureRaw();
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
        this.loadGridCalibration();
        const taught = this.gridCalibration[`${source.label}#${source.occurrence}`];
        // Both layouts share the user-calibrated panel bounds; only the
        // number of divisions differs, and the tab's own separator lines say
        // which it is (a taught per-tab entry still outranks detection).
        const bounds =
          this.gridCalibration["__default_24x24"] ?? this.gridCalibration["__default_12x12"];
        if (taught) {
          this.lastGoodStashGeometry = {
            region: { x: taught.x, y: taught.y, w: taught.w, h: taught.h },
            cols: taught.cols,
            rows: taught.rows,
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
          const frame = await this.captureFrame();
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
          await this.harness.sleep(900, false);
          continue;
        }
        let { region, cols, rows } = this.lastGoodStashGeometry;
        if ((this.options.teach || this.options.teachGrid) && !taught && round === 0) {
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
        for (let r = 0; r < rows; r += 1) {
          for (let c = 0; c < cols; c += 1) {
            if (emptyKeys.has(`${r},${c}`)) continue;
            occupied.push(cellAt(r, c));
          }
        }
        occupied = clampToArea(occupied, STASH_AREA).filter(
          (cell) => !this.phantomStash.has(this.phantomKey(source, cell)),
        );
        if (this.options.teach) {
          occupied = await this.teachOccupancy(source, occupied, cellAt, region, cols, rows);
        }
        if (occupied.length === 0) {
          if (source.drain) {
            this.log(`  · ${key}: zero occupied cells — fully drained (the tab will vanish on its own)`);
          }
          endPhase();
          return moved;
        }
        // INCREMENTAL re-sweep: within this tab visit, only cells the model
        // does not know can have changed (withdrawn cells were forgotten,
        // deposits show up as new occupied cells, unread cells never joined).
        // Untouched cells keep their prior reads; a final full sweep before
        // declaring clean is the belt-and-braces (still saves n-1 of n).
        const occupiedKeys = new Set(occupied.map((cell) => `${cell.row},${cell.col}`));
        for (const modelKey of [...tabReads.keys()]) {
          if (!occupiedKeys.has(modelKey)) tabReads.delete(modelKey);
        }
        const toSweep = occupied.filter((cell) => !tabReads.has(`${cell.row},${cell.col}`));
        const trusted = occupied.length - toSweep.length;
        let unread: GridCell[] = [];
        if (toSweep.length > 0) {
          await this.step(
            `${key}: sweeping ${toSweep.length}/${cols * rows} cells` +
              (trusted > 0 ? ` (${trusted} already read this visit)` : " (black space skipped)"),
          );
          const swept = await this.identifyCells(toSweep, {
            phantomScope: source,
            looksEmpty: (cell) => {
              const score = byKey.get(`${cell.row},${cell.col}`);
              return !score || (score.itemFrac < 0.08 && score.variance < 120);
            },
            probePoint: (cell) => brightestCellPoint(raw.gray, raw.client, region, cols, rows, cell),
            sameSpriteAsLeft: (cell) =>
              cellEdgeContinuity(raw.gray, raw.client, region, cols, rows, cell.row, cell.col),
          });
          unread = swept.unread;
          for (const read of swept.reads) {
            tabReads.set(`${read.cell.row},${read.cell.col}`, read);
          }
        }
        let items = groupIdentifiedCells([...tabReads.values()]);
        if (this.options.teach && items.length > 0) {
          items = await this.teachItems(source, items, region, cols, rows);
        }
        const skippable = new Set<string>([
          ...deadDests,
          ...(source.topLevel ? this.fullDests : []),
        ]);
        // Guild taxonomy remap AFTER the unavailable set is known, so a
        // full "Armor 1" re-routes its items to "Armor 2" instead of
        // skipping them (and a fully unavailable chain resolves to "junk"
        // — the item stays put).
        if (this.guildChest) {
          items = items.map((item) => ({ ...item, dest: guildDestForItem(item, skippable) }));
        }
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
                entry.detoured && (entry.verdict?.tier === "keep" || entry.verdict?.tier === "sell"),
            );
          if (detours.length > 0) {
            this.log(`  · ${key}: ${detours.length} valuable item(s) detour to triage tabs`);
            leaving = [...foreign, ...detours.map((entry) => entry.item)];
          }
        }
        // A cell whose copy failed may HIDE an item — a tab is not clean
        // until every non-phantom cell has been read. Retry them next round
        // (identifyCells blacklists true phantoms after two misses) instead
        // of declaring done past them.
        if (leaving.length === 0 && unread.length > 0 && round < 9) {
          this.harness.guard("unread-cells-retry", true);
          await this.step(`${key}: ${unread.length} cell(s) unread — retrying before declaring clean`);
          continue;
        }
        if (unread.length > 0) {
          this.log(`! ${key}: ${unread.length} cell(s) never yielded item text — check them by hand`);
        }
        this.log(
          `  · ${key}: ${items.length} item(s), ${leaving.length} leaving ` +
            `(${[...new Set(foreign.map((f) => f.dest))].join(", ") || "none"})`,
        );
        if (leaving.length === 0) {
          // A clean verdict built partly on TRUSTED prior reads gets one
          // belt-and-braces full re-sweep before it counts (handoff rule);
          // a verdict from a full sweep of everything stands on its own.
          if (trusted > 0 && !finalSweepQueued && round < 9) {
            finalSweepQueued = true;
            tabReads.clear();
            this.harness.guard("incremental-clean-verify", true);
            await this.step(`${key}: incremental pass reads clean — verifying with one full sweep`);
            continue;
          }
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
        finalSweepQueued = false; // new foreigners reset the verification
        if (leaving.length >= lastForeign) {
          await this.step(`${key}: ${leaving.length} item(s) refuse to move — stopping`);
          endPhase("stalled");
          return moved;
        }
        lastForeign = leaving.length;
        // Budget by REAL cell counts, straight from the identified items.
        const bagFree = BAG_CELL_CAPACITY - (await this.bagCount());
        const batch: IdentifiedItem[] = [];
        let cellsNeeded = 0;
        for (const item of leaving) {
          if (cellsNeeded + item.cells.length > bagFree - 2) continue;
          batch.push(item);
          cellsNeeded += item.cells.length;
        }
        if (batch.length === 0) {
          await this.step("bag too full for any foreign item — filing bag first");
          await this.distributeBag({ returnTo: source, deadDests });
          lastForeign = Number.POSITIVE_INFINITY;
          continue;
        }
        const grabPoints = batch.map((item) => item.cells[0]!);
        await this.step(`${key}: withdrawing ${batch.length} item(s) (${cellsNeeded} cells)`);
        let withdrawn: IdentifiedItem[];
        if (this.guildChest) {
          withdrawn = await this.guildWithdrawSerial(batch, leaving, key);
          if (withdrawn.length === 0) {
            endPhase("plan-not-executed");
            return moved;
          }
        } else {
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
          withdrawn = batch;
        }
        await this.harness.sleep(400);
        moved += withdrawn.length;
        // The withdrawn cells are the ONLY stash cells this trip changed —
        // forget them; the incremental model keeps every other read.
        for (const item of withdrawn) {
          for (const cell of item.cells) tabReads.delete(`${cell.row},${cell.col}`);
        }
        await this.distributeBag({ returnTo: source, deadDests });
      }
      endPhase("round-limit");
      return moved;
    } catch (error) {
      endPhase(error instanceof SortStop ? "stopped" : "failed");
      throw error;
    } finally {
      this.findLocation = "bag";
    }
  }

  /* ---------------- run ---------------- */

  /**
   * Enumerate the folder's tabs from the live folder list, in row order.
   * Duplicate labels (two "Rings" rows) become distinct sources via their
   * occurrence index; Remove-only rows are excluded outright.
   */
  async listSources(): Promise<SourceTab[]> {
    const rows = await this.openFolderList();
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
      const carried = await this.bagCount();
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
      discovered.push(...(await this.listRemoveOnlySources()));
    } else {
      if (scope !== "tabs") discovered.push(...(await this.listSources()));
      if (scope !== "gear") discovered.push(...(await this.listTopSources()));
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
    // A dirty bag from earlier interruptions gets filed FIRST, each item to
    // its true tab by Ctrl+C identity — never dumped wholesale somewhere.
    // Guild runs skip this: live requires an empty bag (gate above), and a
    // dry-run must not churn plans for personal items against guild tabs.
    let moved = this.guildChest ? 0 : await this.distributeBag();
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
        !(await this.gotoTab(source.label, source.occurrence, source.topLevel, source.rowY, source.drain))
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
