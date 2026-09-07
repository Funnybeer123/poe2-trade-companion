/**
 * Gear sorter — shared definitions for the split modules: host/frame types,
 * the public option and result types (re-exported from gearSorter.ts), the
 * screen constants, and the SorterContext the modules receive from the
 * orchestrator. Split out of gearSorter.ts mechanically.
 */
import { TAB_LIST, type StashTabKit, type TabListRow } from "../stashTabKit.js";
import type { SortHarness } from "../sortHarness.js";
import type { WinReply } from "../winHost.js";
import type { bgrToGray, readBmpBgr } from "../bmp.js";
import type { perceiveUi } from "../../core/uiPerception.js";
import type { CalibrationProfile } from "../../core/calibrationProfile.js";
import type { resolvePhysicalClient } from "../../core/screenLayout.js";
import type { CLICK_SURFACES, GridCell, IdentifiedItem } from "../../core/gearSort.js";
import type { TriageRouting } from "../../core/bagTriage.js";
import type { FindRecord } from "../../core/sortTriage.js";
import type { TierVerdict } from "../../core/valueTiers.js";
import type { InventoryRecord } from "../../core/inventoryLedger.js";
import type { StashPerception } from "./stashPerception.js";
import type { TabNavigation } from "./tabNavigation.js";

export interface SortHost {
  send(payload: Record<string, unknown>): Promise<WinReply>;
}

export interface OcrText {
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
  /**
   * The designated SHOP tab (docs/HANDOFF-shop-listings.md): the ONE public
   * tab the shop flow may touch. Mirrors the drain flag's shape — navigation
   * may select it despite the priced-tab protection, but ONLY on a strict
   * labelsEqualFolded match (garbled labels refuse, guess fallbacks are off)
   * and never via cleanTab (cleaning would scatter the listings).
   */
  shop?: boolean;
}

/** Phase-1 result of a tab visit: the single index every decision runs off. */
export interface TabIndex {
  /** Occupied cells the occupancy scan planned to sweep (0 = empty tab). */
  occupiedCount: number;
  modelItems: IdentifiedItem[];
  reads: Array<{ cell: GridCell; text: string }>;
  unread: GridCell[];
  region: { x: number; y: number; w: number; h: number };
  cols: number;
  rows: number;
}

export type TabScanResult =
  | ({ ok: true } & TabIndex)
  | { ok: false; reason: "source-unreachable" | "no-geometry" };

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
  /** Inventory ledger (src/core/inventoryLedger.ts): every identified item,
   * one record per fingerprint per location per run. Estimates come from
   * `triage.evaluate` when triage is on. */
  onObservation?: (record: InventoryRecord) => void;
  /** Groups this session's observations; a location's latest run is its
   * current contents. Defaults to a timestamp-derived id. */
  runId?: string;
}

export interface Frame {
  gray: ReturnType<typeof bgrToGray>;
  bgr: ReturnType<typeof readBmpBgr>;
  client: ReturnType<typeof resolvePhysicalClient>;
  facts: ReturnType<typeof perceiveUi>;
}

/** A cheap frame: pixels only, no perception pass. The identification hot
 * path needs nothing more — occupancy comes from scoring the CALIBRATED
 * regions directly, which skips template matching, nameplate search, and
 * sprite detection on every capture. */
export interface RawFrame {
  gray: ReturnType<typeof bgrToGray>;
  bgr: ReturnType<typeof readBmpBgr>;
  client: ReturnType<typeof resolvePhysicalClient>;
}

export const STASH_BAND = { left: 450, top: 100, width: 700, height: 110 } as const;
export const INVENTORY_BAND = { left: 2900, top: 100, width: 800, height: 110 } as const;
export const PARK = { x: 660, y: 1900 } as const;

/**
 * There are TWO side-list toggles, one per strip row (verified from the
 * user's screenshot, 2026-08-29): (1287,212) opens the TOP-LEVEL list, and
 * the folder row's own chevron below it opens the FOLDER list. Confusing
 * them silently switches navigation context — an earlier build clicked the
 * top toggle for everything and kept reading "Gear | AFFINITIES | T13...".
 */
export const LIST_TOGGLE_TOP = TAB_LIST.toggle;
export const LIST_TOGGLE_FOLDER = { x: 1287, y: 278 } as const;

/**
 * Row clicks land in the label column. The folder list is only ~330px wide
 * (right edge ≈ x1670), so the drain tooling's x=1700 click point falls PAST
 * its edge into the world — selecting nothing.
 */
export const LIST_ROW_CLICK_X = 1430;

/** Pixel probe over the dropdown's on-screen area, for verifying that a
 * toggle click actually opened/closed the list without an OCR round trip. */
export const LIST_PIXEL_PROBE = { x: 1345, y: 195, w: 320, h: 1000 } as const;

/**
 * Guild pacing floors (docs/HANDOFF-standard-drain-guild-stash.md): every
 * guild-stash write is a synchronous realm-master round trip with no
 * published rate limit — actions are verified-serial (one at a time, next
 * only after the previous is pixel-verified committed) and never faster
 * than these floors. The harness pace multiplier can only slow this down
 * (paceDown on any rollback), never below the floor.
 */
export const GUILD_PACE = { itemMs: 1000, tabMs: 2500, commitTimeoutMs: 4000 } as const;

/**
 * What the split-out modules see of the orchestrator: the fixed
 * collaborators, the helpers every module shares, the mutable state that
 * more than one module touches (owned by GearSorter, exposed as accessors),
 * and the sibling modules themselves.
 */
export interface SorterContext {
  /** Fixed collaborators. */
  readonly host: SortHost;
  readonly harness: SortHarness;
  readonly kit: StashTabKit;
  readonly options: GearSorterOptions;
  readonly log: (line: string) => void;
  readonly debugDir: string;
  readonly captureScratchDir: string;

  /** Orchestrator helpers. */
  readonly guildChest: boolean;
  readonly profile: CalibrationProfile;
  titleMatchesChest(text: string): boolean;
  park(): Promise<void>;
  surfaceClick(x: number, y: number, surface: keyof typeof CLICK_SURFACES, why: string): Promise<boolean>;

  /** Shared mutable state, owned by the orchestrator (see the field comments on GearSorter). */
  lastGoodStashGeometry:
    | { region: { x: number; y: number; w: number; h: number }; cols: number; rows: number }
    | undefined;
  lastStashProofAt: number;
  lastSelected: string | undefined;
  folderRowsCache: TabListRow[] | undefined;
  readonly knownTopLabels: Set<string>;
  gridCalibration: Record<string, { x: number; y: number; w: number; h: number; cols: number; rows: number }>;

  /** The sibling modules (cross-module calls go through here). */
  readonly perception: StashPerception;
  readonly navigation: TabNavigation;
}
